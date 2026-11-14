import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import crypto from 'node:crypto'
import path from 'node:path'

// Actual /v1/chat/completions + forwardGLM + GLMAdapter attachment validation.
// Every external capability is a forbidden synthetic mock; there is no real
// network/credential, operating store, OAuth, Electron or native process.
const source = file => readFileSync(new URL('../../src/main/proxy/' + file, import.meta.url), 'utf8')
const compile = (code, name) => ts.transpileModule(code, {
  fileName: name, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
const quiet = { log() {}, error() {}, warn() {}, info() {} }
function run(code, imports = {}, globals = {}, name = 'source.js') {
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    Buffer, URL, URLSearchParams, TextDecoder, Promise, Date, Math, Error,
    setTimeout, clearTimeout, console: quiet, ...globals,
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      throw new Error('No real module allowed: ' + name)
    },
  }, { filename: name, timeout: 1500 })
  return module.exports
}
const ast = ts.createSourceFile('forwarder.ts', source('forwarder.ts'), ts.ScriptTarget.Latest, true)
let selected
const visit = node => {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardGLM') selected = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(selected)
const forwardSource = compile('class OfflineForwarder {' + selected +
  '}\nexports.OfflineForwarder = OfflineForwarder', 'forwarder.ts')
const adapterSource = compile(source('adapters/glm.ts'), 'glm.ts')
const routeSource = compile(source('routes/chat.ts'), 'chat.ts')
const terminal = run(compile(source('streamTerminalGate.ts'), 'streamTerminalGate.ts'),
  { stream: { PassThrough } })
const sample = [
  { type: 'text', text: 'Inspect synthetic attachment' },
  { type: 'image_url', image_url: { url: 'https://127.0.0.1/private?key=SYNTHETIC_LOCAL_ONLY' } },
]

function setup(stream, parts = sample) {
  const effects = []
  const accounting = { started: 0, success: 0, failed: 0, stats: [],
    account: 0, cleaned: 0, marked: 0, cleared: 0, receipts: [] }
  const blocked = type => () => {
    effects.push(type)
    throw new Error('SYNTHETIC_PRIVATE_CAPABILITY_FORBIDDEN_LOCAL25')
  }
  const adapter = run(adapterSource, {
    axios: { __esModule: true, default: {
      get: blocked('get'), post: blocked('post'), delete: blocked('delete'),
    } },
    crypto, path, stream: { PassThrough },
    'mime-types': {}, 'form-data': { __esModule: true, default: class {} },
    'eventsource-parser': { createParser: blocked('parser') },
    '../../store/store': { storeManager: { updateAccount: blocked('store-write') } },
    '../utils/tools': {
      toolsToSystemPrompt: blocked('tool-prompt'),
      TOOL_WRAP_HINT: '', hasToolPromptInjected: () => false,
    },
    '../utils/toolParser': { parseToolCallsFromText: blocked('tool-calls') },
    '../utils/streamToolHandler': { createBaseChunk: blocked('stream-chunk') },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
    'node:dns/promises': { lookup: blocked('dns') },
    'node:https': { Agent: class {} },
  }, {}, 'glm.ts')
  adapter.GLMAdapter.prototype.acquireToken = blocked('auth')
  class NoHandler { constructor() { accounting.cleaned++ } }
  const forward = run(forwardSource, {}, {
    GLMAdapter: adapter.GLMAdapter,
    GLMAttachmentInputFailure: adapter.GLMAttachmentInputFailure,
    GLMStreamHandler: NoHandler,
    shouldDeleteSession: () => true,
    hasCompletedNonStreamAnswer: terminal.hasCompletedNonStreamAnswer,
    unconfirmedProviderCompletion: latency => ({
      success: false, status: 502, error: 'Unconfirmed', latency,
    }),
  }, 'forwarder.ts')
  const fwd = new forward.OfflineForwarder()
  fwd.transformRequestForPromptToolUse = request => ({
    messages: request.messages, plan: {}, tools: undefined,
  })
  fwd.applyToolCallsToResponse = blocked('tool-result')
  fwd.extractHeaders = () => ({})
  const provider = { id: 'glm', name: 'Synthetic GLM', enabled: true,
    apiEndpoint: 'https://chatglm.cn/chatglm' }
  const account = { id: 'synthetic-glm-account', providerId: 'glm',
    credentials: { refresh_token: 'SYNTHETIC_REFRESH' }, status: 'active' }
  const routes = {}
  class Router { post(path, handler) { routes[path] = handler } }
  run(routeSource, {
    '@koa/router': { __esModule: true, default: Router },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-glm-model' }),
      clearAccountFailure: () => accounting.cleared++,
      markAccountFailed: () => accounting.marked++,
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: (request, currentAccount, currentProvider, wireModel) => {
        assert.equal(currentAccount.id, account.id)
        assert.equal(currentProvider.id, provider.id)
        return fwd.forwardGLM(request, currentAccount, currentProvider, wireModel, Date.now())
      },
    } },
    '../stream': { streamHandler: { createTransformStream: blocked('normalize') } },
    '../streamTerminalGate': terminal,
    '../status': { proxyStatusManager: {
      recordRequestStart: () => accounting.started++,
      recordRequestSuccess: () => accounting.success++,
      recordRequestFailure: () => accounting.failed++,
    } },
    '../../store/store': { storeManager: {
      getConfig: () => ({ retryCount: 0 }),
      addLog() {},
      addRequestLog: entry => {
        accounting.receipts.push(entry)
        return { id: 'synthetic-log' }
      },
      recordAccountSuccess: () => accounting.account++,
      recordRequestInStats: ok => accounting.stats.push(ok),
      updateRequestLog: blocked('update-log'),
    } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: blocked('anthropic'),
      transformChunkToAnthropic: blocked('anthropic'),
    },
  }, {}, 'routes/chat.ts')
  assert.equal(typeof routes['/completions'], 'function')
  const ctx = {
    status: 200, ip: '127.0.0.1', headers: {}, res: { headersSent: false },
    request: { body: {
      model: 'synthetic-glm-display',
      messages: [{ role: 'user', content: parts }],
      stream,
    } },
    set() {},
  }
  return { effects, accounting, ctx, invoke: () => routes['/completions'](ctx) }
}

for (const stream of [false, true]) {
  test('GLM real route ' + (stream ? 'stream' : 'nonstream') +
    ' refuses private attachment before auth, GET, upload or completion', async () => {
    const h = setup(stream)
    await h.invoke()
    assert.equal(h.ctx.status, 400)
    assert.equal(h.ctx.body?.error?.code, 'glm_attachment_invalid_input')
    assert.equal(typeof h.ctx.body?.on, 'undefined', 'preflight failed before any response stream')
    assert.equal(h.ctx.body?.error?.message, 'Provider request failed')
    assert.deepEqual(h.effects, [])
    assert.equal(h.accounting.started, 1)
    assert.equal(h.accounting.success, 0)
    assert.equal(h.accounting.failed, 1)
    assert.deepEqual(h.accounting.stats, [false])
    assert.equal(h.accounting.account, 0)
    assert.equal(h.accounting.cleaned, 0)
    assert.equal(h.accounting.cleared, 0)
    assert.equal(h.accounting.marked, 0, 'invalid local input must not penalize a healthy provider account')
    assert.equal(JSON.stringify(h.ctx.body).includes('SYNTHETIC_LOCAL_ONLY'), false)
  })
  test('GLM real route ' + (stream ? 'stream' : 'nonstream') +
    ' refuses a later invalid attachment without prior valid upload', async () => {
    const h = setup(stream, [
      { type: 'text', text: 'Synthetic' },
      { type: 'file', file_url: { url: 'data:text/plain;base64,aGVsbG8=' } },
      { type: 'image_url', image_url: { url: 'http://internal.invalid/private' } },
    ])
    await h.invoke()
    assert.equal(h.ctx.status, 400)
    assert.equal(h.ctx.body?.error?.code, 'glm_attachment_invalid_input')
    assert.deepEqual(h.effects, [])
    assert.deepEqual(h.accounting.stats, [false])
    assert.equal(h.accounting.account, 0)
    assert.equal(h.accounting.cleaned, 0)
    assert.equal(h.accounting.marked, 0, 'invalid local input must not count as account failure')
  })
}
