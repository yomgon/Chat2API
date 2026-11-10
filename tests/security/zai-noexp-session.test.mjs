import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'https://chat.z.ai'
const authUrl = origin + '/api/v1/auths/'
const epoch = Date.UTC(2026, 10, 8)
const secret = 'synthetic_private_error_' + 'x'.repeat(40)
const compiled = new Map()
const plain = value => JSON.parse(JSON.stringify(value))
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function jwt(id = 'synthetic-user-one', extra = {}) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ id, exp: epoch / 1000 + 3600, ...extra })).toString('base64url'),
    Buffer.from('synthetic-signature').toString('base64url'),
  ].join('.')
}

function cookie(value = jwt(), extra = {}) {
  return {
    name: 'token', value, domain: 'chat.z.ai', hostOnly: true,
    path: '/', secure: true, httpOnly: true, session: false,
    expirationDate: epoch / 1000 + 3600, ...extra,
  }
}

function fixture(behavior = {}) {
  const logs = [], statuses = [], results = [], tokens = [], windows = [], sessions = new Map()
  const calls = { partitions: [], cookieQueries: [], scripts: [], storageReads: [], order: [], proxyModes: [], network: 0 }
  let now = epoch, nextTimer = 0, nextWindow = 0
  const timers = new Map()
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const schedule = (callback, delay) => {
    const timer = { id: ++nextTimer, at: now + delay, callback }
    timers.set(timer.id, timer)
    return timer
  }
  const clear = timer => { if (timer) timers.delete(timer.id) }
  const forbidden = name => {
    calls.network++
    throw new Error('Unexpected offline operation: ' + name)
  }

  class FakeSession {
    constructor(partition) {
      this.partition = partition
      this.cookies = new EventEmitter()
      this.rows = []
      this.hooks = { headers: null, before: null }
      this.storageFlushes = 0
      this.cookieFlushes = 0
      this.cookies.get = async filter => {
        calls.cookieQueries.push(plain(filter))
        return behavior.cookieGet ? behavior.cookieGet(filter, this) : [...this.rows]
      }
      this.cookies.flushStore = () => {
        this.cookieFlushes++
        calls.order.push('cookies-flush')
        if (behavior.cookieFlush) return behavior.cookieFlush(this)
        return Promise.resolve()
      }
      this.webRequest = {
        onHeadersReceived: listener => {
          calls.order.push(listener === null ? 'headers-detached' : 'headers-installed')
          if (behavior.detachHeadersError && listener === null) throw new Error(secret)
          this.hooks.headers = listener
        },
        onBeforeSendHeaders: listener => {
          calls.order.push(listener === null ? 'before-detached' : 'before-installed')
          if (behavior.detachBeforeError && listener === null) throw new Error(secret)
          this.hooks.before = listener
        },
      }
    }
    setProxy(value) {
      calls.order.push('proxy')
      calls.proxyModes.push(value.mode)
      return behavior.proxy ? behavior.proxy(value) : Promise.resolve()
    }
    flushStorageData() {
      this.storageFlushes++
      calls.order.push('storage-flush')
      if (behavior.storageFlushError) throw new Error(secret)
    }
  }

  class FakeContents extends EventEmitter {
    constructor(window) {
      super()
      this.id = window.id
      this.window = window
      this.destroyed = false
      this.loadingMainFrame = false
      this.url = 'about:blank'
      this.storage = {}
      this.windowOpenHandler = null
    }
    isDestroyed() { return this.destroyed }
    getURL() { return this.url }
    isLoadingMainFrame() { return this.loadingMainFrame }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
    executeJavaScript(script) {
      calls.scripts.push(script)
      const run = (url = this.url) => vm.runInNewContext(script, {
        URL,
        location: { href: url, origin: new URL(url).origin },
        localStorage: {
          getItem: key => {
            calls.storageReads.push(key)
            if (behavior.storageError) throw new Error(secret)
            return this.storage[key] ?? null
          },
        },
      }, { timeout: 1000 })
      return behavior.execute ? behavior.execute(script, this, run) : Promise.resolve(run())
    }
  }

  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      if (behavior.windowError) throw new Error(secret)
      this.id = ++nextWindow
      this.options = options
      this.destroyed = false
      this.shown = false
      this.webContents = new FakeContents(this)
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    show() { this.shown = true }
    loadURL(url) {
      calls.order.push('load')
      const session = sessions.get(this.options.webPreferences.partition)
      assert.equal(typeof session.hooks.before, 'function', 'Install request hook before navigation')
      assert.equal(typeof session.hooks.headers, 'function', 'Install response hook before navigation')
      if (behavior.load) return behavior.load(url, this)
      this.navigate(url)
      return Promise.resolve()
    }
    navigate(url, finish = true) {
      this.webContents.loadingMainFrame = true
      this.webContents.emit('did-start-navigation', {}, url, false, true)
      this.webContents.url = url
      this.webContents.emit('did-navigate', {}, url, 200, 'OK')
      if (finish) {
        this.webContents.emit('dom-ready')
        this.webContents.loadingMainFrame = false
        this.webContents.emit('did-finish-load')
        this.webContents.emit('did-stop-loading')
      }
    }
    destroy() {
      this.destroyed = true
      this.webContents.destroyed = true
      this.emit('closed')
      calls.order.push('window-destroyed')
    }
    closeByUser() { this.destroy() }
  }
  const dependencies = {
    electron: {
      BrowserWindow: FakeWindow,
      session: {
        fromPartition: partition => {
          calls.partitions.push(partition)
          if (behavior.sessionError) throw new Error(secret)
          if (!sessions.has(partition)) sessions.set(partition, new FakeSession(partition))
          return sessions.get(partition)
        },
      },
    },
    crypto,
    events: { EventEmitter },
  }
  const allowed = new Set([
    'src/main/oauth/inAppLogin.ts',
    'src/main/oauth/zaiSession.ts',
    'src/main/oauth/tokenExtractionConfig.ts',
  ])
  const modules = new Map()
  function load(relative) {
    assert.ok(allowed.has(relative), 'Evaluate only the three source modules under test')
    if (modules.has(relative)) return modules.get(relative).exports
    if (!compiled.has(relative)) {
      const source = readFileSync(path.join(root, relative), 'utf8')
      const result = ts.transpileModule(source, {
        fileName: relative,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true,
      })
      assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
      compiled.set(relative, result.outputText)
    }
    const module = { exports: {} }
    modules.set(relative, module)
    const console = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(level =>
      [level, (...args) => logs.push({ level, args })]))
    vm.runInNewContext(compiled.get(relative), {
      exports: module.exports, module, Buffer, URL, Date: Clock, console,
      setTimeout: schedule, clearTimeout: clear,
      fetch: () => forbidden('fetch'),
      require(name) {
        if (Object.hasOwn(dependencies, name)) return dependencies[name]
        if (name === './tokenExtractionConfig') return load('src/main/oauth/tokenExtractionConfig.ts')
        if (name === './zaiSession') return load('src/main/oauth/zaiSession.ts')
        return forbidden('module ' + name)
      },
    }, { filename: relative, timeout: 1000 })
    return module.exports
  }
  const { InAppLoginManager } = load('src/main/oauth/inAppLogin.ts')
  const attach = manager => {
    manager.on('tokenFound', event => tokens.push(plain(event)))
    manager.on('status', event => statuses.push(plain(event)))
    manager.on('complete', result => results.push(plain(result)))
    return manager
  }
  const manager = attach(new InAppLoginManager())
  const start = (options = {}, owner = manager) => owner.startLogin({
    providerId: 'zai', providerType: 'zai', persistentAccountId: 'account-one', ...options,
  })
  const advance = async ms => {
    await tick()
    const end = now + ms
    for (let count = 0; ; count++) {
      assert.ok(count < 1000, 'Timer activity must stay bounded')
      const next = [...timers.values()].filter(timer => timer.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!next) break
      now = next.at
      timers.delete(next.id)
      next.callback()
      await tick()
    }
    now = end
    await tick()
  }
  function invoke(hook, details) {
    let callbackCount = 0, result
    hook(details, value => { callbackCount++; result = value })
    assert.equal(callbackCount, 1, 'Every intercepted request must continue exactly once')
    return result
  }
  return {
    behavior, calls, logs, statuses, results, tokens, windows, sessions, timers, manager,
    start, advance, invoke, helpers: load('src/main/oauth/zaiSession.ts'),
    newManager: () => attach(new InAppLoginManager()),
    get window() { return windows.at(-1) },
    get session() { return sessions.get(windows.at(-1)?.options.webPreferences.partition) },
    assertPrivate() {
      assert.equal(calls.network, 0, 'No app, account store, HTTP, or unmocked module may execute')
      const visible = JSON.stringify({ logs, statuses, errors: results.map(result => result.error) })
      assert.ok(!visible.includes(secret), 'Do not return or log an exception containing credentials')
      for (const token of [jwt(), jwt('synthetic-user-two'), jwtNoExpiry(), ...tokens.map(event => event.value)]) {
        assert.ok(!visible.includes(token), 'Do not log a token')
        assert.ok(!visible.includes(token.split('.')[1].slice(0, 20)), 'Do not log token prefixes')
      }
      for (const entry of logs) {
        assert.equal(entry.args.length, 1)
        assert.equal(typeof entry.args[0], 'string')
      }
    },
  }
}

function ownedRequest(h, extra = {}) {
  return { url: authUrl, webContentsId: h.window.webContents.id, ...extra }
}

async function cancel(h, pending) {
  h.manager.cancel()
  const result = await pending
  assert.equal(result.success, false)
  assert.equal(h.timers.size, 0)
  h.assertPrivate()
  return result
}

// All token values and server approvals below are synthetic. This harness never
// authenticates a real account. completeWithSuccess represents the manager's
// separate official verification boundary; token capture must not call it.
function jwtNoExpiry(id = 'synthetic-user-one', extra = {}) {
  return jwt(id, { exp: undefined, ...extra })
}

function encodedJwt(header, payload, signature = Buffer.from('synthetic-signature').toString('base64url')) {
  return [
    Buffer.from(JSON.stringify(header)).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    signature,
  ].join('.')
}

test('structural identity exposes unknown expiry without any local usability or authentication claim', () => {
  const h = fixture()
  const unknown = h.helpers.readZaiTokenIdentity(jwtNoExpiry(), epoch)
  assert.deepEqual(plain(unknown), { subject: 'synthetic-user-one', expiryKnown: false })
  for (const field of ['expiresAt', 'usable', 'valid', 'verified', 'authenticated']) {
    assert.equal(Object.hasOwn(unknown, field), false, field)
  }
  assert.equal(h.helpers.readZaiSessionClaims(jwtNoExpiry(), epoch), null)
  const withEmail = h.helpers.readZaiTokenIdentity(jwtNoExpiry('synthetic-user-one', {
    email: 'synthetic@example.invalid',
  }), epoch)
  assert.equal(withEmail.email, 'synthetic@example.invalid')
  assert.equal(h.results.length, 0)
  assert.equal(h.windows.length, 0)
  h.assertPrivate()
})

test('known expiry metadata remains separate from strict remaining-lifetime policy', () => {
  const h = fixture()
  const now = epoch / 1000
  const known = h.helpers.readZaiTokenIdentity(jwt(), epoch)
  assert.deepEqual(plain(known), {
    subject: 'synthetic-user-one', expiryKnown: true, expiresAt: (now + 3600) * 1000,
  })
  assert.equal(Object.hasOwn(known, 'usable'), false)
  assert.equal(h.helpers.readZaiSessionClaims(jwt(), epoch).usable, true)
  for (const exp of [now + 1, now + 30]) {
    const candidate = jwt('synthetic-user-one', { exp })
    assert.equal(h.helpers.readZaiTokenIdentity(candidate, epoch).expiryKnown, true)
    assert.equal(h.helpers.readZaiSessionClaims(candidate, epoch).usable, false)
  }
  assert.equal(h.helpers.readZaiSessionClaims(jwt('synthetic-user-one', { exp: now + 31 }), epoch).usable, true)
  for (const exp of [now - 1, now]) {
    const expired = jwt('synthetic-user-one', { exp })
    assert.equal(h.helpers.readZaiTokenIdentity(expired, epoch), null)
    assert.equal(h.helpers.readZaiSessionClaims(expired, epoch).usable, false)
  }
  h.assertPrivate()
})

test('structural parsing rejects malformed JWTs, invalid identities, guests, and unsigned headers', () => {
  const h = fixture()
  const good = jwtNoExpiry()
  const parts = good.split('.')
  const invalid = [
    ['null', null], ['object', {}], ['number', 1], ['empty', ''],
    ['short', 'not.a.jwt'], ['too long', 'a'.repeat(8193)],
    ['missing part', parts.slice(0, 2).join('.')],
    ['empty signature', parts[0] + '.' + parts[1] + '.'],
    ['extra part', good + '.extra'], ['padding', parts[0] + '=.' + parts[1] + '.' + parts[2]],
    ['whitespace', good + ' '], ['illegal character', parts[0] + '.' + parts[1] + '.!'],
    ['bad header JSON', 'bm90LWpzb24.' + parts[1] + '.' + parts[2]],
    ['bad payload JSON', parts[0] + '.bm90LWpzb24.' + parts[2]],
    ...[null, [], 'HS256', {}, { alg: null }, { alg: '' }, { alg: 'none' }, { alg: 'NoNe' },
      { alg: 'none ' }, { alg: ' HS256' }].map((header, index) => [
      'invalid header ' + index, encodedJwt(header, { id: 'synthetic-user-one' }),
    ]),
    ...[null, [], 'identity', {}, { id: 1 }, { id: '' }, { id: 'a'.repeat(201) },
      { id: 'bad\u0000id' }, { id: 'bad\u202Eid' }, { id: 'bad\uD800id' }].map((payload, index) => [
      'invalid identity ' + index, encodedJwt({ alg: 'HS256' }, payload),
    ]),
    ...['guest@guest.com', 'GUEST@GUEST.COM', 'guest@guest.com ', 'a'.repeat(321) + '@guest.com']
      .map((email, index) => ['guest ' + index, jwtNoExpiry('synthetic-user-one', { email })]),
  ]
  for (const [label, value] of invalid) assert.equal(h.helpers.readZaiTokenIdentity(value, epoch), null, label)
  for (const now of [NaN, Infinity, -Infinity]) assert.equal(h.helpers.readZaiTokenIdentity(good, now), null)
  h.assertPrivate()
})

test('present invalid expiry and future nbf cannot fall back to unknown expiry', () => {
  const h = fixture()
  for (const exp of [null, false, '', 'tomorrow', [], {}, -1, 0, 1.5, 32503680001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(h.helpers.readZaiTokenIdentity(jwtNoExpiry('synthetic-user-one', { exp }), epoch), null)
  }
  for (const nbf of [null, false, '', 'tomorrow', [], {}, -1, 1.5, 32503680001, epoch / 1000 + 1]) {
    assert.equal(h.helpers.readZaiTokenIdentity(jwtNoExpiry('synthetic-user-one', { nbf }), epoch), null)
    assert.equal(h.helpers.readZaiTokenIdentity(jwt('synthetic-user-one', { nbf }), epoch), null)
  }
  for (const nbf of [0, epoch / 1000 - 1, epoch / 1000]) {
    assert.equal(h.helpers.readZaiTokenIdentity(jwtNoExpiry('synthetic-user-one', { nbf }), epoch).expiryKnown, false)
  }
  h.assertPrivate()
})

test('persistent localStorage no-exp capture waits five seconds and never completes locally', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwtNoExpiry()
  await h.advance(4999)
  assert.equal(h.tokens.length, 0)
  await h.advance(1)
  assert.equal(h.tokens.length, 1)
  assert.deepEqual(Object.keys(h.tokens[0]).sort(), ['generation', 'key', 'value'])
  assert.equal(h.tokens[0].value, jwtNoExpiry())
  assert.equal(h.results.length, 0, 'An unverified identity candidate is not login success')
  assert.equal(h.session.storageFlushes, 0)
  assert.equal(h.session.cookieFlushes, 0)
  assert.equal(h.helpers.readZaiSessionClaims(h.tokens[0].value, epoch + 5000), null)
  await h.advance(6000)
  assert.equal(h.tokens.length, 1)
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('unverified no-exp capture still ends at the original login deadline without success', async () => {
  const h = fixture()
  const pending = h.start({ timeout: 6000 })
  h.window.webContents.storage.token = jwtNoExpiry()
  await h.advance(5000)
  assert.equal(h.tokens.length, 1)
  assert.equal(h.results.length, 0)
  await h.advance(1000)
  assert.deepEqual(plain(await pending), { success: false, error: 'Login timeout' })
  assert.equal(h.session.storageFlushes, 0)
  assert.equal(h.timers.size, 0)
  h.assertPrivate()
})

test('no-exp cookie capture queries only the official token cookie and emits no cookie bundle', async () => {
  const h = fixture()
  const pending = h.start()
  h.session.rows = [
    cookie(jwtNoExpiry(), { domain: '.z.ai', hostOnly: false, session: true, expirationDate: undefined }),
    cookie(secret, { name: 'unrelated' }),
  ]
  await h.advance(5000)
  assert.deepEqual(h.tokens.map(event => event.value), [jwtNoExpiry()])
  for (const filter of h.calls.cookieQueries) assert.deepEqual(filter, { url: authUrl, name: 'token' })
  assert.deepEqual(Object.keys(h.tokens[0]).sort(), ['generation', 'key', 'value'])
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('a late stale cookie cannot supersede an eligible localStorage candidate in one Z.ai document', async () => {
  const cookies = deferred()
  const h = fixture({ cookieGet: () => cookies.promise })
  const pending = h.start()
  const current = jwtNoExpiry('synthetic-user-one')
  const stale = jwtNoExpiry('synthetic-user-two')
  h.window.webContents.storage.token = current
  await h.advance(5000)
  assert.deepEqual(h.tokens.map(event => event.value), [current], 'storage must not wait for the cookie read')
  cookies.resolve([cookie(stale)])
  await tick()
  assert.deepEqual(h.tokens.map(event => event.value), [current], 'stale cookie must not replace active storage')
  await h.advance(3000)
  assert.deepEqual(h.tokens.map(event => event.value), [current], 'later polls cannot supersede storage with stale cookie')
  assert.equal(h.results.length, 0, 'candidate arbitration is not server authentication')
  await cancel(h, pending)
})

test('a cookie fallback may be captured first while storage hangs, then authoritative storage supersedes it', async () => {
  const storage = deferred()
  const h = fixture({ execute: () => storage.promise })
  const pending = h.start()
  const fallback = jwtNoExpiry('synthetic-user-two')
  const current = jwtNoExpiry('synthetic-user-one')
  h.session.rows = [cookie(fallback)]
  await h.advance(5000)
  assert.deepEqual(h.tokens.map(event => event.value), [fallback], 'cookie fallback must not await stalled script')
  storage.resolve(current)
  await tick()
  assert.deepEqual(h.tokens.map(event => event.value), [fallback, current])
  await h.advance(2000)
  assert.deepEqual(h.tokens.map(event => event.value), [fallback, current], 'earlier cookie must not recur')
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('no-exp Set-Cookie and changed events remain signals for a scoped jar read', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  h.invoke(h.session.hooks.headers, ownedRequest(h, {
    responseHeaders: { 'Set-Cookie': ['token=' + jwtNoExpiry() + '; Domain=evil.invalid'] },
  }))
  h.session.cookies.emit('changed', {}, cookie(jwtNoExpiry()), 'explicit', false)
  await h.advance(2000)
  assert.equal(h.tokens.length, 0, 'Do not trust token bytes from raw event payloads')
  h.session.rows = [cookie(jwtNoExpiry())]
  h.session.cookies.emit('changed', {}, cookie(jwtNoExpiry()), 'explicit', false)
  await h.advance(2000)
  assert.equal(h.tokens.length, 1)
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('no-exp cookie candidates keep host-only, domain, path, and expiry restrictions', async () => {
  for (const attributes of [
    { domain: 'z.ai', hostOnly: true }, { domain: '.z.ai', hostOnly: true },
    { domain: 'evilz.ai', hostOnly: false }, { domain: '.child.chat.z.ai', hostOnly: false },
    { domain: 'chat.z.ai.evil.invalid', hostOnly: false },
    { path: '/apiX' }, { path: '/unrelated' }, { name: 'unrelated' },
    { expirationDate: epoch / 1000 - 1 },
  ]) {
    const h = fixture()
    const pending = h.start()
    h.session.rows = [cookie(jwtNoExpiry(), attributes)]
    await h.advance(5000)
    assert.equal(h.tokens.length, 0, JSON.stringify(attributes))
    assert.equal(h.results.length, 0)
    await cancel(h, pending)
  }
})

test('no-exp request headers require exact official origin and the owning window', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  const invalidUrls = [
    'http://chat.z.ai/api/v1/auths/', 'https://chat.z.ai.evil.invalid/', 'https://z.ai/',
    'https://child.chat.z.ai/', 'https://chat.z.ai:444/', 'https://user:password@chat.z.ai/',
    'https://chat.z.ai./', 'https://accounts.google.com/',
  ]
  for (const url of invalidUrls) {
    h.invoke(h.session.hooks.before, ownedRequest(h, {
      url, requestHeaders: { Authorization: 'Bearer ' + jwtNoExpiry(), Cookie: secret },
    }))
    h.invoke(h.session.hooks.headers, ownedRequest(h, {
      url, responseHeaders: { 'Set-Cookie': ['token=' + jwtNoExpiry()] },
    }))
  }
  for (const webContentsId of [undefined, h.window.webContents.id + 1]) {
    h.invoke(h.session.hooks.before, ownedRequest(h, {
      webContentsId, requestHeaders: { Authorization: 'Bearer ' + jwtNoExpiry() },
    }))
  }
  assert.equal(h.tokens.length, 0)
  const headers = { Authorization: 'Bearer ' + jwtNoExpiry(), Cookie: secret }
  assert.equal(h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: headers })).requestHeaders, headers)
  assert.equal(h.tokens.length, 1)
  assert.deepEqual(Object.keys(h.tokens[0]).sort(), ['generation', 'key', 'value'])
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('no-exp storage cannot cross the current-document or injected-script origin guards', async () => {
  const h = fixture()
  const pending = h.start()
  await tick()
  h.window.navigate('https://identity.invalid/')
  h.window.webContents.storage.token = jwtNoExpiry()
  h.session.rows = [cookie(jwtNoExpiry())]
  await h.advance(5000)
  h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + jwtNoExpiry() } }))
  assert.equal(h.tokens.length, 0)
  assert.equal(h.calls.storageReads.length, 0)
  assert.equal(h.calls.cookieQueries.length, 0)
  await cancel(h, pending)
  for (const url of ['https://identity.invalid/', 'https://user:password@chat.z.ai/']) {
    const nested = fixture({ execute: (_script, _contents, run) => Promise.resolve(run(url)) })
    const wait = nested.start()
    nested.window.webContents.storage.token = jwtNoExpiry()
    await nested.advance(5000)
    assert.equal(nested.tokens.length, 0)
    assert.equal(nested.calls.storageReads.length, 0)
    await cancel(nested, wait)
  }
})

test('malformed, expired, near-expiry and future-nbf candidates do not bypass persistent gates', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwtNoExpiry()
  await h.advance(5000)
  const ticket = h.tokens[0].generation
  const invalid = [
    jwt('synthetic-user-one', { exp: epoch / 1000 }),
    jwt('synthetic-user-one', { exp: epoch / 1000 + 20 }),
    jwtNoExpiry('synthetic-user-one', { exp: null }),
    jwtNoExpiry('synthetic-user-one', { nbf: epoch / 1000 + 6 }),
    jwtNoExpiry('synthetic-user-one', { email: 'guest@guest.com' }),
    encodedJwt({ alg: 'none' }, { id: 'synthetic-user-one' }),
    'malformed_' + secret,
  ]
  for (const token of invalid) {
    h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + token } }))
    h.manager.completeWithSuccess({ token }, ticket)
  }
  await tick()
  assert.equal(h.tokens.length, 1)
  assert.equal(h.results.length, 0)
  assert.equal(h.session.storageFlushes, 0)
  await cancel(h, pending)
})

test('ephemeral Z.ai cannot emit or complete with unknown-expiry tokens', async () => {
  const h = fixture()
  const pending = h.start({ persistentAccountId: undefined })
  h.window.webContents.storage.token = jwtNoExpiry()
  h.session.rows = [cookie(jwtNoExpiry())]
  await h.advance(5000)
  h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + jwtNoExpiry() } }))
  assert.equal(h.tokens.length, 0)
  h.window.webContents.storage.token = jwt()
  await h.advance(2000)
  assert.equal(h.tokens.length, 1, 'Known-expiry ephemeral behavior is preserved')
  h.manager.completeWithSuccess({ token: jwtNoExpiry() }, h.tokens[0].generation)
  await tick()
  assert.equal(h.results.length, 0)
  assert.equal(h.session.storageFlushes, 0)
  await cancel(h, pending)
})

test('manager-approved no-exp replacement requires the current ticket and both storage flushes', async () => {
  const flushed = deferred()
  const h = fixture({ cookieFlush: () => flushed.promise })
  const pending = h.start()
  const loginSession = h.session
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  const ticket = h.tokens[0].generation
  const replacement = jwtNoExpiry()
  assert.notEqual(replacement, h.tokens[0].value)
  h.manager.completeWithSuccess({ token: replacement })
  h.manager.completeWithSuccess({ token: replacement }, ticket - 1)
  await tick()
  assert.equal(h.results.length, 0)
  assert.equal(loginSession.storageFlushes, 0)
  // Only the manager calls this after its separate official HTTP verification.
  h.manager.completeWithSuccess({ token: replacement, cookies: secret }, ticket)
  h.manager.completeWithSuccess({ token: replacement }, ticket)
  await tick()
  assert.equal(loginSession.storageFlushes, 1)
  assert.equal(loginSession.cookieFlushes, 1)
  assert.equal(h.results.length, 0)
  flushed.resolve()
  assert.deepEqual(plain(await pending), { success: true, credentials: { token: replacement } })
  assert.equal(h.results.length, 1)
  assert.equal(h.timers.size, 0)
  assert.equal(loginSession.hooks.before, null)
  assert.equal(loginSession.hooks.headers, null)
  assert.equal(h.helpers.readZaiSessionClaims(replacement, epoch + 5000), null, 'Success does not invent exp')
  h.assertPrivate()
})

test('new document invalidates no-exp capture tickets and the same token must be recaptured', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwtNoExpiry()
  await h.advance(5000)
  const oldTicket = h.tokens[0].generation
  h.window.navigate(origin + '/auth', false)
  h.manager.completeWithSuccess({ token: jwtNoExpiry() }, oldTicket)
  assert.equal(h.results.length, 0)
  h.window.webContents.emit('dom-ready')
  await h.advance(2000)
  assert.equal(h.tokens.length, 2)
  const currentTicket = h.tokens[1].generation
  assert.notEqual(currentTicket, oldTicket)
  h.manager.completeWithSuccess({ token: jwtNoExpiry() }, oldTicket)
  await tick()
  assert.equal(h.results.length, 0)
  h.manager.completeWithSuccess({ token: jwtNoExpiry() }, currentTicket)
  assert.equal((await pending).success, true)
  h.assertPrivate()
})

test('old-document no-exp reads are discarded across navigation out and back', async () => {
  const read = deferred()
  let first = true
  const h = fixture({ execute: (_script, _contents, run) => {
    if (first) { first = false; return read.promise }
    return Promise.resolve(run())
  } })
  const pending = h.start()
  await h.advance(5000)
  h.window.navigate('https://identity.invalid/')
  h.window.navigate(origin + '/')
  read.resolve(jwtNoExpiry())
  await tick()
  assert.equal(h.tokens.length, 0)
  h.window.webContents.storage.token = jwtNoExpiry('synthetic-user-two')
  await h.advance(2000)
  assert.deepEqual(h.tokens.map(event => event.value), [jwtNoExpiry('synthetic-user-two')])
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('cancelled reads and intercepted callbacks cannot inject no-exp tokens into a replacement attempt', async () => {
  const storage = deferred(), cookies = deferred()
  let firstStorage = true, firstCookies = true
  const h = fixture({
    execute: (_script, _contents, run) => {
      if (firstStorage) { firstStorage = false; return storage.promise }
      return Promise.resolve(run())
    },
    cookieGet: () => {
      if (firstCookies) { firstCookies = false; return cookies.promise }
      return Promise.resolve([])
    },
  })
  const old = h.start()
  await h.advance(5000)
  const oldBefore = h.session.hooks.before
  const oldRequest = ownedRequest(h)
  await cancel(h, old)
  const current = h.start({ persistentAccountId: 'account-two' })
  const currentHook = h.session.hooks.before
  h.window.webContents.storage.token = jwtNoExpiry('synthetic-user-two')
  storage.resolve(jwtNoExpiry())
  cookies.resolve([cookie(jwtNoExpiry())])
  h.invoke(oldBefore, { ...oldRequest, requestHeaders: { Authorization: 'Bearer ' + jwtNoExpiry() } })
  await tick()
  assert.equal(h.tokens.length, 0)
  assert.equal(h.session.hooks.before, currentHook)
  await h.advance(5000)
  assert.deepEqual(h.tokens.map(event => event.value), [jwtNoExpiry('synthetic-user-two')])
  assert.equal(h.results.length, 1, 'Only the cancelled attempt has completed')
  await cancel(h, current)
})

test('timed-out no-exp reads never become candidates and do not duplicate physical reads', async () => {
  const read = deferred()
  let first = true
  const h = fixture({ execute: (_script, _contents, run) => {
    if (first) { first = false; return read.promise }
    return Promise.resolve(run())
  } })
  const pending = h.start()
  await h.advance(5000)
  await h.advance(9500)
  assert.equal(h.calls.scripts.length, 1)
  read.resolve(jwtNoExpiry())
  await tick()
  assert.equal(h.tokens.length, 0)
  h.window.webContents.storage.token = jwtNoExpiry('synthetic-user-two')
  await h.advance(2000)
  assert.equal(h.calls.scripts.length, 2)
  assert.deepEqual(h.tokens.map(event => event.value), [jwtNoExpiry('synthetic-user-two')])
  await cancel(h, pending)
})

test('navigation during no-exp persistence cannot publish prior-document success', async () => {
  for (const url of [origin + '/auth', 'https://identity.invalid/']) {
    const flushed = deferred()
    const h = fixture({ cookieFlush: () => flushed.promise })
    const pending = h.start()
    h.window.webContents.storage.token = jwtNoExpiry()
    await h.advance(5000)
    h.manager.completeWithSuccess({ token: jwtNoExpiry() }, h.tokens[0].generation)
    await tick()
    h.window.navigate(url)
    flushed.resolve()
    assert.deepEqual(plain(await pending), { success: false, error: 'Login page changed before completion' })
    assert.equal(h.results.length, 1)
    assert.equal(h.timers.size, 0)
    h.assertPrivate()
  }
})

test('cancel during no-exp persistence wins without clearing a replacement attempt', async () => {
  const flushed = deferred()
  const h = fixture({ cookieFlush: () => flushed.promise })
  const old = h.start()
  h.window.webContents.storage.token = jwtNoExpiry()
  await h.advance(5000)
  h.manager.completeWithSuccess({ token: jwtNoExpiry() }, h.tokens[0].generation)
  await tick()
  await cancel(h, old)
  const current = h.start()
  const hook = h.session.hooks.before
  flushed.resolve()
  await tick()
  assert.equal(h.results.length, 1)
  assert.equal(h.session.hooks.before, hook)
  assert.equal(h.manager.isWindowOpen(), true)
  await cancel(h, current)
})

test('failed no-exp persistence stays redacted and never publishes success', async () => {
  for (const mode of ['storage', 'cookie', 'deadline']) {
    const h = fixture({
      storageFlushError: mode === 'storage',
      cookieFlush: () => mode === 'cookie' ? Promise.reject(new Error(secret)) : new Promise(() => {}),
    })
    const pending = h.start({ timeout: mode === 'deadline' ? 6000 : 300000 })
    h.window.webContents.storage.token = jwtNoExpiry()
    await h.advance(5000)
    h.manager.completeWithSuccess({ token: jwtNoExpiry() }, h.tokens[0].generation)
    await tick()
    if (mode === 'deadline') await h.advance(1000)
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(h.results.length, 1)
    assert.equal(h.timers.size, 0)
    h.assertPrivate()
  }
})

test('same-document SPA navigation preserves a no-exp candidate without granting success', async () => {
  const read = deferred()
  const h = fixture({ execute: () => read.promise })
  const pending = h.start()
  await h.advance(5000)
  h.window.webContents.emit('did-start-navigation', {}, origin + '/#signed-in', true, true)
  h.window.webContents.url = origin + '/#signed-in'
  h.window.webContents.emit('did-navigate-in-page', {}, origin + '/#signed-in', true)
  read.resolve(jwtNoExpiry())
  await tick()
  assert.equal(h.tokens.length, 1)
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})
