import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Actual products connected: /v1/chat/completions route -> forwardQwenAi ->
// QwenAiAdapter -> QwenAiStreamHandler -> shared terminal gate -> account
// counters/logs. The only transport is an in-memory synthetic Axios spy.
// Never load Electron, real store, real tokens, profiles, sockets or providers.
const read = file => readFileSync(new URL('../../src/main/proxy/' + file, import.meta.url), 'utf8')
const compile = (code, name) => ts.transpileModule(code, {
  fileName: name, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
const quiet = { log() {}, error() {}, warn() {}, info() {} }
function isolate(js, modules = {}, globals = {}, name = 'offline.js') {
  const mod = { exports: {} }
  vm.runInNewContext(js, {
    module: mod, exports: mod.exports, console: quiet,
    Buffer, TextDecoder, URL, URLSearchParams, Date, Math, Error, Promise,
    setTimeout, clearTimeout, ...globals,
    require(specifier) {
      if (Object.hasOwn(modules, specifier)) return modules[specifier]
      throw new Error('Forbidden offline dependency ' + name + ': ' + specifier)
    },
  }, { filename: name, timeout: 1500 })
  return mod.exports
}
const actualGate = isolate(compile(read('streamTerminalGate.ts'), 'streamTerminalGate.ts'),
  { stream: await import('node:stream') })
const forwardAst = ts.createSourceFile('forwarder.ts', read('forwarder.ts'), ts.ScriptTarget.Latest, true)
let selectedMethod
const walk = node => {
  if (ts.isMethodDeclaration(node) && node.name.getText(forwardAst) === 'forwardQwenAi') {
    selectedMethod = node.getText(forwardAst)
  }
  ts.forEachChild(node, walk)
}
walk(forwardAst)
assert.ok(selectedMethod, 'actual forwardQwenAi source required')
const forwardCode = compile('class SelectedForwarder { ' + selectedMethod +
  ' }\nexports.SelectedForwarder = SelectedForwarder', 'forwarder.ts')
const adapterCode = compile(read('adapters/qwen-ai.ts'), 'qwen-ai.ts')
const routeCode = compile(read('routes/chat.ts'), 'routes/chat.ts')

const assistantText = 'Confirmed synthetic assistant answer'
const finished = 'data: ' + JSON.stringify({
  choices: [{ delta: { role: 'assistant', phase: 'answer', status: 'finished', content: assistantText } }],
}) + '\n\n'
const unfinished = 'data: ' + JSON.stringify({
  choices: [{ delta: { role: 'assistant', phase: 'answer', status: 'streaming', content: assistantText } }],
}) + '\n\n'
const forbidden = () => { throw Error('No real network call permitted') }
const immediate = () => new Promise(resolve => setImmediate(resolve))
const plain = v => JSON.parse(JSON.stringify(v))

function fixture({ stream, completion = 'finished', cleanup = false, model = 'Qwen3.7-Plus',
  actualModel = 'qwen3.7-plus', reasoning_effort } = {}) {
  const events = []
  const counters = { start: 0, success: 0, fail: 0, stats: [], account: [],
    pending: [], updates: [], marked: 0, cleared: 0 }
  const raw = new PassThrough({ autoDestroy: false })
  const provider = {
    id: 'qwen-ai', name: 'Synthetic Qwen International',
    enabled: true, apiEndpoint: 'https://chat.qwen.ai',
  }
  const account = {
    id: 'synthetic-qwen-account-1', name: 'Synthetic test account',
    providerId: provider.id, status: 'active',
    credentials: { token: 'SYNTHETIC_TOKEN_ONLY_LOCAL25' },
  }
  const axiosClient = {
    async post(url, payload, config) {
      if (url.endsWith('/api/v2/chats/new')) {
        events.push({ type: 'create', config, payload })
        return { status: 200, data: { data: { id: 'synthetic-qwen-chat' } } }
      }
      if (url.includes('/api/v2/chat/completions?chat_id=')) {
        events.push({ type: 'completion', config, payload })
        return { status: completion === 'http401' ? 401 : 200, data: raw, headers: {} }
      }
      return forbidden()
    },
    async delete(url, config) {
      events.push({ type: 'delete', url, config })
      return { status: 200, data: { success: true } }
    },
    get: forbidden,
  }
  const qwen = isolate(adapterCode, {
    '../../providers/qwenAiToken': QWEN_AI_TOKEN_MODULE,
    axios: { __esModule: true, default: { create: () => axiosClient } },
    stream: { PassThrough },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
  }, {}, 'qwen-ai.ts')
  const forwardExports = isolate(forwardCode, {}, {
    QwenAiAdapter: qwen.QwenAiAdapter,
    QwenAiProxyFailure: qwen.QwenAiProxyFailure,
    QwenAiStreamHandler: qwen.QwenAiStreamHandler,
    shouldDeleteSession: () => cleanup,
    hasCompletedNonStreamAnswer: actualGate.hasCompletedNonStreamAnswer,
    unconfirmedProviderCompletion: latency => ({
      success: false, status: 502, error: 'Provider completion was not confirmed',
      failureStage: 'response-decoding', failureCode: 'provider_completion_unconfirmed', latency,
    }),
    safeWebErrorStatus: e => {
      const status = e?.response?.status
      return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined
    },
  }, 'forwarder.ts')
  const fwd = new forwardExports.SelectedForwarder()
  fwd.transformRequestForPromptToolUse = request => ({
    messages: request.messages, plan: {}, tools: undefined,
  })
  fwd.extractHeaders = () => ({})
  fwd.applyToolCallsToResponse = () => {}

  const routes = {}
  class Router { post(path, handler) { routes[path] = handler } }
  isolate(routeCode, {
    '@koa/router': { __esModule: true, default: Router },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel }),
      markAccountFailed: () => counters.marked++,
      clearAccountFailure: () => counters.cleared++,
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: async (request, selected, selectedProvider, wireModel) => {
        assert.equal(selected.id, account.id)
        assert.equal(selectedProvider.id, provider.id)
        assert.equal(wireModel, actualModel)
        return fwd.forwardQwenAi(request, selected, selectedProvider, wireModel, Date.now())
      },
    } },
    '../stream': { streamHandler: { createTransformStream: forbidden } },
    '../streamTerminalGate': actualGate,
    '../status': { proxyStatusManager: {
      recordRequestStart: () => counters.start++,
      recordRequestSuccess: () => counters.success++,
      recordRequestFailure: () => counters.fail++,
    } },
    '../../store/store': { storeManager: {
      getConfig: () => ({ retryCount: 8, loadBalanceStrategy: 'failover' }),
      recordAccountSuccess: (...args) => { counters.account.push(args); return true },
      addLog() {},
      addRequestLog: entry => {
        counters.pending.push(entry)
        return { id: 'synthetic-log' + counters.pending.length }
      },
      updateRequestLog: (_id, change) => counters.updates.push(change),
      recordRequestInStats: value => counters.stats.push(value),
    } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: forbidden,
      transformChunkToAnthropic: forbidden,
    },
  }, {}, 'routes/chat.ts')
  assert.equal(typeof routes['/completions'], 'function')
  const ctx = {
    status: 200, headers: {}, ip: '127.0.0.1',
    res: { headersSent: false }, responseHeaders: {},
    request: { body: {
      model, stream, messages: [{ role: 'user', content: 'synthetic user text' }],
      ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
    } },
    set(name, value) { this.responseHeaders[name] = value },
  }
  return { raw, ctx, counters, events, invoke: () => routes['/completions'](ctx) }
}

async function settle(h, mode) {
  const running = h.invoke()
  for (let i = 0; i < 10 && !h.events.some(e => e.type === 'completion'); i++) await immediate()
  assert.equal(h.events.filter(e => e.type === 'create').length, 1)
  assert.equal(h.events.filter(e => e.type === 'completion').length, 1)
  assert.equal(h.events.filter(e => e.type === 'delete').length, 0)
  if (mode === 'http401') {
    await running
    return { ...h, body: plain(h.ctx.body) }
  }
  let streamWire
  if (h.ctx.request.body.stream) {
    await running
    assert.equal(typeof h.ctx.body?.on, 'function')
    const chunks = []
    streamWire = new Promise(resolve => {
      h.ctx.body.on('data', value => chunks.push(value.toString()))
      h.ctx.body.once('end', () => resolve(chunks.join('')))
    })
  }
  h.raw.end(mode === 'finished' ? finished : unfinished)
  await running
  const wire = streamWire ? await streamWire : undefined
  return { ...h, wire, body: h.ctx.request.body.stream ? undefined : plain(h.ctx.body) }
}

for (const stream of [false, true]) {
  test('real route+forwarder+Qwen adapter ' + (stream ? 'stream' : 'nonstream') +
    ' completed answer settles exactly once', async () => {
    const h = fixture({ stream, reasoning_effort: false })
    const done = await settle(h, 'finished')
    assert.equal(done.ctx.status, 200)
    assert.equal(done.counters.start, 1)
    assert.equal(done.counters.success, 1)
    assert.equal(done.counters.fail, 0)
    assert.deepEqual(done.counters.stats, [true])
    assert.equal(done.counters.account.length, 1)
    assert.equal(done.counters.updates.length, stream ? 1 : 0)
    if (stream) {
      assert.match(done.wire, /Confirmed synthetic assistant answer/)
      assert.equal((done.wire.match(/data: \[DONE\]/g) || []).length, 1)
    } else {
      assert.equal(done.body.choices[0].message.content, assistantText)
      assert.equal(done.body.choices[0].finish_reason, 'stop')
    }
    assert.equal(done.events[0].type, 'create')
    assert.equal(done.events[1].type, 'completion')
    assert.equal(done.events[0].config.maxRedirects, 0)
    assert.equal(done.events[1].config.maxRedirects, 0)
    assert.equal(done.events[1].payload.messages[0].feature_config.thinking_enabled, false)
    assert.equal(done.events.length, 2, 'no unapproved cleanup or retry')
  })
  test('real route+forwarder+Qwen adapter ' + (stream ? 'stream' : 'nonstream') +
    ' partial EOF fails without account success or [DONE]', async () => {
    const done = await settle(fixture({ stream }), 'unfinished')
    assert.equal(done.counters.success, 0)
    assert.equal(done.counters.fail, 1)
    assert.deepEqual(done.counters.stats, [false])
    assert.equal(done.counters.account.length, 0)
    assert.equal(done.events.length, 2)
    if (stream) {
      assert.equal(done.wire.includes('data: [DONE]'), false)
      assert.equal(done.wire.includes('"error"'), true)
    } else {
      assert.equal(done.ctx.status, 502)
      assert.equal(done.body.error.message, 'Provider request failed')
    }
  })
  test('real route+forwarder+Qwen adapter ' + (stream ? 'stream' : 'nonstream') +
    ' upstream HTTP 401 fails with no decoder cleanup or retry', async () => {
    const h = fixture({ stream, completion: 'http401' })
    const done = await settle(h, 'http401')
    assert.equal(done.ctx.status, 401)
    assert.equal(done.counters.success, 0)
    assert.equal(done.counters.fail, 1)
    assert.deepEqual(done.counters.stats, [false])
    assert.equal(done.counters.account.length, 0)
    assert.equal(done.events.length, 2)
  })
}

test('Qwen real route streaming optional cleanup remains a separate post-success delete', async () => {
  const done = await settle(fixture({ stream: true, cleanup: true }), 'finished')
  await immediate()
  assert.equal(done.counters.success, 1)
  const deletes = done.events.filter(x => x.type === 'delete')
  assert.equal(deletes.length, 1, 'only one independently configured remote delete')
  assert.equal(deletes[0].config.maxRedirects, 0)
  assert.equal(done.events.length, 3)
})
