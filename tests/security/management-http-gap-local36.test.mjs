import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Supplemental HTTP coverage for the *existing* management API routers.
// Real Koa, @koa/router, bodyParser, ProxyServer and management auth middleware.
// Storage, providers, sessions, proxy transitions and smoke diagnostics are
// sealed in-memory fixtures. No Electron app, profile or provider transport.
const requireNode = createRequire(import.meta.url)
const read = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
function load(relative, dependencies) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(read(relative), {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('.')) throw new Error('Unexpected local import ' + relative + ': ' + name)
      if (!['koa', '@koa/router', 'koa-bodyparser', 'crypto', 'node:crypto', 'http'].includes(name)) {
        throw new Error('Unexpected external import ' + relative + ': ' + name)
      }
      return requireNode(name)
    },
    Buffer, TextDecoder, Date, Math, JSON, Error, console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
  }, { filename: relative, timeout: 2000 })
  return module.exports
}

async function makeFixture() {
  const effects = { providerRemote: 0, providerChecks: 0, proxyStarts: 0,
    proxyStops: 0, modelSync: 0, syntheticWrites: 0, sessionDeletes: 0 }
  const accountSecret = 'SYNTHETIC_CREDENTIAL_NEVER_REAL_LOCAL36'
  const managementSecret = 'SYNTHETIC_MANAGEMENT_SECRET_LOCAL36'
  const provider = { id: 'provider-fixture', name: 'Fixture Provider', type: 'custom',
    authType: 'none', apiEndpoint: 'https://fixture.invalid', enabled: true,
    headers: {}, createdAt: 100, supportedModels: ['fixture-model'] }
  let providers = [provider]
  let accounts = [{ id: 'account-fixture', providerId: provider.id, name: 'Fixture Account',
    credentials: { token: accountSecret }, status: 'active', requestCount: 0 }]
  let sessions = [{ id: 'session-fixture', messages: [{ role: 'user', content: 'synthetic only' }] }]
  let config = {
    enableApiKey: true, apiKeys: [{ id: 'proxy-key', key: 'synthetic-proxy-key', enabled: true,
      usageCount: 0, lastUsedAt: 0 }],
    managementApi: { enableManagementApi: false, managementApiSecret: managementSecret },
    proxyPort: 8080, loadBalanceStrategy: 'round-robin', modelMappings: {},
    toolCallingConfig: { clientAdapterId: 'openai' },
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: patch => { config = { ...config, ...patch }; effects.syntheticWrites++; return config },
    addLog() {},
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0,
      totalLatency: 0, modelUsage: {}, providerUsage: {}, accountUsage: {} }),
    getTodayStatistics: () => ({ date: '2026-11-11', totalRequests: 0, successRequests: 0, failedRequests: 0 }),
    getLogs: () => [],
    getRequestLogs: () => [],
  }
  const proxyStatusManager = {
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0,
      activeConnections: 0, requestsPerMinute: 0 }),
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
    getConfig: () => ({ port: 8080, host: '127.0.0.1' }),
  }
  const ProviderManager = {
    getAll: () => providers,
    getById: id => providers.find(p => p.id === id),
    create: data => {
      const created = { ...data, id: 'created-fixture-provider', enabled: true, createdAt: 101 }
      providers = [...providers, created]; effects.syntheticWrites++; return created
    },
    update: (id, data) => {
      const old = providers.find(p => p.id === id)
      if (!old) return null
      providers = providers.map(p => p.id === id ? { ...p, ...data } : p)
      effects.syntheticWrites++
      return providers.find(p => p.id === id)
    },
    delete: id => {
      const size = providers.length
      providers = providers.filter(p => p.id !== id)
      if (size !== providers.length) effects.syntheticWrites++
      return size !== providers.length
    },
  }
  const AccountManager = {
    getAll: () => accounts,
    getByProviderId: id => accounts.filter(a => a.providerId === id),
    getById: id => accounts.find(a => a.id === id),
    create: data => {
      if (!providers.some(p => p.id === data.providerId)) throw new Error('Provider not found')
      const account = { ...data, id: 'created-fixture-account', status: 'active' }
      accounts = [...accounts, account]; effects.syntheticWrites++; return account
    },
    update: (id, data) => {
      const old = accounts.find(a => a.id === id)
      if (!old) return null
      accounts = accounts.map(a => a.id === id ? { ...a, ...data } : a)
      effects.syntheticWrites++; return accounts.find(a => a.id === id)
    },
    delete: id => {
      const size = accounts.length
      accounts = accounts.filter(a => a.id !== id)
      if (size !== accounts.length) effects.syntheticWrites++
      return size !== accounts.length
    },
    validate: async () => { effects.providerChecks++; throw new Error('Real validation forbidden') },
  }
  AccountManager.updateEditable = AccountManager.update
  const ConfigManager = {
    get: () => config,
    update: patch => { config = { ...config, ...patch }; effects.syntheticWrites++; return config },
    validate: () => ({ valid: true, errors: [] }),
    getModelMappings: () => config.modelMappings,
    getModelMapping: model => config.modelMappings[model],
    setModelMapping: mapping => {
      config = { ...config, modelMappings: { ...config.modelMappings, [mapping.requestModel]: mapping } }
      effects.syntheticWrites++
    },
    removeModelMapping: model => {
      if (!Object.hasOwn(config.modelMappings, model)) return false
      const next = { ...config.modelMappings }
      delete next[model]
      config = { ...config, modelMappings: next }
      effects.syntheticWrites++
      return true
    },
  }
  const sessionManager = {
    getAllActiveSessions: () => sessions,
    getSession: id => sessions.find(s => s.id === id),
    deleteSession: id => {
      const size = sessions.length
      sessions = sessions.filter(s => s.id !== id)
      if (sessions.length !== size) effects.sessionDeletes++
      return sessions.length !== size
    },
    clearAllSessions: () => { effects.sessionDeletes += sessions.length; sessions = [] },
    initialize: () => { throw new Error('Do not auto-start sessions') },
    destroy: () => {},
  }
  const fakeProxyServer = {
    isRunning: () => false,
    start: () => { effects.proxyStarts++; throw new Error('Real proxy start forbidden') },
    stop: () => { effects.proxyStops++; throw new Error('Real proxy stop forbidden') },
    restart: () => { effects.proxyStarts++; throw new Error('Real proxy restart forbidden') },
  }
  const fakeSmoke = {
    buildSmokeFixture: () => ({ messages: [{ role: 'user', content: 'fake' }] }),
    getLatestToolCallingSmokeResult: () => null,
    setLatestToolCallingSmokeResult: result => result,
  }
  const localSecurity = load('localSecurity.ts', {})
  const auth = load('middleware/managementAuth.ts',
    { '../../store/store': { storeManager } }).managementAuthMiddleware
  const routerModule = { '@koa/router': requireNode('@koa/router') }
  const shared = {
    ...routerModule,
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager },
    '../../../store/store': { storeManager },
  }
  class ProviderEndpointTrustError extends Error { constructor(code, message) { super(message); this.code = code } }
  const managementPaths = {
    'config.ts': shared,
    'providers.ts': { ...shared, '../../../store/providers': { __esModule: true, default: ProviderManager },
      '../../../providers/endpointTrust': { ProviderEndpointTrustError } },
    'accounts.ts': { ...shared, '../../../store/accounts': { __esModule: true, default: AccountManager } },
    'apiKeys.ts': shared,
    'modelMappings.ts': shared,
    'sessions.ts': { ...shared, '../../sessionManager': { __esModule: true, default: sessionManager } },
    'statistics.ts': { ...shared, '../../status': { proxyStatusManager } },
    'proxy.ts': { ...shared, '../../server': { proxyServer: fakeProxyServer },
      '../../status': { proxyStatusManager }, '../../localSecurity': localSecurity },
    'toolCalling.ts': { ...shared, '../../toolCalling/diagnostics': fakeSmoke },
  }
  const managementRoutes = Object.entries(managementPaths)
    .map(([file, deps]) => load('routes/management/' + file, deps).default)
  const server = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'fixture' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [], './routes/management': managementRoutes,
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager },
    './localSecurity': localSecurity,
  }).proxyServer
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port

  const request = (path, { method = 'GET', body, auth: authorized = true, host, origin } = {}) => {
    const headers = { Host: host ?? `127.0.0.1:${port}` }
    if (authorized) headers.Authorization = `Bearer ${managementSecret}`
    if (origin) headers.Origin = origin
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, response => {
        const chunks = []
        response.on('data', data => chunks.push(data))
        response.on('error', reject)
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(raw) } catch {}
          resolve({ status: response.statusCode, json, raw })
        })
      })
      req.on('error', reject)
      req.setTimeout(2000, () => req.destroy(new Error('Synthetic localhost HTTP timeout')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const close = async () => {
    listener.closeAllConnections()
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  }
  return { request, close, effects, accountSecret,
    enableManagement: () => { config.managementApi.enableManagementApi = true },
    state: () => ({ providers, accounts, sessions, config }),
  }
}

test('real Koa HTTP: management disabled, missing secret, Host and Origin are rejected for all additional routes', async t => {
  const f = await makeFixture(); t.after(f.close)
  const base = '/v0/management'
  const paths = ['/providers', '/accounts', '/model-mappings', '/sessions', '/proxy/status',
    '/tool-calling/status', '/health', '/logs']
  for (const path of paths) {
    const off = await f.request(base + path)
    assert.equal(off.status, 404, path)
    assert.equal(off.json.error.code, 'management_api_disabled')
  }
  f.enableManagement()
  for (const path of paths) {
    assert.equal((await f.request(base + path, { auth: false })).status, 401, path)
    assert.equal((await f.request(base + path, { host: 'malicious.invalid' })).status, 403, path)
    assert.equal((await f.request(base + path, { origin: 'https://malicious.invalid' })).status, 403, path)
  }
  assert.deepEqual(f.effects, { providerRemote: 0, providerChecks: 0, proxyStarts: 0,
    proxyStops: 0, modelSync: 0, syntheticWrites: 0, sessionDeletes: 0 })
})

test('real Koa HTTP: existing management GETs return synthetic state, mask account secrets, and do not trigger provider checks', async t => {
  const f = await makeFixture(); t.after(f.close); f.enableManagement()
  const base = '/v0/management'
  const reads = [
    ['/providers', data => assert.equal(data[0].id, 'provider-fixture')],
    ['/providers/provider-fixture', data => assert.equal(data.id, 'provider-fixture')],
    ['/accounts', data => assert.equal(data[0].credentials.token, '***')],
    ['/accounts/account-fixture', data => assert.equal(data.credentials.token, '***')],
    ['/providers/provider-fixture/accounts', data => assert.equal(data[0].credentials.token, '***')],
    ['/model-mappings', data => assert.equal(data.length, 0)],
    ['/sessions', data => assert.equal(data[0].id, 'session-fixture')],
    ['/sessions/session-fixture', data => assert.equal(data.id, 'session-fixture')],
    ['/proxy/status', data => assert.equal(data.isRunning, false)],
    ['/tool-calling/status', data => assert.equal(data.latestSmokeResult, null)],
    ['/health', data => assert.equal(data.health.status, 'unhealthy')],
    ['/logs', data => assert.equal(data.logs.length, 0)],
  ]
  for (const [path, check] of reads) {
    const response = await f.request(base + path)
    assert.equal(response.status, 200, path)
    assert.equal(response.json.success, true, path)
    check(response.json.data)
    assert.doesNotMatch(response.raw, /SYNTHETIC_CREDENTIAL_NEVER_REAL_LOCAL36/)
  }
  assert.equal(f.effects.providerChecks, 0)
  assert.equal(f.effects.proxyStarts, 0)
})

test('real Koa HTTP: model mapping CRUD writes only isolated configuration and handles duplicates/unknown targets', async t => {
  const f = await makeFixture(); t.after(f.close); f.enableManagement()
  const base = '/v0/management/model-mappings'
  assert.equal((await f.request(base, { method: 'POST', body: { requestModel: 'mapped', actualModel: 'wire-model' } })).status, 201)
  assert.equal((await f.request(base, { method: 'POST', body: { requestModel: 'mapped', actualModel: 'wire-model' } })).status, 409)
  assert.equal((await f.request(base + '/mapped', { method: 'PUT', body: { actualModel: 'wire-model-v2' } })).json.data.actualModel, 'wire-model-v2')
  assert.equal((await f.request(base)).json.data[0].actualModel, 'wire-model-v2')
  assert.equal((await f.request(base + '/mapped', { method: 'DELETE' })).status, 200)
  assert.equal((await f.request(base + '/missing', { method: 'DELETE' })).status, 404)
  assert.equal(f.effects.providerRemote, 0)
  assert.equal(f.effects.providerChecks, 0)
  assert.equal(f.effects.syntheticWrites, 3)
})

test('real Koa HTTP: account/provider CRUD affects only fixtures and masks credentials', async t => {
  const f = await makeFixture(); t.after(f.close); f.enableManagement()
  const base = '/v0/management'
  assert.equal((await f.request(base + '/providers', { method: 'POST', body: {
    name: 'Created Fixture', authType: 'none', apiEndpoint: 'https://fixture.invalid',
  } })).status, 201)
  assert.equal((await f.request(base + '/providers/missing', { method: 'GET' })).status, 404)
  assert.equal((await f.request(base + '/providers/created-fixture-provider/status',
    { method: 'PATCH', body: { enabled: false } })).json.data.enabled, false)
  assert.equal((await f.request(base + '/accounts', { method: 'POST', body: {
    name: 'Created account', providerId: 'created-fixture-provider',
    credentials: { token: f.accountSecret },
  } })).status, 201)
  const masked = await f.request(base + '/accounts/created-fixture-account')
  assert.equal(masked.json.data.credentials.token, '***')
  assert.equal((await f.request(base + '/accounts/created-fixture-account',
    { method: 'PUT', body: { name: 'Renamed account' } })).json.data.name, 'Renamed account')
  assert.equal((await f.request(base + '/accounts/created-fixture-account', { method: 'DELETE' })).status, 200)
  assert.equal((await f.request(base + '/providers/created-fixture-provider', { method: 'DELETE' })).status, 200)
  assert.equal(f.effects.providerChecks, 0)
  assert.equal(f.effects.providerRemote, 0)
})

test('real Koa HTTP: session deletion requires confirmed fixture scope; proxy control never starts an operational listener', async t => {
  const f = await makeFixture(); t.after(f.close); f.enableManagement()
  const base = '/v0/management'
  assert.equal((await f.request(base + '/sessions', { method: 'DELETE', body: {} })).status, 400)
  assert.equal(f.effects.sessionDeletes, 0)
  assert.equal((await f.request(base + '/sessions/session-fixture', { method: 'DELETE' })).status, 200)
  assert.equal(f.effects.sessionDeletes, 1)
  assert.equal((await f.request(base + '/sessions/missing', { method: 'DELETE' })).status, 404)
  assert.equal((await f.request(base + '/proxy/stop', { method: 'POST', body: {} })).status, 400)
  assert.equal((await f.request(base + '/proxy/restart',
    { method: 'POST', body: { host: '0.0.0.0', port: 8080 } })).status, 400)
  assert.equal(f.effects.proxyStarts, 0)
  assert.equal(f.effects.proxyStops, 0)
})

test('real Koa HTTP RED: non-string model IDs are invalid input, not a persisted model mapping', async t => {
  const f = await makeFixture(); t.after(f.close); f.enableManagement()
  const before = f.effects.syntheticWrites
  for (const body of [
    { requestModel: 7, actualModel: 'fixture-model' },
    { requestModel: 'fixture', actualModel: 42 },
  ]) {
    const response = await f.request('/v0/management/model-mappings', { method: 'POST', body })
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.equal(f.effects.syntheticWrites, before)
  assert.deepEqual(f.state().config.modelMappings, {})
})

test('real Koa HTTP RED: mapping updates refuse malformed model IDs without mutating prior mapping', async t => {
  const f = await makeFixture(); t.after(f.close); f.enableManagement()
  const path = '/v0/management/model-mappings'
  assert.equal((await f.request(path, {
    method: 'POST', body: { requestModel: 'existing-model', actualModel: 'original-wire' },
  })).status, 201)
  const writes = f.effects.syntheticWrites
  const response = await f.request(path + '/existing-model', {
    method: 'PUT', body: { actualModel: 7 },
  })
  assert.equal(response.status, 400)
  assert.equal(f.effects.syntheticWrites, writes)
  assert.equal(f.state().config.modelMappings['existing-model'].actualModel, 'original-wire')
})
