import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'
import { ZAI_SESSION_MODULE } from './helpers/zaiSessionModule.mjs'

// Actual product adapter, forwardQwenAi method and public ProviderChecker entry.
// Every transport is synthetic; imports cannot reach an app, profile or network.
const source = rel => readFileSync(new URL('../../src/main/' + rel, import.meta.url), 'utf8')
const compile = (text, fileName) => ts.transpileModule(text, {
  fileName,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const adapterCode = compile(source('proxy/adapters/qwen-ai.ts'), 'qwen-ai.ts')
const checkerCode = compile(source('providers/checker.ts'), 'checker.ts')
const forwarderSource = source('proxy/forwarder.ts')
const ast = ts.createSourceFile('forwarder.ts', forwarderSource, ts.ScriptTarget.Latest, true)
const methods = []
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardQwenAi') methods.push(node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(methods.length, 1, 'Extract exactly the current production method')
const forwarderCode = compile('class OfflineForwarder {' + methods[0] +
  '} exports.OfflineForwarder = OfflineForwarder', 'forwardQwenAi.ts')
const TOKEN = 'SYNTHETIC_QWEN_LOCAL25_TOKEN'
const PRIVATE = 'SYNTHETIC_QWEN_LOCAL25_PRIVATE_ERROR'
const blocked = () => { throw new Error('Unexpected transport or app effect in local25') }

function load(code, dependencies, name, logs, globals = {}) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, URL, Date, Math, Error,
    setTimeout, clearTimeout,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      throw new Error('Forbidden import in ' + name + ': ' + specifier)
    },
    ...globals,
  }, { filename: name, timeout: 1500 })
  return mod.exports
}

function chatHarness() {
  const requests = [], submitted = [], logs = []
  let destroyed = 0
  const transport = {
    async post(url, payload, config) {
      requests.push({ url, payload, config })
      if (requests.length === 1) {
        assert.equal(url, 'https://chat.qwen.ai/api/v2/chats/new')
        return { status: 201, data: { data: { id: 'synthetic-local25-chat' } }, headers: {} }
      }
      if (requests.length === 2) {
        assert.equal(new URL(url).pathname, '/api/v2/chat/completions')
        // Inspect real wire options, then reject. A fixture is not live success.
        return { status: 401, headers: {}, data: { destroy() { destroyed++ } } }
      }
      return blocked()
    },
    get: blocked, delete: blocked, request: blocked,
  }
  const product = load(adapterCode, {
    '../../providers/qwenAiToken': QWEN_AI_TOKEN_MODULE,
    axios: { __esModule: true, default: { create: () => transport, get: blocked, post: blocked, delete: blocked } },
    stream: { PassThrough },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
  }, 'qwen-ai.ts', logs)
  const provider = Object.freeze({ id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai',
    modelMappings: Object.freeze({ 'Qwen3.7-Plus': 'qwen3.7-plus' }) })
  const account = Object.freeze({ id: 'synthetic-local25-account', providerId: 'qwen-ai',
    credentials: Object.freeze({ token: TOKEN }) })
  class ObservedAdapter extends product.QwenAiAdapter {
    async chatCompletion(request) {
      submitted.push(request)
      return super.chatCompletion(request)
    }
  }
  const { OfflineForwarder } = load(forwarderCode, {}, 'forwardQwenAi.ts', logs, {
    QwenAiAdapter: ObservedAdapter,
    QwenAiProxyFailure: product.QwenAiProxyFailure,
    QwenAiStreamHandler: class { constructor() { blocked() } },
    safeWebErrorStatus: () => undefined,
    shouldDeleteSession: blocked,
    hasCompletedNonStreamAnswer: blocked,
    unconfirmedProviderCompletion: blocked,
  })
  const forwarder = new OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({ messages: request.messages, plan: {} })
  return { requests, submitted, logs, provider, account, forwarder,
    adapter: new product.QwenAiAdapter(provider, account), destroyed: () => destroyed }
}

function assertWire(h, thinking) {
  assert.equal(h.requests.length, 2, 'One create and one completion; no retry, auth GET or cleanup')
  assert.equal(h.destroyed(), 1)
  const body = h.requests[1].payload
  assert.equal(body.model, 'qwen3.7-plus')
  assert.equal(h.requests[0].payload.models[0], 'qwen3.7-plus')
  assert.equal(body.stream, true)
  assert.equal(body.messages[0].feature_config.thinking_enabled, thinking)
  assert.equal(body.messages[0].feature_config.auto_thinking, thinking)
  assert.equal(body.messages[0].feature_config.auto_search, false)
  for (const request of h.requests) {
    assert.equal(request.config.maxRedirects, 0)
    assert.equal(request.config.headers.Authorization, 'Bearer ' + TOKEN)
  }
  assert.equal(JSON.stringify(h.logs).includes(TOKEN), false)
}

const aliases = [
  ['Qwen3.7-Plus', false],
  ['Qwen3.7-Plus-thinking', true],
  ['Qwen3.7-Plus-fast', false],
  ['Qwen3.7-Plus-Think-Search', true],
  ['Qwen3.7-Plus-r1', true],
]
for (const stream of [false, true]) for (const [alias, inferred] of aliases) {
  for (const [label, options, forwarded, expected] of [
    ['omitted', {}, undefined, inferred],
    ['false', { reasoning_effort: false }, false, false],
    ['high', { reasoning_effort: 'high' }, true, true],
  ]) {
    test('actual Qwen forwarder/adapter ' + alias + ' ' + label + ' stream=' + stream, async () => {
      const h = chatHarness()
      const request = Object.freeze({ model: alias, stream, ...options,
        messages: Object.freeze([Object.freeze({ role: 'user', content: 'synthetic option probe' })]) })
      const result = await h.forwarder.forwardQwenAi(request, h.account, h.provider,
        'qwen3.7-plus', Date.now())
      assert.equal(result.success, false)
      assert.equal(result.status, 401)
      assert.equal(result.failureStage, 'chat-completion')
      assert.equal(h.submitted.length, 1)
      assert.equal(h.submitted[0].enable_thinking, forwarded, 'Omitted is distinct from explicit false')
      assertWire(h, expected)
    })
  }
}

for (const [model, option, expected] of [
  ['Qwen3.7-Plus-thinking', undefined, true],
  ['Qwen3.7-Plus-thinking', false, false],
  ['Qwen3.7-Plus-fast', undefined, false],
  ['Qwen3.7-Plus-fast', true, true],
]) {
  test('actual adapter retains mapModel suffix with boolean priority ' + model + '/' + option, async () => {
    const h = chatHarness()
    await assert.rejects(h.adapter.chatCompletion({ model, enable_thinking: option,
      messages: [{ role: 'user', content: 'synthetic direct adapter probe' }] }),
    error => error.stage === 'chat-completion' && error.upstreamStatus === 401)
    assertWire(h, expected)
  })
}

const validUser = { name: 'Synthetic user', email: 'synthetic@example.invalid', is_guest: false }
function checkerHarness({ status = 200, body = { success: true, data: validUser }, errorKind } = {}) {
  const requests = [], logs = []
  class AxiosError extends Error {}
  const fakeAxios = {
    async get(url, config) {
      requests.push({ url, config })
      if (errorKind) {
        const error = errorKind === 'axios' ? new AxiosError(PRIVATE) : new Error(PRIVATE)
        error.config = { url: 'https://synthetic.invalid/?token=' + PRIVATE,
          headers: { Authorization: PRIVATE } }
        error.response = { data: { error: PRIVATE } }
        throw error
      }
      return { status, data: body }
    },
    post: blocked, delete: blocked, request: blocked,
  }
  const { ProviderChecker } = load(checkerCode, {
    axios: { __esModule: true, default: fakeAxios, AxiosError },
    './builtin': { getBuiltinProvider: id => id === 'qwen-ai' ? { id } : null },
    './qwenTicket': QWEN_TICKET_MODULE,
    './qwenAiToken': QWEN_AI_TOKEN_MODULE,
    '../oauth/zaiSession': ZAI_SESSION_MODULE,
  }, 'checker.ts', logs)
  const check = token => ProviderChecker.checkAccountToken(
    { id: 'qwen-ai', type: 'builtin', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'synthetic-local25-checker', providerId: 'qwen-ai', credentials: { token } })
  return { check, requests, logs }
}

function assertOneIdentityGet(h) {
  assert.equal(h.requests.length, 1, 'No retry or guessed fallback endpoint')
  const { url, config } = h.requests[0]
  assert.equal(url, 'https://chat.qwen.ai/api/v2/user', 'Preserve the existing checker endpoint')
  assert.equal(config.headers.Authorization, 'Bearer ' + TOKEN)
  assert.equal(config.maxRedirects, 0)
  assert.equal(Object.keys(config.headers).some(key => key.toLowerCase() === 'cookie'), false)
}
function assertPrivateNotReflected(h, result) {
  for (const value of [result, h.logs]) {
    assert.equal(JSON.stringify(value).includes(PRIVATE), false)
    assert.equal(JSON.stringify(value).includes(TOKEN), false)
  }
}

for (const [label, body] of [
  ['explicit success', { success: true, data: validUser }],
  ['legacy success omitted', { data: validUser }],
  ['guest flag omitted', { data: { name: 'Synthetic user', email: 'synthetic@example.invalid' } }],
  ['nullable error fields', { success: true, error: null, data: { ...validUser, error: null } }],
]) {
  test('actual checker accepts existing non-guest record: ' + label, async () => {
    const h = checkerHarness({ body })
    const result = await h.check(TOKEN)
    assert.equal(result.valid, true)
    assert.equal(result.userInfo.name, 'Synthetic user')
    assert.equal(result.userInfo.email, 'synthetic@example.invalid')
    assertOneIdentityGet(h)
    assertPrivateNotReflected(h, result)
  })
}

const invalidBodies = [
  ['explicit failure', { success: false, data: validUser }],
  ['nonboolean success', { success: 'true', data: validUser }],
  ['numeric success', { success: 1, data: validUser }],
  ['null success', { success: null, data: validUser }],
  ['provider error', { success: true, error: { message: PRIVATE }, data: validUser }],
  ['false error', { error: false, data: validUser }],
  ['empty error', { error: '', data: validUser }],
  ['nested error', { data: { ...validUser, error: { message: PRIVATE } } }],
  ['nested false error', { data: { ...validUser, error: false } }],
  ['guest', { data: { ...validUser, is_guest: true } }],
  ['guest string', { data: { ...validUser, is_guest: 'false' } }],
  ['guest null', { data: { ...validUser, is_guest: null } }],
  ['guest numeric', { data: { ...validUser, is_guest: 0 } }],
  ['guest email', { data: { ...validUser, email: ' Guest@GUEST.COM\t' } }],
  ['no body', null], ['string body', PRIVATE], ['array body', []],
  ['no data', { success: true }], ['null data', { data: null }],
  ['empty data', { data: {} }], ['array data', { data: [validUser] }],
  ['string data', { data: PRIVATE }], ['number data', { data: 1 }],
]
for (const [label, body] of invalidBodies) {
  test('actual checker rejects HTTP 200 without verified non-guest data: ' + label, async () => {
    const h = checkerHarness({ body })
    const result = await h.check(TOKEN)
    assert.equal(result.valid, false)
    assert.equal(typeof result.error, 'string')
    assert.equal(result.userInfo, undefined)
    assertOneIdentityGet(h)
    assertPrivateNotReflected(h, result)
  })
}

for (const status of [201, 204, 301, 302, 307, 308, 401, 403, 429, 500, 503]) {
  test('actual checker rejects HTTP ' + status + ' without redirect/retry', async () => {
    const h = checkerHarness({ status })
    const result = await h.check(TOKEN)
    assert.equal(result.valid, false)
    assertOneIdentityGet(h)
    assertPrivateNotReflected(h, result)
  })
}

for (const kind of ['axios', 'ordinary']) {
  test('actual checker does not expose ' + kind + ' transport errors', async () => {
    const h = checkerHarness({ errorKind: kind })
    const result = await h.check(TOKEN)
    assert.equal(result.valid, false)
    assertPrivateNotReflected(h, result)
    assertOneIdentityGet(h)
  })
}

test('actual checker rejects malformed token before any request without JWT-only authentication', async () => {
  for (const token of [undefined, null, '', 0, false, {}, [], 'has space', 'bad\nheader', '\tbad', 'bad\u0085']) {
    const h = checkerHarness()
    const result = await h.check(token)
    assert.equal(result.valid, false)
    assert.equal(h.requests.length, 0)
    assertPrivateNotReflected(h, result)
  }
})

test('actual checker exposes only string display fields from a successful profile', async () => {
  const h = checkerHarness({ body: { success: true,
    data: { is_guest: false, name: { private: PRIVATE }, email: ['invalid', PRIVATE] } } })
  const result = await h.check(TOKEN)
  assert.equal(result.valid, true)
  assert.equal(typeof result.userInfo.name, 'string')
  assert.equal(typeof result.userInfo.email, 'string')
  assertOneIdentityGet(h)
  assertPrivateNotReflected(h, result)
})
