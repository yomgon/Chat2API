import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

// Source-only VM tests: no real app, user store, OS credentials, profiles or network.
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
    credentials: { token: jwt({ id: OTHER_SUBJECT, exp: NOW / 1000 - 60 }) },
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
  const timers = new Map(), cache = new Map()
  let timerId = 0, now = NOW, generation = 0, loginResolve, pendingFlush
  let scanCount = 0, providerReads = 0
  const state = {
    accounts: clone(options.accounts ?? []),
    provider: clone(Object.hasOwn(options, 'provider') ? options.provider : { id: 'zai', type: 'builtin', enabled: true }),
    config: clone({ oauthProxyMode: 'none', modelMappings: {
      'keep-route': { actualModel: 'synthetic-model', preferredProviderId: 'deepseek', preferredAccountId: 'synthetic-existing-deepseek' },
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
    updateAccount: () => deny('existing account update'),
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
          if (providerType === 'zai') return new (load('src/main/oauth/adapters/zai.ts').ZaiAdapter)(config)
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
    manager, exports, login, state, original, reads, additions, writes, generated, starts, completions,
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

scenario('loading the manager never allocates an ID or creates an account automatically', () => {
  const h = harness()
  assert.equal(h.generated.length, 0)
  assert.equal(h.starts.length, 0)
  assert.equal(h.fetches.length, 0)
  h.assertNoWrite()
  h.assertPrivate({})
})

scenario('explicit creation saves exactly one verified account and preserves all unrelated rows and mappings', async () => {
  const accounts = ['deepseek', 'glm', 'kimi', 'qwen', 'minimax'].map(provider => otherAccount(provider))
  const candidate = jwt()
  const h = harness({ accounts, replies: [authResponse({ id: SUBJECT, role: 'user' })] })
  const pending = h.manager.createZaiAccount('  새 계정  ')
  assert.deepEqual(h.generated, [NEW_ID])
  assert.equal(h.starts.length, 1)
  assert.equal(h.starts[0].persistentAccountId, NEW_ID)
  assert.equal(h.starts[0].providerType, 'zai')
  assert.equal(h.starts[0].proxyMode, 'none')
  h.assertNoWrite()
  h.login.token(candidate, { allCookies: { session: 'synthetic-cookie-canary' } })
  const result = plain(await pending)
  assert.deepEqual(result, { success: true, accountId: NEW_ID })
  assert.equal(h.additions.length, 1)
  assert.equal(h.writes.length, 1)
  assert.equal(h.fetches.length, 1)
  assert.equal(h.fetches[0].url, AUTH_URL)
  assert.equal(h.fetches[0].init.method, 'GET')
  assert.equal(h.fetches[0].init.credentials, 'include')
  assert.equal(h.fetches[0].init.redirect, 'error')
  assert.equal(h.fetches[0].init.headers.Authorization, 'Bearer ' + candidate)
  assert.equal(Object.hasOwn(h.fetches[0].init.headers, 'Cookie'), false)
  assert.equal(h.partitions[0], 'persist:chat2api-zai-' + crypto.createHash('sha256').update(NEW_ID).digest('hex').slice(0, 32))
  assert.deepEqual(h.state.accounts.slice(0, -1), h.original.accounts)
  assert.deepEqual(h.state.config, h.original.config)
  assert.deepEqual(h.state.accounts.at(-1), {
    id: NEW_ID, providerId: 'zai', name: '새 계정', credentials: { token: candidate },
    status: 'active', createdAt: NOW, updatedAt: NOW, requestCount: 0, todayUsed: 0,
  })
  assert.ok(h.reads.filter(read => read.kind === 'id').every(read => read.id === NEW_ID && !read.includeCredentials))
  h.assertPrivate(result, [candidate, 'synthetic-cookie-canary', '새 계정'])
})

scenario('a matching usable server replacement token is the sole saved credential', async () => {
  const candidate = jwt(), replacement = jwt({ exp: NOW / 1000 + 7000 })
  const h = harness({ replies: [authResponse({ id: SUBJECT, token: replacement, ignored: 'synthetic-profile-canary' })] })
  const pending = h.manager.createZaiAccount('x'.repeat(100))
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.success, true)
  assert.deepEqual(h.additions[0].credentials, { token: replacement })
  h.assertPrivate(result, [candidate, replacement, 'synthetic-profile-canary'])
})

for (const [label, name] of [
  ['empty', ''], ['spaces', '   '], ['long', 'x'.repeat(101)], ['null', null], ['object', {}],
  ['number', 7], ['newline before trim', '\nname'], ['NUL', 'na\u0000me'],
  ['format control', 'na\u202eme'], ['line separator', 'na\u2028me'], ['lone surrogate', 'na\ud800me'],
]) {
  scenario('invalid account name is rejected before any storage or login operation: ' + label, async () => {
    const h = harness()
    const result = plain(await h.manager.createZaiAccount(name))
    assert.deepEqual(result, { success: false, reason: 'invalid_account_name' })
    assert.equal(h.generated.length, 0)
    assert.equal(h.reads.length, 0)
    assert.equal(h.starts.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result)
  })
}

for (const [label, provider] of [
  ['missing', null], ['disabled', { id: 'zai', type: 'builtin', enabled: false }],
  ['custom', { id: 'zai', type: 'custom', enabled: true }],
  ['wrong ID', { id: 'other', type: 'builtin', enabled: true }],
]) {
  scenario('provider preflight prevents creation: ' + label, async () => {
    const h = harness({ provider })
    const result = plain(await h.manager.createZaiAccount('New account'))
    assert.deepEqual(result, { success: false, reason: 'provider_unavailable' })
    assert.equal(h.generated.length, 0)
    assert.equal(h.starts.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result)
  })
}

for (const [label, account, unreadable, reason] of [
  ['missing identity', existingZai({ credentials: {} }), [], 'identity_unavailable'],
  ['malformed identity', existingZai({ credentials: { token: 'synthetic-invalid' } }), [], 'identity_unavailable'],
  ['ambiguous aliases', existingZai({ credentials: { token: jwt(), jwt: jwt({ id: OTHER_SUBJECT }) } }), [], 'identity_unavailable'],
  ['guest identity', existingZai({ credentials: { token: jwt({ email: 'synthetic@guest.com' }) } }), [], 'identity_unavailable'],
  ['decrypt failure', existingZai(), ['synthetic-existing-zai'], 'storage_unavailable'],
]) {
  scenario('unverifiable existing Z.ai identity fails closed before opening the login: ' + label, async () => {
    const h = harness({ accounts: [account], unreadable })
    const result = plain(await h.manager.createZaiAccount('New account'))
    assert.deepEqual(result, { success: false, reason })
    assert.equal(h.generated.length, 0)
    assert.equal(h.starts.length, 0)
    assert.equal(h.fetches.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result)
  })
}

for (const id of ['', undefined, 42, ' bad-id ', 'bad\u0000id']) {
  scenario('invalid generated ID cannot select a persistent session: ' + String(id), async () => {
    const h = harness({ ids: [id] })
    const result = plain(await h.manager.createZaiAccount('New account'))
    assert.deepEqual(result, { success: false, reason: 'storage_unavailable' })
    assert.equal(h.starts.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result)
  })
}

scenario('an already used generated ID is rejected before opening its partition', async () => {
  const h = harness({ accounts: [otherAccount('glm', { id: NEW_ID })] })
  const result = plain(await h.manager.createZaiAccount('New account'))
  assert.deepEqual(result, { success: false, reason: 'account_id_conflict' })
  assert.equal(h.starts.length, 0)
  assert.equal(h.partitions.length, 0)
  h.assertNoWrite()
  h.assertPrivate(result)
})

for (const key of ['token', 'accessToken', 'jwt']) {
  scenario('duplicate expired inactive identity is blocked before GET using alias ' + key, async () => {
    const previous = jwt({ exp: NOW / 1000 - 600 }), candidate = jwt()
    const h = harness({ accounts: [existingZai({ status: 'inactive', credentials: { [key]: previous } })] })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    const result = await h.cancelRejected(pending)
    assert.equal(h.fetches.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate, previous])
  })
}

scenario('after a duplicate candidate the user may explicitly log in as a different identity', async () => {
  const duplicate = jwt(), different = jwt({ id: OTHER_SUBJECT })
  const h = harness({ accounts: [existingZai({ credentials: { token: duplicate } })],
    replies: [authResponse({ id: OTHER_SUBJECT })] })
  const pending = h.manager.createZaiAccount('Different account')
  h.login.token(duplicate)
  await flush()
  assert.equal(h.fetches.length, 0)
  assert.equal(h.additions.length, 0)
  h.login.token(different)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.fetches.length, 1)
  assert.equal(h.additions.length, 1)
  assert.equal(h.additions[0].credentials.token, different)
  h.assertPrivate(result, [duplicate, different])
})

scenario('unrelated provider credentials are never decrypted while checking Z.ai uniqueness', async () => {
  const other = otherAccount('glm'), candidate = jwt()
  const h = harness({ accounts: [other], unreadable: [other.id], replies: [authResponse({ id: SUBJECT })] })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.success, true)
  assert.deepEqual(h.state.accounts[0], other)
  h.assertPrivate(result, [candidate])
})

for (const [label, candidate] of [
  ['expired', jwt({ exp: NOW / 1000 - 1 })], ['near expiry', jwt({ exp: NOW / 1000 + 15 })],
  ['null expiry', jwt({ exp: null })], ['future nbf', jwt({ nbf: NOW / 1000 + 120 })],
  ['guest', jwt({ email: 'synthetic@guest.com' })], ['malformed', 'synthetic-invalid-token'],
]) {
  scenario('invalid new candidate never makes a request or creates a row: ' + label, async () => {
    const h = harness()
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    const result = await h.cancelRejected(pending)
    assert.equal(h.fetches.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate])
  })
}

for (const [label, makeResponse] of [
  ['401', () => authResponse({}, { status: 401 })],
  ['403', () => authResponse({}, { status: 403 })],
  ['different subject', () => authResponse({ id: OTHER_SUBJECT })],
  ['nested identity', () => authResponse({ user: { id: SUBJECT } })],
  ['null replacement', () => authResponse({ id: SUBJECT, token: null })],
  ['different replacement subject', () => authResponse({ id: SUBJECT, token: jwt({ id: OTHER_SUBJECT }) })],
  ['expired replacement', () => authResponse({ id: SUBJECT, token: jwt({ exp: NOW / 1000 - 1 }) })],
  ['redirect', () => authResponse({ id: SUBJECT }, { redirected: true })],
  ['HTML', () => authResponse({ id: SUBJECT }, { headers: { 'Content-Type': 'text/html' } })],
  ['oversized body', () => authResponse({ id: SUBJECT, ignored: 'x'.repeat(70 * 1024) })],
]) {
  scenario('first-party verification failure never creates an account: ' + label, async () => {
    const candidate = jwt()
    const h = harness({ replies: [makeResponse()] })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    await flush()
    h.login.token(candidate)
    await flush()
    assert.equal(h.fetches.length, 1)
    const result = await h.cancelRejected(pending)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate])
  })
}

scenario('network rejection is redacted and a later new candidate can succeed without retrying the failed token', async () => {
  const failed = jwt(), replacement = jwt({ exp: NOW / 1000 + 7000 })
  const h = harness({ replies: [new Error('synthetic-network-secret ' + failed), authResponse({ id: SUBJECT })] })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(failed)
  await flush()
  h.login.token(failed)
  await flush()
  assert.equal(h.fetches.length, 1)
  h.assertNoWrite()
  h.login.token(replacement)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.fetches.length, 2)
  assert.equal(h.additions.length, 1)
  h.assertPrivate(result, [failed, replacement, 'synthetic-network-secret'])
})

scenario('request timeout does not retry or create and the original overall timeout still ends creation', async () => {
  const response = deferred(), candidate = jwt()
  const h = harness({ replies: [response.promise] })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  await flush()
  h.timer(12000)
  await flush()
  assert.equal(h.fetches[0].init.signal.aborted, true)
  h.login.token(candidate)
  await flush()
  assert.equal(h.fetches.length, 1)
  h.assertNoWrite()
  h.timer(300000)
  const result = await pending
  assert.equal(result.reason, 'login_timeout')
  response.resolve(authResponse({ id: SUBJECT }))
  await flush()
  h.assertNoWrite()
  h.assertPrivate(result, [candidate])
})

scenario('cookie flush is required before the only addAccount call and success notification', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })], deferFlush: true })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  await flush()
  assert.equal(h.completions.length, 1)
  assert.equal(h.additions.length, 0)
  assert.ok(!h.statuses.includes('success'))
  assert.ok(!h.progress.some(item => item.event.status === 'success'))
  h.assertNoWrite()
  h.login.finishFlush()
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.additions.length, 1)
  h.assertPrivate(result, [candidate])
})

for (const mode of ['cancel', 'timeout', 'destroy']) {
  scenario('late cookie flush cannot create after ' + mode, async () => {
    const candidate = jwt()
    const h = harness({ replies: [authResponse({ id: SUBJECT })], deferFlush: true })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    await flush()
    assert.equal(h.login.finalizing, true)
    assert.equal(h.additions.length, 0)
    if (mode === 'cancel') h.manager.cancelInAppLogin()
    if (mode === 'timeout') h.timer(300000)
    if (mode === 'destroy') h.manager.destroy()
    const result = await pending
    assert.equal(result.success, false)
    h.login.finishFlush()
    await flush()
    assert.equal(h.additions.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate])
  })
}

for (const failure of ['storage flush', 'document navigation']) {
  scenario('failed persistent completion creates no row: ' + failure, async () => {
    const candidate = jwt()
    const h = harness({ replies: [authResponse({ id: SUBJECT })], deferFlush: true })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    await flush()
    if (failure === 'document navigation') h.login.navigate()
    h.login.finishFlush(failure !== 'storage flush')
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(h.additions.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate])
  })
}

for (const mode of ['cancel', 'close', 'timeout', 'destroy']) {
  scenario('late verification cannot create after ' + mode, async () => {
    const response = deferred(), candidate = jwt(), queued = jwt({ exp: NOW / 1000 + 7000 })
    const h = harness({ replies: [response.promise] })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    await flush()
    h.login.token(queued)
    if (mode === 'cancel') h.manager.cancelInAppLogin()
    if (mode === 'close') h.login.end({ success: false, error: 'Login window was closed' })
    if (mode === 'timeout') h.timer(300000)
    if (mode === 'destroy') h.manager.destroy()
    const result = await pending
    assert.equal(result.success, false)
    response.resolve(authResponse({ id: SUBJECT }))
    await flush()
    assert.equal(h.fetches.length, 1)
    assert.equal(h.additions.length, 0)
    h.assertNoWrite()
    h.assertPrivate(result, [candidate, queued])
  })
}

for (const [label, mutate, reason] of [
  ['provider disabled', h => { h.state.provider.enabled = false }, 'provider_unavailable'],
  ['provider custom', h => { h.state.provider.type = 'custom' }, 'provider_unavailable'],
  ['ID taken', h => { h.state.accounts.push(otherAccount('glm', { id: NEW_ID })) }, 'account_id_conflict'],
  ['duplicate added', h => { h.state.accounts.push(existingZai({ credentials: { token: jwt() } })) }, 'duplicate_identity'],
  ['unreadable account added', h => {
    h.state.accounts.push(existingZai())
    h.unreadable.add('synthetic-existing-zai')
  }, 'storage_unavailable'],
  ['unknown identity added', h => { h.state.accounts.push(existingZai({ credentials: {} })) }, 'identity_unavailable'],
  ['candidate expires', h => { h.now(NOW + 3600 * 1000) }, 'invalid_session'],
]) {
  scenario('final recheck after cookie flush blocks a concurrent change: ' + label, async () => {
    const candidate = jwt()
    const h = harness({ replies: [authResponse({ id: SUBJECT })], deferFlush: true })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(candidate)
    await flush()
    mutate(h)
    const changed = clone(h.state)
    h.login.finishFlush()
    const result = await pending
    assert.equal(result.reason, reason)
    assert.equal(h.additions.length, 0)
    h.assertNoWrite(changed)
    h.assertPrivate(result, [candidate])
  })
}

scenario('cancellation during final provider recheck prevents the synchronous add', async () => {
  const candidate = jwt()
  let h
  h = harness({ replies: [authResponse({ id: SUBJECT })],
    onProviderRead(_state, count) { if (count === 2) h.manager.cancelInAppLogin() } })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.reason, 'login_cancelled')
  assert.equal(h.additions.length, 0)
  h.assertNoWrite()
  h.assertPrivate(result, [candidate])
})

scenario('OS-protected store rejection is redacted and is never retried or rolled back', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })],
    addError: new Error('synthetic-protected-storage-secret ' + candidate) })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  const result = plain(await pending)
  assert.deepEqual(result, { success: false, reason: 'storage_unavailable' })
  assert.equal(h.additions.length, 1)
  h.assertNoWrite()
  assert.ok(!h.statuses.includes('success'))
  h.assertPrivate(result, [candidate, 'synthetic-protected-storage-secret'])
})

scenario('post-commit renderer notification failure still returns the authoritative success receipt', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })],
    notificationError: new Error('synthetic-notification-secret ' + candidate) })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  const result = plain(await pending)
  assert.deepEqual(result, { success: true, accountId: NEW_ID })
  assert.equal(h.additions.length, 1)
  assert.equal(h.writes.length, 1)
  h.assertPrivate(result, [candidate, 'synthetic-notification-secret'])
})

scenario('reentrant cancellation after the store commit cannot turn success into a retryable failure', async () => {
  const candidate = jwt()
  let h
  h = harness({ replies: [authResponse({ id: SUBJECT })], afterAdd() { h.manager.cancelInAppLogin() } })
  const pending = h.manager.createZaiAccount('New account')
  h.login.token(candidate)
  const result = plain(await pending)
  assert.deepEqual(result, { success: true, accountId: NEW_ID })
  assert.equal(h.writes.length, 1)
  h.assertPrivate(result, [candidate])
})

scenario('one module lock covers create, reconnect and generic login until flush and commit', async () => {
  const candidate = jwt()
  const h = harness({ replies: [authResponse({ id: SUBJECT })], deferFlush: true })
  const pending = h.manager.createZaiAccount('New account')
  const other = new h.exports.OAuthManager()
  assert.equal((await other.createZaiAccount('Second')).reason, 'busy')
  assert.equal((await other.reconnectZaiAccount('anything')).reason, 'busy')
  assert.equal((await other.startInAppLogin('zai', 'zai')).success, false)
  assert.equal((await other.startLogin({ providerId: 'zai', providerType: 'zai' })).success, false)
  h.login.token(candidate)
  await flush()
  assert.equal((await other.createZaiAccount('Third')).reason, 'busy')
  assert.equal(h.generated.length, 1)
  h.login.finishFlush()
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(h.additions.length, 1)
  h.assertPrivate(result, [candidate])
})

scenario('an already open generic login prevents new account allocation', async () => {
  const h = harness()
  const pending = h.manager.startInAppLogin('deepseek', 'deepseek')
  const other = new h.exports.OAuthManager()
  const result = plain(await other.createZaiAccount('New account'))
  assert.deepEqual(result, { success: false, reason: 'busy' })
  assert.equal(h.generated.length, 0)
  h.manager.cancelInAppLogin()
  await pending
  h.assertNoWrite()
  h.assertPrivate(result)
})

for (const newDocument of [false, true]) {
  scenario('only the latest verified identity may be created after ' + (newDocument ? 'document change' : 'same-document token rotation'), async () => {
    const previousResponse = deferred(), currentResponse = deferred()
    const previous = jwt(), current = jwt({ id: OTHER_SUBJECT })
    const h = harness({ replies: [previousResponse.promise, currentResponse.promise] })
    const pending = h.manager.createZaiAccount('New account')
    h.login.token(previous)
    await flush()
    if (newDocument) h.login.navigate()
    h.login.token(current)
    previousResponse.resolve(authResponse({ id: SUBJECT, token: previous }))
    await flush()
    assert.equal(h.completions.length, 0)
    assert.equal(h.additions.length, 0)
    assert.equal(h.fetches.length, 2)
    currentResponse.resolve(authResponse({ id: OTHER_SUBJECT }))
    const result = await pending
    assert.equal(result.success, true)
    assert.equal(h.additions.length, 1)
    assert.equal(h.additions[0].credentials.token, current)
    assert.equal(h.completions[0].generation, newDocument ? 2 : 1)
    h.assertPrivate(result, [previous, current])
  })
}

scenario('late canceled creation A cannot write or release the lock of creation B', async () => {
  const responseA = deferred(), responseB = deferred()
  const candidateA = jwt(), candidateB = jwt({ id: OTHER_SUBJECT })
  const h = harness({ replies: [responseA.promise, responseB.promise] })
  const first = h.manager.createZaiAccount('First account')
  h.login.token(candidateA)
  await flush()
  h.manager.cancelInAppLogin()
  assert.equal((await first).success, false)
  const second = h.manager.createZaiAccount('Second account')
  h.login.token(candidateB)
  await flush()
  responseA.resolve(authResponse({ id: SUBJECT }))
  await flush()
  assert.equal((await h.manager.createZaiAccount('Third account')).reason, 'busy')
  assert.equal(h.additions.length, 0)
  responseB.resolve(authResponse({ id: OTHER_SUBJECT }))
  const result = plain(await second)
  assert.deepEqual(result, { success: true, accountId: 'synthetic-created-2' })
  assert.equal(h.additions.length, 1)
  assert.equal(h.additions[0].id, 'synthetic-created-2')
  assert.equal(h.additions[0].credentials.token, candidateB)
  h.assertPrivate(result, [candidateA, candidateB])
})

scenario('a forged in-app success without accepted server verification cannot create a row', async () => {
  const candidate = jwt()
  const h = harness()
  const pending = h.manager.createZaiAccount('New account')
  h.login.end({ success: true, credentials: { token: candidate } })
  const result = await pending
  assert.equal(result.success, false)
  assert.equal(h.fetches.length, 0)
  assert.equal(h.additions.length, 0)
  h.assertNoWrite()
  h.assertPrivate(result, [candidate])
})

scenario('public non-persistent Z.ai login remains available and never implicitly creates an account', async () => {
  const candidate = jwt()
  const h = harness()
  const pending = h.manager.startInAppLogin('zai', 'zai')
  assert.equal(Object.hasOwn(h.starts[0], 'persistentAccountId'), false)
  h.login.token(candidate)
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(result.credentials.token, candidate)
  assert.equal(h.generated.length, 0)
  assert.equal(h.fetches.length, 0)
  assert.equal(h.additions.length, 0)
  h.assertNoWrite()
  h.assertPrivate({ success: result.success }, [candidate])
})
