import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const AUTH_URL = 'https://chat.qwen.ai/api/v2/user/info'
const FAILURE = 'Qwen AI session verification failed'
const PRIVATE = 'SYNTHETIC_QWEN_OAUTH_PRIVATE_LOCAL21'
const SUBJECT = 'synthetic-qwen-subject'
const EMAIL = 'synthetic-qwen@example.invalid'
const NOW = 2_000_000_000
const plain = value => JSON.parse(JSON.stringify(value))
const jwt = (claims = {}, header = { alg: 'HS256' }) => [
  Buffer.from(JSON.stringify(header)).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: SUBJECT, email: EMAIL, name: 'Synthetic account', ...claims })).toString('base64url'),
  Buffer.from('synthetic-signature-only').toString('base64url'),
].join('.')
const TOKEN = jwt()
const record = (extra = {}) => ({ email: EMAIL, name: 'Synthetic account', is_guest: false, ...extra })
const response = (data = record(), status = 200, extra = {}) => ({
  status, data: { success: true, data, ...extra }, headers: {},
})
const privateError = () => Object.assign(new Error(PRIVATE), {
  config: { url: 'https://synthetic.invalid/?token=' + PRIVATE,
    headers: { Authorization: 'Bearer ' + PRIVATE, Cookie: PRIVATE } },
  response: { data: { error: PRIVATE }, headers: { 'set-cookie': PRIVATE } },
})

const compiled = new Map(['qwen-ai.ts', 'base.ts'].map(file => {
  const source = readFileSync(new URL('../../src/main/oauth/adapters/' + file, import.meta.url), 'utf8')
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } })
  assert.equal((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
  return [file, result.outputText]
}))

function harness(options = {}) {
  const calls = [], logs = [], progress = [], forbidden = []
  const clock = { nowMs: NOW * 1000 }
  const failOperation = name => {
    forbidden.push(name)
    throw new Error('Forbidden offline operation')
  }
  const fakeAxios = {
    get: async (url, config) => {
      calls.push({ url, config })
      if (options.get) return options.get({ clock, calls })
      if (options.error) throw options.error
      return options.response === undefined ? response() : options.response
    },
    post: () => failOperation('POST'),
    delete: () => failOperation('DELETE'),
    request: () => failOperation('unapproved transport'),
    create: () => failOperation('transport instance'),
  }
  const cache = new Map()
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    vm.runInNewContext(compiled.get(file), {
      module, exports: module.exports, Buffer, URL,
      Date: class extends Date { static now() { return clock.nowMs } },
      console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(
        level => [level, (...args) => logs.push({ level, args })])),
      require: name => {
        if (name === 'axios') return { __esModule: true, default: fakeAxios }
        if (name === './base') return load('base.ts')
        if (name === 'electron') return {
          BrowserWindow: class { constructor() { failOperation('GUI') } },
          shell: { openExternal: () => failOperation('browser') },
        }
        if (name === 'http') return { createServer: () => failOperation('HTTP server') }
        if (name === 'crypto') return Object.fromEntries(
          ['randomBytes', 'randomUUID', 'createHash'].map(key => [key, () => failOperation('crypto effect')]))
        return failOperation('unexpected import')
      },
    }, { filename: file, timeout: 2000 })
    return module.exports
  }
  const { QwenAiAdapter } = load('qwen-ai.ts')
  const adapter = new QwenAiAdapter({
    providerId: 'qwen-ai', apiUrl: 'https://synthetic.invalid/',
    loginUrl: 'https://synthetic.invalid/', authMethods: ['manual'],
  })
  adapter.setProgressCallback(event => progress.push(event))
  return {
    adapter, calls, logs, progress, forbidden, clock,
    assertPrivate(value) {
      const diagnostics = JSON.stringify({ logs, progress, value })
      for (const canary of [PRIVATE, TOKEN, SUBJECT, EMAIL]) {
        assert.equal(diagnostics.includes(canary), false, 'private values must not enter failure diagnostics')
      }
      assert.equal(forbidden.length, 0, 'the VM must never attempt an unapproved operation')
    },
  }
}

async function invoke(h, mode, token = TOKEN) {
  return mode === 'validate'
    ? h.adapter.validateToken({ token })
    : h.adapter.loginWithToken('qwen-ai', token)
}
function assertRejected(h, result, mode, expectedCalls = 1) {
  assert.equal(mode === 'validate' ? result.valid : result.success, false)
  assert.equal(result.error, FAILURE)
  assert.equal(result.credentials, undefined)
  assert.equal(result.accountInfo, undefined)
  assert.equal(h.progress.some(event => event.status === 'success'), false)
  assert.equal(h.calls.length, expectedCalls)
  h.assertPrivate(result)
}

for (const mode of ['validate', 'login']) {
  test(mode + ' preserves verified token-only success at the fixed official endpoint', async () => {
    const h = harness()
    const supplied = Object.freeze({ token: TOKEN })
    const result = mode === 'validate'
      ? await h.adapter.validateToken(supplied)
      : await h.adapter.loginWithToken('qwen-ai', TOKEN)
    assert.equal(mode === 'validate' ? result.valid : result.success, true)
    assert.deepEqual(plain(result.accountInfo), { userId: SUBJECT, email: EMAIL, name: 'Synthetic account' })
    if (mode === 'login') {
      assert.equal(result.credentials.token === TOKEN, true)
      assert.deepEqual(Object.keys(result.credentials), ['token'])
      assert.deepEqual(h.progress.map(event => event.status), ['pending', 'success'])
    }
    assert.equal(h.calls.length, 1)
    const call = h.calls[0]
    assert.equal(call.url, AUTH_URL)
    assert.equal(call.config.maxRedirects, 0)
    assert.equal(call.config.headers.Authorization === 'Bearer ' + TOKEN, true)
    assert.equal(Object.keys(call.config.headers).some(key => key.toLowerCase() === 'cookie'), false)
    assert.equal(h.forbidden.length, 0)
    h.assertPrivate(undefined)
  })

  for (const status of [204, 301, 302, 307, 308, 401, 403, 429, 500, '200']) {
    test(mode + ' rejects HTTP status ' + status + ' without retry or credential result', async () => {
      const h = harness({ response: response(record(), status, { error: PRIVATE }) })
      assertRejected(h, await invoke(h, mode), mode)
    })
  }
  for (const [name, body] of [
    ['null body', null],
    ['HTML body', '<html>' + PRIVATE + '</html>'],
    ['array body', []],
    ['missing success', { data: record() }],
    ['false success', { success: false, data: record() }],
    ['truthy nonboolean success', { success: 'true', data: record() }],
    ['numeric success', { success: 1, data: record() }],
    ['missing user', { success: true }],
    ['null user', { success: true, data: null }],
    ['array user', { success: true, data: [record()] }],
    ['string user', { success: true, data: PRIVATE }],
    ['empty user', { success: true, data: {} }],
    ['guest user', { success: true, data: record({ is_guest: true }) }],
    ['malformed guest flag', { success: true, data: record({ is_guest: 'false' }) }],
    ['null guest flag', { success: true, data: record({ is_guest: null }) }],
    ['guest server email', { success: true, data: record({ email: 'Guest@GUEST.COM' }) }],
    ['contradictory root error', { success: true, data: record(), error: PRIVATE }],
    ['contradictory user error', { success: true, data: record({ error: PRIVATE }) }],
  ]) {
    test(mode + ' rejects ' + name + ' without promoting JWT metadata to authentication', async () => {
      const h = harness({ response: { status: 200, data: body } })
      assertRejected(h, await invoke(h, mode), mode)
    })
  }

  test(mode + ' rejects a user-info transport exception without exposing it', async () => {
    const h = harness({ error: privateError() })
    assertRejected(h, await invoke(h, mode), mode)
  })
  test(mode + ' rejects an unexpected user-info helper exception', async () => {
    const h = harness()
    h.adapter.getUserInfo = async () => { throw privateError() }
    assertRejected(h, await invoke(h, mode), mode, 0)
  })
  test(mode + ' rejects a null user-info helper result', async () => {
    const h = harness()
    h.adapter.getUserInfo = async () => null
    assertRejected(h, await invoke(h, mode), mode, 0)
  })

  for (const [name, claims] of [
    ['expired exp', { exp: NOW - 1 }],
    ['exp boundary', { exp: NOW }],
    ['string exp', { exp: String(NOW + 60) }],
    ['null exp', { exp: null }],
    ['boolean exp', { exp: true }],
    ['negative exp', { exp: -1 }],
    ['object exp', { exp: { value: NOW + 60 } }],
    ['future nbf', { nbf: NOW + 1 }],
    ['string nbf', { nbf: String(NOW - 1) }],
    ['null nbf', { nbf: null }],
    ['boolean nbf', { nbf: false }],
    ['negative nbf', { nbf: -1 }],
    ['array nbf', { nbf: [NOW - 1] }],
    ['guest token email', { email: 'Guest@GUEST.COM' }],
    ['invalid subject shape', { sub: { secret: PRIVATE } }],
  ]) {
    test(mode + ' rejects ' + name + ' before the official lookup', async () => {
      const h = harness()
      assertRejected(h, await invoke(h, mode, jwt(claims)), mode, 0)
    })
  }

  test(mode + ' rechecks expiry after the asynchronous official lookup', async () => {
    const h = harness({ get: ({ clock }) => {
      clock.nowMs = (NOW + 2) * 1000
      return response()
    } })
    assertRejected(h, await invoke(h, mode, jwt({ exp: NOW + 1 })), mode)
  })
  test(mode + ' retains supported identity aliases and optional numeric time claims', async () => {
    for (const key of ['sub', 'id', 'user_id', 'uid']) {
      const h = harness()
      const candidate = jwt({ sub: undefined, [key]: SUBJECT, exp: NOW + 0.5, nbf: NOW })
      const result = await invoke(h, mode, candidate)
      assert.equal(mode === 'validate' ? result.valid : result.success, true)
      assert.equal(result.accountInfo.userId, SUBJECT)
      assert.equal(h.calls.length, 1)
      h.assertPrivate(undefined)
    }
  })
}

test('known user profile without guest flag or undocumented identity fields remains compatible', async () => {
  const h = harness({ response: response({ email: EMAIL, name: 'Synthetic account' }) })
  const result = await h.adapter.loginWithToken('qwen-ai', TOKEN)
  assert.equal(result.success, true)
  assert.equal(result.credentials.token === TOKEN, true)
  assert.equal(h.calls.length, 1)
  h.assertPrivate(undefined)
})

test('malformed local token values and JWT payloads fail before transport', async () => {
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url')
  for (const token of [
    undefined, null, '', 42, {}, [], ' ' + TOKEN, TOKEN + '\r\n',
    'opaque-without-jwt', header + '..signature',
    jwt({}, { alg: 'none' }), jwt({}, { alg: '' }), jwt({}, { alg: 42 }), jwt({}, []),
    header + '.' + Buffer.from('{"sub":"' + SUBJECT + '","exp":1e999}').toString('base64url') + '.signature',
    header + '.' + Buffer.from('{"sub":"' + SUBJECT + '","nbf":1e999}').toString('base64url') + '.signature',
    header + '.' + Buffer.from('null').toString('base64url') + '.signature',
    header + '.' + Buffer.from('[]').toString('base64url') + '.signature',
    header + '.' + Buffer.from('{"sub":"' + SUBJECT + '",}').toString('base64url') + '.signature',
  ]) {
    const h = harness()
    assertRejected(h, await h.adapter.validateToken({ token }), 'validate', 0)
  }
})

test('loginWithToken never forwards an unexpected validator error or failure message', async () => {
  for (const throws of [false, true]) {
    const h = harness()
    h.adapter.validateToken = async () => {
      if (throws) throw privateError()
      return { valid: false, error: PRIVATE }
    }
    assertRejected(h, await h.adapter.loginWithToken('qwen-ai', TOKEN), 'login', 0)
  }
})
