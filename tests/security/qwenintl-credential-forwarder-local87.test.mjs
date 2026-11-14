import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'

// Execute the current first-party forwardQwenAi method and adapter with a
// fully synthetic transport. No real account, OS home, app or HTTP is loaded.
const source = rel => readFileSync(new URL('../../src/main/' + rel, import.meta.url), 'utf8')
const compile = (code, name) => ts.transpileModule(code, {
  fileName: name,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true },
}).outputText
const adapterCode = compile(source('proxy/adapters/qwen-ai.ts'), 'qwen-ai.ts')
const tokenCode = compile(source('providers/qwenAiToken.ts'), 'qwenAiToken.ts')
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

function harness(credentials = { token: 'SYNTHETIC_MODEL_TOKEN_NOT_REAL' }) {
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
  const tokenModule = load(tokenCode, 'qwenAiToken.ts', {})
  const product = load(adapterCode, 'qwen-ai.ts', {
    axios: { __esModule: true, default: axios },
    stream: { PassThrough },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../../providers/qwenAiToken': tokenModule,
  })
  const provider = { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai',
    modelMappings: { 'Qwen3.7-Plus': 'qwen3.7-plus', 'catalog-alias': 'overwritten-wire' } }
  const account = { id: 'synthetic-model-account', providerId: 'qwen-ai', credentials }
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

for (const [label, credentials, selected] of [
  ['manual OAuth canonical token', { token: 'OFFLINE_LOCAL87_CANONICAL' }, 'OFFLINE_LOCAL87_CANONICAL'],
  ['persisted legacy accessToken', { accessToken: 'OFFLINE_LOCAL87_ACCESS' }, 'OFFLINE_LOCAL87_ACCESS'],
  ['persisted legacy apiKey', { apiKey: 'OFFLINE_LOCAL87_APIKEY' }, 'OFFLINE_LOCAL87_APIKEY'],
  ['blank canonical falls back to accessToken',
    { token: '', accessToken: 'OFFLINE_LOCAL87_SECONDARY' }, 'OFFLINE_LOCAL87_SECONDARY'],
  ['valid first nonempty token wins without switching identity',
    { token: 'OFFLINE_LOCAL87_FIRST', accessToken: 'OFFLINE_LOCAL87_OTHER' }, 'OFFLINE_LOCAL87_FIRST'],
]) {
  test('actual Qwen Intl forwarder and consumer adapter pin ' + label + ' across create/completion', async () => {
    const h = harness(credentials)
    const result = await h.forwarder.forwardQwenAi({
      model: 'Synthetic Display Name', stream: false,
      messages: [{ role: 'user', content: 'LOCAL87_OFFLINE_NO_PROVIDER_EFFECT' }],
    }, h.account, h.provider, 'wire-exact-87', Date.now())
    assert.equal(result.success, false)
    assert.equal(result.status, 401)
    assert.equal(result.failureStage, 'chat-completion')
    assert.equal(h.calls.length, 2, 'One synthetic chat creation + one completion; retry0')
    assert.equal(h.submitted.length, 1)
    assert.equal(h.calls[0].body.models[0], 'wire-exact-87')
    assert.equal(h.calls[1].body.model, 'wire-exact-87')
    for (const { config } of h.calls) {
      assert.equal(config.headers.Authorization, 'Bearer ' + selected)
      assert.equal(config.maxRedirects, 0)
      assert.equal(Object.keys(config.headers).some(k => k.toLowerCase() === 'cookie'), false)
    }
    assert.equal(JSON.stringify(result).includes(selected), false)
    assert.deepEqual(h.account.credentials, credentials, 'No account mutation on upstream failure')
  })
}

for (const [label, credentials] of [
  ['malformed primary token', { token: { secret: 'PRIVATE' }, accessToken: 'VALID_SECONDARY' }],
  ['CRLF credential', { token: 'header\r\nInjected: 1' }],
  ['missing all token fields', {}],
]) {
  test('Qwen Intl refuses ' + label + ' before chat creation or completion with safe provenance', async () => {
    const h = harness(credentials)
    const result = await h.forwarder.forwardQwenAi({
      model: 'Synthetic Display Name', stream: true,
      messages: [{ role: 'user', content: 'LOCAL87_OFFLINE_REFUSAL' }],
    }, h.account, h.provider, 'wire-exact-87', Date.now())
    assert.equal(result.success, false)
    assert.equal(result.failureStage, 'auth-preflight')
    assert.equal(h.calls.length, 0)
    assert.equal(h.submitted.length, 1)
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  })
}
