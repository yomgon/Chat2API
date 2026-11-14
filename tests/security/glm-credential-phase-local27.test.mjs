import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'
import { ZAI_SESSION_MODULE } from './helpers/zaiSessionModule.mjs'

// Real OAuth output, consumer adapter and public checker. All Axios, Electron,
// store and attachment capabilities are synthetic; unknown imports fail.
// Completion returns a rejected HTTP result, never a made-up model answer.
const REFRESH = 'SYNTHETIC_LOCAL27_REFRESH'
const ACCESS = 'SYNTHETIC_LOCAL27_ACCESS'
const ROTATED = 'SYNTHETIC_LOCAL27_ROTATED'
const PRIVATE = 'SYNTHETIC_LOCAL27_PRIVATE_ERROR'
const REFRESH_URL = 'https://chatglm.cn/chatglm/user-api/user/refresh'
const COMPLETION_URL = 'https://chatglm.cn/chatglm/backend-api/assistant/stream'
const provider = Object.freeze({ id: 'glm', type: 'builtin', apiEndpoint: 'https://chatglm.cn/chatglm' })
const source = file => readFileSync(new URL('../../src/main/' + file, import.meta.url), 'utf8')
const compile = file => ts.transpileModule(source(file), { fileName: file, compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const proxyCode = compile('proxy/adapters/glm.ts')
const checkerCode = compile('providers/checker.ts')
const oauthCode = compile('oauth/adapters/glm.ts')
const goodReply = (access = ACCESS, refresh = REFRESH) => ({
  status: 200, data: { code: 0, result: { access_token: access, refresh_token: refresh,
    user: { name: 'Synthetic user' } } },
})

function run(code, imports, logs, filename) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports,
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, Error, Date, Math, Promise,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      throw new Error('Forbidden local27 import: ' + name)
    },
  }, { filename, timeout: 2000 })
  return mod.exports
}
async function settled(promise) {
  return promise.then(value => ({ fulfilled: true, value }), error => ({ fulfilled: false, error }))
}
function assertPrivate(value) {
  const rendered = inspect(value, { depth: 20, customInspect: false, getters: false })
  assert.equal(rendered.includes(PRIVATE), false, 'private provider details must not escape')
}
function fixture(credentials, { replies = [], reject = false, persistReject = false, persistMissing = false } = {}) {
  const calls = [], updates = [], committed = [], logs = [], denied = []
  const blocked = name => () => {
    denied.push(name)
    throw new Error('Forbidden local27 capability: ' + name)
  }
  class AxiosError extends Error {}
  const failure = Object.assign(new AxiosError('Authorization Bearer ' + PRIVATE), {
    config: { url: 'https://private.invalid/?token=' + PRIVATE,
      headers: { Authorization: PRIVATE } },
  })
  let refreshCount = 0
  const transport = {
    async post(url, body, config) {
      calls.push({ url, body, config })
      if (url === REFRESH_URL) {
        if (reject) throw failure
        const reply = replies[refreshCount++] ?? goodReply()
        return reply
      }
      if (url === COMPLETION_URL) return { status: 401, headers: {}, data: {} }
      return blocked('unexpected POST')()
    },
    get: blocked('GET'), delete: blocked('DELETE'), request: blocked('request'),
  }
  const axios = { __esModule: true, default: transport, AxiosError }
  const dependencies = {
    axios, crypto, stream: { PassThrough },
    '../../store/store': { storeManager: {
      getAccountById(id, includeCredentials) {
        assert.equal(id, 'synthetic-local27-account')
        assert.equal(includeCredentials, true)
        return { id, providerId: 'glm', credentials: structuredClone(credentials) }
      },
      updateAccount(id, update) {
      updates.push({ id, update: structuredClone(update) })
      if (persistReject) throw failure
      if (persistMissing) return null
      committed.push({ id, update: structuredClone(update) })
      return { id, providerId: 'glm', ...update }
    } } },
    'eventsource-parser': { createParser: blocked('SSE parser') },
    'form-data': { __esModule: true, default: class { constructor() { blocked('upload')() } } },
    'mime-types': {},
    '../utils/tools': { toolsToSystemPrompt: blocked('tool prompt'),
      TOOL_WRAP_HINT: '', hasToolPromptInjected: () => false },
    '../utils/toolParser': { parseToolCallsFromText: blocked('tool parser') },
    '../utils/streamToolHandler': { createBaseChunk: blocked('chunk') },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
    'node:dns/promises': { lookup: blocked('DNS') },
    'node:https': { Agent: class { constructor() { blocked('HTTPS Agent')() } } },
  }
  const product = run(proxyCode, dependencies, logs, 'glm-proxy.ts')
  const checker = run(checkerCode, {
    axios, crypto, './builtin': { getBuiltinProvider: id => id === 'glm' ? { id } : null },
    './qwenTicket': QWEN_TICKET_MODULE,
    './qwenAiToken': QWEN_AI_TOKEN_MODULE,
    '../oauth/zaiSession': ZAI_SESSION_MODULE,
  }, logs, 'checker.ts')
  const account = Object.freeze({ id: 'synthetic-local27-account', providerId: 'glm', credentials })
  const adapter = new product.GLMAdapter(provider, account)
  const request = Object.freeze({ model: 'synthetic-model', stream: false,
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'Synthetic credential check' })]) })
  return {
    calls, updates, committed, logs, denied, failure, account, adapter,
    proxy: () => adapter.chatCompletion(request),
    proxyWithCredentials: next => new product.GLMAdapter(provider,
      Object.freeze({ ...account, credentials: Object.freeze(next) })).chatCompletion(request),
    check: () => checker.ProviderChecker.checkAccountToken(provider, account),
    refreshCalls: () => calls.filter(call => call.url === REFRESH_URL),
    completions: () => calls.filter(call => call.url === COMPLETION_URL),
  }
}
async function assertDenied(h, target) {
  const result = target === 'proxy' ? await settled(h.proxy()) : await h.check()
  if (target === 'proxy') {
    assert.equal(result.fulfilled, false, 'invalid credentials must reject before completion')
    assert.match(result.error.message, /^GLM (?:credentials are invalid|token refresh failed|token refresh response is invalid|credential persistence failed)$/)
  } else {
    assert.equal(result.valid, false)
  }
  assertPrivate(result)
  assertPrivate(h.logs)
  assert.deepEqual(h.denied, [])
  return result
}
async function assertAccepted(h, target, expected = REFRESH) {
  if (target === 'proxy') {
    const result = await h.proxy()
    assert.equal(result.response.status, 401, 'fixture stops at captured completion, no model success')
    assert.equal(h.completions().length, 1)
    assert.equal(h.completions()[0].config.headers.Authorization, 'Bearer ' + ACCESS)
  } else {
    assert.equal((await h.check()).valid, true)
    assert.equal(h.completions().length, 0)
  }
  assert.equal(h.refreshCalls().length, 1)
  assert.equal(h.refreshCalls()[0].config.headers.Authorization, 'Bearer ' + expected)
  assert.equal(h.refreshCalls()[0].config.maxRedirects, 0)
  assert.deepEqual(h.denied, [])
  assertPrivate(h.logs)
}

test('actual OAuth login result feeds both proxy and checker without alias conversion or OAuth POST', async () => {
  const logs = [], forbidden = []
  const deny = () => { forbidden.push('OAuth transport'); throw new Error('Forbidden OAuth transport') }
  class Base {
    constructor(config) { this.config = config; this.progress = [] }
    emitProgress(status, message) { this.progress.push({ status, message }) }
    generateUUID() { return '12345678-1234-4123-8123-123456789012' }
    md5() { return 'synthetic-signature' }
    getTimestamp() { return 1700000000 }
  }
  const oauth = run(oauthCode, {
    axios: { __esModule: true, default: { post: deny, get: deny } },
    electron: { shell: { openExternal: deny } },
    './base': { BaseOAuthAdapter: Base },
  }, logs, 'glm-oauth.ts')
  const login = new oauth.GLMAdapter({ id: 'glm', providerId: 'glm' })
  login.refreshToken = async () => ({ value: ACCESS, refreshToken: REFRESH })
  login.validateToken = async credentials => {
    assert.equal(credentials.refreshToken, REFRESH)
    assert.equal(credentials.accessToken, ACCESS)
    return { valid: true, accountInfo: { userId: 'synthetic-user' } }
  }
  const result = await login.loginWithToken('glm', REFRESH)
  assert.equal(result.success, true)
  assert.equal(result.credentials.refreshToken, REFRESH)
  assert.equal(result.credentials.accessToken, ACCESS)
  assert.equal(Object.hasOwn(result.credentials, 'refresh_token'), false)
  for (const target of ['proxy', 'checker']) {
    await assertAccepted(fixture(Object.freeze(result.credentials)), target)
  }
  assert.deepEqual(forbidden, [])
  assertPrivate(logs)
})

const validCredentials = [
  ['manual refresh_token', { refresh_token: REFRESH }],
  ['OAuth refreshToken', { refreshToken: REFRESH, accessToken: ACCESS }],
  ['browser chatglm_refresh_token', { chatglm_refresh_token: REFRESH }],
  ['legacy token', { token: REFRESH }],
  ['matching refresh aliases', { refresh_token: REFRESH, chatglm_refresh_token: REFRESH,
    refreshToken: REFRESH, token: REFRESH, accessToken: ACCESS }],
]
for (const target of ['proxy', 'checker']) for (const [label, credentials] of validCredentials) {
  test(target + ': accepts ' + label + ' exactly', async () => {
    const frozen = Object.freeze(credentials)
    const h = fixture(frozen)
    await assertAccepted(h, target)
    assert.equal(h.account.credentials, frozen)
    assert.equal(h.updates.length, 0, 'unchanged refresh must not rewrite credentials')
  })
}

const invalidCredentials = [
  ['missing', undefined], ['null', null], ['array', []], ['empty object', {}],
  ['access-only', { accessToken: ACCESS }],
  ['absent own refresh', Object.create({ refresh_token: REFRESH })],
  ['empty canonical with usable fallback', { refresh_token: '', refreshToken: REFRESH }],
  ['null canonical with usable fallback', { refresh_token: null, refreshToken: REFRESH }],
  ['object canonical with usable fallback', { refresh_token: {}, token: REFRESH }],
  ['canonical/OAuth identity conflict', { refresh_token: REFRESH, refreshToken: ROTATED }],
  ['canonical/legacy identity conflict', { refresh_token: REFRESH, token: ROTATED }],
  ['valid canonical with malformed alias', { refresh_token: REFRESH, refreshToken: {} }],
  ['header injection', { refreshToken: REFRESH + '\r\nInjected: ' + PRIVATE }],
  ['embedded whitespace', { refreshToken: REFRESH + ' ' + PRIVATE }],
  ['C1 control', { refreshToken: '\u0085' + REFRESH }],
  ['non-header Unicode', { refreshToken: '\u0100' + REFRESH }],
  ['non-header emoji', { refreshToken: REFRESH + '\u{1f600}' }],
]
for (const field of ['refresh_token', 'chatglm_refresh_token', 'refreshToken', 'token']) {
  invalidCredentials.push([field + ' false', { [field]: false }])
  invalidCredentials.push([field + ' undefined', { [field]: undefined }])
}
for (const target of ['proxy', 'checker']) for (const [label, credentials] of invalidCredentials) {
  test(target + ': rejects ' + label + ' before refresh or completion', async () => {
    const h = fixture(credentials)
    await assertDenied(h, target)
    assert.equal(h.calls.length, 0)
    assert.equal(h.updates.length, 0)
  })
}

const badResults = [
  ['missing result', undefined], ['null result', null], ['array result', []], ['empty result', {}],
  ['missing access', { refresh_token: REFRESH }],
  ['missing refresh', { access_token: ACCESS }],
  ['empty access', { access_token: '', refresh_token: REFRESH }],
  ['object access', { access_token: { token: PRIVATE }, refresh_token: REFRESH }],
  ['numeric access', { access_token: 1, refresh_token: REFRESH }],
  ['control access', { access_token: ACCESS + '\n' + PRIVATE, refresh_token: REFRESH }],
  ['empty refresh', { access_token: ACCESS, refresh_token: '' }],
  ['object refresh', { access_token: ACCESS, refresh_token: { token: PRIVATE } }],
  ['numeric refresh', { access_token: ACCESS, refresh_token: 1 }],
  ['control refresh', { access_token: ACCESS, refresh_token: REFRESH + '\u009f' }],
]
for (const target of ['proxy', 'checker']) for (const [label, result] of badResults) {
  test(target + ': malformed refresh ' + label + ' cannot publish cache or credentials', async () => {
    const h = fixture({ refresh_token: REFRESH }, {
      replies: [{ status: 200, data: { code: 0, result } }, goodReply()],
    })
    await assertDenied(h, target)
    assert.equal(h.refreshCalls().length, 1)
    assert.equal(h.completions().length, 0)
    assert.equal(h.updates.length, 0)
    if (target === 'proxy') {
      const second = await h.proxy()
      assert.equal(second.response.status, 401)
      assert.equal(h.refreshCalls().length, 2, 'a new explicit request must not reuse a poisoned cache')
      assert.equal(h.completions().length, 1)
      assert.equal(h.completions()[0].config.headers.Authorization, 'Bearer ' + ACCESS)
    }
  })
}

for (const target of ['proxy', 'checker']) for (const status of [302, 401, 403, 429, 500]) {
  test(target + ': HTTP ' + status + ' refresh failure is fixed and private', async () => {
    const h = fixture({ refresh_token: REFRESH }, {
      replies: [{ status, data: { code: 1, message: PRIVATE, msg: PRIVATE } }],
    })
    await assertDenied(h, target)
    assert.equal(h.calls.length, 1)
    assert.equal(h.updates.length, 0)
    assert.equal(h.refreshCalls()[0].config.maxRedirects, 0)
  })
}
for (const target of ['proxy', 'checker']) {
  test(target + ': business failure with token-like fields is not success', async () => {
    const h = fixture({ refresh_token: REFRESH }, {
      replies: [{ status: 200, data: { code: 1, message: PRIVATE,
        result: { access_token: ACCESS, refresh_token: REFRESH } } }],
    })
    await assertDenied(h, target)
    assert.equal(h.calls.length, 1)
    assert.equal(h.updates.length, 0)
  })
  test(target + ': rejected transport does not expose Axios text, URL, headers or stack', async () => {
    const h = fixture({ refresh_token: REFRESH }, { reject: true })
    await assertDenied(h, target)
    assert.equal(h.calls.length, 1)
    assert.equal(h.updates.length, 0)
  })
}

test('valid refresh rotation retains existing manual credential update and cached access', async () => {
  const h = fixture({ refreshToken: REFRESH, accessToken: ACCESS }, { replies: [goodReply(ACCESS, ROTATED)] })
  assert.equal((await h.proxy()).response.status, 401)
  assert.equal((await h.proxy()).response.status, 401)
  assert.equal(h.refreshCalls().length, 1)
  assert.equal(h.completions().length, 2)
  assert.deepEqual(h.committed, [{ id: 'synthetic-local27-account',
    update: { credentials: { refreshToken: ROTATED, accessToken: ACCESS,
      refresh_token: ROTATED } } }])
  assert.equal((await h.proxyWithCredentials(h.committed[0].update.credentials)).response.status, 401)
  assert.equal(h.refreshCalls().length, 1, 'the stored rotated credential must use the same access cache')
  assert.equal(h.completions().length, 3)
  assertPrivate(h.logs)
})

for (const mode of ['throw', 'missing-account']) test(mode + ': failed persistence cannot publish access cache', async () => {
  const h = fixture({ refresh_token: REFRESH }, {
    replies: [goodReply(ACCESS, ROTATED), goodReply()],
    persistReject: mode === 'throw', persistMissing: mode === 'missing-account',
  })
  await assertDenied(h, 'proxy')
  assert.equal(h.refreshCalls().length, 1)
  assert.equal(h.completions().length, 0)
  assert.equal(h.updates.length, 1)
  assert.equal(h.committed.length, 0)
  const second = await h.proxy()
  assert.equal(second.response.status, 401)
  assert.equal(h.refreshCalls().length, 2)
  assert.equal(h.completions().length, 1)
  assert.equal(h.committed.length, 0)
})
