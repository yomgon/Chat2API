import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Production ProviderChecker, Z.ai JWT metadata parser and Qwen China ticket
// helper in a closed synthetic transport. Never load app/profile/cookie store,
// reach a real server, or persist account/session data.
const nodeRequire = createRequire(import.meta.url)
const raw = rel => readFileSync(new URL('../../src/main/' + rel, import.meta.url), 'utf8')
const compile = (rel) => ts.transpileModule(raw(rel), {
  fileName: rel, compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

const PRIVATE = 'LOCAL87_PRIVATE_AUTH_COOKIE_CANARY_NEVER_OUTPUT'
const SUBJECT = 'synthetic-local87-identity'
const OTHER = 'different-local87-identity'
const ZAI_URL = 'https://chat.z.ai/api/v1/auths/'
const QWEN_URL = 'https://chat.qwen.ai/api/v2/user'
const expiry = Math.floor(Date.now() / 1000) + 3600
const jwt = (id = SUBJECT, claims = {}) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ id, ...claims })).toString('base64url'),
  Buffer.from('only-a-synthetic-test-signature').toString('base64url'),
].join('.')
const noExpiry = jwt()
const knownExpiry = jwt(SUBJECT, { exp: expiry })
const authResponse = (body = { id: SUBJECT }, status = 200, contentType = 'application/json') => ({
  status, data: body, headers: { 'content-type': contentType },
})
const qwenResponse = (body = { success: true, data: {
  name: 'Synthetic user', email: 'synthetic@example.invalid', is_guest: false,
} }, status = 200) => ({ status, data: body, headers: { 'content-type': 'application/json' } })

function load(relative, imports, globals = {}) {
  const module = { exports: {} }
  runInNewContext(compile(relative), {
    module, exports: module.exports, Buffer, URL, Date, Math, Error,
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, () => {}])),
    require(key) {
      if (Object.hasOwn(imports, key)) return imports[key]
      throw Error('Unexpected closed account checker dependency: ' + key)
    },
    ...globals,
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}
const claims = load('oauth/zaiSession.ts', { crypto: nodeRequire('node:crypto') })
const qwenChina = load('providers/qwenTicket.ts', {})
const qwenIntl = load('providers/qwenAiToken.ts', {})

function fixture(providerId, { body, status, contentType, transportError } = {}) {
  const calls = [], logs = []
  const desired = providerId === 'zai'
    ? authResponse(body === undefined ? { id: SUBJECT } : body, status ?? 200, contentType ?? 'application/json')
    : qwenResponse(body === undefined ? undefined : body, status ?? 200)
  const request = (method, url, config) => {
    calls.push({ method, url, config })
    if (transportError) throw transportError
    return Promise.resolve(desired)
  }
  const axios = Object.assign(config => request('call', config.url, config), {
    get: (url, config) => request('GET', url, config),
    post: (url, data, config) => request('POST', url, config),
    delete: () => { throw Error('Deletion not allowed') },
    request: () => { throw Error('Arbitrary request not allowed') },
  })
  const builtin = { getBuiltinProvider: id => id === providerId
    ? { id, apiEndpoint: providerId === 'zai' ? 'https://chat.z.ai/api' : 'https://chat.qwen.ai',
      tokenCheckEndpoint: providerId === 'zai' ? '/api/v1/users/user/settings' : '/api/v2/user' }
    : null }
  const checker = load('providers/checker.ts', {
    axios: { __esModule: true, default: axios },
    './builtin': builtin,
    './qwenTicket': qwenChina,
    '../oauth/zaiSession': claims,
    './qwenAiToken': qwenIntl,
  }, { console: Object.fromEntries(['log', 'error', 'warn'].map(k => [k, (...args) => logs.push(args)])) })
  const check = credentials => checker.ProviderChecker.checkAccountToken({
    id: providerId, type: 'builtin',
    apiEndpoint: providerId === 'zai' ? 'https://chat.z.ai/api' : 'https://chat.qwen.ai',
  }, { id: 'isolated-account-local87', providerId, status: 'active', credentials })
  const safe = result => {
    const serialized = JSON.stringify({ result, logs })
    assert.equal(serialized.includes(PRIVATE), false)
    assert.equal(serialized.includes(noExpiry), false)
    assert.equal(serialized.includes(knownExpiry), false)
  }
  return { check, calls, logs, safe }
}

for (const [label, token] of [['no-exp from stored account', noExpiry], ['known-exp valid', knownExpiry]]) {
  test('RED: Z.ai checker proves JWT subject with official first-party identity GET: ' + label, async () => {
    const f = fixture('zai')
    const result = await f.check({ token })
    assert.equal(result.valid, true)
    assert.equal(f.calls.length, 1)
    const [call] = f.calls
    assert.equal(call.method, 'GET')
    assert.equal(call.url, ZAI_URL)
    assert.equal(call.config.maxRedirects, 0)
    assert.equal(call.config.headers.Authorization, 'Bearer ' + token)
    assert.equal(call.config.headers.Cookie, 'token=' + token)
    assert.equal(result.userInfo?.name, undefined, 'No invented profile attributes')
    f.safe(result)
  })
}

for (const [label, data, status, contentType] of [
  ['mismatched server subject', { id: OTHER }, 200, 'application/json'],
  ['missing server subject', {}, 200, 'application/json'],
  ['non-string ID', { id: { secret: PRIVATE } }, 200, 'application/json'],
  ['array body', [{ id: SUBJECT }], 200, 'application/json'],
  ['null body', null, 200, 'application/json'],
  ['HTML content-type despite matching subject', { id: SUBJECT }, 200, 'text/html'],
  ['server-declared failure', { id: SUBJECT, success: false }, 200, 'application/json'],
  ['server-declared error', { id: SUBJECT, error: PRIVATE }, 200, 'application/json'],
  ['rotated token is different subject', { id: SUBJECT, token: jwt(OTHER) }, 200, 'application/json'],
  ['rotated token is not JWT', { id: SUBJECT, token: PRIVATE }, 200, 'application/json'],
  ['HTTP 201', { id: SUBJECT }, 201, 'application/json'],
  ['HTTP 302', { id: SUBJECT }, 302, 'application/json'],
  ['HTTP 401', { id: SUBJECT }, 401, 'application/json'],
  ['HTTP 429', { id: SUBJECT }, 429, 'application/json'],
  ['HTTP 503', { id: SUBJECT }, 503, 'application/json'],
]) {
  test('RED: Z.ai checker rejects unverified official identity: ' + label, async () => {
    const f = fixture('zai', { body: data, status, contentType })
    const outcome = await f.check({ token: noExpiry })
    assert.equal(outcome.valid, false, 'Never authenticate from HTTP 2xx alone')
    assert.equal(f.calls.length, 1, 'Only one synthetic GET, no retry')
    assert.equal(f.calls[0].method, 'GET')
    f.safe(outcome)
  })
}

for (const [label, token] of [
  ['missing', undefined], ['garbage', PRIVATE],
  ['expired', jwt(SUBJECT, { exp: Math.floor(Date.now() / 1000) - 60 })],
  ['future not-before', jwt(SUBJECT, { nbf: Math.floor(Date.now() / 1000) + 300 })],
  ['guest identity', jwt(SUBJECT, { email: 'Guest@guest.com' })],
  ['different shape', { jwt: PRIVATE }],
]) {
  test('RED: Z.ai rejects local invalid candidate before any GET: ' + label, async () => {
    const f = fixture('zai')
    const r = await f.check({ token })
    assert.equal(r.valid, false)
    assert.equal(f.calls.length, 0)
    f.safe(r)
  })
}

test('Z.ai checker never reveals Axios/URL/Cookie canaries on transport failure', async () => {
  const secretError = Object.assign(new Error(PRIVATE), {
    config: { url: ZAI_URL + '?token=' + PRIVATE, headers: { Cookie: PRIVATE } },
    response: { data: { token: PRIVATE }, headers: { 'set-cookie': PRIVATE } },
  })
  const f = fixture('zai', { transportError: secretError })
  const result = await f.check({ token: noExpiry })
  assert.equal(result.valid, false)
  assert.equal(f.calls.length, 1)
  f.safe(result)
})

for (const [label, credentials, expected] of [
  ['OAuth canonical token', { token: PRIVATE }, PRIVATE],
  ['legacy accessToken only', { accessToken: PRIVATE }, PRIVATE],
  ['legacy apiKey only', { apiKey: PRIVATE }, PRIVATE],
  ['blank canonical with usable accessToken', { token: '', accessToken: PRIVATE }, PRIVATE],
  ['different aliases honor the selected token', { token: PRIVATE, accessToken: 'not-selected' }, PRIVATE],
]) {
  test('RED: Qwen International checker reads the same opaque auth field as proxy: ' + label, async () => {
    const f = fixture('qwen-ai')
    const result = await f.check(credentials)
    assert.equal(result.valid, true)
    assert.equal(f.calls.length, 1)
    const [call] = f.calls
    assert.equal(call.method, 'GET')
    assert.equal(call.url, QWEN_URL)
    assert.equal(call.config.maxRedirects, 0)
    assert.equal(call.config.headers.Authorization, 'Bearer ' + expected)
    f.safe(result)
  })
}

for (const [label, creds] of [
  ['empty object', {}], ['malformed primary dominates fallback', { token: {}, accessToken: PRIVATE }],
  ['header injection', { token: 'plain\r\nInjection: 1' }],
  ['nonstring legacy field', { accessToken: { payload: PRIVATE } }],
]) {
  test('Qwen International checker rejects unsafe alias before any first-party GET: ' + label, async () => {
    const f = fixture('qwen-ai')
    const result = await f.check(creds)
    assert.equal(result.valid, false)
    assert.equal(f.calls.length, 0)
    f.safe(result)
  })
}
