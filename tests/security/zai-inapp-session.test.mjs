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
    start, advance, invoke, newManager: () => attach(new InAppLoginManager()),
    get window() { return windows.at(-1) },
    get session() { return sessions.get(windows.at(-1)?.options.webPreferences.partition) },
    assertPrivate() {
      assert.equal(calls.network, 0, 'No app, account store, HTTP, or unmocked module may execute')
      const visible = JSON.stringify({ logs, statuses, errors: results.map(result => result.error) })
      assert.ok(!visible.includes(secret), 'Do not return or log an exception containing credentials')
      for (const token of [jwt(), jwt('synthetic-user-two')]) {
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

test('stable account partitions, isolated accounts, and ephemeral non-Z.ai login', async () => {
  const h = fixture()
  const first = h.start()
  const a = h.calls.partitions.at(-1)
  assert.match(a, /^persist:chat2api-zai-[a-f0-9]{32}$/)
  assert.ok(!a.includes('account-one'))
  assert.equal(h.window.options.webPreferences.sandbox, true)
  assert.equal(h.window.options.webPreferences.nodeIntegration, false)
  assert.equal(h.window.options.webPreferences.webSecurity, true)
  await cancel(h, first)
  const second = h.start()
  assert.equal(h.calls.partitions.at(-1), a)
  await cancel(h, second)
  const third = h.start({ persistentAccountId: 'account-two' })
  assert.notEqual(h.calls.partitions.at(-1), a)
  await cancel(h, third)
  const ephemeral = []
  for (let i = 0; i < 2; i++) {
    const pending = h.start({ providerId: 'deepseek', providerType: 'deepseek', persistentAccountId: undefined })
    ephemeral.push(h.calls.partitions.at(-1))
    await cancel(h, pending)
  }
  assert.match(ephemeral[0], /^oauth-[a-f0-9-]{36}$/)
  assert.notEqual(ephemeral[0], ephemeral[1])
})

test('invalid persistence or timeout is refused without creating a session', async () => {
  const h = fixture()
  const wrongProvider = await h.start({ providerType: 'deepseek', persistentAccountId: secret })
  assert.equal(wrongProvider.success, false)
  assert.equal(h.calls.partitions.length, 0)
  for (const timeout of [0, -1, Infinity, NaN, 300001]) {
    assert.equal((await h.start({ timeout })).success, false)
  }
  const invalidAccount = await h.start({ persistentAccountId: '' })
  assert.equal(invalidAccount.success, false)
  assert.equal(h.calls.partitions.length, 0)
  assert.equal(h.timers.size, 0)
  h.assertPrivate()
})

test('an early loaded persistent token is checked at five seconds and emitted only once', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwt()
  await h.advance(4999)
  assert.equal(h.tokens.length, 0)
  await h.advance(1)
  assert.equal(h.tokens.length, 1)
  assert.equal(h.tokens[0].key, 'token')
  assert.equal(typeof h.tokens[0].generation, 'number')
  assert.deepEqual(Object.keys(h.tokens[0]).sort(), ['generation', 'key', 'value'])
  await h.advance(6000)
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})

test('DOM-ready can capture and persist a token cookie while full loading and renderer execution remain pending', async () => {
  const renderer = deferred()
  const h = fixture({
    load: (url, window) => {
      window.navigate(url, false)
      window.webContents.emit('dom-ready')
      return Promise.resolve()
    },
    execute: () => renderer.promise,
  })
  const pending = h.start()
  await tick()
  h.session.rows = [cookie()]
  await h.advance(4999)
  assert.equal(h.tokens.length, 0)
  await h.advance(1)
  assert.equal(h.tokens.length, 1)
  assert.equal(h.calls.scripts.length, 1)
  assert.equal(h.calls.cookieQueries.length, 1)
  await h.advance(8000)
  assert.equal(h.calls.scripts.length, 1, 'A timed-out physical renderer call must not be duplicated')
  assert.ok(h.calls.cookieQueries.length >= 3, 'Cookie polling must continue independently')
  h.manager.completeWithSuccess({ token: jwt() }, h.tokens[0].generation)
  assert.equal((await pending).success, true)
  assert.equal(h.session.storageFlushes, 1)
  assert.equal(h.session.cookieFlushes, 1)
  assert.equal(h.timers.size, 0)
  renderer.resolve(jwt('synthetic-user-two'))
  await tick()
  assert.equal(h.tokens.length, 1)
  assert.equal(h.results.length, 1)
  h.assertPrivate()
})

test('renderer rejection or a synchronous exception does not suppress the scoped cookie source', async () => {
  for (const execute of [
    () => Promise.reject(new Error(secret)),
    () => { throw new Error(secret) },
  ]) {
    const h = fixture({ execute })
    const pending = h.start()
    await tick()
    h.session.rows = [cookie()]
    await h.advance(5000)
    assert.equal(h.tokens.length, 1)
    assert.equal(h.calls.cookieQueries.length, 1)
    assert.equal(h.tokens[0].value, jwt())
    await cancel(h, pending)
  }
})

test('a stalled cookie read cannot prevent localStorage capture or accumulate cookie requests', async () => {
  const h = fixture({ cookieGet: () => new Promise(() => {}) })
  const pending = h.start()
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  assert.equal(h.tokens.length, 1)
  await h.advance(8000)
  assert.equal(h.calls.cookieQueries.length, 1)
  assert.ok(h.calls.scripts.length >= 3)
  await cancel(h, pending)
})

test('a renderer deadline discards its late value and permits a fresh read only after physical settlement', async () => {
  const read = deferred()
  let first = true
  const h = fixture({ execute: (_script, _contents, run) => {
    if (first) { first = false; return read.promise }
    return Promise.resolve(run())
  } })
  const pending = h.start()
  await h.advance(5000)
  assert.equal(h.calls.scripts.length, 1)
  await h.advance(9500)
  assert.equal(h.calls.scripts.length, 1)
  assert.equal(h.tokens.length, 0)
  h.window.webContents.storage.token = jwt('synthetic-user-two')
  read.resolve(jwt())
  await tick()
  assert.equal(h.tokens.length, 0, 'The timed-out value must never become a candidate')
  await h.advance(2000)
  assert.equal(h.calls.scripts.length, 2)
  assert.deepEqual(h.tokens.map(event => event.value), [jwt('synthetic-user-two')])
  await cancel(h, pending)
})

test('a pending old-document renderer read does not block the new document cookie or emit a late token', async () => {
  const read = deferred()
  const h = fixture({ execute: () => read.promise })
  const pending = h.start()
  await h.advance(5000)
  assert.equal(h.calls.scripts.length, 1)
  h.window.navigate(origin + '/signed-in')
  h.session.rows = [cookie(jwt('synthetic-user-two'))]
  await h.advance(2000)
  assert.deepEqual(h.tokens.map(event => event.value), [jwt('synthetic-user-two')])
  assert.equal(h.calls.scripts.length, 1)
  read.resolve(jwt())
  await tick()
  assert.deepEqual(h.tokens.map(event => event.value), [jwt('synthetic-user-two')])
  await cancel(h, pending)
})

test('late completion from a destroyed window cannot release the replacement window read', async () => {
  const oldRead = deferred(), newRead = deferred()
  let calls = 0
  const h = fixture({ execute: () => (++calls === 1 ? oldRead.promise : newRead.promise) })
  const first = h.start()
  await h.advance(5000)
  await cancel(h, first)
  const second = h.start()
  await h.advance(5000)
  assert.equal(calls, 2)
  oldRead.resolve(jwt())
  await tick()
  assert.equal(h.tokens.length, 0)
  await h.advance(1000)
  assert.equal(calls, 2)
  newRead.resolve(jwt('synthetic-user-two'))
  await tick()
  assert.deepEqual(h.tokens.map(event => event.value), [jwt('synthetic-user-two')])
  await cancel(h, second)
})

test('a cancelled provisional navigation recovers the ready document without reviving old validation', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  const oldTicket = h.tokens[0].generation
  const contents = h.window.webContents
  contents.loadingMainFrame = true
  contents.emit('did-start-navigation', {}, 'https://identity.invalid/', false, true)
  contents.storage.token = jwt('synthetic-user-two')
  h.session.rows = [cookie(jwt('synthetic-user-two'))]
  contents.emit('dom-ready')
  contents.emit('did-fail-provisional-load', {}, -3, secret, 'https://identity.invalid/', true)
  contents.emit('did-stop-loading')
  await h.advance(2000)
  assert.equal(h.tokens.length, 1, 'A stale stop or readiness event must not authorize a pending navigation')
  contents.loadingMainFrame = false
  contents.emit('did-stop-loading')
  await h.advance(2000)
  assert.equal(h.tokens.length, 2)
  assert.equal(h.tokens[1].value, jwt('synthetic-user-two'))
  assert.ok(h.tokens[1].generation > oldTicket)
  h.manager.completeWithSuccess({ token: jwt() }, oldTicket)
  await tick()
  assert.equal(h.results.length, 0)
  await cancel(h, pending)
})

test('a newly committed document needs its own readiness event after a stale prior DOM event', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  const contents = h.window.webContents
  contents.loadingMainFrame = true
  contents.emit('did-start-navigation', {}, origin + '/signed-in', false, true)
  contents.emit('dom-ready')
  contents.url = origin + '/signed-in'
  contents.emit('did-navigate', {}, contents.url, 200, 'OK')
  h.session.rows = [cookie()]
  await h.advance(2000)
  assert.equal(h.tokens.length, 0)
  contents.emit('dom-ready')
  await h.advance(2000)
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})

test('cancellation settles all logical read deadlines even when both browser promises stay pending', async () => {
  const h = fixture({
    execute: () => new Promise(() => {}),
    cookieGet: () => new Promise(() => {}),
  })
  const pending = h.start()
  await h.advance(5000)
  assert.equal(h.calls.scripts.length, 1)
  assert.equal(h.calls.cookieQueries.length, 1)
  await cancel(h, pending)
  await h.advance(10000)
  assert.equal(h.timers.size, 0)
  assert.equal(h.tokens.length, 0)
  assert.equal(h.results.length, 1)
  assert.equal(h.calls.scripts.length, 1)
  assert.equal(h.calls.cookieQueries.length, 1)
})

test('only the exact Z.ai origin and owning window can contribute request tokens', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  const invalid = [
    'http://chat.z.ai/api/v1/auths/', 'https://chat.z.ai.evil.invalid/',
    'https://evilz.ai/', 'https://z.ai/', 'https://chat.z.ai:444/',
    'https://user:password@chat.z.ai/', 'https://accounts.google.com/',
    'https://chat.z.ai./', 'https://child.chat.z.ai/',
  ]
  for (const url of invalid) {
    const headers = { Authorization: 'Bearer ' + jwt(), Cookie: secret }
    const result = h.invoke(h.session.hooks.before, ownedRequest(h, { url, requestHeaders: headers }))
    assert.equal(result.requestHeaders, headers)
    h.invoke(h.session.hooks.headers, ownedRequest(h, {
      url, responseHeaders: { 'Set-Cookie': ['token=' + jwt() + '; Secure'] },
    }))
  }
  for (const webContentsId of [undefined, h.window.webContents.id + 1]) {
    h.invoke(h.session.hooks.before, ownedRequest(h, { webContentsId, requestHeaders: { Authorization: 'Bearer ' + jwt() } }))
  }
  assert.equal(h.tokens.length, 0)
  h.invoke(h.session.hooks.before, ownedRequest(h, {
    url: 'https://chat.z.ai:443/api/models',
    requestHeaders: { Authorization: 'Bearer ' + jwt() },
  }))
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})

test('a third-party current document cannot capture a first-party request or local storage', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwt()
  await tick()
  h.window.navigate('https://identity.invalid/')
  await h.advance(5000)
  h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + jwt() } }))
  assert.equal(h.tokens.length, 0)
  assert.equal(h.calls.storageReads.length, 0)
  h.window.navigate(origin + '/')
  await h.advance(2000)
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})

test('the injected script checks origin and userinfo again inside the document', async () => {
  for (const url of ['https://identity.invalid/', 'https://user:password@chat.z.ai/']) {
    const h = fixture({ execute: (_script, _contents, run) => Promise.resolve(run(url)) })
    const pending = h.start()
    h.window.webContents.storage.token = jwt()
    await h.advance(5000)
    assert.equal(h.tokens.length, 0)
    assert.equal(h.calls.storageReads.length, 0)
    await cancel(h, pending)
  }
})

test('expired, guest, malformed and near-expiry Z.ai token candidates never pass local capture', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  for (const value of [
    'not_a_jwt_' + secret,
    jwt('synthetic-user-one', { exp: epoch / 1000 }),
    jwt('synthetic-user-one', { exp: epoch / 1000 + 20 }),
    jwt('synthetic-user-one', { email: 'guest@guest.com' }),
    jwt('synthetic-user-one', { exp: 'tomorrow' }),
  ]) {
    h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + value } }))
  }
  assert.equal(h.tokens.length, 0)
  await cancel(h, pending)
})

test('Z.ai cookie candidates obey domain, host-only, path and expiry semantics', async () => {
  const cases = [
    [{ domain: 'chat.z.ai', hostOnly: true }, true],
    [{ domain: '.chat.z.ai', hostOnly: false }, true],
    [{ domain: '.z.ai', hostOnly: false }, true],
    [{ domain: 'z.ai', hostOnly: false, path: '/api' }, true],
    [{ domain: 'z.ai', hostOnly: true }, false],
    [{ domain: '.z.ai', hostOnly: true }, false],
    [{ domain: 'evilz.ai', hostOnly: false }, false],
    [{ domain: 'chat.z.ai.evil.invalid', hostOnly: false }, false],
    [{ domain: '.child.chat.z.ai', hostOnly: false }, false],
    [{ path: '/api/v1/auths/' }, true],
    [{ path: '/apiX' }, false],
    [{ path: '/unrelated' }, false],
    [{ name: 'unrelated_secret' }, false],
    [{ expirationDate: epoch / 1000 - 1 }, false],
  ]
  for (const [attributes, accepted] of cases) {
    const h = fixture()
    const pending = h.start()
    h.session.rows = [cookie(jwt(), attributes)]
    await h.advance(5000)
    assert.equal(h.tokens.length, accepted ? 1 : 0, JSON.stringify(attributes))
    assert.ok(h.calls.cookieQueries.length > 0)
    for (const filter of h.calls.cookieQueries) assert.deepEqual(filter, { url: authUrl, name: 'token' })
    for (const event of h.tokens) assert.equal(Object.hasOwn(event, 'allCookies'), false)
    await cancel(h, pending)
  }
})

test('different applicable token cookies are ambiguous while duplicate equal values are harmless', async () => {
  for (const same of [false, true]) {
    const h = fixture()
    const pending = h.start()
    h.session.rows = [
      cookie(),
      cookie(same ? jwt() : jwt('synthetic-user-two'), { domain: '.z.ai', hostOnly: false, path: '/api' }),
      cookie(secret, { name: 'unrelated' }),
    ]
    await h.advance(5000)
    assert.equal(h.tokens.length, same ? 1 : 0)
    await cancel(h, pending)
  }
})

test('Set-Cookie and changed events are signals, never raw Z.ai credential sources', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  h.invoke(h.session.hooks.headers, ownedRequest(h, {
    responseHeaders: { 'Set-Cookie': ['token=' + jwt() + '; Domain=evil.invalid; Secure'] },
  }))
  h.session.cookies.emit('changed', {}, cookie(), 'explicit', false)
  await h.advance(2000)
  assert.equal(h.tokens.length, 0, 'Event payload must not bypass the current cookie jar')
  h.session.rows = [cookie()]
  h.session.cookies.emit('changed', {}, cookie(), 'explicit', false)
  await h.advance(2000)
  assert.equal(h.tokens.length, 1)
  assert.deepEqual(Object.keys(h.tokens[0]).sort(), ['generation', 'key', 'value'])
  await cancel(h, pending)
})

test('removed and expired cookie payloads cannot authorize success', async () => {
  const h = fixture()
  const pending = h.start()
  await h.advance(5000)
  h.session.cookies.emit('changed', {}, cookie(), 'expired', true)
  h.session.cookies.emit('changed', {}, cookie(jwt(), { expirationDate: epoch / 1000 - 1 }), 'expired-overwrite', false)
  await h.advance(2000)
  assert.equal(h.tokens.length, 0)
  await cancel(h, pending)
})

test('late localStorage results cannot affect a cancelled or replacement attempt', async () => {
  const read = deferred()
  let first = true
  const h = fixture({ execute: (_script, _contents, run) => {
    if (first) { first = false; return read.promise }
    return Promise.resolve(run())
  } })
  const a = h.start()
  await h.advance(5000)
  assert.equal(h.calls.scripts.length, 1, 'Reach the deferred read before cancellation')
  await cancel(h, a)
  const b = h.start({ persistentAccountId: 'account-two' })
  read.resolve(jwt())
  await tick()
  assert.equal(h.tokens.length, 0)
  assert.equal(h.results.length, 1)
  assert.equal(h.manager.isWindowOpen(), true)
  await cancel(h, b)
})

test('late cookie reads cannot affect the replacement attempt', async () => {
  const read = deferred()
  let first = true
  const h = fixture({ cookieGet: () => {
    if (first) { first = false; return read.promise }
    return Promise.resolve([])
  } })
  const a = h.start()
  await h.advance(5000)
  assert.equal(h.calls.cookieQueries.length, 1, 'Reach the deferred cookie query before cancellation')
  await cancel(h, a)
  const b = h.start()
  const currentBefore = h.session.hooks.before
  read.resolve([cookie()])
  await tick()
  assert.equal(h.tokens.length, 0)
  assert.equal(h.session.hooks.before, currentBefore)
  await cancel(h, b)
})

test('navigation out and back invalidates an in-flight read from the old document', async () => {
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
  read.resolve(jwt())
  await tick()
  assert.equal(h.tokens.length, 0)
  h.window.webContents.storage.token = jwt()
  await h.advance(2000)
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})

test('Z.ai completion requires the matching captured generation', async () => {
  const h = fixture()
  const a = h.start()
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  const oldGeneration = h.tokens[0].generation
  h.manager.completeWithSuccess({ token: jwt() })
  await tick()
  assert.equal(h.results.length, 0)
  await cancel(h, a)
  const b = h.start()
  h.window.webContents.storage.token = jwt('synthetic-user-two')
  await h.advance(5000)
  h.manager.completeWithSuccess({ token: jwt() }, oldGeneration)
  await tick()
  assert.equal(h.results.length, 1)
  const currentGeneration = h.tokens.at(-1).generation
  assert.notEqual(currentGeneration, oldGeneration)
  h.manager.completeWithSuccess({ token: jwt('synthetic-user-two') }, currentGeneration)
  const result = await b
  assert.equal(result.success, true)
  assert.equal(h.results.length, 2)
  h.assertPrivate()
})

test('successful persistence flushes both stores before one completion and removes only owned listeners', async () => {
  const flushed = deferred()
  const h = fixture({ cookieFlush: () => flushed.promise })
  const pending = h.start()
  const session = h.session
  const unrelated = () => {}
  session.cookies.on('changed', unrelated)
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  const generation = h.tokens[0].generation
  h.manager.completeWithSuccess({ token: jwt(), cookies: secret }, generation)
  h.manager.completeWithSuccess({ token: jwt() }, generation)
  await tick()
  assert.equal(session.storageFlushes, 1)
  assert.equal(session.cookieFlushes, 1)
  assert.equal(h.results.length, 0)
  assert.equal(h.window.destroyed, false)
  flushed.resolve()
  const result = await pending
  assert.deepEqual(plain(result), { success: true, credentials: { token: jwt() } })
  assert.equal(h.results.length, 1)
  assert.equal(h.window.destroyed, true)
  assert.equal(h.timers.size, 0)
  assert.equal(session.hooks.before, null)
  assert.equal(session.hooks.headers, null)
  assert.deepEqual(session.cookies.listeners('changed'), [unrelated])
  assert.ok(h.calls.order.indexOf('storage-flush') < h.calls.order.indexOf('cookies-flush'))
  assert.ok(h.calls.order.indexOf('cookies-flush') < h.calls.order.indexOf('window-destroyed'))
  h.assertPrivate()
})

test('storage flush throws, cookie rejects, and pending flushes fail closed without secret errors', async () => {
  for (const mode of ['storage', 'reject', 'timeout']) {
    const h = fixture({
      storageFlushError: mode === 'storage',
      cookieFlush: () => mode === 'reject' ? Promise.reject(new Error(secret)) : new Promise(() => {}),
    })
    const pending = h.start()
    h.window.webContents.storage.token = jwt()
    await h.advance(5000)
    h.manager.completeWithSuccess({ token: jwt() }, h.tokens[0].generation)
    await tick()
    if (mode === 'timeout') await h.advance(5000)
    const result = await pending
    assert.deepEqual(plain(result), { success: false, error: 'Unable to preserve the login session' })
    assert.equal(h.timers.size, 0)
    assert.equal(h.results.length, 1)
    h.assertPrivate()
  }
})

test('cancel during flush wins and late resolution cannot clear the next attempt hooks', async () => {
  const flushed = deferred()
  const h = fixture({ cookieFlush: () => flushed.promise })
  const a = h.start()
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  h.manager.completeWithSuccess({ token: jwt() }, h.tokens[0].generation)
  await tick()
  await cancel(h, a)
  const b = h.start()
  const before = h.session.hooks.before, headers = h.session.hooks.headers
  flushed.resolve()
  await tick()
  assert.equal(h.results.length, 1)
  assert.equal(h.session.hooks.before, before)
  assert.equal(h.session.hooks.headers, headers)
  assert.equal(h.manager.isWindowOpen(), true)
  await cancel(h, b)
})

test('the original login deadline still wins while storage is flushing', async () => {
  const flushed = deferred()
  const h = fixture({ cookieFlush: () => flushed.promise })
  const pending = h.start({ timeout: 6000 })
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  h.manager.completeWithSuccess({ token: jwt() }, h.tokens[0].generation)
  await tick()
  assert.equal(h.session.cookieFlushes, 1, 'Reach the pending flush before the deadline')
  await h.advance(1000)
  assert.deepEqual(plain(await pending), { success: false, error: 'Login timeout' })
  flushed.reject(new Error(secret))
  await tick()
  assert.equal(h.results.length, 1)
  assert.equal(h.timers.size, 0)
  h.assertPrivate()
})

test('stale intercepted callbacks continue once without touching a new login', async () => {
  const h = fixture()
  const a = h.start()
  await h.advance(5000)
  const oldBefore = h.session.hooks.before, oldHeaders = h.session.hooks.headers
  const oldRequest = ownedRequest(h)
  await cancel(h, a)
  const b = h.start()
  const newBefore = h.session.hooks.before
  h.invoke(oldBefore, { ...oldRequest, requestHeaders: { Authorization: 'Bearer ' + jwt() } })
  h.invoke(oldHeaders, { ...oldRequest, responseHeaders: { 'Set-Cookie': ['token=' + jwt()] } })
  assert.equal(h.tokens.length, 0)
  assert.equal(h.session.hooks.before, newBefore)
  await cancel(h, b)
})

test('a second manager cannot overwrite a live persistent session hooks', async () => {
  const h = fixture()
  const a = h.start()
  const before = h.session.hooks.before
  const second = h.newManager()
  const rejected = await h.start({}, second)
  assert.equal(rejected.success, false)
  assert.equal(h.session.hooks.before, before)
  assert.equal(h.manager.isWindowOpen(), true)
  await cancel(h, a)
  const next = h.start({}, second)
  second.cancel()
  assert.equal((await next).success, false)
  h.assertPrivate()
})

test('startup and late proxy/load errors stay redacted and cannot complete the next attempt', async () => {
  for (const key of ['windowError', 'sessionError']) {
    const h = fixture({ [key]: true })
    assert.equal((await h.start()).success, false)
    assert.equal(h.timers.size, 0)
    h.assertPrivate()
  }
  const proxy = deferred()
  const h = fixture({ proxy: config => config.mode === 'direct' ? proxy.promise : Promise.resolve() })
  const a = h.start({ proxyMode: 'none' })
  await cancel(h, a)
  const b = h.start({ proxyMode: 'system' })
  proxy.reject(new Error(secret))
  await tick()
  assert.equal(h.results.length, 1)
  assert.equal(h.calls.order.filter(value => value === 'load').length, 1)
  await cancel(h, b)

  const load = deferred()
  const l = fixture({ load: () => load.promise })
  const failed = l.start()
  load.reject(new Error(secret))
  assert.deepEqual(plain(await failed), { success: false, error: 'Failed to load login page' })
  l.assertPrivate()
})

test('other providers retain JSON token and cookie-bundle extraction without persistent writes', async () => {
  const h = fixture()
  const a = h.start({ providerId: 'minimax', providerType: 'minimax', persistentAccountId: undefined })
  h.window.webContents.storage._token = JSON.stringify({ value: jwt() })
  h.window.webContents.storage.user_detail_agent = JSON.stringify({ realUserID: 'synthetic-real-user-id' })
  await h.advance(5000)
  assert.deepEqual(h.tokens.map(({ key }) => key), ['token', 'realUserID'])
  h.manager.completeWithSuccess({ token: jwt(), realUserID: 'synthetic-real-user-id' })
  assert.equal((await a).success, true)
  assert.equal(h.session.storageFlushes, 0)

  const b = h.start({ providerId: 'perplexity', providerType: 'perplexity', persistentAccountId: undefined })
  h.session.rows = [
    cookie('generic_cookie_' + 'a'.repeat(40), { name: '__Secure-next-auth.session-token', domain: '.perplexity.ai' }),
    cookie('generic_other_' + 'b'.repeat(40), { name: 'other', domain: '.perplexity.ai' }),
  ]
  await h.advance(5000)
  const event = h.tokens.at(-1)
  assert.equal(event.key, '__Secure-next-auth.session-token')
  assert.equal(event.allCookies.other, 'generic_other_' + 'b'.repeat(40))
  await cancel(h, b)
})

test('callback and cookie cleanup exceptions expose no values and never strand requests', async () => {
  const h = fixture({ detachBeforeError: true })
  const pending = h.start()
  h.manager.on('tokenFound', () => { throw new Error(secret) })
  await h.advance(5000)
  h.invoke(h.session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + jwt() } }))
  const session = h.session
  await cancel(h, pending)
  assert.equal(session.hooks.headers, null, 'A failing first detach must not prevent the second detach')
  assert.equal(session.cookies.listenerCount('changed'), 0)
  h.invoke(session.hooks.before, ownedRequest(h, { requestHeaders: { Authorization: 'Bearer ' + jwt() } }))
  h.assertPrivate()
})

test('a reused persistent session explicitly restores the selected system proxy', async () => {
  const h = fixture()
  const a = h.start({ proxyMode: 'none' })
  await tick()
  const partition = h.calls.partitions.at(-1)
  await cancel(h, a)
  const b = h.start({ proxyMode: 'system' })
  await tick()
  assert.equal(h.calls.partitions.at(-1), partition)
  assert.deepEqual(h.calls.proxyModes, ['direct', 'system'])
  await cancel(h, b)
})

test('an aborted superseded load cannot close a later main document', async () => {
  const initialLoad = deferred()
  const h = fixture({ load: (url, window) => {
    window.navigate(url, false)
    return initialLoad.promise
  } })
  const pending = h.start()
  await tick()
  assert.equal(h.calls.order.filter(value => value === 'load').length, 1)
  h.window.navigate(origin + '/auth')
  initialLoad.reject(new Error('ERR_ABORTED ' + secret))
  await tick()
  assert.equal(h.results.length, 0)
  assert.equal(h.manager.isWindowOpen(), true)
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})

test('validation tickets expire on a new document and the same token can be checked again', async () => {
  const h = fixture()
  const pending = h.start()
  h.window.webContents.storage.token = jwt()
  await h.advance(5000)
  const oldTicket = h.tokens[0].generation
  h.window.navigate(origin + '/auth', false)
  h.manager.completeWithSuccess({ token: jwt() }, oldTicket)
  assert.equal(h.results.length, 0)
  h.window.webContents.emit('did-finish-load')
  await h.advance(2000)
  assert.equal(h.tokens.length, 2)
  const ticket = h.tokens[1].generation
  assert.notEqual(ticket, oldTicket)
  h.manager.completeWithSuccess({ token: jwt() }, oldTicket)
  await tick()
  assert.equal(h.results.length, 0)
  h.manager.completeWithSuccess({ token: jwt() }, ticket)
  assert.equal((await pending).success, true)
  h.assertPrivate()
})

test('navigation during flush cannot publish success from the prior document', async () => {
  for (const url of [origin + '/auth', 'https://identity.invalid/']) {
    const flushed = deferred()
    const h = fixture({ cookieFlush: () => flushed.promise })
    const pending = h.start()
    h.window.webContents.storage.token = jwt()
    await h.advance(5000)
    h.manager.completeWithSuccess({ token: jwt() }, h.tokens[0].generation)
    await tick()
    assert.equal(h.session.cookieFlushes, 1)
    h.window.navigate(url)
    flushed.resolve()
    const result = await pending
    assert.deepEqual(plain(result), { success: false, error: 'Login page changed before completion' })
    assert.equal(h.results.length, 1)
    assert.equal(h.timers.size, 0)
    h.assertPrivate()
  }
})

test('same-document SPA navigation preserves an in-flight storage read', async () => {
  const read = deferred()
  let first = true
  const h = fixture({ execute: (_script, _contents, run) => {
    if (first) { first = false; return read.promise }
    return Promise.resolve(run())
  } })
  const pending = h.start()
  await h.advance(5000)
  assert.equal(h.calls.scripts.length, 1)
  h.window.webContents.emit('did-start-navigation', {}, origin + '/#signed-in', true, true)
  h.window.webContents.url = origin + '/#signed-in'
  h.window.webContents.emit('did-navigate-in-page', {}, origin + '/#signed-in', true)
  read.resolve(jwt())
  await tick()
  assert.equal(h.tokens.length, 1)
  await cancel(h, pending)
})
