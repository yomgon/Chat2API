import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Execute the current first-party forwardQwenAi method and adapter with a
// fully synthetic transport. No real account, OS home, app or HTTP is loaded.
const source = rel => readFileSync(new URL('../../src/main/' + rel, import.meta.url), 'utf8')
const compile = (code, name) => ts.transpileModule(code, {
  fileName: name,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true },
}).outputText
const adapterCode = compile(source('proxy/adapters/qwen-ai.ts'), 'qwen-ai.ts')
const forwarderSource = source('proxy/forwarder.ts')
const ast = ts.createSourceFile('forwarder.ts', forwarderSource, ts.ScriptTarget.Latest, true)
const methods = []
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardQwenAi')
    methods.push(node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(methods.length, 1, 'Use exactly the production Qwen International method')
const forwarderCode = compile('class OfflineForwarder {' + methods[0] +
  '} exports.OfflineForwarder=OfflineForwarder', 'forwardQwenAi.ts')
const blocked = () => { throw Error('Unexpected real network, account, cleanup or retry effect') }

function load(code, name, dependencies, globals = {}) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, URL, Date, Math, Error,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      throw Error('Forbidden import in ' + name + ': ' + specifier)
    },
    ...globals,
  }, { filename: name, timeout: 1500 })
  return mod.exports
}

function harness() {
  const calls = [], submitted = []
  const axios = { create: () => ({
    async post(url, body, config) {
      calls.push({ url, body, config })
      if (calls.length === 1)
        return { status: 201, data: { data: { id: 'synthetic-model-session' } }, headers: {} }
      if (calls.length === 2)
        return { status: 401, data: { destroy() {} }, headers: {} }
      return blocked()
    },
    get: blocked, delete: blocked, request: blocked,
  }) }
  const product = load(adapterCode, 'qwen-ai.ts', {
    '../../providers/qwenAiToken': QWEN_AI_TOKEN_MODULE,
    axios: { __esModule: true, default: axios },
    stream: { PassThrough },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
  })
  const provider = { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai',
    modelMappings: { 'Qwen3.7-Plus': 'qwen3.7-plus', 'catalog-alias': 'overwritten-wire' } }
  const account = { id: 'synthetic-model-account', providerId: 'qwen-ai',
    credentials: { token: 'SYNTHETIC_MODEL_TOKEN_NOT_REAL' } }
  class ObservedAdapter extends product.QwenAiAdapter {
    async chatCompletion(request) {
      submitted.push(request)
      return super.chatCompletion(request)
    }
  }
  const { OfflineForwarder } = load(forwarderCode, 'forwardQwenAi.ts', {}, {
    QwenAiAdapter: ObservedAdapter,
    QwenAiProxyFailure: product.QwenAiProxyFailure,
    QwenAiStreamHandler: class { constructor() { blocked() } },
    safeWebErrorStatus: () => undefined,
    shouldDeleteSession: blocked,
    hasCompletedNonStreamAnswer: blocked,
    unconfirmedProviderCompletion: blocked,
  })
  const forwarder = new OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = req => ({ messages: req.messages, plan: {} })
  return { calls, submitted, forwarder, provider, account,
    adapter: new product.QwenAiAdapter(provider, account) }
}

for (const [label, display, wire, expectedThinking] of [
  ['catalog suffix is a literal wire ID', 'Qwen3.7-Plus-thinking', 'catalog-model-fast', true],
  ['catalog ID must not become a built-in alias', 'Synthetic Display Name', 'qwen', false],
  ['catalog ID must not be remapped a second time', 'Synthetic Display Name', 'catalog-alias', false],
]) {
  test('selected effective model is exact Qwen Intl web wire: ' + label, async () => {
    const h = harness()
    const response = await h.forwarder.forwardQwenAi({ model: display, stream: false,
      messages: [{ role: 'user', content: 'SYNTHETIC_TEXT_ONLY' }] },
    h.account, h.provider, wire, Date.now())
    assert.equal(response.success, false)
    assert.equal(response.status, 401, 'Known synthetic HTTP rejection only; never claim inference success')
    assert.equal(response.failureStage, 'chat-completion')
    assert.equal(h.calls.length, 2, 'Exactly one synthetic create and one completion, no retry')
    assert.equal(h.submitted.length, 1)
    assert.equal(h.calls[0].body.models[0], wire, 'Do not remap model during chat creation')
    assert.equal(h.calls[1].body.model, wire, 'Do not reinterpret exact wire model on completion')
    assert.equal(h.calls[1].body.messages[0].feature_config.thinking_enabled, expectedThinking)
    for (const request of h.calls) assert.equal(request.config.maxRedirects, 0)
  })
}

test('direct legacy Qwen Intl adapter callers may still map a display model', async () => {
  const h = harness()
  const failure = await h.adapter.chatCompletion({ model: 'Qwen3.7-Plus-thinking',
    messages: [{ role: 'user', content: 'SYNTHETIC_LEGACY_TEXT' }] }).catch(e => e)
  assert.equal(failure.stage, 'chat-completion')
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].body.models[0], 'qwen3.7-plus')
  assert.equal(h.calls[1].body.model, 'qwen3.7-plus')
  assert.equal(h.calls[1].body.messages[0].feature_config.thinking_enabled, true)
})
