import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

// Source-only VM tests. No actual app, user store, browser session or network.
const root = new URL('../../', import.meta.url)
const NOW = Date.UTC(2026, 10, 8, 12)
const SUBJECT = 'synthetic-original-subject'
const AUTH_URL = 'https://chat.z.ai/api/v1/auths/'
const compiled = new Map()
const plain = value => JSON.parse(JSON.stringify(value))
const clone = value => value === undefined ? undefined : structuredClone(value)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve))
}
function jwt(overrides = {}) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      id: SUBJECT, exp: NOW / 1000 + 3600, email: 'synthetic@example.invalid', ...overrides,
    })).toString('base64url'),
    Buffer.from('synthetic-signature-not-a-real-secret').toString('base64url'),
  ].join('.')
}
function authResponse(body, options = {}) {
  const text = options.raw ?? JSON.stringify(body)
  const response = new Response(options.stream ?? text, {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  // Electron ses.fetch does not promise a populated/correct Response.url.
  // Preserve the native Response's empty URL unless a test supplies metadata.
  if (Object.hasOwn(options, 'url')) Object.defineProperty(response, 'url', { value: options.url })
  if (Object.hasOwn(options, 'redirected')) Object.defineProperty(response, 'redirected', { value: options.redirected })
  return response
}
function fixtureAccount(overrides = {}) {
  return {
    id: 'account-original', providerId: 'zai', name: 'Keep original name',
    email: 'stored@example.invalid', createdAt: NOW - 100000, updatedAt: NOW - 50000,
    status: 'expired', requestCount: 37, todayUsed: 4, dailyLimit: 40,
    errorMessage: 'Old session expired',
    credentials: { token: jwt({ exp: NOW / 1000 - 20 }), captcha_verify_param: 'synthetic-captcha-option' },
    ...overrides,
  }
}
function harness(options = {}) {
  const logs = [], progress = [], status = [], fetches = [], partitions = []
  const updates = [], reads = [], starts = [], completions = [], validations = [], forbidden = []
  const timers = new Map(), cache = new Map()
  let timerId = 0, now = NOW, generation = 0, loginResolve, pendingCompletion
  const state = {
    accounts: clone(options.accounts ?? [fixtureAccount()]),
    provider: clone(options.provider ?? { id: 'zai', enabled: true, type: 'builtin' }),
    config: clone({ oauthProxyMode: 'none', modelMappings: {
      'existing-route': { actualModel: 'existing-wire-id', preferredProviderId: 'zai', preferredAccountId: 'account-original' },
    } }),
  }
  const original = clone(state)
  const replies = [...(options.replies ?? [])]
  const validationReplies = [...(options.validations ?? [])]
  const deny = what => {
    forbidden.push(what)
    throw new Error('Blocked real operation: ' + what)
  }
  const login = new EventEmitter()
  login.open = false
  login.startLogin = input => {
    if (login.open) return Promise.resolve({ success: false, error: 'A login window is already open' })
    starts.push(clone(input))
    generation++
    login.open = true
    return new Promise(resolve => { loginResolve = resolve })
  }
  login.isWindowOpen = () => login.open
  login.navigate = () => { generation++ }
  login.end = result => {
    if (!login.open) return
    const resolve = loginResolve
    loginResolve = undefined
    login.open = false
    const event = { ...result, generation }
    login.emit('complete', event)
    resolve?.(event)
  }
  login.completeWithSuccess = (credentials, expectedGeneration) => {
    completions.push({ credentials: clone(credentials), generation: expectedGeneration })
    if (expectedGeneration !== undefined && expectedGeneration !== generation) return
    if (options.deferCompletion) {
      pendingCompletion = { credentials, generation }
      return
    }
    login.end({ success: true, credentials })
  }
  login.finishAccepted = () => {
    const saved = pendingCompletion
    pendingCompletion = undefined
    if (saved && login.open && saved.generation === generation) {
      login.end({ success: true, credentials: saved.credentials })
    }
  }
  login.cancel = () => login.end({ success: false, error: 'Login cancelled by user' })
  login.destroy = () => { login.cancel(); login.removeAllListeners() }
  login.token = (value, extra = {}) => login.emit('tokenFound', {
    key: 'token', value, generation, ...extra,
  })
  const fakeSession = {
    async fetch(url, init) {
      fetches.push({ url, init })
      if (!replies.length) return deny('unmocked HTTP request')
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply(url, init) : reply
    },
  }
  const fakeStore = {
    getAccountById(id, includeCredentials) {
      reads.push({ id, includeCredentials })
      options.onRead?.(state, reads.length)
      return clone(state.accounts.find(account => account.id === id))
    },
    getProviderById(id) {
      assert.equal(id, 'zai')
      return clone(state.provider)
    },
    getConfig: () => clone(state.config),
    updateAccount(id, value) {
      updates.push({ id, value: clone(value) })
      if (options.writeError) throw options.writeError
      if (options.writeNull) return null
      const index = state.accounts.findIndex(account => account.id === id)
      if (index === -1) return null
      state.accounts[index] = { ...state.accounts[index], ...clone(value), updatedAt: now }
      options.afterWrite?.(state)
      return clone(state.accounts[index])
    },
    addAccount: () => deny('account creation'),
    deleteAccount: () => deny('account deletion'),
    updateConfig: () => deny('configuration mutation'),
  }
  const fakeConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug']
    .map(level => [level, (...args) => logs.push({ level, args })]))
  class FakeDate extends Date { static now() { return now } }
  class FakeBaseAdapter {
    setMainWindow() {}
    setProgressCallback(callback) { this.callback = callback }
    emitProgress(kind, message) { this.callback?.({ status: kind, message }) }
    destroy() {}
  }
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports
    assert.ok([
      'src/main/oauth/manager.ts',
      'src/main/oauth/adapters/zai.ts',
      'src/main/oauth/zaiSession.ts',
    ].includes(relative), 'Only selected source files may execute')
    if (!compiled.has(relative)) {
      const source = readFileSync(new URL(relative, root), 'utf8')
      const result = ts.transpileModule(source, {
        fileName: relative, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      })
      assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
      compiled.set(relative, result.outputText)
    }
    const module = { exports: {} }
    cache.set(relative, module)
    const require = name => {
      if (name === 'electron') return {
        BrowserWindow: class { constructor() { deny('real BrowserWindow') } },
        shell: { openExternal: () => deny('external browser') }, app: {},
        session: { fromPartition(partition) { partitions.push(partition); return fakeSession } },
      }
      if (name === 'http') return { createServer: () => deny('HTTP listener') }
      if (name === 'events') return { EventEmitter }
      if (name === 'crypto') return crypto
      if (name === './inAppLogin') return { inAppLoginManager: login }
      if (name === '../store/store') return { storeManager: fakeStore }
      if (name === './zaiSession' || name === '../zaiSession') return load('src/main/oauth/zaiSession.ts')
      if (name === './base') return { BaseOAuthAdapter: FakeBaseAdapter }
      if (name === './adapters') return {
        createAdapter(providerType, config) {
          assert.equal(config.providerType, providerType)
          if (providerType === 'zai') return new (load('src/main/oauth/adapters/zai.ts').ZaiAdapter)(config)
          return {
            setMainWindow() {}, setProgressCallback() {}, destroy() {},
            async validateToken(credentials) {
              validations.push(clone(credentials))
              const result = validationReplies.length ? validationReplies.shift() : { valid: true }
              if (result instanceof Error) throw result
              return result
            },
          }
        },
      }
      return deny('unexpected import ' + name)
    }
    vm.runInNewContext(compiled.get(relative), {
      module, exports: module.exports, require, console: fakeConsole, Buffer, URL, URLSearchParams,
      AbortController, Date: FakeDate,
      setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id },
      clearTimeout(id) { timers.delete(id) },
    }, { filename: fileURLToPath(new URL(relative, root)), timeout: 1000 })
    return module.exports
  }
  const exports = load('src/main/oauth/manager.ts')
  const manager = exports.oauthManager
  manager.setMainWindow({
    isDestroyed: () => false,
    webContents: {
      send(channel, event) {
        if (options.notificationError && event.status === (options.notificationFailureStatus ?? 'success')) {
          throw options.notificationError
        }
        progress.push({ channel, event: clone(event) })
      },
    },
  })
  manager.on('statusChange', value => status.push(value))
  return {
    manager, exports, load, login, state, original, reads, updates, starts, completions, validations,
    fetches, partitions, timers, logs, progress, status,
    now: value => { now = value },
    timer(ms) {
      const item = [...timers].find(([, timer]) => timer.ms === ms)
      assert.ok(item, 'Expected pending timer ' + ms)
      timers.delete(item[0])
      item[1].callback()
    },
    async cancelAfterRejection(pending) {
      await flush()
      assert.equal(login.open, true, 'A rejected candidate must leave time for another login candidate')
      assert.equal(manager.getStatus(), 'pending')
      assert.equal(completions.length, 0)
      assert.equal(updates.length, 0)
      manager.cancelInAppLogin()
      const result = await pending
      assert.equal(result.reason, 'login_cancelled')
      return result
    },
    assertUnchanged() { assert.deepEqual(state, original); assert.equal(updates.length, 0) },
    assertPrivate(result, secrets = []) {
      const output = JSON.stringify({ result, logs, progress, status })
      for (const secret of [SUBJECT, 'stored@example.invalid', 'synthetic-captcha-option', ...secrets]) {
        assert.ok(!output.includes(secret), 'No credential, identity or upstream body may escape')
      }
      assert.deepEqual(forbidden, [])
      assert.equal(timers.size, 0)
      assert.equal(login.listenerCount('tokenFound'), 0)
      assert.equal(login.listenerCount('status'), 0)
      assert.equal(login.listenerCount('complete'), 0)
    },
  }
}

test('reconnect preserves existing ID and metadata with expired baseline identity and one partition GET', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT, private_profile: 'synthetic-profile-canary' })] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  assert.equal(h.starts[0].persistentAccountId, 'account-original')
  assert.equal(h.starts[0].providerType, 'zai')
  assert.equal(h.starts[0].proxyMode, 'none')
  h.login.token(candidate, { allCookies: { evil: 'synthetic-unrelated-cookie' } })
  const result = plain(await pending)
  assert.deepEqual(result, { success: true, accountId: 'account-original' })
  assert.equal(h.fetches.length, 1)
  assert.equal(h.fetches[0].url, AUTH_URL)
  const init = h.fetches[0].init
  assert.equal(init.method, 'GET')
  assert.equal(init.credentials, 'include')
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers.Authorization, 'Bearer ' + candidate)
  assert.equal(Object.hasOwn(init.headers, 'Cookie'), false)
  assert.equal(h.partitions[0], 'persist:chat2api-zai-' +
    crypto.createHash('sha256').update('account-original').digest('hex').slice(0, 32))
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].id, 'account-original')
  assert.deepEqual(Object.keys(h.updates[0].value).sort(), ['credentials', 'errorMessage', 'status'])
  const saved = h.state.accounts[0], old = h.original.accounts[0]
  for (const key of ['id', 'providerId', 'createdAt', 'name', 'email', 'requestCount', 'todayUsed', 'dailyLimit']) {
    assert.deepEqual(saved[key], old[key])
  }
  assert.equal(saved.credentials.token, candidate)
  assert.equal(saved.credentials.captcha_verify_param, old.credentials.captcha_verify_param)
  assert.equal(saved.credentials.cookies, undefined)
  assert.equal(saved.status, 'active')
  assert.equal(saved.errorMessage, undefined)
  assert.deepEqual(h.state.config, h.original.config)
  assert.equal(h.completions[0].generation, 1)
  h.assertPrivate(result, [candidate, old.credentials.token, 'synthetic-profile-canary', 'synthetic-unrelated-cookie'])
})

for (const [name, metadata] of [
  ['empty', {}],
  ['inaccurate', { url: 'https://example.invalid/unreliable-response-metadata' }],
]) {
  test('authenticated fixed-origin response accepts ' + name + ' Response.url metadata', async () => {
    const candidate = jwt()
    const response = authResponse({ id: SUBJECT }, metadata)
    assert.equal(response.url, metadata.url ?? '')
    const h = harness({ replies: [response] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    try {
      h.login.token(candidate)
      await flush()
      assert.equal(h.updates.length, 1, 'Valid identity JSON must not be rejected by unreliable URL metadata')
      const result = plain(await pending)
      assert.deepEqual(result, { success: true, accountId: 'account-original' })
      assert.equal(h.fetches.length, 1)
      assert.equal(h.fetches[0].url, AUTH_URL)
      assert.equal(h.fetches[0].init.redirect, 'error')
      assert.equal(h.fetches[0].init.credentials, 'include')
      assert.equal(h.fetches[0].init.headers.Authorization, 'Bearer ' + candidate)
      assert.equal(h.state.accounts[0].credentials.token, candidate)
      h.assertPrivate(result, [candidate])
    } finally {
      if (h.login.open) h.manager.cancelInAppLogin()
    }
  })
}

test('matching server replacement token is saved; stored provider options and legacy aliases survive', async () => {
  const oldToken = jwt({ exp: NOW / 1000 - 5 })
  const candidate = jwt(), replacement = jwt({ exp: NOW / 1000 + 7200 })
  const account = fixtureAccount({ credentials: {
    token: oldToken, accessToken: oldToken, jwt: oldToken, captchaVerifyParam: 'synthetic-keep-captcha',
  } })
  const h = harness({ accounts: [account], replies: [authResponse({ id: SUBJECT, token: replacement })] })
  const pending = h.manager.reconnectZaiAccount(account.id)
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.success, true)
  const credentials = h.state.accounts[0].credentials
  for (const key of ['token', 'accessToken', 'jwt']) assert.equal(credentials[key], replacement)
  assert.equal(credentials.captchaVerifyParam, 'synthetic-keep-captcha')
  h.assertPrivate(result, [oldToken, candidate, replacement, 'synthetic-keep-captcha'])
})

for (const [name, input, options, reason] of [
  ['missing', 'absent-account', {}, 'account_unavailable'],
  ['empty ID', '', {}, 'invalid_account_id'],
  ['wrong provider', 'account-original', { accounts: [fixtureAccount({ providerId: 'glm' })] }, 'account_unavailable'],
  ['disabled provider', 'account-original', { provider: { id: 'zai', enabled: false } }, 'provider_unavailable'],
  ['missing subject', 'account-original', { accounts: [fixtureAccount({ credentials: { token: jwt({ id: null }) } })] }, 'identity_unavailable'],
  ['malformed timestamp', 'account-original', { accounts: [fixtureAccount({ updatedAt: 'wrong-type' })] }, 'identity_unavailable'],
]) {
  test('invalid starting account: ' + name, async () => {
    const h = harness(options)
    const result = plain(await h.manager.reconnectZaiAccount(input))
    assert.deepEqual(result, { success: false, reason })
    assert.equal(h.starts.length, 0)
    assert.equal(h.fetches.length, 0)
    h.assertUnchanged()
    h.assertPrivate(result)
  })
}

for (const [name, candidate] of [
  ['expired', jwt({ exp: NOW / 1000 - 1 })],
  ['short remaining life', jwt({ exp: NOW / 1000 + 15 })],
  ['null expiry', jwt({ exp: null })],
  ['string expiry', jwt({ exp: String(NOW / 1000 + 3600) })],
  ['future nbf', jwt({ nbf: NOW / 1000 + 60 })],
  ['guest', jwt({ email: 'someone@guest.com' })],
  ['malformed', 'synthetic-invalid-token'],
  ['other identity', jwt({ id: 'synthetic-other-subject' })],
]) {
  test('candidate is rejected before authentication request: ' + name, async () => {
    const h = harness()
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(candidate)
    const result = await h.cancelAfterRejection(pending)
    assert.equal(result.success, false)
    assert.equal(h.fetches.length, 0)
    h.assertUnchanged()
    h.assertPrivate(result, [candidate])
  })
}

for (const [name, makeResponse] of [
  ['401', () => authResponse({ token: 'synthetic-error-canary' }, { status: 401 })],
  ['403', () => authResponse({ token: 'synthetic-error-canary' }, { status: 403 })],
  ['wrong server identity', () => authResponse({ id: 'synthetic-other-subject' })],
  ['nested identity only', () => authResponse({ user: { id: SUBJECT } })],
  ['array response', () => authResponse([{ id: SUBJECT }])],
  ['redirected', () => authResponse({ id: SUBJECT }, { redirected: true })],
  ['missing redirect status', () => authResponse({ id: SUBJECT }, { redirected: undefined })],
  ['HTTP redirect', () => authResponse({ id: SUBJECT }, { status: 302, headers: { Location: 'https://example.invalid/profile' } })],
  ['HTML', () => authResponse({ id: SUBJECT }, { headers: { 'Content-Type': 'text/html' } })],
  ['bad JSON', () => authResponse(null, { raw: '{"synthetic-secret-canary":' })],
  ['null token', () => authResponse({ id: SUBJECT, token: null })],
  ['empty token', () => authResponse({ id: SUBJECT, token: '' })],
  ['expired replacement', () => authResponse({ id: SUBJECT, token: jwt({ exp: NOW / 1000 - 1 }) })],
  ['foreign replacement', () => authResponse({ id: SUBJECT, token: jwt({ id: 'synthetic-other-subject' }) })],
  ['large length', () => authResponse({ id: SUBJECT }, { headers: { 'Content-Length': '999999' } })],
  ['large actual body', () => authResponse({ id: SUBJECT, ignored: 'x'.repeat(70 * 1024) })],
]) {
  test('authentication failure preserves original account: ' + name, async () => {
    const candidate = jwt()
    const h = harness({ replies: [makeResponse()] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(candidate)
    await flush()
    assert.equal(h.login.open, true)
    h.login.token(candidate)
    await flush()
    assert.equal(h.fetches.length, 1)
    h.assertUnchanged()
    const result = await h.cancelAfterRejection(pending)
    h.assertPrivate(result, [candidate, 'synthetic-error-canary', 'synthetic-secret-canary'])
  })
}

test('network exception never returns its token-bearing message or request object', async () => {
  const candidate = jwt()
  const error = Object.assign(new Error('synthetic-exception-secret ' + candidate), {
    config: { url: AUTH_URL + '?token=' + candidate, headers: { Authorization: candidate } },
  })
  const h = harness({ replies: [error] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  const result = await h.cancelAfterRejection(pending)
  h.assertUnchanged()
  h.assertPrivate(result, [candidate, 'synthetic-exception-secret'])
})

for (const mode of ['cancel', 'close', 'login-timeout', 'destroy']) {
  test('late authentication result cannot write after ' + mode, async () => {
    const response = deferred(), candidate = jwt(), queued = jwt({ exp: NOW / 1000 + 8000 })
    const h = harness({ replies: [response.promise] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(candidate)
    await flush()
    assert.equal(h.fetches.length, 1)
    h.login.token(queued)
    if (mode === 'cancel') h.manager.cancelInAppLogin()
    if (mode === 'close') h.login.end({ success: false, error: 'Login window was closed' })
    if (mode === 'login-timeout') h.timer(300000)
    if (mode === 'destroy') h.manager.destroy()
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(h.fetches[0].init.signal.aborted, true)
    response.resolve(authResponse({ id: SUBJECT, token: candidate }))
    await flush()
    assert.equal(h.completions.length, 0)
    assert.equal(h.fetches.length, 1, 'Cancellation must also discard the queued candidate')
    h.assertUnchanged()
    h.assertPrivate(result, [candidate, queued])
  })
}

test('authentication deadline also bounds a stalled JSON body', async () => {
  let controller
  const stream = new ReadableStream({ start(value) { controller = value } })
  const candidate = jwt()
  const h = harness({ replies: [authResponse(null, { stream })] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  await flush()
  h.timer(12000)
  await flush()
  assert.equal(h.login.open, true)
  assert.equal(h.fetches[0].init.signal.aborted, true)
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: SUBJECT, token: candidate })))
  controller.close()
  await flush()
  h.assertUnchanged()
  const result = await h.cancelAfterRejection(pending)
  h.assertPrivate(result, [candidate])
})

for (const [name, mutate] of [
  ['delete', state => { state.accounts = [] }],
  ['provider', state => { state.accounts[0].providerId = 'glm' }],
  ['createdAt', state => { state.accounts[0].createdAt-- }],
  ['updatedAt', state => { state.accounts[0].updatedAt++ }],
  ['status', state => { state.accounts[0].status = 'inactive' }],
  ['same-subject token at same timestamp', state => { state.accounts[0].credentials.token = jwt({ exp: NOW / 1000 + 500 }) }],
  ['disabled provider', state => { state.provider.enabled = false }],
]) {
  test('concurrent account mutation is not overwritten: ' + name, async () => {
    const response = deferred(), candidate = jwt()
    const h = harness({ replies: [response.promise] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(candidate)
    await flush()
    mutate(h.state)
    const changed = clone(h.state)
    response.resolve(authResponse({ id: SUBJECT }))
    const result = await pending
    assert.equal(result.reason, 'account_changed')
    assert.equal(h.updates.length, 0)
    assert.deepEqual(h.state, changed)
    assert.ok(!h.status.includes('success'))
    h.assertPrivate(result, [candidate])
  })
}

test('expiry is checked again immediately before the store write', async () => {
  const candidate = jwt({ exp: NOW / 1000 + 31 })
  let h
  h = harness({ replies: [authResponse({ id: SUBJECT })],
    onRead(_state, count) { if (count === 2) h.now(NOW + 2000) },
  })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.reason, 'invalid_session')
  h.assertUnchanged()
  h.assertPrivate(result, [candidate])
})

for (const failure of ['throw', 'null']) {
  test('store ' + failure + ' returns no premature success notification', async () => {
    const candidate = jwt()
    const h = harness({
      replies: [authResponse({ id: SUBJECT })],
      ...(failure === 'throw' ? { writeError: new Error('synthetic-store-secret ' + candidate) } : { writeNull: true }),
    })
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(candidate)
    const result = await pending
    assert.equal(result.reason, 'storage_unavailable')
    assert.equal(h.updates.length, 1)
    assert.deepEqual(h.state, h.original)
    assert.ok(!h.status.includes('success'))
    assert.ok(!h.progress.some(({ event }) => event.status === 'success'))
    h.assertPrivate(result, [candidate, 'synthetic-store-secret'])
  })
}

test('post-commit notification failure retains the success receipt without a second write', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })],
    notificationError: new Error('synthetic-notification-secret ' + candidate) })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  const result = plain(await pending)
  assert.deepEqual(result, { success: true, accountId: 'account-original' })
  assert.equal(h.updates.length, 1)
  h.assertPrivate(result, [candidate, 'synthetic-notification-secret'])
})

test('renderer reload during progress cannot strand the reconnect lock or expose its exception', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })],
    notificationError: new Error('synthetic-progress-secret ' + candidate), notificationFailureStatus: 'pending' })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.updates.length, 1)
  assert.equal(h.manager.getStatus(), 'idle')
  h.assertPrivate(result, [candidate, 'synthetic-progress-secret'])
})

test('one reconnect lock blocks both another manager instance and public login paths', async () => {
  const h = harness()
  const pending = h.manager.reconnectZaiAccount('account-original')
  const other = new h.exports.OAuthManager()
  assert.equal((await other.reconnectZaiAccount('account-original')).reason, 'busy')
  assert.equal((await other.startInAppLogin('zai', 'zai')).success, false)
  assert.equal((await h.manager.startLogin({ providerId: 'zai', providerType: 'zai' })).success, false)
  assert.equal(h.starts.length, 1)
  h.manager.cancelInAppLogin()
  const result = await pending
  h.assertUnchanged()
  h.assertPrivate(result)
})

test('persistent candidate generation is forwarded and missing, invalid or older generations are ignored', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  for (const generation of [undefined, 0, -1, 1.5, NaN]) h.login.token(candidate, { generation })
  assert.equal(h.fetches.length, 0)
  h.login.navigate()
  h.login.token(candidate)
  h.login.token(jwt({ id: 'synthetic-wrong' }), { generation: 1 })
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.completions[0].generation, 2)
  assert.equal(h.fetches.length, 1)
  h.assertPrivate(result, [candidate])
})

test('same-generation rotations coalesce to the latest candidate while a server request is pending', async () => {
  const response = deferred(), latestResponse = deferred()
  const candidate = jwt(), skipped = jwt({ exp: NOW / 1000 + 5000 }), replacement = jwt({ exp: NOW / 1000 + 8000 })
  const h = harness({ replies: [response.promise, latestResponse.promise] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  await flush()
  h.login.token(skipped)
  h.login.token(replacement)
  h.login.token(replacement)
  assert.equal(h.fetches.length, 1)
  response.resolve(authResponse({ id: SUBJECT, token: candidate }))
  await flush()
  assert.equal(h.fetches.length, 2)
  assert.equal(h.fetches[1].init.headers.Authorization, 'Bearer ' + replacement)
  assert.equal(h.completions.length, 0, 'The superseded successful response must not complete the login')
  h.assertUnchanged()
  latestResponse.resolve(authResponse({ id: SUBJECT }))
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.state.accounts[0].credentials.token, replacement)
  assert.equal(h.updates.length, 1)
  assert.equal(h.completions.length, 1)
  assert.equal(h.completions[0].generation, 1)
  h.assertPrivate(result, [candidate, skipped, replacement])
})

for (const changedToken of [false, true]) {
  test('new same-window document generation queues its ' + (changedToken ? 'new' : 'unchanged') + ' token', async () => {
    const previousResponse = deferred(), currentResponse = deferred()
    const previous = jwt(), current = changedToken ? jwt({ exp: NOW / 1000 + 8000 }) : previous
    const h = harness({ replies: [previousResponse.promise, currentResponse.promise] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(previous)
    await flush()
    h.login.navigate()
    h.login.token(current)
    h.login.token(jwt({ id: 'synthetic-stale-wrong-subject' }), { generation: 1 })
    assert.equal(h.starts.length, 1)
    assert.equal(h.fetches.length, 1)
    previousResponse.resolve(authResponse({ id: SUBJECT, token: previous }))
    await flush()
    assert.equal(h.fetches.length, 2)
    assert.equal(h.completions.length, 0)
    assert.equal(h.login.open, true)
    h.assertUnchanged()
    currentResponse.resolve(authResponse({ id: SUBJECT }))
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(h.state.accounts[0].credentials.token, current)
    assert.equal(h.updates.length, 1)
    assert.equal(h.completions.length, 1)
    assert.equal(h.completions[0].generation, 2)
    h.assertPrivate(result, [previous, current])
  })
}

for (const failure of ['403', 'network rejection', 'request timeout']) {
  test('a later Z.ai candidate is accepted after async ' + failure + ' with no replacement already queued', async () => {
    const firstResponse = deferred()
    const previous = jwt(), current = jwt({ exp: NOW / 1000 + 8000 })
    const h = harness({ replies: [firstResponse.promise, authResponse({ id: SUBJECT })] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    const overallTimer = [...h.timers].find(([, timer]) => timer.ms === 300000)[0]
    h.login.token(previous)
    await flush()
    if (failure === '403') firstResponse.resolve(authResponse({ token: 'synthetic-rejected-secret' }, { status: 403 }))
    if (failure === 'network rejection') firstResponse.reject(new Error('synthetic-rejected-secret ' + previous))
    if (failure === 'request timeout') h.timer(12000)
    await flush()
    assert.equal(h.login.open, true)
    assert.equal(h.manager.getStatus(), 'pending')
    assert.equal(h.completions.length, 0)
    h.assertUnchanged()
    h.login.token(previous)
    await flush()
    assert.equal(h.fetches.length, 1, 'A failed candidate must not be retried automatically or by duplicate capture')
    assert.equal(h.timers.has(overallTimer), true, 'Candidate failure must not replace the overall deadline')
    h.login.token(current)
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(h.fetches.length, 2)
    assert.equal(h.state.accounts[0].credentials.token, current)
    assert.equal(h.updates.length, 1)
    assert.equal(h.completions.length, 1)
    if (failure === 'request timeout') {
      assert.equal(h.fetches[0].init.signal.aborted, true)
      firstResponse.resolve(authResponse({ id: SUBJECT, token: previous }))
      await flush()
      assert.equal(h.updates.length, 1)
    }
    h.assertPrivate(result, [previous, current, 'synthetic-rejected-secret'])
  })
}

for (const rejection of ['403', 'network rejection']) {
  test('queued candidate survives the superseded server ' + rejection, async () => {
    const response = deferred(), previous = jwt(), current = jwt({ exp: NOW / 1000 + 8000 })
    const h = harness({ replies: [response.promise, authResponse({ id: SUBJECT })] })
    const pending = h.manager.reconnectZaiAccount('account-original')
    h.login.token(previous)
    await flush()
    h.login.token(current)
    if (rejection === '403') response.resolve(authResponse({}, { status: 403 }))
    else response.reject(new Error('synthetic-stale-secret ' + previous))
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(h.fetches.length, 2)
    assert.equal(h.updates.length, 1)
    assert.equal(h.completions.length, 1)
    assert.equal(h.state.accounts[0].credentials.token, current)
    h.assertPrivate(result, [previous, current, 'synthetic-stale-secret'])
  })
}

test('superseded server timeout aborts only its request and drains the queued candidate', async () => {
  const response = deferred(), previous = jwt(), current = jwt({ exp: NOW / 1000 + 8000 })
  const h = harness({ replies: [response.promise, authResponse({ id: SUBJECT })] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(previous)
  await flush()
  h.login.token(current)
  h.timer(12000)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.fetches.length, 2)
  assert.equal(h.fetches[0].init.signal.aborted, true)
  assert.equal(h.updates.length, 1)
  assert.equal(h.state.accounts[0].credentials.token, current)
  response.resolve(authResponse({ id: SUBJECT, token: previous }))
  await flush()
  assert.equal(h.completions.length, 1)
  h.assertPrivate(result, [previous, current])
})

test('document change before its next capture rejects stale completion and later accepts the new candidate', async () => {
  const response = deferred(), previous = jwt(), current = jwt({ exp: NOW / 1000 + 8000 })
  const h = harness({ replies: [response.promise, authResponse({ id: SUBJECT })] })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(previous)
  await flush()
  h.login.navigate()
  response.resolve(authResponse({ id: SUBJECT }))
  await flush()
  assert.equal(h.completions.length, 1, 'The bridge sees the stale attempt and refuses its generation')
  assert.equal(h.completions[0].generation, 1)
  assert.equal(h.login.open, true)
  h.assertUnchanged()
  h.login.token(current)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.fetches.length, 2)
  assert.equal(h.completions.length, 2)
  assert.equal(h.completions[1].generation, 2)
  assert.equal(h.updates.length, 1)
  assert.equal(h.state.accounts[0].credentials.token, current)
  h.assertPrivate(result, [previous, current])
})

test('late generic validation A cannot complete or close login B', async () => {
  const oldValidation = deferred()
  const h = harness({ validations: [oldValidation.promise, { valid: true }] })
  const a = h.manager.startInAppLogin('deepseek', 'deepseek')
  h.login.token('synthetic-token-A')
  await flush()
  h.manager.cancelInAppLogin()
  assert.equal((await a).success, false)
  const b = h.manager.startInAppLogin('deepseek', 'deepseek')
  oldValidation.resolve({ valid: true })
  await flush()
  assert.equal(h.login.open, true)
  assert.equal(h.completions.length, 0)
  h.login.token('synthetic-token-B')
  const result = await b
  assert.equal(result.success, true)
  assert.equal(result.credentials.token, 'synthetic-token-B')
  assert.equal(h.completions.length, 1)
  assert.equal(h.completions[0].generation, 2)
  assert.equal(h.starts.some(value => Object.hasOwn(value, 'persistentAccountId')), false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.fetches.length, 0)
})

test('generic invalid candidate can be replaced without changing non-persistent behavior', async () => {
  const h = harness({ validations: [{ valid: false }, { valid: true }] })
  const pending = h.manager.startInAppLogin('deepseek', 'deepseek')
  h.login.token('synthetic-invalid')
  await flush()
  assert.equal(h.login.open, true)
  assert.equal(h.manager.getStatus(), 'pending')
  h.login.token('synthetic-replacement', { allCookies: { session: 'synthetic-generic-cookie' } })
  const result = await pending
  assert.equal(result.credentials.token, 'synthetic-replacement')
  assert.equal(result.credentials.cookies.session, 'synthetic-generic-cookie')
  assert.equal(h.manager.getStatus(), 'idle')
  assert.equal(h.timers.size, 0)
})

test('generic async rejection releases validation so a later fresh candidate can finish', async () => {
  const rejected = deferred()
  const h = harness({ validations: [rejected.promise, { valid: true }] })
  const pending = h.manager.startInAppLogin('deepseek', 'deepseek')
  h.login.token('synthetic-rejected-token')
  rejected.reject(new Error('synthetic-validation-secret synthetic-rejected-token'))
  await flush()
  assert.equal(h.login.open, true)
  assert.equal(h.completions.length, 0)
  h.login.token('synthetic-rejected-token')
  await flush()
  assert.equal(h.validations.length, 1)
  h.login.token('synthetic-fresh-token')
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(result.credentials.token, 'synthetic-fresh-token')
  assert.equal(h.validations.length, 2)
  assert.equal(h.completions.length, 1)
  h.assertUnchanged()
  h.assertPrivate({ success: result.success }, ['synthetic-rejected-token', 'synthetic-fresh-token', 'synthetic-validation-secret'])
})

for (const outcome of ['success', 'rejection']) {
  test('queued generic candidate survives the superseded adapter ' + outcome, async () => {
    const previous = deferred()
    const h = harness({ validations: [previous.promise, { valid: true }] })
    const pending = h.manager.startInAppLogin('deepseek', 'deepseek')
    h.login.token('synthetic-earlier-token')
    h.login.token('synthetic-latest-token')
    assert.equal(h.validations.length, 1)
    if (outcome === 'success') previous.resolve({ valid: true })
    else previous.reject(new Error('synthetic-stale-validation-secret'))
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(result.credentials.token, 'synthetic-latest-token')
    assert.equal(h.validations.length, 2)
    assert.equal(h.completions.length, 1)
    assert.equal(h.completions[0].credentials.token, 'synthetic-latest-token')
    h.assertUnchanged()
    h.assertPrivate({ success: result.success }, ['synthetic-earlier-token', 'synthetic-latest-token', 'synthetic-stale-validation-secret'])
  })
}

test('duplicate generic cookie bundles with different key order do not supersede a pending candidate', async () => {
  const validation = deferred()
  const h = harness({ validations: [validation.promise] })
  const pending = h.manager.startInAppLogin('deepseek', 'deepseek')
  h.login.token('synthetic-bundle-token', { allCookies: { first: 'synthetic-first', second: 'synthetic-second' } })
  h.login.token('synthetic-bundle-token', { allCookies: { second: 'synthetic-second', first: 'synthetic-first' } })
  validation.resolve({ valid: true })
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.validations.length, 1)
  assert.equal(h.completions.length, 1)
  assert.deepEqual(plain(result.credentials.cookies), { first: 'synthetic-first', second: 'synthetic-second' })
  h.assertPrivate({ success: result.success }, ['synthetic-bundle-token', 'synthetic-first', 'synthetic-second'])
})

test('MiniMax and Mimo collection contracts remain intact', async () => {
  for (const provider of ['minimax', 'mimo']) {
    const h = harness()
    const pending = h.manager.startInAppLogin(provider, provider)
    if (provider === 'minimax') {
      h.login.token('synthetic-minimax-token')
      assert.equal(h.validations.length, 0)
      h.login.token('synthetic-minimax-id', { key: 'realUserID' })
    } else {
      h.login.token('synthetic-service', { key: 'serviceToken' })
      h.login.token('synthetic-user', { key: 'userId' })
      assert.equal(h.validations.length, 0)
      h.login.token('synthetic-ph', { key: 'xiaomichatbot_ph' })
    }
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(h.validations.length, 1)
    if (provider === 'minimax') {
      assert.equal(h.validations[0].token, 'synthetic-minimax-id+synthetic-minimax-token')
      assert.equal(result.credentials.realUserID, 'synthetic-minimax-id')
    } else {
      assert.deepEqual(plain(result.credentials), { service_token: 'synthetic-service', user_id: 'synthetic-user', ph_token: 'synthetic-ph' })
    }
    assert.equal(h.fetches.length, 0)
    assert.equal(h.timers.size, 0)
  }
})

test('public Z.ai login cannot select an existing persistent account through extra arguments', async () => {
  const candidate = jwt()
  const h = harness()
  const pending = h.manager.startInAppLogin('zai', 'zai', undefined, undefined,
    { persistentAccountId: 'account-original' })
  assert.equal(Object.hasOwn(h.starts[0], 'persistentAccountId'), false)
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(result.credentials.token, candidate)
  assert.equal(h.partitions.length, 0)
  assert.equal(h.fetches.length, 0)
  h.assertUnchanged()
  h.assertPrivate({ success: result.success }, [candidate])
})

test('account stays unchanged until the persistent session flush completes', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })], deferCompletion: true })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  await flush()
  assert.equal(h.completions.length, 1)
  assert.equal(h.updates.length, 0)
  assert.equal((await h.manager.reconnectZaiAccount('account-original')).reason, 'busy')
  assert.ok(!h.progress.some(({ event }) => event.status === 'success'))
  h.login.finishAccepted()
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.updates.length, 1)
  h.assertPrivate(result, [candidate])
})

test('cancelling during persistent flush leaves the original account intact', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })], deferCompletion: true })
  const pending = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidate)
  await flush()
  assert.equal(h.completions.length, 1)
  h.manager.cancelInAppLogin()
  const result = await pending
  assert.equal(result.reason, 'login_cancelled')
  h.login.finishAccepted()
  await flush()
  h.assertUnchanged()
  h.assertPrivate(result, [candidate])
})

test('late cancelled reconnect A cannot overwrite successful reconnect B', async () => {
  const oldResponse = deferred()
  const candidateA = jwt(), candidateB = jwt({ exp: NOW / 1000 + 8000 })
  const h = harness({ replies: [oldResponse.promise, authResponse({ id: SUBJECT })] })
  const first = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidateA)
  await flush()
  h.manager.cancelInAppLogin()
  assert.equal((await first).success, false)
  const second = h.manager.reconnectZaiAccount('account-original')
  h.login.token(candidateB)
  const result = await second
  assert.equal(result.success, true)
  oldResponse.resolve(authResponse({ id: SUBJECT, token: candidateA }))
  await flush()
  assert.equal(h.updates.length, 1)
  assert.equal(h.state.accounts[0].credentials.token, candidateB)
  assert.equal(h.completions.length, 1)
  assert.equal(h.completions[0].generation, 2)
  h.assertPrivate(result, [candidateA, candidateB])
})

test('Z.ai adapter local metadata rejects expiry without claiming network authentication', async () => {
  const h = harness()
  const Adapter = h.load('src/main/oauth/adapters/zai.ts').ZaiAdapter
  const adapter = new Adapter({})
  const valid = await adapter.validateToken({ token: jwt() })
  assert.equal(valid.valid, true)
  assert.equal(valid.accountInfo.userId, SUBJECT)
  assert.equal(valid.expiresAt, NOW + 3600000)
  for (const token of [jwt({ exp: NOW / 1000 }), jwt({ nbf: NOW / 1000 + 100 }), jwt({ email: 'guest@guest.com' }), 'broken']) {
    assert.equal((await adapter.validateToken({ token })).valid, false)
  }
  assert.equal(h.fetches.length, 0)
})
