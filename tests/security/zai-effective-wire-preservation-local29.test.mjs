import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual forwardChatCompletion -> forwardZai -> ZaiAdapter path.
// All authentication and POST replies are synthetic; completion always fails
// before decoding. No app, operating store, real credentials or HTTP is loaded.
const source = relative => readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8')
const compile = (relative) => {
  const result = ts.transpileModule(source(relative), { fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true } })
  assert.equal(result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
  return result.outputText
}
const adapterCode = compile('proxy/adapters/zai.ts')
const forwarderCode = compile('proxy/forwarder.ts')
const identityCode = compile('oauth/zaiSession.ts')
const PRIVATE = 'SYNTHETIC_ZAI_WIRE_PRIVATE_LOCAL29'
const SUBJECT = 'synthetic-wire-subject'
const jwtPart = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = [jwtPart({ alg: 'HS256', typ: 'JWT' }),
  jwtPart({ id: SUBJECT, email: 'synthetic@example.invalid', note: PRIVATE }), 'synthetic-signature'].join('.')

function harness(options = {}) {
  const calls = []
  const submitted = []
  const logs = []
  const state = { forbidden: 0, destroys: 0, posts: 0 }
  const blocked = () => {
    state.forbidden++
    throw new Error('Forbidden external effect, retry, cleanup, summary or import')
  }
  function load(code, name, dependencies) {
    const mod = { exports: {} }
    vm.runInNewContext(code, {
      module: mod, exports: mod.exports, Buffer, URL, URLSearchParams, Date, Math, Error,
      TextDecoder, setTimeout: blocked, clearTimeout: blocked,
      console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
        [level, (...args) => logs.push(args)])),
      require(specifier) {
        if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
        return blocked()
      },
    }, { filename: name, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
    return mod.exports
  }
  const identity = load(identityCode, 'zaiSession.ts', { crypto })
  const axios = {
    async get(url, config) {
      assert.equal(url, 'https://chat.z.ai/api/v1/auths/')
      calls.push({ method: 'GET', url, config })
      assert.equal(config.headers.Authorization, 'Bearer ' + token)
      return { status: options.authStatus ?? 200, headers: { 'content-type': 'application/json' },
        data: { id: SUBJECT, token } }
    },
    async post(url, body, config) {
      calls.push({ method: 'POST', url, body, config })
      state.posts++
      if (state.posts === 1) {
        assert.equal(url, 'https://chat.z.ai/api/v1/chats/new')
        return { status: options.createStatus ?? 201, data: { id: 'synthetic-wire-chat' }, headers: {} }
      }
      if (state.posts === 2) {
        assert.equal(new URL(url).origin, 'https://chat.z.ai')
        assert.equal(new URL(url).pathname, '/api/v2/chat/completions')
        return { status: 503, headers: {}, data: { destroy() { state.destroys++ } } }
      }
      return blocked()
    },
    delete: blocked, request: blocked,
    create: () => ({ get: blocked, post: blocked, delete: blocked, request: blocked }),
  }
  const product = load(adapterCode, 'zai.ts', {
    axios: { __esModule: true, default: axios }, crypto, stream: { PassThrough },
    'eventsource-parser': { createParser: blocked },
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': identity,
    '../promptToolUse': { hasToolUse: blocked, parseToolUse: blocked },
    '../utils/toolParser': { parseToolCallsFromText: blocked },
    '../utils/streamToolHandler': { createToolCallState: blocked,
      processStreamContent: blocked, flushToolCallBuffer: blocked, createBaseChunk: blocked },
  })
  class ObservedAdapter extends product.ZaiAdapter {
    async chatCompletion(request) {
      submitted.push(request)
      return super.chatCompletion(request)
    }
  }
  class Inert {
    static isDeepSeekProvider() { return false }
    static isGLMProvider() { return false }
    static isKimiProvider() { return false }
    static isQwenProvider() { return false }
    static isQwenAiProvider() { return false }
    static isMimoProvider() { return false }
    static isMiniMaxProvider() { return false }
    static isPerplexityProvider() { return false }
  }
  const forward = load(forwarderCode, 'forwarder.ts', {
    axios: { __esModule: true, default: axios }, http2: { __esModule: true, default: {} },
    stream: { PassThrough }, './status': { proxyStatusManager: {} },
    '../store/store': { storeManager: { getConfig: () => ({ retryCount: 5,
      contextManagement: { enabled: true }, toolCallingConfig: {} }) } },
    './adapters/deepseek': { DeepSeekAdapter: Inert },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: Inert },
    './adapters/glm': { GLMAdapter: Inert, GLMStreamHandler: Inert },
    './adapters/kimi': { KimiAdapter: Inert, KimiStreamHandler: Inert },
    './adapters/qwen': { QwenAdapter: Inert, QwenStreamHandler: Inert },
    './adapters/qwen-ai': { QwenAiAdapter: Inert, QwenAiStreamHandler: Inert },
    './adapters/mimo': { MimoAdapter: Inert, MimoStreamHandler: Inert },
    './adapters/minimax': { MiniMaxAdapter: Inert, MiniMaxStreamHandler: Inert },
    './adapters/perplexity': { PerplexityAdapter: Inert },
    './adapters/perplexity-stream': { PerplexityStreamHandler: Inert },
    './adapters/zai': { ...product, ZaiAdapter: ObservedAdapter,
      ZaiStreamHandler: class { constructor() { blocked() } } },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: blocked } },
    './streamTerminalGate': { hasCompletedNonStreamAnswer: blocked },
    './services/contextManagementService': { createContextManagementService: blocked },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class {
      transformRequest({ request }) {
        assert.equal(request.tools, undefined)
        return { messages: request.messages, plan: {} }
      }
    } },
  })
  const forwarder = new forward.RequestForwarder()
  forwarder.delay = blocked
  const provider = { id: 'zai', apiEndpoint: 'https://chat.z.ai',
    modelMappings: { 'Synthetic Display': 'unused-provider-mapping' } }
  const account = { id: 'synthetic-wire-account', providerId: 'zai', status: 'active', credentials: { token } }
  const messages = [{ role: 'user', content: 'SYNTHETIC_NONEMPTY_USER_MESSAGE' }]
  const requestFor = (model, flags = {}) => ({ model, messages, stream: false, ...flags })
  const send = (wire, display = 'Synthetic Display', flags = {}) => {
    const request = requestFor(display, flags)
    return forwarder.forwardChatCompletion(request, account, provider, wire,
      { requestId: 'synthetic-request', model: display, actualModel: wire,
        startTime: Date.now(), isStream: false })
  }
  return { send, calls, submitted, logs, state, requestFor,
    adapter: new product.ZaiAdapter(provider, account) }
}

function assertCreateWire(call, expected) {
  assert.equal(call.body.chat.models[0], expected, 'create-chat must preserve the selected model')
  const messages = Object.values(call.body.chat.history.messages)
  assert.equal(messages.length, 1, 'nonempty user content must create an actual history entry')
  assert.equal(messages[0].models[0], expected, 'history must preserve the same selected model')
}

function assertCompleteWire(h, expected) {
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST'])
  const history = Object.values(h.calls[1].body.chat.history.messages)
  assert.equal(history.length, 1, 'the actual create payload must contain user history')
  assert.deepEqual({ create: h.calls[1].body.chat.models[0],
    history: history.map(message => message.models[0]), completion: h.calls[2].body.model },
  { create: expected, history: [expected], completion: expected },
  'create, history and completion must all preserve the exact selected wire')
  assert.equal(h.calls[2].body.stream, true, 'upstream SSE contract is unchanged')
  for (const call of h.calls) assert.equal(call.config.maxRedirects, 0)
  assert.equal(h.state.destroys, 1)
  assert.equal(h.state.forbidden, 0, 'no retry, fallback, decoder, summary or cleanup after rejection')
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(JSON.stringify(h.logs).includes(token), false)
}

function assertForwardFailure(reply) {
  assert.equal(reply.success, false)
  assert.equal(reply.status, 503, 'synthetic completion rejection must remain a failure')
  assert.equal(reply.failureStage, 'chat-completion')
  assert.equal(JSON.stringify(reply).includes(PRIVATE), false)
}

for (const wire of ['glm-5.1', 'glm-5-turbo', 'GLM-5', 'gLm-5V-TuRbO',
  'Synthetic_Wire.v2', 'GLM-5.1', 'GLM-5v-Turbo', 'glm-5']) {
  test('actual forwarder preserves exact effective Z.ai wire ID: ' + wire, async () => {
    const h = harness()
    assertForwardFailure(await h.send(wire))
    assertCompleteWire(h, wire)
    assert.equal(h.submitted.length, 1)
    assert.equal(h.submitted[0].originalModel, 'Synthetic Display')
  })
}

for (const [legacy, expected] of [['glm-5.1', 'GLM-5.1'], ['GLM-5V-Turbo', 'GLM-5v-Turbo']]) {
  for (const resolvedModelId of [undefined, false]) {
    test('direct legacy adapter keeps mapping for ' + legacy + ', marker=' + resolvedModelId, async () => {
      const h = harness()
      const request = h.requestFor(legacy)
      if (resolvedModelId !== undefined) request.resolvedModelId = resolvedModelId
      const reply = await h.adapter.chatCompletion(request)
      assert.equal(reply.response.status, 503)
      assertCompleteWire(h, expected)
    })
  }
}

for (const [label, display, flags, search, thinking] of [
  ['infer search from original alias', 'Synthetic Display Search', {}, true, true],
  ['explicit false wins over alias', 'Synthetic Display Search', { web_search: false, reasoning_effort: false }, false, false],
  ['explicit true works without alias', 'Synthetic Display', { web_search: true, reasoning_effort: 'high' }, true, true],
]) {
  test('exact wire preserves originalModel option semantics: ' + label, async () => {
    const h = harness()
    assertForwardFailure(await h.send('Synthetic_Wire.v2', display, flags))
    assertCompleteWire(h, 'Synthetic_Wire.v2')
    assert.equal(h.submitted[0].originalModel, display)
    assert.equal(h.calls[2].body.features.auto_web_search, search)
    assert.equal(h.calls[2].body.features.enable_thinking, thinking)
  })
}

test('synthetic auth rejection still stops before any model POST', async () => {
  const h = harness({ authStatus: 403 })
  const reply = await h.send('glm-5.1')
  assert.equal(reply.success, false)
  assert.equal(reply.status, 403)
  assert.equal(reply.failureStage, 'auth-preflight')
  assert.deepEqual(h.calls.map(call => call.method), ['GET'])
  assert.equal(h.state.forbidden, 0)
})

test('synthetic create rejection does not retry or submit a completion', async () => {
  const h = harness({ createStatus: 429 })
  const reply = await h.send('Synthetic_Wire.v2')
  assert.equal(reply.success, false)
  assert.equal(reply.status, 429)
  assert.equal(reply.failureStage, 'chat-creation')
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST'])
  assertCreateWire(h.calls[1], 'Synthetic_Wire.v2')
  assert.equal(h.state.forbidden, 0)
})
