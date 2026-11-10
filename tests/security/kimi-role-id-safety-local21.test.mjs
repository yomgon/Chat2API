import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

// Real Kimi parser and the real forwardKimi method, isolated from every app,
// credential store and transport. All IDs, content and HTTP results are synthetic.
const root = new URL('../../', import.meta.url)
const PRIVATE = 'SYNTHETIC_ROLE_ID_VALUE_NOT_FOR_OUTPUT'
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const source = relative => readFileSync(new URL(relative, root), 'utf8')
function compile(text, filename) {
  const compiled = ts.transpileModule(text, { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true })
  assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return compiled.outputText
}
const adapterCode = compile(source('src/main/proxy/adapters/kimi.ts'), 'kimi.ts')
const protocolCode = compile(source('src/main/proxy/adapters/providerModelOptions.ts'), 'options.ts')
const forwardAst = ts.createSourceFile('forwarder.ts', source('src/main/proxy/forwarder.ts'), ts.ScriptTarget.Latest, true)
let forwardMethod
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(forwardAst) === 'forwardKimi') forwardMethod = node.getText(forwardAst)
  ts.forEachChild(node, visit)
}
visit(forwardAst)
assert.ok(forwardMethod)
const forwardCode = compile('class OfflineForwarder { ' + forwardMethod + ' }\nexports.OfflineForwarder = OfflineForwarder', 'forwardKimi.ts')

function load(code, dependencies, logs, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, URL, Date, Error,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected offline dependency')
    },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])), ...globals,
  }, { timeout: 1500 })
  return module.exports
}

function harness(upstream) {
  const logs = [], calls = []
  const axios = { post: async (url, body, config) => {
    calls.push({ url, body, config })
    if (url.endsWith('/Chat')) return { status: 200, headers: {}, data: upstream }
    if (url.endsWith('/DeleteChat')) return { status: 200, data: {} }
    throw new Error('Unexpected synthetic request')
  } }
  const exports = load(adapterCode, {
    axios: { __esModule: true, default: axios }, stream: { PassThrough },
    './providerModelOptions': load(protocolCode, {}, logs),
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }, logs)
  return { ...exports, calls, logs }
}

const answer = (content = 'safe assistant answer') => ({
  op: 'append', mask: 'block.text.content', block: { text: { content, flags: 'answer' } },
})
function frame(flag, value) {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
function watch(output) {
  const state = { chunks: [], ended: false }
  output.on('data', chunk => state.chunks.push(chunk.toString('utf8')))
  output.once('end', () => { state.ended = true })
  output.on('error', () => {})
  return state
}
async function run(t, mode, messages) {
  const upstream = new PassThrough({ autoDestroy: false })
  const h = harness(upstream)
  const handler = new h.KimiStreamHandler('k2d6-chat', '')
  let output, observed, result
  if (mode === 'stream') {
    output = await handler.handleStream(upstream)
    observed = watch(output)
  } else handler.handleNonStream(upstream).then(value => { result = { value } }, error => { result = { error } })
  t.after(() => { upstream.destroy(); output?.destroy() })
  for (const message of messages) assert.doesNotThrow(() => upstream.write(frame(0, message)))
  assert.doesNotThrow(() => upstream.end(frame(2, {})))
  await nextTurn()
  return { ...h, handler, observed, result }
}
function assertFailed(h, mode) {
  assert.equal(h.handler.hasSessionError(), true)
  assert.equal(h.handler.hasSuccessfulTerminal(), false)
  if (mode === 'stream') {
    const text = h.observed.chunks.join('')
    assert.equal(h.observed.ended, true)
    assert.equal(text.includes('"error"'), true)
    assert.equal(text.includes('data: [DONE]'), false)
    assert.equal(text.includes('"finish_reason":"stop"'), false)
    assert.equal(text.includes(PRIVATE), false)
  } else {
    assert.equal(h.result?.error instanceof h.KimiProxyFailure, true)
    assert.equal(h.result.error.stage, 'response-decoding')
    assert.equal(h.result.error.message, 'Kimi response decoding failed')
    assert.equal(h.result.error.cause, undefined)
    assert.equal(inspect(h.result.error, { showHidden: true }).includes(PRIVATE), false)
  }
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(h.calls.length, 0)
}

test('present chat records and IDs fail closed before either consumer emits assistant output', async t => {
  const chats = [null, [], false, 7, PRIVATE, { id: {} }, { id: [PRIVATE] }, { id: null },
    { id: false }, { id: 7 }, { id: '' }, { id: '  ' }, { id: ' padded ' }, { id: 'bad\nidentifier' }]
  for (const mode of ['stream', 'nonstream']) for (const chat of chats) {
    const h = await run(t, mode, [{ ...answer(PRIVATE), chat }])
    assertFailed(h, mode)
    assert.equal(h.handler.getConversationId(), null)
  }
})

test('present message records and IDs cannot inject nonstring or empty identifiers', async t => {
  const messages = [null, [], false, PRIVATE, { role: 'assistant', id: {} },
    { role: 'assistant', id: [PRIVATE] }, { role: 'assistant', id: null },
    { role: 'assistant', id: false }, { role: 'assistant', id: 9 },
    { role: 'assistant', id: '' }, { role: 'assistant', id: '  ' }, { role: 'assistant', id: 'bad\u0000id' }]
  for (const mode of ['stream', 'nonstream']) for (const message of messages) {
    const h = await run(t, mode, [{ ...answer(PRIVATE), message }])
    assertFailed(h, mode)
    assert.equal(h.handler.getLastMessageId(), null)
  }
})

test('explicit non-assistant or malformed roles are never reclassified as assistant text', async t => {
  for (const mode of ['stream', 'nonstream']) for (const role of ['user', 'system', 'tool', 'developer', 'ASSISTANT', ' assistant ', '', null, 1, {}, []]) {
    const h = await run(t, mode, [{ ...answer(PRIVATE), message: { role } }])
    assertFailed(h, mode)
  }
})

test('non-assistant metadata cannot be followed by unlabelled text and successful cleanup', async t => {
  for (const mode of ['stream', 'nonstream']) {
    assertFailed(await run(t, mode, [{ message: { role: 'user', id: 'synthetic-user-message' } }, answer(PRIVATE)]), mode)
  }
})

test('heartbeat and later metadata still pass through the same role and ID validation', async t => {
  for (const mode of ['stream', 'nonstream']) for (const bad of [
    { heartbeat: true, chat: { id: { private: PRIVATE } } },
    { heartbeat: true, message: { role: 'user' } },
    { message: { role: 'assistant', id: { private: PRIVATE } } },
  ]) assertFailed(await run(t, mode, [{ chat: { id: 'synthetic-chat' } }, answer(), bad]), mode)
})

test('valid assistant metadata preserves identifiers and answer in both modes', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const h = await run(t, mode, [{ chat: { id: 'synthetic-chat' }, message: { id: 'synthetic-assistant', role: 'assistant' } }, answer()])
    assert.equal(h.handler.hasSessionError(), false)
    assert.equal(h.handler.getConversationId(), 'synthetic-chat')
    assert.equal(h.handler.getLastMessageId(), 'synthetic-assistant')
    if (mode === 'stream') {
      assert.equal(h.handler.hasSuccessfulTerminal(), true)
      assert.equal(h.observed.chunks.join('').includes('[DONE]'), true)
    } else assert.equal(h.result?.value?.choices[0].message.content, 'safe assistant answer')
  }
})

test('conflicting chat IDs cannot authorize cleanup for an ambiguous response', async t => {
  for (const mode of ['stream', 'nonstream']) {
    assertFailed(await run(t, mode, [{ chat: { id: 'synthetic-first' } }, answer(),
      { chat: { id: 'synthetic-second' } }]), mode)
    const repeated = await run(t, mode, [{ chat: { id: 'synthetic-first' } }, answer(),
      { chat: { id: 'synthetic-first' } }])
    assert.equal(repeated.handler.hasSessionError(), false)
    assert.equal(repeated.handler.getConversationId(), 'synthetic-first')
  }
})

test('absent role and identifier metadata stays optional for existing valid responses', async t => {
  for (const mode of ['stream', 'nonstream']) for (const metadata of [{}, { chat: {} }, { message: {} }, { message: { role: 'assistant' } }, { message: { id: 'synthetic-assistant' } }]) {
    const h = await run(t, mode, [{ ...answer(), ...metadata }])
    assert.equal(h.handler.hasSessionError(), false)
    assert.equal(h.handler.getConversationId(), null)
    if (mode === 'stream') assert.equal(h.observed.chunks.join('').includes('[DONE]'), true)
    else assert.equal(h.result?.value?.choices[0].message.content, 'safe assistant answer')
  }
})

function forwarder(h) {
  const { OfflineForwarder } = load(forwardCode, {}, h.logs, {
    ...h, shouldDeleteSession: () => true,
    safeWebErrorStatus: error => error?.upstreamStatus,
    hasCompletedNonStreamAnswer: value => value?.choices?.[0]?.message?.role === 'assistant'
      && typeof value.choices[0].message.content === 'string' && !!value.choices[0].message.content.trim(),
    unconfirmedProviderCompletion: latency => ({ success: false, status: 502, latency }),
  })
  const instance = new OfflineForwarder()
  instance.transformRequestForPromptToolUse = request => ({ messages: request.messages, plan: { shouldParseResponse: false } })
  instance.applyToolCallsToResponse = () => {}
  instance.extractHeaders = () => ({})
  return instance
}

test('actual forwardKimi cleanup requires valid role and string IDs plus clean terminal EOF', async t => {
  for (const stream of [false, true]) for (const kind of ['object-chat-id', 'user-text', 'conflicting-id', 'absent-id', 'valid']) {
    const upstream = new PassThrough({ autoDestroy: false })
    const h = harness(upstream)
    const request = { model: 'k2d6-chat', messages: [{ role: 'user', content: 'synthetic request' }], stream }
    let result, observed
    const pending = forwarder(h).forwardKimi(request,
      { id: 'synthetic-account', providerId: 'kimi', credentials: { token: 'SYNTHETIC_TOKEN' } },
      { id: 'kimi', apiEndpoint: 'https://www.kimi.com' }, 'k2d6-chat', Date.now()).then(value => { result = value; return value })
    await nextTurn()
    if (stream) observed = watch((await pending).stream)
    t.after(() => { upstream.destroy(); result?.stream?.destroy() })
    const message = { ...answer(), ...(kind === 'absent-id' ? {} : { chat: { id: kind === 'object-chat-id' ? { private: PRIVATE } : 'synthetic-chat' } }),
      message: { id: 'synthetic-assistant', role: kind === 'user-text' ? 'user' : 'assistant' } }
    upstream.write(Buffer.concat([frame(0, message), ...(kind === 'conflicting-id'
      ? [frame(0, { chat: { id: 'synthetic-other-chat' } })] : []), frame(2, {})]))
    await nextTurn()
    assert.equal(h.calls.filter(call => call.url.endsWith('/DeleteChat')).length, 0)
    upstream.end()
    await nextTurn()
    assert.equal(h.calls.filter(call => call.url.endsWith('/Chat')).length, 1)
    assert.equal(h.calls.filter(call => call.url.endsWith('/DeleteChat')).length, kind === 'valid' ? 1 : 0)
    const successful = kind === 'valid' || kind === 'absent-id'
    if (stream) assert.equal(observed.chunks.join('').includes('[DONE]'), successful)
    else {
      await pending
      assert.equal(result.success, successful)
      if (!successful) {
        assert.equal(result.failureStage, 'response-decoding')
        assert.equal(result.status, 502)
      }
    }
    assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  }
})

const tokenFields = ['token', 'refreshToken', 'accessToken']
function selectedCredentials(index, candidate, prior) {
  const credentials = {}, reads = []
  for (const [position, field] of tokenFields.entries()) {
    Object.defineProperty(credentials, field, { enumerable: true, get() {
      reads.push(field)
      return position < index ? prior : position === index ? candidate : PRIVATE + '_FALLBACK'
    } })
  }
  return { credentials: Object.freeze(credentials), reads }
}
function adapterForCredentials(h, credentials) {
  return new h.KimiAdapter(Object.freeze({ id: 'kimi', apiEndpoint: 'https://www.kimi.com' }),
    Object.freeze({ id: 'synthetic-token-account', providerId: 'kimi', credentials }))
}
function assertRejectedCandidate(h, selected, index) {
  assert.throws(() => adapterForCredentials(h, selected.credentials), error => {
    assert.equal(error instanceof h.KimiProxyFailure, true)
    assert.equal(error.stage, 'auth-preflight')
    assert.equal(error.message, 'Kimi authentication preflight failed')
    assert.equal(error.upstreamStatus, undefined)
    assert.equal(error.cause, undefined)
    assert.equal(inspect({ error, logs: h.logs }, { showHidden: true }).includes(PRIVATE), false)
    return true
  })
  assert.deepEqual(selected.reads, tokenFields.slice(0, index + 1))
  assert.equal(h.calls.length, 0)
}

test('token candidate precedence is retained without reading lower-priority fields', async () => {
  // Empty strings and undefined retain the existing unconfigured-field meaning.
  for (const index of [0, 1, 2]) for (const prior of [undefined, '']) {
    const h = harness({})
    const candidate = PRIVATE + '_SELECTED'
    const selected = selectedCredentials(index, candidate, prior)
    const adapter = adapterForCredentials(h, selected.credentials)
    await adapter.chatCompletion({ model: 'k2d6-chat', messages: [{ role: 'user', content: 'synthetic request' }] })
    assert.deepEqual(selected.reads, tokenFields.slice(0, index + 1))
    assert.equal(h.calls.length, 1)
    const call = h.calls[0]
    assert.equal(call.url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat')
    assert.equal(call.config.maxRedirects, 0)
    assert.equal(call.config.headers.Authorization === `Bearer ${candidate}`, true)
    assert.equal(Object.keys(call.config.headers).filter(key => key.toLowerCase() === 'authorization').length, 1)
    assert.equal(Object.keys(call.config.headers).some(key => key.toLowerCase() === 'cookie'), false)
    assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  }
})

test('malformed selected token candidates fail before fallback or transport', () => {
  const malformed = [null, false, 0, {}, [], [PRIVATE], new String(PRIVATE),
    { toString() { throw new Error(PRIVATE) } }, ' ', '\t', '\u00a0', PRIVATE + ' ',
    PRIVATE + '\n', PRIVATE + '\u2028', PRIVATE + '\u2029']
  for (const index of [0, 1, 2]) for (const prior of [undefined, '']) for (const candidate of malformed) {
    assertRejectedCandidate(harness({}), selectedCredentials(index, candidate, prior), index)
  }
})

test('all C0, DEL and C1 controls in selected token candidates fail locally', () => {
  const controls = [...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => 0x7f + index)]
  for (const index of [0, 1, 2]) for (const code of controls) {
    assertRejectedCandidate(harness({}), selectedCredentials(index, PRIVATE + String.fromCharCode(code), undefined), index)
  }
})
