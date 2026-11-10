import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

// Source-only no-exp regression tests. All accounts, JWTs, HTTP and persistence are synthetic.
// Only the manager, local Z.ai adapter and claim parser are loaded; real effects are denied.
const root = new URL('../../', import.meta.url)
const NOW = Date.UTC(2026, 10, 9, 0)
const SUBJECT = 'synthetic-new-subject'
const OTHER_SUBJECT = 'synthetic-other-subject'
const AUTH_URL = 'https://chat.z.ai/api/v1/auths/'
const NEW_ID = 'synthetic-created-1'
const compiled = new Map()
const plain = value => JSON.parse(JSON.stringify(value))
const clone = value => value === undefined ? undefined : structuredClone(value)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve))
}
const scenario = (name, run) => test(name, { timeout: 2000 }, run)
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
  const response = new Response(options.raw ?? JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  // Preserve Electron's ordinary reconstructed response: empty URL, no redirect.
  if (Object.hasOwn(options, 'redirected')) {
    Object.defineProperty(response, 'redirected', { value: options.redirected })
  }
  return response
}
function existingZai(overrides = {}) {
  return {
    id: 'synthetic-existing-zai', providerId: 'zai', name: 'Existing synthetic account',
    credentials: { token: jwt({ exp: undefined }), accessToken: jwt({ exp: undefined }),
      jwt: jwt({ exp: undefined }), captcha_verify_param: 'synthetic-preserved-option' },
    status: 'expired', createdAt: NOW - 50000, updatedAt: NOW - 40000,
    requestCount: 19, todayUsed: 2, dailyLimit: 40, ...overrides,
  }
}
function otherAccount(providerId = 'deepseek', overrides = {}) {
  return {
    id: 'synthetic-existing-' + providerId, providerId, name: 'Unrelated synthetic account',
    credentials: { token: 'synthetic-unrelated-protected-value' },
    status: 'active', createdAt: NOW - 100000, updatedAt: NOW - 90000,
    requestCount: 8, todayUsed: 1, ...overrides,
  }
}
function harness(options = {}) {
  const logs = [], progress = [], statuses = [], fetches = [], partitions = []
  const starts = [], completions = [], additions = [], writes = [], reads = [], generated = [], forbidden = []
  const updates = [], validations = []
  const timers = new Map(), cache = new Map()
  let timerId = 0, now = NOW, generation = 0, loginResolve, pendingFlush
  let scanCount = 0, providerReads = 0
  const state = {
    accounts: clone(options.accounts ?? (options.mode === 'reconnect' ? [existingZai()] : [])),
    provider: clone(Object.hasOwn(options, 'provider') ? options.provider : { id: 'zai', type: 'builtin', enabled: true }),
    config: clone({ oauthProxyMode: 'none', modelMappings: {
      'keep-route': { actualModel: 'synthetic-model', preferredProviderId: 'zai', preferredAccountId: 'synthetic-existing-zai' },
    } }),
  }
  const original = clone(state)
  const replies = [...(options.replies ?? [])]
  const ids = [...(options.ids ?? [NEW_ID, 'synthetic-created-2', 'synthetic-created-3'])]
  const unreadable = new Set(options.unreadable ?? [])
  const deny = what => {
    forbidden.push(what)
    throw new Error('Blocked operation: ' + what)
  }
  const login = new EventEmitter()
  login.open = false
  login.finalizing = false
  login.startLogin = input => {
    if (login.open) return Promise.resolve({ success: false, error: 'A login window is already open' })
    if (options.startError) throw options.startError
    starts.push(clone(input))
    generation++
    login.open = true
    login.finalizing = false
    return new Promise(resolve => { loginResolve = resolve })
  }
  login.isWindowOpen = () => login.open
  login.navigate = () => { generation++ }
  login.end = result => {
    if (!login.open) return
    const resolve = loginResolve
    loginResolve = undefined
    login.open = false
    login.finalizing = false
    resolve?.(result)
    login.emit('complete', result)
  }
  login.completeWithSuccess = (credentials, expectedGeneration) => {
    completions.push({ credentials: clone(credentials), generation: expectedGeneration })
    if (!login.open || expectedGeneration !== generation) return
    if (options.deferFlush) {
      login.finalizing = true
      pendingFlush = { credentials: clone(credentials), generation }
    } else {
      login.end({ success: true, credentials })
    }
  }
  login.finishFlush = (success = true) => {
    const saved = pendingFlush
    pendingFlush = undefined
    if (!saved || !login.open) return
    if (saved.generation !== generation) {
      login.end({ success: false, error: 'Login page changed before completion' })
    } else if (!success) {
      login.end({ success: false, error: 'Unable to preserve the login session' })
    } else {
      login.end({ success: true, credentials: saved.credentials })
    }
  }
  login.cancel = () => login.end({ success: false, error: 'Login cancelled by user' })
  login.destroy = () => { login.cancel(); login.removeAllListeners() }
  login.token = (value, extra = {}) => {
    if (!login.finalizing) login.emit('tokenFound', { key: 'token', value, generation, ...extra })
  }
  const fakeStore = {
    getProviderById(id) {
      assert.equal(id, 'zai')
      providerReads++
      options.onProviderRead?.(state, providerReads)
      return clone(state.provider)
    },
    getAccountsByProviderId(id, includeCredentials) {
      assert.equal(id, 'zai')
      assert.equal(includeCredentials, true)
      scanCount++
      reads.push({ kind: 'subjects', providerId: id, includeCredentials })
      options.onScan?.(state, scanCount)
      const accounts = state.accounts.filter(account => account.providerId === id)
      if (accounts.some(account => unreadable.has(account.id))) {
        throw new Error('synthetic-decryption-secret')
      }
      return clone(accounts)
    },
    getAccountById(id, includeCredentials = false) {
      reads.push({ kind: 'id', id, includeCredentials })
      options.onIdRead?.(state, id)
      const account = state.accounts.find(value => value.id === id)
      if (includeCredentials && account && unreadable.has(account.id)) throw new Error('synthetic-decryption-secret')
      return clone(account)
    },
    generateId() {
      const id = ids.shift()
      generated.push(id)
      if (options.generateError) throw options.generateError
      return id
    },
    getConfig: () => clone(state.config),
    addAccount(account) {
      additions.push(clone(account))
      // Atomic failure injection. Production addAccount encrypts before store.set.
      if (options.addError) throw options.addError
      state.accounts = [...state.accounts, clone(account)]
      writes.push(clone(account))
      options.afterAdd?.(state)
    },
    getAccounts: () => deny('unscoped credential enumeration'),
    updateAccount(id, patch) {
      assert.equal(options.mode, 'reconnect')
      assert.equal(id, 'synthetic-existing-zai')
      updates.push({ id, patch: clone(patch) })
      const account = state.accounts.find(row => row.id === id)
      assert.ok(account)
      const updated = { ...account, ...clone(patch), updatedAt: now }
      state.accounts = state.accounts.map(row => row.id === id ? updated : row)
      writes.push(clone(updated))
      return clone(updated)
    },
    deleteAccount: () => deny('account deletion'),
    updateConfig: () => deny('configuration mutation'),
  }
  const fakeSession = {
    async fetch(url, init) {
      fetches.push({ url, init })
      if (!replies.length) return deny('unmocked HTTP request')
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply(url, init) : reply
    },
  }
  const fakeConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug']
    .map(level => [level, (...args) => logs.push({ level, args })]))
  class FakeDate extends Date { static now() { return now } }
  class FakeBaseAdapter {
    setMainWindow() {}
    setProgressCallback(callback) { this.callback = callback }
    emitProgress(status, message) { this.callback?.({ status, message }) }
    destroy() {}
  }
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports
    assert.ok([
      'src/main/oauth/manager.ts', 'src/main/oauth/adapters/zai.ts', 'src/main/oauth/zaiSession.ts',
    ].includes(relative))
    if (!compiled.has(relative)) {
      const result = ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
        fileName: relative, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      })
      assert.equal((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
      compiled.set(relative, result.outputText)
    }
    const module = { exports: {} }
    cache.set(relative, module)
    const require = name => {
      if (name === 'events') return { EventEmitter }
      if (name === 'crypto') return crypto
      if (name === 'http') return { createServer: () => deny('HTTP listener') }
      if (name === 'electron') return {
        BrowserWindow: class { constructor() { deny('real browser window') } },
        shell: { openExternal: () => deny('external browser') }, app: {},
        session: { fromPartition(partition) { partitions.push(partition); return fakeSession } },
      }
      if (name === '../store/store') return { storeManager: fakeStore }
      if (name === './inAppLogin') return { inAppLoginManager: login }
      if (name === './zaiSession' || name === '../zaiSession') return load('src/main/oauth/zaiSession.ts')
      if (name === './base') return { BaseOAuthAdapter: FakeBaseAdapter }
      if (name === './adapters') return {
        createAdapter(providerType, config) {
          assert.equal(config.providerType, providerType)
          if (providerType === 'zai') {
            const adapter = new (load('src/main/oauth/adapters/zai.ts').ZaiAdapter)(config)
            const validate = adapter.validateToken.bind(adapter)
            adapter.validateToken = async credentials => {
              validations.push(clone(credentials))
              return validate(credentials)
            }
            return adapter
          }
          return { setMainWindow() {}, setProgressCallback() {}, destroy() {}, async validateToken() { return { valid: true } } }
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
  manager.setMainWindow({ isDestroyed: () => false, webContents: {
    send(channel, event) {
      if (options.notificationError && event.status === 'success') throw options.notificationError
      progress.push({ channel, event: clone(event) })
    },
  } })
  manager.on('statusChange', status => statuses.push(status))
  return {
    manager, exports, login, state, original, reads, additions, updates, validations, writes, generated, starts, completions,
    mode: options.mode ?? 'create',
    fetches, partitions, timers, logs, progress, statuses, unreadable,
    now(value) { now = value },
    timer(ms) {
      const entry = [...timers].find(([, value]) => value.ms === ms)
      assert.ok(entry, 'Expected pending timer ' + ms)
      timers.delete(entry[0])
      entry[1].callback()
    },
    assertNoWrite(expected = original) {
      assert.equal(writes.length, 0)
      assert.deepEqual(state, expected)
    },
    async cancelRejected(pending) {
      await flush()
      assert.equal(login.open, true)
      assert.equal(completions.length, 0)
      assert.equal(additions.length, 0)
      manager.cancelInAppLogin()
      const result = await pending
      assert.equal(result.reason, 'login_cancelled')
      return result
    },
    assertPrivate(result, secrets = []) {
      const output = JSON.stringify({ result, logs, progress, statuses })
      for (const secret of [SUBJECT, OTHER_SUBJECT, 'synthetic@example.invalid', 'synthetic-decryption-secret', ...secrets]) {
        assert.ok(!output.includes(secret), 'No credential, identity or raw error may escape')
      }
      assert.deepEqual(forbidden, [])
      assert.equal(timers.size, 0)
      assert.equal(login.listenerCount('tokenFound'), 0)
      assert.equal(login.listenerCount('status'), 0)
      assert.equal(login.listenerCount('complete'), 0)
    },
  }
}

const noexp = overrides => jwt({ exp: undefined, ...overrides })
const start = h => h.mode === 'reconnect'
  ? h.manager.reconnectZaiAccount('synthetic-existing-zai')
  : h.manager.createZaiAccount('No-exp account')

function assertSaved(h, result, token) {
  const accountId = h.mode === 'reconnect' ? 'synthetic-existing-zai' : h.generated.at(-1)
  assert.deepEqual(plain(result), { success: true, accountId })
  assert.equal(h.writes.length, 1)
  assert.equal(h.additions.length, h.mode === 'create' ? 1 : 0)
  assert.equal(h.updates.length, h.mode === 'reconnect' ? 1 : 0)
  const saved = h.state.accounts.find(account => account.id === accountId)
  assert.equal(saved.status, 'active')
  assert.equal(saved.credentials.token, token)
  assert.deepEqual(h.state.config, h.original.config)
  assert.deepEqual(h.state.provider, h.original.provider)
  if (h.mode === 'reconnect') {
    const previous = h.original.accounts.find(account => account.id === accountId)
    for (const key of ['id', 'providerId', 'name', 'email', 'createdAt', 'requestCount', 'todayUsed', 'dailyLimit']) {
      assert.deepEqual(saved[key], previous[key])
    }
    const expected = { ...previous.credentials, token }
    for (const alias of ['accessToken', 'jwt']) {
      if (Object.hasOwn(expected, alias)) expected[alias] = token
    }
    assert.deepEqual(saved.credentials, expected)
    assert.equal(h.state.accounts.length, h.original.accounts.length)
  } else {
    assert.deepEqual(saved.credentials, { token })
    assert.equal(saved.requestCount, 0)
    assert.equal(saved.todayUsed, 0)
    assert.deepEqual(h.state.accounts.filter(account => account.id !== accountId), h.original.accounts)
  }
  assert.equal(Object.hasOwn(saved, 'expiresAt'), false)
  h.assertPrivate(result, [token, 'synthetic-cookie-canary', 'synthetic-response-canary'])
}

for (const mode of ['create', 'reconnect']) {
  for (const [label, candidate, replacement] of [
    ['exp candidate and no-exp server token', jwt(), noexp({ nonce: 'replacement' })],
    ['no-exp candidate and no-exp server token', noexp({ nonce: 'candidate' }), noexp({ nonce: 'replacement' })],
    ['no-exp candidate without a replacement', noexp({ nonce: 'candidate' }), undefined],
    ['no-exp candidate and known-expiry replacement', noexp({ nbf: NOW / 1000 - 1 }), jwt({ nonce: 'replacement' })],
  ]) {
    scenario(mode + ' accepts only authenticated ' + label, async () => {
      const body = { id: SUBJECT, note: 'synthetic-response-canary' }
      if (replacement !== undefined) body.token = replacement
      const h = harness({ mode, replies: [authResponse(body)] })
      const pending = start(h)
      h.login.token(candidate, { allCookies: { session: 'synthetic-cookie-canary' } })
      const result = await pending
      assert.equal(h.fetches.length, 1)
      const request = h.fetches[0]
      assert.equal(request.url, AUTH_URL)
      assert.equal(request.init.method, 'GET')
      assert.equal(request.init.credentials, 'include')
      assert.equal(request.init.redirect, 'error')
      assert.equal(request.init.headers.Authorization, 'Bearer ' + candidate)
      assert.equal(Object.hasOwn(request.init.headers, 'Cookie'), false)
      assert.equal(h.validations.length, label.startsWith('exp candidate') ? 1 : 0)
      const expectedId = mode === 'reconnect' ? 'synthetic-existing-zai' : NEW_ID
      assert.deepEqual(h.partitions, [
        'persist:chat2api-zai-' + crypto.createHash('sha256').update(expectedId).digest('hex').slice(0, 32),
      ])
      assertSaved(h, result, replacement ?? candidate)
      h.assertPrivate(result, [candidate])
    })
  }

  scenario(mode + ' never treats no-exp identity as authentication or a completed cookie flush', async () => {
    const response = deferred(), candidate = noexp({ nonce: 'candidate' })
    const replacement = noexp({ nonce: 'server-replacement' })
    const h = harness({ mode, replies: [response.promise], deferFlush: true })
    const pending = start(h)
    h.login.token(candidate)
    await flush()
    assert.equal(h.fetches.length, 1)
    assert.equal(h.validations.length, 0)
    assert.equal(h.completions.length, 0)
    assert.ok(!h.statuses.includes('success'))
    h.assertNoWrite()
    response.resolve(authResponse({ id: SUBJECT, token: replacement }))
    await flush()
    assert.equal(h.completions.length, 1)
    assert.equal(h.login.finalizing, true)
    assert.ok(!h.statuses.includes('success'))
    h.assertNoWrite()
    h.login.finishFlush()
    assertSaved(h, await pending, replacement)
  })

  scenario(mode + ' rejects a forged low-level no-exp success without server verification', async () => {
    const candidate = noexp()
    const h = harness({ mode })
    const pending = start(h)
    h.login.end({ success: true, credentials: { token: candidate } })
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(h.fetches.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate])
  })

  for (const [label, candidate] of [
    ['present null exp', jwt({ exp: null })],
    ['present string exp', jwt({ exp: String(NOW / 1000 + 3600) })],
    ['present fractional exp', jwt({ exp: NOW / 1000 + 3600.5 })],
    ['present expired exp', jwt({ exp: NOW / 1000 - 1 })],
    ['present near-expiry exp', jwt({ exp: NOW / 1000 + 15 })],
    ['no-exp guest', noexp({ email: 'synthetic@guest.com' })],
    ['no-exp future nbf', noexp({ nbf: NOW / 1000 + 1 })],
    ['no-exp invalid nbf', noexp({ nbf: null })],
    ['no-exp missing subject', noexp({ id: undefined })],
    ['malformed canonical JWT', 'synthetic.invalid.signature'],
  ]) {
    scenario(mode + ' cannot use the no-exp exception for ' + label, async () => {
      const h = harness({ mode })
      const pending = start(h)
      h.login.token(candidate)
      const result = await h.cancelRejected(pending)
      assert.equal(h.fetches.length, 0)
      h.assertNoWrite()
      h.assertPrivate(result, [candidate])
    })
  }

  for (const [label, makeResponse] of [
    ['HTTP403', () => authResponse({ detail: 'synthetic-response-canary' }, { status: 403 })],
    ['missing root identity', () => authResponse({ token: noexp() })],
    ['nested identity', () => authResponse({ user: { id: SUBJECT }, token: noexp() })],
    ['wrong root identity', () => authResponse({ id: OTHER_SUBJECT, token: noexp() })],
    ['replacement wrong subject', () => authResponse({ id: SUBJECT, token: noexp({ id: OTHER_SUBJECT }) })],
    ['malformed replacement', () => authResponse({ id: SUBJECT, token: 'synthetic.invalid.signature' })],
    ['replacement guest', () => authResponse({ id: SUBJECT, token: noexp({ email: 'synthetic@guest.com' }) })],
    ['replacement future nbf', () => authResponse({ id: SUBJECT, token: noexp({ nbf: NOW / 1000 + 1 }) })],
    ['replacement invalid nbf', () => authResponse({ id: SUBJECT, token: noexp({ nbf: 'invalid' }) })],
    ['null replacement', () => authResponse({ id: SUBJECT, token: null })],
    ['replacement bad exp', () => authResponse({ id: SUBJECT, token: jwt({ exp: null }) })],
    ['replacement expired exp', () => authResponse({ id: SUBJECT, token: jwt({ exp: NOW / 1000 - 1 }) })],
    ['replacement near-expiry exp', () => authResponse({ id: SUBJECT, token: jwt({ exp: NOW / 1000 + 15 }) })],
  ]) {
    scenario(mode + ' rejects ' + label + ' without fallback, mutation or automatic retry', async () => {
      const candidate = noexp({ nonce: 'candidate' })
      const h = harness({ mode, replies: [makeResponse()] })
      const pending = start(h)
      h.login.token(candidate)
      await flush()
      h.login.token(candidate)
      await flush()
      assert.equal(h.fetches.length, 1)
      const result = await h.cancelRejected(pending)
      h.assertNoWrite()
      h.assertPrivate(result, [candidate, 'synthetic-response-canary'])
    })
  }

  scenario(mode + ' redacts a no-exp verification network failure and never retries it', async () => {
    const candidate = noexp()
    const h = harness({ mode, replies: [new Error('synthetic-network-secret ' + candidate)] })
    const pending = start(h)
    h.login.token(candidate)
    await flush()
    h.login.token(candidate)
    const result = await h.cancelRejected(pending)
    assert.equal(h.fetches.length, 1)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate, 'synthetic-network-secret'])
  })

  scenario(mode + ' request timeout and late no-exp response cannot save or retry', async () => {
    const response = deferred(), candidate = noexp()
    const h = harness({ mode, replies: [response.promise] })
    const pending = start(h)
    h.login.token(candidate)
    await flush()
    h.timer(12000)
    await flush()
    assert.equal(h.fetches[0].init.signal.aborted, true)
    h.login.token(candidate)
    response.resolve(authResponse({ id: SUBJECT, token: noexp({ nonce: 'late' }) }))
    await flush()
    const result = await h.cancelRejected(pending)
    assert.equal(h.fetches.length, 1)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate])
  })

  for (const newDocument of [false, true]) {
    scenario(mode + ' binds same-subject no-exp verification to the latest ' +
      (newDocument ? 'document generation' : 'token revision'), async () => {
      const first = noexp({ nonce: 'first' }), second = noexp({ nonce: 'second' })
      const responseA = deferred(), responseB = deferred()
      const h = harness({ mode, replies: [responseA.promise, responseB.promise] })
      const pending = start(h)
      h.login.token(first)
      await flush()
      if (newDocument) h.login.navigate()
      h.login.token(second)
      responseA.resolve(authResponse({ id: SUBJECT, token: first }))
      await flush()
      assert.equal(h.fetches.length, 2)
      assert.equal(h.completions.length, 0)
      h.assertNoWrite()
      assert.equal(h.fetches[1].init.headers.Authorization, 'Bearer ' + second)
      responseB.resolve(authResponse({ id: SUBJECT, token: second }))
      assertSaved(h, await pending, second)
      h.assertPrivate({}, [first, second])
    })
  }

  for (const stage of ['server request', 'cookie flush']) {
    scenario(mode + ' cancellation prevents a late no-exp ' + stage + ' from committing', async () => {
      const response = deferred(), candidate = noexp()
      const h = harness({ mode, replies: [response.promise], deferFlush: true })
      const pending = start(h)
      h.login.token(candidate)
      await flush()
      if (stage === 'cookie flush') {
        response.resolve(authResponse({ id: SUBJECT, token: candidate }))
        await flush()
        assert.equal(h.login.finalizing, true)
      }
      h.manager.cancelInAppLogin()
      const result = await pending
      assert.equal(result.reason, 'login_cancelled')
      response.resolve(authResponse({ id: SUBJECT, token: candidate }))
      h.login.finishFlush()
      await flush()
      h.assertNoWrite()
      h.assertPrivate(result, [candidate])
    })
  }

  scenario(mode + ' rechecks a known-expiry replacement after deferred cookie persistence', async () => {
    const candidate = noexp(), replacement = jwt({ exp: NOW / 1000 + 60 })
    const h = harness({ mode, replies: [authResponse({ id: SUBJECT, token: replacement })], deferFlush: true })
    const pending = start(h)
    h.login.token(candidate)
    await flush()
    assert.equal(h.login.finalizing, true)
    h.now(NOW + 31000)
    h.login.finishFlush()
    const result = await pending
    assert.equal(result.reason, 'invalid_session')
    h.assertNoWrite()
    h.assertPrivate(result, [candidate, replacement])
  })

  scenario(mode + ' late no-exp verification A cannot authenticate or unlock operation B', async () => {
    const responseA = deferred(), responseB = deferred()
    const first = noexp({ nonce: 'cancelled' }), second = noexp({ nonce: 'current' })
    const h = harness({ mode, replies: [responseA.promise, responseB.promise] })
    const pendingA = start(h)
    h.login.token(first)
    await flush()
    h.manager.cancelInAppLogin()
    assert.equal((await pendingA).success, false)
    const pendingB = start(h)
    h.login.token(second)
    await flush()
    responseA.resolve(authResponse({ id: SUBJECT, token: first }))
    await flush()
    assert.equal((await h.manager.createZaiAccount('Concurrent')).reason, 'busy')
    assert.equal(h.completions.length, 0)
    h.assertNoWrite()
    responseB.resolve(authResponse({ id: SUBJECT, token: second }))
    assertSaved(h, await pendingB, second)
    h.assertPrivate({}, [first, second])
  })

  scenario(mode + ' fails closed if a stored no-exp Z.ai credential cannot be decrypted', async () => {
    const account = existingZai()
    const h = harness({ mode, accounts: [account], unreadable: [account.id] })
    const result = await start(h)
    assert.equal(result.reason, 'storage_unavailable')
    assert.equal(h.starts.length, 0)
    assert.equal(h.fetches.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result)
  })
}

for (const alias of ['token', 'accessToken', 'jwt']) {
  scenario('reconnect identifies a stored no-exp ' + alias + ' and preserves the account and provider options', async () => {
    const previous = noexp({ nonce: 'stored' }), candidate = noexp({ nonce: 'new' })
    const account = existingZai({ credentials: { [alias]: previous, captcha_verify_param: 'synthetic-preserved-option' } })
    const h = harness({ mode: 'reconnect', accounts: [account, otherAccount()], replies: [authResponse({ id: SUBJECT })] })
    const pending = start(h)
    h.login.token(candidate)
    assertSaved(h, await pending, candidate)
    assert.deepEqual(h.state.accounts[1], h.original.accounts[1])
    h.assertPrivate({}, [previous])
  })
}

scenario('a no-exp candidate with another subject cannot even verify an existing account', async () => {
  const candidate = noexp({ id: OTHER_SUBJECT })
  const h = harness({ mode: 'reconnect' })
  const pending = start(h)
  h.login.token(candidate)
  const result = await h.cancelRejected(pending)
  assert.equal(h.fetches.length, 0)
  h.assertNoWrite()
  h.assertPrivate(result, [candidate])
})

for (const [label, previous] of [
  ['no-exp', noexp({ nonce: 'stored' })],
  ['expired', jwt({ exp: NOW / 1000 - 60 })],
]) {
  scenario('create detects a stored ' + label + ' duplicate identity before GET', async () => {
    const candidate = noexp({ nonce: 'candidate' })
    const h = harness({ accounts: [existingZai({ credentials: { token: previous } })] })
    const pending = start(h)
    h.login.token(candidate)
    const result = await h.cancelRejected(pending)
    assert.equal(h.fetches.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [previous, candidate])
  })
}

scenario('create preserves a different stored no-exp identity while adding the verified identity', async () => {
  const candidate = noexp(), previous = noexp({ id: OTHER_SUBJECT })
  const h = harness({ accounts: [existingZai({ credentials: { token: previous } })],
    replies: [authResponse({ id: SUBJECT, token: candidate })] })
  const pending = start(h)
  h.login.token(candidate)
  assertSaved(h, await pending, candidate)
  h.assertPrivate({}, [previous])
})

scenario('a same-subject stored no-exp token change invalidates the original reconnect snapshot', async () => {
  const candidate = noexp({ nonce: 'candidate' })
  const h = harness({ mode: 'reconnect', replies: [authResponse({ id: SUBJECT })], deferFlush: true })
  const pending = start(h)
  h.login.token(candidate)
  await flush()
  const current = h.state.accounts[0]
  h.state.accounts[0] = { ...current, credentials: { ...current.credentials, token: noexp({ nonce: 'concurrent-edit' }) } }
  const changed = clone(h.state)
  h.login.finishFlush()
  const result = await pending
  assert.equal(result.reason, 'account_changed')
  h.assertNoWrite(changed)
  h.assertPrivate(result, [candidate])
})

scenario('a no-exp duplicate inserted during cookie flush prevents the final create commit', async () => {
  const candidate = noexp()
  const h = harness({ replies: [authResponse({ id: SUBJECT })], deferFlush: true })
  const pending = start(h)
  h.login.token(candidate)
  await flush()
  h.state.accounts.push(existingZai())
  const changed = clone(h.state)
  h.login.finishFlush()
  const result = await pending
  assert.equal(result.reason, 'duplicate_identity')
  h.assertNoWrite(changed)
  h.assertPrivate(result, [candidate])
})

scenario('generic non-persistent Z.ai login never inherits the no-exp exception', async () => {
  const candidate = noexp()
  const h = harness()
  const pending = h.manager.startInAppLogin('zai', 'zai')
  assert.equal(Object.hasOwn(h.starts[0], 'persistentAccountId'), false)
  h.login.token(candidate)
  await flush()
  assert.equal(h.validations.length, 1)
  assert.equal(h.fetches.length, 0)
  assert.equal(h.completions.length, 0)
  h.manager.cancelInAppLogin()
  const result = await pending
  assert.equal(result.success, false)
  h.assertNoWrite()
  h.assertPrivate(result, [candidate])
})

scenario('public local validation does not claim a no-exp token is authenticated', async () => {
  const candidate = noexp()
  const h = harness()
  const result = await h.manager.validateToken('zai', 'zai', { token: candidate })
  assert.equal(result.valid, false)
  assert.equal(h.validations.length, 1)
  assert.equal(h.fetches.length, 0)
  h.assertNoWrite()
  h.assertPrivate(result, [candidate])
})
