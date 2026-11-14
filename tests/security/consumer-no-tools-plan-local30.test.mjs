import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { createRequire } from 'node:module'
import { PassThrough, Transform, Readable } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Actual full forwarder, production tool plan, response handlers and parsers.
// Only adapter transport replies are synthetic. No app, credentials, operating
// store, HTTP, cleanup, retry or context-summary implementation can be loaded.
const files = [
  'src/main/proxy/forwarder.ts',
  'src/main/proxy/adapters/qwen-ai.ts',
  'src/main/providers/qwenAiToken.ts',
  'src/main/proxy/adapters/zai.ts',
  'src/main/proxy/promptToolUse.ts',
  'src/main/proxy/streamTerminalGate.ts',
  'src/shared/toolCalling.ts',
  'src/main/proxy/toolCalling/ToolCallingEngine.ts',
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
const compiled = new Map(files.map(file => {
  const result = ts.transpileModule(readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), {
    fileName: file, reportDiagnostics: true, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  })
  assert.equal(result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
  return [file, result.outputText]
}))
const requireNode = createRequire(import.meta.url)
const eventsource = requireNode('eventsource-parser')
const XML = '<tool_use><name>lookup</name><arguments>{"query":"synthetic"}</arguments></tool_use>'
const ORDINARY = 'Ordinary synthetic assistant answer 한글'
const PRIVATE = 'SYNTHETIC_NO_TOOLS_PRIVATE_LOCAL30'
const DECLARED = [{ type: 'function', function: {
  name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' },
} }]
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n'

function harness(providerId, config = {}) {
  const cache = new Map(), plans = [], applied = [], calls = [], effects = [], logs = [], timers = []
  const raw = new PassThrough({ autoDestroy: false })
  const forbidden = () => {
    effects.push('forbidden capability')
    throw new Error('Forbidden local30 external effect or import')
  }
  const axios = { get: forbidden, post: forbidden, delete: forbidden, request: forbidden,
    create: () => ({ get: forbidden, post: forbidden, delete: forbidden, request: forbidden }) }
  const common = {
    axios: { __esModule: true, default: axios },
    stream: { PassThrough, Transform, Readable },
    crypto: {},
    'eventsource-parser': eventsource,
    'form-data': { __esModule: true, default: class FormData {} },
  }
  const adapterStubs = {
    '../../oauth/zaiSession': { readZaiSessionClaims: forbidden, readZaiTokenIdentity: forbidden },
    '../utils/toolParser': { parseToolCallsFromText: forbidden },
    // This obsolete constructor state is unused by the active Z.ai handlers.
    '../utils/streamToolHandler': { createToolCallState: () => ({}),
      processStreamContent: forbidden, flushToolCallBuffer: forbidden, createBaseChunk: forbidden },
  }
  let forwardDependencies
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    assert.ok(compiled.has(file), 'unapproved source dependency: ' + file)
    const module = { exports: {} }
    cache.set(file, module)
    vm.runInNewContext(compiled.get(file), {
      module, exports: module.exports, Buffer, TextDecoder, URL, URLSearchParams, Date, Math, Error,
      console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [
        level, (...args) => logs.push(args),
      ])),
      setTimeout(callback, delay) {
        assert.equal(delay, 60000, 'only the real Z.ai decoder deadline is expected')
        const timer = { callback, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimeout(timer) { timer.cleared = true },
      require(name) {
        if (file === files[0] && Object.hasOwn(forwardDependencies, name)) return forwardDependencies[name]
        if (Object.hasOwn(common, name)) return common[name]
        if (file === 'src/main/proxy/adapters/zai.ts' && Object.hasOwn(adapterStubs, name)) {
          return adapterStubs[name]
        }
        if (!name.startsWith('.')) return forbidden()
        let target = posix.normalize(posix.join(posix.dirname(file), name))
        if (!target.endsWith('.ts')) target += '.ts'
        return load(target)
      },
    }, { filename: file, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
    return module.exports
  }

  const qwen = load('src/main/proxy/adapters/qwen-ai.ts')
  const zai = load('src/main/proxy/adapters/zai.ts')
  const gate = load('src/main/proxy/streamTerminalGate.ts')
  const engine = load('src/main/proxy/toolCalling/ToolCallingEngine.ts')
  class ObservedEngine extends engine.ToolCallingEngine {
    transformRequest(input) {
      const result = super.transformRequest(input)
      plans.push(result.plan)
      return result
    }
    applyNonStreamResponse(result, plan) {
      applied.push(plan)
      return super.applyNonStreamResponse(result, plan)
    }
  }
  class SyntheticAdapter {
    async chatCompletion(request) {
      calls.push(request)
      return { response: { status: 200, headers: {}, data: raw },
        chatId: 'synthetic-chat', parentId: null, requestId: 'synthetic-request' }
    }
    async deleteChat() { return forbidden() }
  }
  class SyntheticQwen extends SyntheticAdapter {
    static isQwenAiProvider(provider) { return provider.id === 'qwen-ai' }
  }
  class SyntheticZai extends SyntheticAdapter {
    static isZaiProvider(provider) { return provider.id === 'zai' }
  }
  class Inert {
    static isDeepSeekProvider() { return false }
    static isGLMProvider() { return false }
    static isKimiProvider() { return false }
    static isQwenProvider() { return false }
    static isMimoProvider() { return false }
    static isMiniMaxProvider() { return false }
    static isPerplexityProvider() { return false }
  }
  forwardDependencies = {
    http2: { __esModule: true, default: {} },
    './status': { proxyStatusManager: {} },
    '../store/store': { storeManager: { getConfig: () => ({
      retryCount: 5, contextManagement: { enabled: true }, toolCallingConfig: config,
    }) } },
    './adapters/deepseek': { DeepSeekAdapter: Inert },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: Inert },
    './adapters/glm': { GLMAdapter: Inert, GLMStreamHandler: Inert },
    './adapters/kimi': { KimiAdapter: Inert, KimiStreamHandler: Inert },
    './adapters/qwen': { QwenAdapter: Inert, QwenStreamHandler: Inert },
    './adapters/mimo': { MimoAdapter: Inert, MimoStreamHandler: Inert },
    './adapters/minimax': { MiniMaxAdapter: Inert, MiniMaxStreamHandler: Inert },
    './adapters/perplexity': { PerplexityAdapter: Inert },
    './adapters/perplexity-stream': { PerplexityStreamHandler: Inert },
    './adapters/qwen-ai': { ...qwen, QwenAiAdapter: SyntheticQwen },
    './adapters/zai': { ...zai, ZaiAdapter: SyntheticZai },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => false } },
    './streamTerminalGate': gate,
    './services/contextManagementService': { createContextManagementService: forbidden },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: ObservedEngine },
  }
  const product = load(files[0])
  const forwarder = new product.RequestForwarder()
  forwarder.delay = forbidden
  return { raw, plans, applied, calls, effects, logs, timers, gate, forwarder,
    Handler: providerId === 'zai' ? zai.ZaiStreamHandler : qwen.QwenAiStreamHandler }
}

function fixture(provider, text, failure) {
  const answer = role => provider === 'zai'
    ? sse({ type: 'chat:completion', data: { phase: 'answer', role, delta_content: text } })
    : sse({ choices: [{ index: 0, delta: { role, phase: 'answer', status: 'streaming', content: text } }] })
  const terminal = provider === 'zai'
    ? sse({ type: 'chat:completion', data: { phase: 'done', done: true } })
    : sse({ choices: [{ index: 0, delta: { phase: 'answer', status: 'finished', content: '' },
      finish_reason: 'stop' }] })
  if (failure === 'malformed JSON') return answer('assistant') + 'data: {broken ' + PRIVATE + '}\n\n'
  if (failure === 'nonassistant') return answer('user') + terminal
  if (failure === 'missing terminal') return answer('assistant')
  const complete = answer('assistant') + terminal + 'data: [DONE]\n\n'
  if (failure === 'late error') return complete + sse({ error: { message: PRIVATE } })
  return complete
}

function viewJson(reply) {
  const choice = reply.choices[0]
  return { content: choice.message.content, calls: choice.message.tool_calls, finish: choice.finish_reason }
}
function viewStream(wire) {
  const records = wire.split('\n\n').filter(frame => frame.startsWith('data: {'))
    .map(frame => JSON.parse(frame.slice(6)))
  const choices = records.flatMap(record => record.choices ?? [])
  const finishes = choices.filter(choice => choice.finish_reason != null)
  const calls = choices.flatMap(choice => choice.delta?.tool_calls ?? [])
  return { records, finishes, content: choices.map(choice => choice.delta?.content ?? '').join(''),
    calls: calls.length ? calls : undefined, finish: finishes.at(-1)?.finish_reason }
}

async function consume(t, provider, mode, scenario = {}, failure, direct = false) {
  const h = harness(provider, scenario.config)
  const terminals = []
  let wire = '', output, settled = false
  const request = { model: 'synthetic-display', messages: [
    { role: 'user', content: 'Quote the example as ordinary text.' },
  ], stream: mode === 'stream', ...scenario.request }
  t.after(() => { output?.destroy(); h.raw.destroy() })
  const handler = direct ? new h.Handler('synthetic-wire') : null
  handler?.setChatId('synthetic-chat')
  const pending = (direct
    ? mode === 'stream' ? handler.handleStream(h.raw).then(stream => ({ success: true, stream }))
      : handler.handleNonStream(h.raw).then(body => ({ success: true, body }))
    : h.forwarder.forwardChatCompletion(request,
      { id: 'synthetic-account', providerId: provider, status: 'active', credentials: {} },
      { id: provider }, 'synthetic-wire',
      { requestId: 'synthetic-request', model: request.model, actualModel: 'synthetic-wire',
        startTime: Date.now(), isStream: request.stream }))
    .then(reply => { settled = true; return reply })
  let reply, finished
  if (mode === 'stream') {
    reply = await pending
    assert.equal(reply.success, true)
    output = h.gate.createOpenAIStreamTerminalGate(reply.stream, success => terminals.push(success))
    finished = new Promise((resolve, reject) => {
      output.on('data', bytes => { wire += bytes.toString('utf8') })
      output.once('end', resolve)
      output.once('error', reject)
    })
  } else {
    await nextTurn()
  }
  assert.ok(h.raw.listenerCount('data') > 0, 'real consumer must be attached before synthetic input')
  if (!direct) {
    assert.equal(h.plans.length, 1)
    assert.equal(h.plans[0].mode, scenario.planMode ?? 'disabled')
    if (scenario.reason) assert.equal(h.plans[0].diagnostics.reason, scenario.reason)
    if (h.plans[0].mode === 'disabled') assert.equal(h.plans[0].shouldParseResponse, false)
    assert.equal(h.calls.length, 1, 'exactly one synthetic completion, even with retryCount=5')
    assert.equal(h.calls[0].model, 'synthetic-wire')
    assert.equal(h.calls[0].resolvedModelId, true)
  }

  h.raw.write(Buffer.from(fixture(provider, scenario.text ?? XML, failure)))
  if (!failure) {
    await nextTurn()
    if (mode === 'nonstream') assert.equal(settled, false, 'native terminal must await clean EOF')
    else {
      assert.deepEqual(terminals, [])
      assert.equal(wire.includes('data: [DONE]'), false)
      assert.equal(viewStream(wire).finishes.length, 0)
    }
  }
  if (failure === 'close before EOF') h.raw.destroy()
  else h.raw.end()
  if (mode === 'stream') await finished
  else reply = await pending
  assert.deepEqual(h.effects, [])
  assert.equal(h.timers.every(timer => timer.cleared), true)
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(JSON.stringify({ body: reply.body, error: reply.error }).includes(PRIVATE), false)
  if (!direct) assert.equal(h.calls.length, 1, 'no replay after success or failure')
  if (failure) {
    if (mode === 'nonstream') {
      assert.equal(reply.success, false)
      assert.equal(reply.status, 502)
      assert.equal(reply.failureStage, 'response-decoding')
      assert.equal(reply.body, undefined)
    } else {
      assert.deepEqual(terminals, [false])
      assert.equal(viewStream(wire).calls, undefined, 'errors must not leak fabricated tool calls')
      assert.equal(viewStream(wire).finishes.length, 0)
      assert.equal(wire.includes('data: [DONE]'), false)
      assert.equal(wire.includes(PRIVATE), false)
      assert.equal(viewStream(wire).records.some(record => record.error), true)
    }
    return
  }
  assert.equal(reply.success, true)
  if (mode === 'nonstream') {
    if (!direct) {
      assert.equal(h.applied.length, 1, 'actual response postprocessing must run')
      assert.equal(h.applied[0], h.plans[0])
    }
    return viewJson(reply.body)
  }
  assert.deepEqual(terminals, [true])
  assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1)
  const view = viewStream(wire)
  assert.equal(view.finishes.length, 1)
  assert.equal(view.records.some(record => record.error), false)
  return view
}

function assertText(result, text = XML) {
  assert.equal(result.finish, 'stop', 'ordinary quoted content must remain a text completion')
  assert.equal(result.content, text)
  assert.equal(result.calls, undefined, 'no undeclared tool-call response is allowed')
}
function assertLegacy(result) {
  assert.equal(result.finish, 'tool_calls')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].function.name, 'lookup')
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { query: 'synthetic' })
}

const disabled = [
  { label: 'omitted tools', reason: 'no_tools' },
  { label: 'empty tools', request: { tools: [] }, reason: 'no_tools' },
  { label: 'mode off', request: { tools: DECLARED }, config: { mode: 'off' }, reason: 'mode_off' },
  { label: 'enabled false', request: { tools: DECLARED }, config: { enabled: false }, reason: 'mode_off' },
]
for (const provider of ['qwen-ai', 'zai']) {
  for (const mode of ['nonstream', 'stream']) {
    for (const scenario of disabled) {
      test(provider + ' ' + mode + ': real disabled plan keeps XML text for ' + scenario.label,
        { timeout: 2000 }, async t => assertText(await consume(t, provider, mode, scenario)))
    }
    test(provider + ' ' + mode + ': explicit none with declared tools stays text',
      { timeout: 2000 }, async t => assertText(await consume(t, provider, mode, {
        request: { tools: DECLARED, tool_choice: 'none' }, reason: 'tool_choice_none',
      })))
    test(provider + ' ' + mode + ': ordinary text still completes',
      { timeout: 2000 }, async t => assertText(await consume(t, provider, mode, {
        text: ORDINARY, reason: 'no_tools',
      }), ORDINARY))
    test(provider + ' ' + mode + ': direct legacy default remains compatible',
      { timeout: 2000 }, async t => {
        const result = await consume(t, provider, mode, {}, undefined, true)
        if (provider === 'zai' && mode === 'nonstream') assertText(result)
        else assertLegacy(result)
      })
    for (const failure of ['malformed JSON', 'nonassistant', 'missing terminal', 'late error', 'close before EOF']) {
      test(provider + ' ' + mode + ': disabled plan preserves failure for ' + failure,
        { timeout: 2000 }, async t => consume(t, provider, mode, { reason: 'no_tools' }, failure))
    }
  }
}
