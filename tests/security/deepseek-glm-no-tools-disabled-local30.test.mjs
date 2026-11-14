import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import * as streams from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { createParser } from 'eventsource-parser'

const { PassThrough } = streams
// Production engine/runtime plan, dedicated consumers, legacy/managed parsers,
// terminal gate and route run in a closed VM. Transport and persistent stores
// are unavailable. The route's forwarder boundary returns the real consumer
// result after actual engine postprocessing; it does not perform a request.
const files = [
  'src/main/proxy/adapters/deepseek-stream.ts',
  'src/main/proxy/adapters/glm.ts',
  'src/main/proxy/routes/chat.ts',
  'src/main/proxy/streamTerminalGate.ts',
  'src/main/proxy/utils/toolParser.ts',
  'src/shared/toolCalling.ts',
  'src/main/proxy/toolCalling/ToolCallingEngine.ts',
  'src/main/proxy/toolCalling/ToolStreamParser.ts',
  'src/main/proxy/toolCalling/runtimePlan.ts',
  'src/main/proxy/toolCalling/providerProfiles.ts',
  'src/main/proxy/toolCalling/clientAdapters/index.ts',
  'src/main/proxy/toolCalling/clientAdapters/standardOpenAiTools.ts',
  'src/main/proxy/toolCalling/clientAdapters/cherryStudioMcp.ts',
  'src/main/proxy/toolCalling/protocols/index.ts',
  'src/main/proxy/toolCalling/protocols/shared.ts',
  'src/main/proxy/toolCalling/protocols/managedXml.ts',
  'src/main/proxy/toolCalling/protocols/managedBracket.ts',
  'src/main/proxy/toolCalling/protocols/anthropicToolUse.ts',
  'src/main/proxy/toolCalling/protocols/codexResponses.ts',
]
const compiled = new Map(files.map(file => [file, ts.transpileModule(
  readFileSync(new URL('../../' + file, import.meta.url), 'utf8'),
  {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  },
).outputText]))
const LITERAL = '[function_calls][call:lookup]{}[/call][/function_calls]'
const ORDINARY = 'Ordinary synthetic assistant answer'
const MANAGED = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="lookup"><|CHAT2API|parameter name="city"><![CDATA[synthetic-city]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
const DECLARED = [{
  type: 'function',
  function: { name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' } },
}]

function loadProduct(providerId) {
  const effects = [], logs = [], cache = new Map()
  const accounting = { success: 0, failure: 0, accounts: 0, stats: [], forwards: 0 }
  let route, forwardedBody
  const forbidden = name => () => {
    effects.push(name)
    throw new Error('Forbidden synthetic capability: ' + name)
  }
  const provider = { id: providerId, name: 'Synthetic provider' }
  const account = { id: 'synthetic-account', providerId, name: 'Synthetic account' }
  const stubs = {
    axios: { __esModule: true, default: {
      get: forbidden('GET'), post: forbidden('POST'), delete: forbidden('DELETE'),
    } },
    crypto: {},
    stream: streams,
    'eventsource-parser': { createParser },
    'form-data': { __esModule: true, default: class {} },
    'mime-types': {},
    '../../store/store': { storeManager: {
      updateAccount: forbidden('credential persistence'),
    } },
    '../utils/tools': {
      hasToolPromptInjected: forbidden('legacy prompt'),
      toolsToSystemPrompt: forbidden('legacy tool definitions'),
      TOOL_WRAP_HINT: '',
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
    },
  }
  const routeDependencies = {
    '@koa/router': { __esModule: true, default: class {
      post(path, handler) { assert.equal(path, '/completions'); route = handler }
    } },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-model' }),
      clearAccountFailure: () => {},
      markAccountFailed: forbidden('unexpected account failure'),
    } },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: async () => {
        accounting.forwards++
        return { success: true, status: 200, body: forwardedBody, latency: 1 }
      },
    } },
    '../stream': { streamHandler: { createTransformStream: forbidden('generic stream transform') } },
    '../status': { proxyStatusManager: {
      recordRequestStart: () => {},
      recordRequestSuccess: () => { accounting.success++ },
      recordRequestFailure: () => { accounting.failure++ },
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => providerId,
      getPreferredAccount: () => account.id,
    } },
    '../../store/store': { storeManager: {
      getConfig: () => ({ loadBalanceStrategy: 'round-robin' }),
      recordAccountSuccess: () => { accounting.accounts++; return true },
      addLog: (...args) => logs.push(args),
      addRequestLog: () => ({ id: 'synthetic-log' }),
      recordRequestInStats: success => accounting.stats.push(success),
    } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: forbidden('unrequested tool format'),
      transformChunkToAnthropic: forbidden('unrequested stream format'),
    },
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    assert.ok(compiled.has(file), 'source dependency must be explicitly allowed: ' + file)
    const module = { exports: {} }
    cache.set(file, module)
    vm.runInNewContext(compiled.get(file), {
      module, exports: module.exports, Buffer, TextDecoder, Date, Error,
      console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [
        level, (...args) => logs.push({ level, args }),
      ])),
      require: name => {
        if (file === files[2] && Object.hasOwn(routeDependencies, name)) return routeDependencies[name]
        if (Object.hasOwn(stubs, name)) return stubs[name]
        assert.ok(name.startsWith('.'), 'external dependency is forbidden: ' + name)
        let target = posix.normalize(posix.join(posix.dirname(file), name))
        if (!target.endsWith('.ts')) target += '.ts'
        return load(target)
      },
    }, { filename: file, timeout: 1500 })
    return module.exports
  }
  const exported = load(providerId === 'deepseek' ? files[0] : files[1])
  return {
    ...exported,
    ...load('src/main/proxy/toolCalling/ToolCallingEngine.ts'),
    ...load('src/main/proxy/streamTerminalGate.ts'),
    effects, logs, providerId,
    async routeResponse(response, request) {
      forwardedBody = response
      load(files[2])
      const ctx = {
        request: { body: { ...request, stream: false } },
        headers: {}, ip: '127.0.0.1', status: 200,
        set() {},
      }
      await route(ctx)
      assert.equal(ctx.status, 200)
      assert.equal(accounting.forwards, 1)
      assert.equal(accounting.success, 1)
      assert.equal(accounting.failure, 0)
      assert.equal(accounting.accounts, 1, 'one confirmed synthetic account settlement')
      assert.deepEqual(accounting.stats, [true])
      return ctx.body
    },
  }
}

function production(providerId, request = {}, config = {}) {
  const h = loadProduct(providerId)
  const engine = new h.ToolCallingEngine(config)
  const originalRequest = {
    model: 'synthetic-model',
    messages: [{ role: 'user', content: 'Synthetic request' }],
    ...request,
  }
  const { plan } = engine.transformRequest({
    request: originalRequest,
    provider: { id: providerId },
    actualModel: 'synthetic-model',
  })
  return { ...h, engine, plan, originalRequest }
}

const sse = value => 'data: ' + JSON.stringify(value) + '\n\n'
function providerBytes(providerId, text) {
  if (providerId === 'deepseek') {
    return sse({ p: 'response/fragments', v: [{ type: 'ANSWER', content: text }] }) + 'data: [DONE]\n\n'
  }
  return sse({
    status: 'streaming', conversation_id: 'synthetic-conversation',
    parts: [{ logic_id: '1', status: 'streaming', content: [{ type: 'text', text }] }],
  }) + sse({ status: 'finish', conversation_id: 'synthetic-conversation' })
}

async function consume(t, h, mode, text) {
  const handler = h.providerId === 'deepseek'
    ? new h.DeepSeekStreamHandler('synthetic-model', 'synthetic-session', undefined, false, undefined, h.plan)
    : new h.GLMStreamHandler('synthetic-model', undefined, undefined, h.plan)
  const input = new PassThrough({ autoDestroy: false })
  const chunks = [], terminals = []
  let converted, output, pending
  if (mode === 'stream') {
    converted = await handler.handleStream(input)
    output = h.createOpenAIStreamTerminalGate(converted, completed => terminals.push(completed))
    pending = new Promise((resolve, reject) => {
      output.on('data', chunk => chunks.push(chunk.toString('utf8')))
      output.once('end', resolve)
      output.once('error', reject)
    })
  } else {
    pending = handler.handleNonStream(input)
  }
  t.after(() => { input.destroy(); output?.destroy(); converted?.destroy() })
  input.end(providerBytes(h.providerId, text))
  let response = await pending
  if (mode === 'nonstream' && h.engine) {
    h.engine.applyNonStreamResponse(response, h.plan)
    response = await h.routeResponse(response, h.originalRequest)
  }
  assert.deepEqual(h.effects, [], 'no transport, auth, persistence or request construction')
  if (mode === 'nonstream') {
    const choice = response.choices[0]
    assert.equal(choice.message.role, 'assistant')
    return { content: choice.message.content, calls: choice.message.tool_calls, finish: choice.finish_reason }
  }
  assert.deepEqual(terminals, [true])
  const wire = chunks.join('')
  assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1)
  const records = wire.split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
  assert.equal(records.some(record => record.error), false)
  const choices = records.flatMap(record => record.choices ?? [])
  const finishes = choices.filter(choice => choice.finish_reason !== null && choice.finish_reason !== undefined)
  assert.equal(finishes.length, 1)
  const calls = choices.flatMap(choice => choice.delta?.tool_calls ?? [])
  return {
    content: choices.map(choice => choice.delta?.content ?? '').join(''),
    calls: calls.length ? calls : undefined,
    finish: finishes[0].finish_reason,
  }
}

function assertText(result, expected) {
  assert.equal(result.finish, 'stop')
  assert.equal(result.content, expected)
  assert.equal(result.calls, undefined, 'literal text must not become an undeclared tool call')
}

function assertLookup(result, args) {
  assert.equal(result.finish, 'tool_calls')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].type, 'function')
  assert.equal(result.calls[0].function.name, 'lookup')
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), args)
}

const disabledCases = [
  { label: 'omitted tools', request: {}, reason: 'no_tools' },
  { label: 'empty tools', request: { tools: [] }, reason: 'no_tools' },
  { label: 'mode off with declared tools', request: { tools: DECLARED }, config: { mode: 'off' }, reason: 'mode_off' },
  { label: 'enabled false with declared tools', request: { tools: DECLARED }, config: { enabled: false }, reason: 'mode_off' },
]

for (const providerId of ['deepseek', 'glm']) {
  for (const mode of ['stream', 'nonstream']) {
    for (const scenario of disabledCases) {
      test(providerId + ' ' + mode + ': actual disabled plan preserves literal tool text for ' + scenario.label, { timeout: 2500 }, async t => {
        const h = production(providerId, scenario.request, scenario.config)
        assert.equal(h.plan.mode, 'disabled')
        assert.equal(h.plan.diagnostics.reason, scenario.reason)
        assert.equal(h.plan.toolChoiceMode, 'auto')
        assert.equal(h.plan.shouldParseResponse, false)
        assertText(await consume(t, h, mode, LITERAL), LITERAL)
      })
    }

    test(providerId + ' ' + mode + ': explicit tool_choice none keeps declared-tool syntax as text', { timeout: 2500 }, async t => {
      const h = production(providerId, { tools: DECLARED, tool_choice: 'none' })
      assert.equal(h.plan.mode, 'disabled')
      assert.equal(h.plan.toolChoiceMode, 'none')
      assertText(await consume(t, h, mode, LITERAL), LITERAL)
    })

    for (const [label, choice] of [
      ['auto', 'auto'],
      ['required', 'required'],
      ['forced', { type: 'function', function: { name: 'lookup' } }],
    ]) {
      test(providerId + ' ' + mode + ': managed ' + label + ' plan still emits a declared tool call', { timeout: 2500 }, async t => {
        const h = production(providerId, {
          tools: [...DECLARED, { type: 'function', function: { name: 'alternate', parameters: {} } }],
          tool_choice: choice,
        })
        assert.equal(h.plan.mode, 'managed')
        assert.equal(h.plan.shouldParseResponse, true)
        assert.equal(h.plan.toolChoiceMode, label)
        if (label === 'forced') assert.deepEqual([...h.plan.allowedToolNames], ['lookup'])
        assertLookup(await consume(t, h, mode, MANAGED), { city: 'synthetic-city' })
      })
    }

    for (const [label, request] of [['disabled', {}], ['managed', { tools: DECLARED }]]) {
      test(providerId + ' ' + mode + ': ordinary text completes with a ' + label + ' plan', { timeout: 2500 }, async t => {
        const h = production(providerId, request)
        assert.equal(h.plan.mode, label)
        assertText(await consume(t, h, mode, ORDINARY), ORDINARY)
      })
    }
  }

  for (const [label, plan] of [
    ['no plan', undefined],
    ['legacy partial auto plan', { shouldParseResponse: false, toolChoiceMode: 'auto' }],
  ]) {
    test(providerId + ' nonstream: direct ' + label + ' retains legacy tool parsing', { timeout: 2500 }, async t => {
      const h = { ...loadProduct(providerId), plan }
      assertLookup(await consume(t, h, 'nonstream', LITERAL), {})
    })
  }

  test(providerId + ' nonstream: legacy partial none plan keeps literal text', { timeout: 2500 }, async t => {
    const h = { ...loadProduct(providerId), plan: { shouldParseResponse: false, toolChoiceMode: 'none' } }
    assertText(await consume(t, h, 'nonstream', LITERAL), LITERAL)
  })
}
