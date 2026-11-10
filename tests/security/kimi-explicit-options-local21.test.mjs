import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

// Real forwardKimi, Kimi adapter, Connect parser and payload builder with only
// in-memory transport. No app, account store, credentials or network is loaded.
const root = new URL('../../', import.meta.url)
const PRIVATE = 'SYNTHETIC_KIMI_OPTIONS_TOKEN_NOT_FOR_LOGS'
const ORIGIN = 'https://www.kimi.com'
const source = path => readFileSync(new URL(path, root), 'utf8')
function compile(text, filename) {
  const result = ts.transpileModule(text, { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true })
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return result.outputText
}
const adapterCode = compile(source('src/main/proxy/adapters/kimi.ts'), 'kimi.ts')
const protocolCode = compile(source('src/main/proxy/adapters/providerModelOptions.ts'), 'providerModelOptions.ts')
const forwardAst = ts.createSourceFile('forwarder.ts', source('src/main/proxy/forwarder.ts'), ts.ScriptTarget.Latest, true)
const forwardMethods = []
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(forwardAst) === 'forwardKimi') {
    forwardMethods.push(node.getText(forwardAst))
  }
  ts.forEachChild(node, visit)
}
visit(forwardAst)
assert.equal(forwardMethods.length, 1)
const forwardCode = compile('class OfflineForwarder { ' + forwardMethods[0] +
  ' }\nexports.OfflineForwarder = OfflineForwarder', 'forwardKimi.ts')

function load(code, dependencies, logs, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, URL, Date, Error,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected offline dependency')
    },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    ...globals,
  }, { timeout: 1500 })
  return module.exports
}
function frame(flag, payload) {
  const data = Buffer.from(JSON.stringify(payload))
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, data])
}
function harness(t) {
  const logs = [], calls = [], submitted = [], streams = []
  t.after(() => streams.forEach(stream => stream.destroy()))
  const api = load(adapterCode, {
    axios: { __esModule: true, default: { post: async (url, body, config) => {
      calls.push({ url, body, config })
      assert.equal(url, ORIGIN + '/apiv2/kimi.gateway.chat.v1.ChatService/Chat')
      const upstream = new PassThrough({ autoDestroy: false })
      streams.push(upstream)
      upstream.end(Buffer.concat([
        frame(0, { op: 'append', mask: 'block.text.content',
          message: { role: 'assistant' }, block: { text: { content: 'synthetic answer', flags: 'answer' } } }),
        frame(2, {}),
      ]))
      return { status: 200, headers: {}, data: upstream }
    } } },
    stream: { PassThrough },
    './providerModelOptions': load(protocolCode, {}, logs),
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }, logs)
  class ObservedKimiAdapter extends api.KimiAdapter {
    async chatCompletion(request) {
      submitted.push({ ...request })
      return super.chatCompletion(request)
    }
  }
  const { OfflineForwarder } = load(forwardCode, {}, logs, {
    ...api, KimiAdapter: ObservedKimiAdapter,
    shouldDeleteSession: () => false,
    safeWebErrorStatus: error => error?.upstreamStatus,
    hasCompletedNonStreamAnswer: value => value?.choices?.[0]?.message?.role === 'assistant'
      && typeof value.choices[0].message.content === 'string' && !!value.choices[0].message.content.trim(),
    unconfirmedProviderCompletion: latency => ({ success: false, status: 502, latency }),
  })
  const forwarder = new OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages, plan: { shouldParseResponse: false },
  })
  forwarder.applyToolCallsToResponse = () => {}
  forwarder.extractHeaders = () => ({})
  return { ...api, calls, logs, submitted, streams, forwarder }
}
const provider = Object.freeze({ id: 'kimi', apiEndpoint: ORIGIN })
const account = Object.freeze({ id: 'synthetic-options-account', providerId: 'kimi',
  credentials: Object.freeze({ token: PRIVATE }) })
const messages = Object.freeze([Object.freeze({ role: 'user', content: 'synthetic prompt' })])
function assertPayload(h, thinking, search, scenario = 'SCENARIO_CHAT') {
  assert.equal(h.calls.length, 1, 'exactly one synthetic Chat request')
  const { body, config } = h.calls[0]
  assert.equal(config.maxRedirects, 0)
  assert.equal(config.headers.Authorization === 'Bearer ' + PRIVATE, true)
  assert.equal(Object.keys(config.headers).filter(key => key.toLowerCase() === 'authorization').length, 1)
  assert.equal(Object.keys(config.headers).some(key => key.toLowerCase() === 'cookie'), false)
  assert.equal(body.readUInt8(0), 0)
  assert.equal(body.readUInt32BE(1), body.length - 5)
  assert.deepEqual(JSON.parse(body.subarray(5).toString('utf8')), {
    scenario, chat_id: '', tools: search ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: { parent_id: '', role: 'user',
      blocks: [{ message_id: '', text: { content: 'synthetic prompt\n' } }], scenario },
    options: { thinking },
  })
  assert.equal(inspect(h.logs, { depth: 8 }).includes(PRIVATE), false)
}
async function forwarded(t, model, options = {}, stream = false, actualModel = 'k2d6-chat') {
  const h = harness(t)
  const request = Object.freeze({ model, messages, stream, ...options })
  const result = await h.forwarder.forwardKimi(request, account, provider, actualModel, Date.now())
  assert.equal(result.success, true)
  assert.equal(result.status, 200)
  if (stream) {
    h.streams.push(result.stream)
    let output = ''
    for await (const chunk of result.stream) output += chunk.toString('utf8')
    assert.equal(output.includes('synthetic answer'), true)
    assert.equal(output.includes('data: [DONE]'), true)
    assert.equal(output.includes('"error"'), false)
  } else assert.equal(result.body.choices[0].message.content, 'synthetic answer')
  assert.equal(h.submitted.length, 1)
  assert.equal(h.submitted[0].model, actualModel)
  assert.equal(h.submitted[0].originalModel, model)
  for (const key of ['enableThinking', 'enableWebSearch']) {
    assert.equal(h.submitted[0][key] === undefined || typeof h.submitted[0][key] === 'boolean', true)
  }
  assert.equal(inspect({ result, logs: h.logs }, { depth: 6 }).includes(PRIVATE), false)
  return h
}

test('actual forwardKimi preserves absent and undefined options for mapped alias inference', { timeout: 10000 }, async t => {
  for (const stream of [false, true]) for (const options of [{}, { reasoning_effort: undefined, web_search: undefined }]) {
    for (const [alias, thinking, search] of [
      ['Kimi-K2.6', false, false], ['Kimi-K2.6-search', false, true],
      ['Kimi-K2.6-r1', true, false], ['KIMI-K2.6-THINK-SEARCH', true, true],
    ]) {
      const h = await forwarded(t, alias, options, stream)
      assert.equal(h.submitted[0].enableThinking, undefined)
      assert.equal(h.submitted[0].enableWebSearch, undefined)
      assertPayload(h, thinking, search)
    }
  }
})

test('actual forwardKimi explicit false overrides both flags on a mapped think-search alias', { timeout: 10000 }, async t => {
  // false is a runtime boundary fixture; the public reasoning level union stays unchanged.
  for (const stream of [false, true]) {
    const h = await forwarded(t, 'Kimi-K2.6-think-search', { reasoning_effort: false, web_search: false }, stream)
    assert.equal(h.submitted[0].enableThinking, false)
    assert.equal(h.submitted[0].enableWebSearch, false)
    assertPayload(h, false, false)
  }
})

test('one explicit false does not erase the other omitted Kimi option', { timeout: 10000 }, async t => {
  for (const stream of [false, true]) for (const [options, thinking, search] of [
    [{ reasoning_effort: false }, false, true], [{ web_search: false }, true, false],
    [{ reasoning_effort: false, web_search: true }, false, true],
    [{ reasoning_effort: 'high', web_search: false }, true, false],
  ]) {
    const h = await forwarded(t, 'Kimi-K2.6-think-search', options, stream)
    if (!Object.hasOwn(options, 'reasoning_effort')) assert.equal(h.submitted[0].enableThinking, undefined)
    if (!Object.hasOwn(options, 'web_search')) assert.equal(h.submitted[0].enableWebSearch, undefined)
    assertPayload(h, thinking, search)
  }
})

test('explicit true and existing reasoning effort levels stay enabled without aliases', { timeout: 10000 }, async t => {
  for (const stream of [false, true]) for (const reasoning_effort of [true, 'low', 'medium', 'high']) {
    const h = await forwarded(t, 'Kimi-K2.6', { reasoning_effort, web_search: true }, stream)
    assert.equal(h.submitted[0].enableThinking, true)
    assert.equal(h.submitted[0].enableWebSearch, true)
    assertPayload(h, true, true)
  }
})

test('actual adapter independently respects false true and undefined for each legacy alias', { timeout: 10000 }, async t => {
  for (const [originalModel, aliasThinking, aliasSearch] of [
    ['Kimi-K2.6', false, false], ['Kimi-K2.6-search', false, true],
    ['Kimi-K2.6-think', true, false], ['Kimi-K2.6-r1', true, false],
    ['KIMI-K2.6-THINK-SEARCH', true, true],
  ]) for (const enableThinking of [undefined, false, true]) for (const enableWebSearch of [undefined, false, true]) {
    const h = harness(t)
    await new h.KimiAdapter(provider, account).chatCompletion(Object.freeze({
      model: 'k2d6-chat', originalModel, messages, enableThinking, enableWebSearch,
    }))
    assertPayload(h, enableThinking === undefined ? aliasThinking : enableThinking,
      enableWebSearch === undefined ? aliasSearch : enableWebSearch)
  }
})

test('absent adapter options retain original-name precedence and existing Kimi scenarios', { timeout: 10000 }, async t => {
  for (const [model, originalModel, thinking, search, scenario] of [
    ['Kimi-K2.6-think-search', undefined, true, true, 'SCENARIO_K2D6'],
    ['kimi-k2.5-search', undefined, false, true, 'SCENARIO_K2D5'],
    ['k2d6-chat', undefined, false, false, 'SCENARIO_CHAT'],
    ['Kimi-K2.6-think-search', 'Kimi-K2.6', false, false, 'SCENARIO_K2D6'],
  ]) {
    const h = harness(t)
    await new h.KimiAdapter(provider, account).chatCompletion(Object.freeze({ model, originalModel, messages }))
    assertPayload(h, thinking, search, scenario)
  }
})

test('explicit feature options do not promote agent models into the Kimi chat route', { timeout: 10000 }, async t => {
  for (const stream of [false, true]) for (const actualModel of ['k3-agent', 'k28-agent-preview']) {
    const h = harness(t)
    const result = await h.forwarder.forwardKimi(Object.freeze({
      model: 'Kimi-K2.6-think-search', messages, stream, reasoning_effort: 'high', web_search: true,
    }), account, provider, actualModel, Date.now())
    assert.equal(result.success, false)
    assert.equal(result.failureCode, 'kimi_upstream_operation_failed')
    assert.equal(h.calls.length, 0)
    assert.equal(inspect({ result, logs: h.logs }, { depth: 6 }).includes(PRIVATE), false)
  }
})
