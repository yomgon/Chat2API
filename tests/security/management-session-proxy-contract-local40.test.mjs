import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const read = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
function load(relative, deps) {
  const module = { exports: {} }
  const code = ts.transpileModule(read(relative), {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      return requireNode(name)
    },
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
  }, { filename: relative, timeout: 2000 })
  return module.exports
}

const SECRET = 'SYNTHETIC_MANAGEMENT_LOCAL40'
const INTERNAL = 'SYNTHETIC_INTERNAL_SESSION_SECRET_LOCAL40'
const turn = () => new Promise(resolve => setImmediate(resolve))

async function fixture() {
  let enabled = true
  let sessions = [{
    id: 'session-1', providerId: 'provider-1', accountId: 'account-1', sessionType: 'chat',
    messages: [{ role: 'user', content: 'visible history' }], createdAt: 1, lastActiveAt: 2,
    status: 'active', model: 'fixture-model', metadata: { title: 'Fixture', tokenCount: 3 },
    credentials: { token: INTERNAL }, internalProviderToken: INTERNAL,
  }]
  const effects = { stop: 0, restart: 0, start: 0, deletes: 0, clears: 0, logs: [] }
  const storeManager = {
    getConfig: () => ({ managementApi: { enableManagementApi: enabled, managementApiSecret: SECRET } }),
    addLog: (...args) => effects.logs.push(args),
  }
  const sessionManager = {
    getAllActiveSessions: () => sessions,
    getSession: id => sessions.find(s => s.id === id),
    deleteSession: id => {
      const before = sessions.length
      sessions = sessions.filter(s => s.id !== id)
      if (sessions.length !== before) effects.deletes++
      return sessions.length !== before
    },
    clearAllSessions: () => { effects.clears++; sessions = [] },
  }
  let running = true
  const proxyServer = {
    isRunning: () => running,
    start: async () => { effects.start++; running = true; return true },
    stop: async () => { effects.stop++; running = false; return true },
    restart: async () => { effects.restart++; running = true; return true },
  }
  const status = {
    getRunningStatus: () => ({ isRunning: running, uptime: 10 }),
    getStatistics: () => ({ activeConnections: 0 }), getPort: () => 9876, getHost: () => '127.0.0.1',
  }
  const localSecurity = { isLocalBindHost: host => host === '127.0.0.1' || host === 'localhost' || host === '::1' }
  const auth = load('middleware/managementAuth.ts', { '../../store/store': { storeManager } }).managementAuthMiddleware
  const sessionsRouter = load('routes/management/sessions.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../sessionManager': { __esModule: true, default: sessionManager },
  }).default
  const proxyRouter = load('routes/management/proxy.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../server': { proxyServer }, '../../localSecurity': localSecurity,
    '../../status': { proxyStatusManager: status }, '../../../store/store': { storeManager },
  }).default
  const Koa = requireNode('koa')
  const bodyParser = requireNode('koa-bodyparser')
  const app = new Koa()
  app.use(bodyParser())
  app.use(sessionsRouter.routes()); app.use(sessionsRouter.allowedMethods())
  app.use(proxyRouter.routes()); app.use(proxyRouter.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` }
    if (authorized) headers.Authorization = `Bearer ${SECRET}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c)); res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, raw, json: raw ? JSON.parse(raw) : undefined })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
  const abortRequest = (path, body) => new Promise(resolve => {
    const payload = JSON.stringify(body)
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${SECRET}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } })
    req.on('error', () => resolve())
    req.write(payload)
    req.end()
    req.destroy()
    resolve()
  })
  return { request, abortRequest, effects, setEnabled: v => { enabled = v },
    resetRunning: v => { running = v },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

test('session management never serializes fields outside the public SessionRecord contract', async t => {
  const f = await fixture(); t.after(f.close)
  for (const path of ['/v0/management/sessions', '/v0/management/sessions/session-1']) {
    const response = await f.request(path)
    assert.equal(response.status, 200)
    assert.equal(response.raw.includes(INTERNAL), false)
    const session = Array.isArray(response.json.data) ? response.json.data[0] : response.json.data
    assert.equal(Object.hasOwn(session, 'credentials'), false)
    assert.equal(Object.hasOwn(session, 'internalProviderToken'), false)
    assert.equal(session.messages[0].content, 'visible history')
  }
})

test('disabled or unauthorized management requests cause no session/proxy effects', async t => {
  const f = await fixture(); t.after(f.close)
  f.setEnabled(false)
  assert.equal((await f.request('/v0/management/sessions/session-1', { method: 'DELETE' })).status, 404)
  assert.equal((await f.request('/v0/management/proxy/restart', { method: 'POST', body: {} })).status, 404)
  f.setEnabled(true)
  assert.equal((await f.request('/v0/management/sessions/session-1', { method: 'DELETE', authorized: false })).status, 401)
  assert.deepEqual(f.effects, { stop: 0, restart: 0, start: 0, deletes: 0, clears: 0, logs: [] })
})

test('completed authorized stop schedules exactly one transition after response completion', async t => {
  const f = await fixture(); t.after(f.close)
  f.resetRunning(true)
  const response = await f.request('/v0/management/proxy/stop', { method: 'POST', body: {} })
  assert.equal(response.status, 202)
  await turn()
  assert.equal(f.effects.stop, 1)
  assert.equal(f.effects.restart, 0)
})

test('client-canceled restart response must not execute a restart transition', async t => {
  const f = await fixture(); t.after(f.close)
  await f.abortRequest('/v0/management/proxy/restart', {})
  await turn(); await turn()
  assert.equal(f.effects.restart, 0)
  assert.equal(f.effects.start, 0)
  assert.equal(f.effects.stop, 0)
})
