import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual proxy server, authentication, management accounts/config routes and
// Koa HTTP middleware. Entire store and upstream are synthetic; never load
// Electron's operating profile, live credentials or provider network.
const requireNode = createRequire(import.meta.url)
const source = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
function load(path, dependencies) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(source(path), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, Date, JSON, Math, Error,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('.')) throw Error('Unexpected product dependency ' + path + ': ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const CANARY = 'SYNTHETIC_ACCESS_TOKEN_AND_COOKIES_SHOULD_NEVER_LEAK_LOCAL38'
const SECRET = 'SYNTHETIC_MANAGEMENT_SECRET_NOT_OPERATING'

async function fixture() {
  const state = { failAccounts: false, failCreate: false, failConfig: false, validateCalls: 0, getCalls: 0 }
  const config = {
    managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    enableApiKey: true, apiKeys: [],
    modelMappings: {}, loadBalanceStrategy: 'round-robin',
  }
  const storeManager = {
    getConfig: () => config,
    addLog() {},
    getProviders: () => [],
    updateConfig() { throw Error('Unauthorised synthetic mutation') },
  }
  const AccountManager = {
    getAll() {
      state.getCalls++
      if (state.failAccounts) throw Error(CANARY)
      return [{ id: 'synthetic-account', providerId: 'synthetic-provider', name: 'fixture',
        credentials: { token: 'synthetic-credential' }, status: 'active' }]
    },
    getByProviderId: () => [],
    getById: id => id === 'synthetic-account' ? { id, providerId: 'synthetic-provider', name: 'fixture',
      credentials: { token: 'synthetic-credential' } } : null,
    validate: async () => { state.validateCalls++; throw Error(CANARY) },
    create: () => {
      if (state.failCreate) throw Error('Provider not found: ' + CANARY)
      throw Error('No account creation in this fixture')
    },
    update: () => { throw Error('No account update in fixture') },
    delete: () => { throw Error('No account delete in fixture') },
  }
  const ConfigManager = {
    get: () => {
      if (state.failConfig) throw Error(CANARY)
      return config
    },
    validate: () => ({ valid: true, errors: [] }),
    update: () => { throw Error('No operating config mutation') },
  }
  const status = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const auth = load('middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const shared = {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }
  const accounts = load('routes/management/accounts.ts', shared).default
  const managementConfig = load('routes/management/config.ts', shared).default
  const security = load('localSecurity.ts', {})
  const server = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'synthetic' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [], './routes/management': [accounts, managementConfig],
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': security,
  }).proxyServer
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port
  function request(path, { method = 'GET', body, authorized = true } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Host: '127.0.0.1:' + port }
      if (authorized) headers.Authorization = 'Bearer ' + SECRET
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
        const chunks = []
        response.on('data', c => chunks.push(c))
        response.on('error', reject)
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: response.statusCode, json, raw })
        })
      })
      req.on('error', reject)
      req.setTimeout(2000, () => req.destroy(Error('Local test timeout')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const close = async () => {
    listener.closeAllConnections()
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  }
  return { state, request, close }
}

test('real management Koa GET accounts: internal store exception never returns credential canary', async t => {
  const f = await fixture(); t.after(f.close)
  f.state.failAccounts = true
  const response = await f.request('/v0/management/accounts')
  assert.equal(response.status, 500)
  assert.equal(response.json?.error?.code, 'internal_error')
  assert.doesNotMatch(response.raw, /SYNTHETIC_ACCESS_TOKEN_AND_COOKIES/)
  assert.doesNotMatch(response.raw, /SYNTHETIC_MANAGEMENT_SECRET/)
})

test('real management Koa account validation: async provider exception cannot echo protected token', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.request('/v0/management/accounts/synthetic-account/validate', { method: 'POST' })
  assert.equal(response.status, 500)
  assert.equal(response.json?.error?.code, 'internal_error')
  assert.doesNotMatch(response.raw, /SYNTHETIC_ACCESS_TOKEN_AND_COOKIES/)
  assert.equal(f.state.validateCalls, 1, 'No retry or second external effect')
})

test('real management Koa config GET: private persistence failure returns fixed error', async t => {
  const f = await fixture(); t.after(f.close)
  f.state.failConfig = true
  const response = await f.request('/v0/management/config')
  assert.equal(response.status, 500)
  assert.equal(response.json?.error?.code, 'internal_error')
  assert.doesNotMatch(response.raw, /SYNTHETIC_ACCESS_TOKEN_AND_COOKIES/)
})

test('real management Koa account provider-not-found fallback must not disclose original exception', async t => {
  const f = await fixture(); t.after(f.close)
  f.state.failCreate = true
  const response = await f.request('/v0/management/accounts', {
    method: 'POST', body: { providerId: 'nonexisting-provider', name: 'synthetic',
      credentials: { token: 'synthetic-not-real' } },
  })
  assert.equal(response.status, 404)
  assert.equal(response.json?.error?.code, 'provider_not_found')
  assert.doesNotMatch(response.raw, /SYNTHETIC_ACCESS_TOKEN_AND_COOKIES/)
})

test('real management Koa: normal masked read, known 400 and unauthorized 401 retain contracts', async t => {
  const f = await fixture(); t.after(f.close)
  const allowed = await f.request('/v0/management/accounts')
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json?.data?.[0]?.credentials?.token, '***')
  const bad = await f.request('/v0/management/accounts', { method: 'POST', body: {} })
  assert.equal(bad.status, 400)
  assert.equal(bad.json?.error?.code, 'invalid_request')
  const unauthorized = await f.request('/v0/management/accounts', { authorized: false })
  assert.equal(unauthorized.status, 401)
  assert.equal(f.state.validateCalls, 0)
})
