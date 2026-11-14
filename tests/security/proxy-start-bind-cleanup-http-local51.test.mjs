import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual product ProxyServer, ProxyStatusManager, SessionManager and authenticated
// management proxy Koa route. A real 127.0.0.1:0 listener owns an occupied
// port to provoke EADDRINUSE. Store, scheduler clock and account data are
// strictly synthetic. No Electron profile, credentials, provider transport or
// external socket exists.
const nodeRequire = createRequire(import.meta.url)
const AUTH = 'SYNTHETIC_LOCAL51_MANAGEMENT_ONLY'

function product(relative, deps, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'),
    {
      fileName: relative,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      },
    },
  ).outputText
  runInNewContext(code, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error, TextDecoder, Map, Set,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected local product dependency: ' + relative + ':' + id)
      return nodeRequire(id)
    },
    ...globals,
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function bindOnPortZero() {
  const listener = createNetServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  return listener
}

async function fixture() {
  const logs = []
  const timers = new Map()
  const effects = { initialize: 0, destroy: 0, validation: 0 }
  let nextTimerId = 1
  const storeManager = {
    getConfig: () => ({
      managementApi: { enableManagementApi: true, managementApiSecret: AUTH },
      enableApiKey: true, apiKeys: [],
    }),
    getSessionConfig: () => ({ sessionTimeout: 30, deleteAfterTimeout: false }),
    cleanExpiredSessions: () => 0,
    addLog: (level, message) => { logs.push({ level, message }) },
  }
  const timerEnv = {
    setInterval: (callback, ms) => {
      const id = nextTimerId++
      timers.set(id, { callback, ms })
      effects.initialize++
      return id
    },
    clearInterval: id => {
      timers.delete(id)
      effects.destroy++
    },
  }
  const sessionManager = product('proxy/sessionManager.ts', {
    '../store/store': { storeManager },
  }, timerEnv).sessionManager
  const proxyStatusManager = new (product('proxy/status.ts', {}).ProxyStatusManager)()
  const localSecurity = product('proxy/localSecurity.ts', {})
  const ProxyServer = product('proxy/server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'local51-synthetic' } },
    '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [], './routes/management': [],
    './sessionManager': { sessionManager },
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './localSecurity': localSecurity,
  }).ProxyServer
  const proxy = new ProxyServer()
  const managementAuthMiddleware = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const managementRouter = product('proxy/routes/management/proxy.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../server': { proxyServer: proxy },
    '../../status': { proxyStatusManager },
    '../../../store/store': { storeManager },
    '../../localSecurity': localSecurity,
  }).default
  const app = new (nodeRequire('koa'))()
  app.use(nodeRequire('koa-bodyparser')())
  app.use(managementRouter.routes())
  app.use(managementRouter.allowedMethods())
  const control = createHttpServer(app.callback())
  control.listen(0, '127.0.0.1')
  await once(control, 'listening')
  const port = control.address().port
  const holders = []
  const request = (path, { authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + AUTH
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'GET', headers,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, json: JSON.parse(raw), raw })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic Koa local51 timeout')))
    req.end()
  })
  const occupy = async () => {
    const held = await bindOnPortZero()
    holders.push(held)
    return held.address().port
  }
  return {
    proxy, logs, timers, effects, status: proxyStatusManager, request, occupy,
    close: async () => {
      if (proxy.server) await proxy.stop()
      sessionManager.destroy()
      for (const held of holders) await new Promise(resolve => held.close(resolve))
      control.closeAllConnections()
      await new Promise(resolve => control.close(resolve))
    },
  }
}

test('actual Koa EADDRINUSE start refusal leaves no session cleanup timers and HTTP status remains stopped', async t => {
  const f = await fixture()
  t.after(f.close)
  const occupied = await f.occupy()
  assert.equal(await f.proxy.start(occupied, '127.0.0.1'), false)
  assert.ok(f.logs.some(log => log.level === 'error' && log.message.includes('in use')))
  const status = await f.request('/v0/management/proxy/status')
  assert.equal(status.status, 200)
  assert.equal(status.json.data.isRunning, false)
  assert.equal(f.timers.size, 0, 'failed bind must release the cleanup interval')
  assert.equal(f.effects.destroy, 1, 'failed bind must destroy exactly its initialized session scheduler')
})

test('two refused real Koa binds never accumulate leaked session timers', async t => {
  const f = await fixture()
  t.after(f.close)
  const occupied = await f.occupy()
  assert.equal(await f.proxy.start(occupied, '127.0.0.1'), false)
  assert.equal(await f.proxy.start(occupied, '127.0.0.1'), false)
  assert.equal(f.effects.initialize, 2)
  assert.equal(f.effects.destroy, 2)
  assert.equal(f.timers.size, 0)
})

test('invalid non-loopback bind is refused before scheduler or socket effects', async t => {
  const f = await fixture()
  t.after(f.close)
  assert.equal(await f.proxy.start(38888, '0.0.0.0'), false)
  assert.equal(f.timers.size, 0)
  assert.equal(f.effects.initialize, 0)
  assert.equal((await f.request('/v0/management/proxy/status')).json.data.isRunning, false)
})

test('actual authorized HTTP proxy status and unauthorized guard do not start a proxy', async t => {
  const f = await fixture()
  t.after(f.close)
  const authorized = await f.request('/v0/management/proxy/status')
  const denied = await f.request('/v0/management/proxy/status', { authorized: false })
  assert.equal(authorized.status, 200)
  assert.equal(authorized.json.data.isRunning, false)
  assert.equal(denied.status, 401)
  assert.equal(f.timers.size, 0)
})

test('successful real Koa bind followed by stop owns only one scheduler and releases it', async t => {
  const f = await fixture()
  t.after(f.close)
  const held = await bindOnPortZero()
  const port = held.address().port
  await new Promise(resolve => held.close(resolve))
  assert.equal(await f.proxy.start(port, '127.0.0.1'), true)
  assert.equal(f.timers.size, 1)
  assert.equal((await f.request('/v0/management/proxy/status')).json.data.isRunning, true)
  assert.equal(await f.proxy.stop(), true)
  assert.equal(f.timers.size, 0)
  assert.equal((await f.request('/v0/management/proxy/status')).json.data.isRunning, false)
})
