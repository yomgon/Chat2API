import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real StoreManager writer, real Config/Provider/AccountManager, authenticated
// Koa management routes. The electron-store backing object, safeStorage API,
// main-window webContents and provider/account contents are synthetic in-memory
// objects. Neither real disk/profile nor vendor network is ever accessed.
const nodeRequire = createRequire(import.meta.url)
const ROOT = new URL('../../src/main/', import.meta.url)
const SECRET = 'SYNTHETIC_LOCAL75_STORE_UI_MANAGEMENT_SECRET'
const PRIVATE = 'SYNTHETIC_LOCAL75_ACCOUNT_PRIVATE_CANARY'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const source = path => readFileSync(new URL(path, ROOT), 'utf8')
function product(path, deps) {
  const mod = { exports: {} }
  const js = ts.transpileModule(source(path), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true },
  }).outputText
  runInNewContext(js, {
    module: mod, exports: mod.exports, Buffer, Date, Math, JSON, Error,
    crypto: globalThis.crypto,
    process: { env: {}, platform: 'win32' }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (name.startsWith('.')) throw Error('Unexpected closed dependency: ' + path + ' ' + name)
      return nodeRequire(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function fixture({ failPostcommitObserver = null } = {}) {
  const defaultConfig = {
    managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    enableApiKey: true, apiKeys: [], modelMappings: {},
    proxyPort: 8080, proxyHost: '127.0.0.1',
    logLevel: 'error', requestTimeout: 60000,
    logRetentionDays: 30, retryCount: 0, loadBalanceStrategy: 'round-robin',
    toolCallingConfig: { advanced: {}, mode: 'off' }, sessionConfig: {},
    requestLogConfig: {},
  }
  const durable = { config: clone(defaultConfig), providers: [], accounts: [] }
  let failNextWrite = false
  const backing = {
    get: key => clone(durable[key]),
    set(key, value) {
      if (failNextWrite) {
        failNextWrite = false
        throw Error('SYNTHETIC_LOCAL75_STORAGE_REFUSAL_PRIVATE')
      }
      if (typeof key === 'object') Object.assign(durable, clone(key))
      else durable[key] = clone(value)
    },
  }
  const notifications = []
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send(channel, kind) {
      notifications.push({ channel, kind })
    } },
  }
  const electron = { app: { getVersion: () => 'synthetic-local75' },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from('enc:' + value, 'utf8'),
      decryptString: value => Buffer.from(value).toString('utf8').slice(4),
    },
    BrowserWindow: { getAllWindows: () => [mainWindow] },
  }
  const storeTypes = {
    DEFAULT_CONFIG: clone(defaultConfig), BUILTIN_PROVIDERS: [],
    DEFAULT_REQUEST_LOG_CONFIG: {},
    DEFAULT_STATISTICS: {}, DEFAULT_USER_MODEL_OVERRIDES: {},
    normalizeModelMappingsWithDefaults: x => clone(x || {}),
    normalizeToolCallingConfig: x => x,
    createDefaultModelMappings: () => ({}),
    sanitizeDeepSeekModelOverrides: x => x,
  }
  const storeDeps = {
    electron,
    '../ipc/channels': product('ipc/channels.ts', {}),
    './types': storeTypes,
    '../data/builtin-prompts': { BUILTIN_PROMPTS: [] },
    '../requestLogs/manager': { RequestLogManager: class {} },
    '../requestLogs/types': { normalizeRequestLogConfig: x => x },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
    '../appLogs/manager': { AppLogManager: class {} },
    './configSecrets': {
      encodeConfigSecrets: x => clone(x),
      decodeConfigSecrets: x => clone(x),
      redactExportConfigSecrets: x => clone(x),
    },
  }
  const StoreManager = product('store/store.ts', storeDeps).StoreManager
  const storeManager = new StoreManager()
  storeManager.store = backing
  storeManager.isInitialized = true
  storeManager.setMainWindow(mainWindow)
  if (failPostcommitObserver === 'appLogs') {
    storeManager.appLogManager = {
      setMaxEntries() { throw Error('SYNTHETIC_LOCAL75_POSTCOMMIT_OBSERVER_PRIVATE') },
    }
  }
  if (failPostcommitObserver === 'requestLogs') {
    storeManager.requestLogManager = {
      setConfig() { throw Error('SYNTHETIC_LOCAL75_POSTCOMMIT_OBSERVER_PRIVATE') },
    }
  }
  const ConfigManager = product('store/config.ts', {
    './store': { storeManager }, './configSecrets': storeDeps['./configSecrets'],
    './types': storeTypes, '../../shared/toolCalling': storeDeps['../../shared/toolCalling'],
  }).default
  const ProviderManager = product('store/providers.ts', {
    './store': { storeManager }, './types': storeTypes,
    '../providers/endpointTrust': {
      validateProviderEndpoint: x => x,
      assertProviderEndpointChangeAllowed: (_, x) => x,
      assertProviderIdentityUnchanged() {},
    },
  }).default
  const AccountManager = product('store/accounts.ts', {
    './store': { storeManager }, './types': storeTypes,
    './validator': { validateCredentials: async () => {
      throw Error('Synthetic validation must never issue provider effects')
    } },
    '../providers/endpointTrust': {},
  }).default
  const managementAuthMiddleware = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const shared = {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
  }
  const configRouter = product('proxy/routes/management/config.ts', {
    ...shared, '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const mappingRouter = product('proxy/routes/management/modelMappings.ts', {
    ...shared, '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const apiKeysRouter = product('proxy/routes/management/apiKeys.ts', {
    ...shared, '../../../store/store': { storeManager },
  }).default
  const accountsRouter = product('proxy/routes/management/accounts.ts', {
    ...shared, '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  class ProviderEndpointTrustError extends Error {
    constructor(code, message) { super(message); this.code = code }
  }
  const providersRouter = product('proxy/routes/management/providers.ts', {
    ...shared, '../../../store/providers': { __esModule: true, default: ProviderManager },
    '../../../providers/endpointTrust': { ProviderEndpointTrustError },
  }).default
  const status = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const proxy = product('proxy/server.ts', {
    koa: nodeRequire('koa'), electron, '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [],
    './routes/management': [configRouter, mappingRouter, apiKeysRouter, accountsRouter, providersRouter],
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager },
    './localSecurity': product('proxy/localSecurity.ts', {}),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + SECRET
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const bytes = []
      res.on('data', piece => bytes.push(piece))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(bytes).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Closed HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    request, notifications, state: () => clone(durable),
    refuseOneWrite: () => { failNextWrite = true },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('committed authenticated management key and mapping changes notify GUI without secrets', async t => {
  const f = await fixture()
  t.after(f.close)
  const created = await f.request('/v0/management/api-keys', {
    method: 'POST', body: { name: 'Created by management' },
  })
  assert.equal(created.status, 201, created.raw)
  assert.deepEqual(f.notifications.map(n => n.kind), ['config'])
  const mapping = await f.request('/v0/management/model-mappings', {
    method: 'POST', body: { requestModel: 'local75-managed', actualModel: 'synthetic-wire' },
  })
  assert.equal(mapping.status, 201, mapping.raw)
  assert.deepEqual(f.notifications.map(n => n.kind), ['config', 'config'])
  assert.ok(f.notifications.every(n => n.channel === 'store:changed'))
  assert.equal(JSON.stringify(f.notifications).includes(created.json.data.key), false)
  assert.equal(JSON.stringify(f.notifications).includes(SECRET), false)
  assert.equal(JSON.stringify(f.notifications).includes(PRIVATE), false)
})

test('committed management provider/account create and status mutation notify owner GUI', async t => {
  const f = await fixture()
  t.after(f.close)
  const provider = await f.request('/v0/management/providers/', { method: 'POST',
    body: { name: 'Synthetic custom', authType: 'none', apiEndpoint: 'https://synthetic.invalid' },
  })
  assert.equal(provider.status, 201, provider.raw)
  const id = provider.json.data.id
  const account = await f.request('/v0/management/accounts', { method: 'POST', body: {
    providerId: id, name: 'Synthetic account', credentials: { token: PRIVATE },
  } })
  assert.equal(account.status, 201, account.raw)
  const status = await f.request('/v0/management/providers/' + id + '/status',
    { method: 'PATCH', body: { enabled: false } })
  assert.equal(status.status, 200, status.raw)
  assert.deepEqual(f.notifications.map(n => n.kind), ['providers', 'accounts', 'providers'])
  assert.equal(JSON.stringify(f.notifications).includes(PRIVATE), false)
})

test('failed authenticated durable management update never sends phantom GUI notification', async t => {
  const f = await fixture()
  t.after(f.close)
  const before = f.state()
  f.refuseOneWrite()
  const refusal = await f.request('/v0/management/api-keys', { method: 'POST', body: { name: 'Refused' } })
  assert.equal(refusal.status, 500)
  assert.deepEqual(f.state(), before)
  assert.deepEqual(f.notifications, [])
  assert.equal(refusal.raw.includes('SYNTHETIC_LOCAL75_STORAGE_REFUSAL_PRIVATE'), false)
})

for (const observer of ['appLogs', 'requestLogs']) {
  test('committed management API-key create cannot become a false HTTP500 after ' +
    observer + ' observer failure', async t => {
    const f = await fixture({ failPostcommitObserver: observer })
    t.after(f.close)
    const created = await f.request('/v0/management/api-keys', {
      method: 'POST', body: { name: 'Immutable new credential' },
    })
    assert.equal(f.state().config.apiKeys.length, 1, 'writer committed exactly once')
    assert.equal(f.notifications.length, 1, 'durable change has one GUI invalidation')
    assert.equal(created.status, 201, 'a created key must be disclosed to its authorized caller')
    assert.equal(created.json.success, true)
    assert.equal(created.json.data.key, f.state().config.apiKeys[0].key)
    assert.equal(created.raw.includes('SYNTHETIC_LOCAL75_POSTCOMMIT_OBSERVER_PRIVATE'), false)
  })
}

test('committed model mapping CRUD also remains successful after optional request-log settings observer throws', async t => {
  const f = await fixture({ failPostcommitObserver: 'requestLogs' })
  t.after(f.close)
  const mapped = await f.request('/v0/management/model-mappings', {
    method: 'POST', body: { requestModel: 'observer-alias', actualModel: 'wire-exact' },
  })
  assert.equal(f.state().config.modelMappings['observer-alias']?.actualModel, 'wire-exact')
  assert.equal(f.notifications.length, 1)
  assert.equal(mapped.status, 201)
  assert.equal(mapped.json.success, true)
})
