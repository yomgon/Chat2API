import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// The REAL ProxyServer middleware wraps actual authenticated management
// account/session routes and a real AccountManager. Only store state and the
// unavailable optional diagnostics sink are synthetic. All HTTP is loopback
// 127.0.0.1:0; no Electron profile, operating credentials or upstream effects.
const requireNode = createRequire(import.meta.url)
const AUTH = 'SYNTHETIC_LOCAL50_MANAGEMENT_AUTH'
const SECRET = 'SYNTHETIC_LOCAL50_ACCOUNT_CANARY_NEVER_IN_RESPONSE'
const LOG_CANARY = 'SYNTHETIC_LOCAL50_ACCESS_LOG_REFUSED'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function product(relative, deps, { clock = Date } = {}) {
  const mod = { exports: {} }
  const source = readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    fileName: relative,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, Buffer, Date: clock, Math, JSON, Error,
    TextDecoder, process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (name.startsWith('.')) throw Error('Unexpected local product dependency: ' + relative + ':' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function fixture({ refuseAccessLog = false, slow = false, refuseWrite = false } = {}) {
  let accounts = [{
    id: 'original', providerId: 'synthetic-provider', name: 'Original',
    credentials: { token: SECRET }, status: 'active', dailyLimit: 5,
    todayUsed: 0, requestCount: 0, createdAt: 1, updatedAt: 1,
  }]
  const effects = { durableWrites: 0, accessLogAttempts: 0, infoLogs: 0, errorLogs: 0, upstreamCalls: 0 }
  const provider = { id: 'synthetic-provider', name: 'Synthetic', type: 'custom', enabled: true }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true, apiKeys: [],
      managementApi: { enableManagementApi: true, managementApiSecret: AUTH },
    }),
    ensureProviderExists(id) {
      if (id !== provider.id) throw Error('Provider not found')
    },
    getProviderById: id => id === provider.id ? clone(provider) : undefined,
    generateId: () => 'new-synthetic-id',
    getAccounts: () => clone(accounts),
    getAccountById: id => clone(accounts.find(x => x.id === id)),
    getAccountsByProviderId: id => clone(accounts.filter(x => x.providerId === id)),
    addAccount(account) {
      effects.durableWrites++
      if (refuseWrite) throw Error('Synthetic durable account storage refusal')
      accounts = [...accounts, clone(account)]
    },
    addLog(level) {
      if (level === 'info') effects.infoLogs++
      if (level === 'error') effects.errorLogs++
      if (level === 'warn') {
        effects.accessLogAttempts++
        if (refuseAccessLog) throw Error(LOG_CANARY)
      }
    },
  }
  const AccountManager = product('store/accounts.ts', {
    './store': { storeManager },
    './validator': { validateCredentials: async () => {
      effects.upstreamCalls++
      throw Error('Upstream account validation forbidden in local50 fixture')
    } },
  }).AccountManager
  const managementAuthMiddleware = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const sharedRouterDeps = {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
  }
  const accountRouter = product('proxy/routes/management/accounts.ts', {
    ...sharedRouterDeps,
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  const sessions = { getSession: () => undefined, getAllActiveSessions: () => [] }
  const sessionRouter = product('proxy/routes/management/sessions.ts', {
    ...sharedRouterDeps, '../../sessionManager': { __esModule: true, default: sessions },
  }).default
  const proxyStatusManager = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getHost: () => '127.0.0.1', getPort: () => 8080,
  }
  let ticks = 0
  class SlowClock extends Date {
    static now() { return Date.now() + (ticks++ * 1800) }
  }
  const proxy = product('proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local50-fixture' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [], './routes/management': [accountRouter, sessionRouter],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() { throw Error('No proxy startup') }, destroy() {} } },
    './localSecurity': product('proxy/localSecurity.ts', {}),
  }, { clock: slow ? SlowClock : Date }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port

  const request = (url, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + AUTH
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Local50 synthetic HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

  return {
    request, effects, accounts: () => clone(accounts),
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

test('real Koa unauthorized management HTTP 401 is not converted to 500 by failed access logging', async t => {
  const f = await fixture({ refuseAccessLog: true }); t.after(f.close)
  const result = await f.request('/v0/management/accounts', { authorized: false })
  assert.equal(result.status, 401)
  assert.equal(f.effects.accessLogAttempts, 1)
  assert.equal(f.effects.durableWrites, 0)
  assert.equal(result.raw.includes(LOG_CANARY), false)
  assert.equal(result.raw.includes(AUTH), false)
})

test('real Koa missing session HTTP 404 and its error code survive optional access log refusal', async t => {
  const f = await fixture({ refuseAccessLog: true }); t.after(f.close)
  const result = await f.request('/v0/management/sessions/missing')
  assert.equal(result.status, 404)
  assert.equal(result.json.error.code, 'session_not_found')
  assert.equal(f.effects.accessLogAttempts, 1)
  assert.equal(f.effects.durableWrites, 0)
  assert.equal(result.raw.includes(LOG_CANARY), false)
})

test('real Koa slow committed account create stays HTTP 201 after global access-log failure', async t => {
  const f = await fixture({ refuseAccessLog: true, slow: true }); t.after(f.close)
  const result = await f.request('/v0/management/accounts', {
    method: 'POST',
    body: { providerId: 'synthetic-provider', name: 'New', credentials: { token: SECRET } },
  })
  assert.equal(f.accounts().length, 2)
  assert.equal(f.effects.durableWrites, 1)
  assert.equal(f.effects.infoLogs, 1)
  assert.equal(f.effects.accessLogAttempts, 1)
  assert.equal(f.effects.upstreamCalls, 0)
  assert.equal(result.status, 201)
  assert.equal(result.json.success, true)
  assert.equal(result.json.data.id, 'new-synthetic-id')
  assert.equal(result.json.data.credentials.token, '***')
  assert.equal(result.raw.includes(SECRET) || result.raw.includes(LOG_CANARY), false)
})

test('healthy access logger preserves normal slow 201 response and masked credentials', async t => {
  const f = await fixture({ slow: true }); t.after(f.close)
  const result = await f.request('/v0/management/accounts', {
    method: 'POST',
    body: { providerId: 'synthetic-provider', name: 'New', credentials: { token: SECRET } },
  })
  assert.equal(result.status, 201)
  assert.equal(result.json.data.credentials.token, '***')
  assert.equal(f.effects.durableWrites, 1)
  assert.equal(f.effects.accessLogAttempts, 1)
  assert.equal(result.raw.includes(SECRET), false)
})

test('true account storage refusal still fails HTTP without changing preserved accounts', async t => {
  const f = await fixture({ refuseWrite: true, slow: true }); t.after(f.close)
  const before = f.accounts()
  const result = await f.request('/v0/management/accounts', {
    method: 'POST',
    body: { providerId: 'synthetic-provider', name: 'New', credentials: { token: SECRET } },
  })
  assert.equal(result.status, 500)
  assert.equal(f.effects.durableWrites, 1)
  assert.deepEqual(f.accounts(), before)
  assert.equal(f.effects.upstreamCalls, 0)
  assert.equal(result.raw.includes(SECRET), false)
})
