import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

// Independent true product storage-boundary HTTP regression. Prior key-route
// fixtures stubbed StoreManager/configSecrets, so a real packaged Electron
// local.76 exposed HTTP500 after the key generator was repaired: the management
// API produced sk-mgmt-<32 hex> but real encodeConfigSecrets accepted only
// sk-<48 alphanumeric> as an API key. This runs actual StoreManager,
// encodeConfigSecrets/decodeConfigSecrets, management auth/API-key middleware,
// Koa/bodyparser/real management CRUD with a synthetic OS safeStorage/backend.
// No user profile, filesystem persistence, real provider, or remote request.
const requireNode = createRequire(import.meta.url)
const root = new URL('../../src/main/', import.meta.url)
const source = p => readFileSync(new URL(p, root), 'utf8')
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const MGMT = 'mgmt_11111111-1111-4111-8111-111111111111'
const GUI_KEY = 'sk-' + 'A'.repeat(48)
const PRIVATE = 'SYNTHETIC_LOCAL77_PRIVATE_STORE_FAILURE'
// Product modules (and stored JSON snapshots) must share one JavaScript realm.
// The real configSecrets.copyRecord intentionally rejects foreign-prototype
// objects; an independent VM for each module would be a fixture bug.
const realm = createContext({
  Buffer, Date, Math, Error,
  process: { env: {}, platform: 'win32' },
  console: { log() {}, warn() {}, error() {} },
})
const vmJSON = runInContext('JSON', realm)
const vmClone = value => value === undefined ? undefined : vmJSON.parse(JSON.stringify(value))
function product(relative, deps = {}) {
  const m = { exports: {} }
  const js = ts.transpileModule(source(relative), { fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true },
  }).outputText
  // Invoke each CommonJS module in a separate closure inside the same realm;
  // avoids duplicate top-level const declarations without splitting prototypes.
  const execute = runInContext('(function(module,exports,require){\n' + js + '\n})',
    realm, { filename: relative, timeout: 2000,
      codeGeneration: { strings: false, wasm: false } })
  execute(m, m.exports, id => {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected product import: ' + relative + ':' + id)
      return requireNode(id)
  })
  return m.exports
}

async function fixture({ failWrites = false, failOptionalObservers = false } = {}) {
  const defaultConfig = {
    managementApi: { enableManagementApi: true, managementApiSecret: MGMT },
    enableApiKey: true,
    apiKeys: [{ id: 'gui-key', name: 'GUI', key: GUI_KEY,
      createdAt: 1, enabled: true, usageCount: 3 }],
    modelMappings: {}, logLevel: 'error', logRetentionDays: 7,
    requestLogConfig: { enabled: false }, proxyPort: 8080,
    proxyHost: '127.0.0.1', requestTimeout: 60000, retryCount: 0,
    loadBalanceStrategy: 'round-robin', toolCallingConfig: { advanced: {} },
    sessionConfig: {},
  }
  const durable = { config: clone(defaultConfig), providers: [], accounts: [] }
  const effects = { writes: 0, broadcasts: [], observerCalls: 0, providerCalls: 0 }
  const backing = {
    get(key) { return vmClone(durable[key]) },
    set(key, value) {
      effects.writes++
      if (failWrites) throw Error(PRIVATE)
      if (typeof key === 'object') Object.assign(durable, clone(key))
      else durable[key] = clone(value)
    },
  }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(text) { return Buffer.from('local77_os:' + text, 'utf8') },
    decryptString(data) {
      const text = Buffer.from(data).toString('utf8')
      assert.ok(text.startsWith('local77_os:'))
      return text.slice('local77_os:'.length)
    },
  }
  const types = {
    DEFAULT_CONFIG: vmClone(defaultConfig), BUILTIN_PROVIDERS: [],
    DEFAULT_REQUEST_LOG_CONFIG: { enabled: false },
    DEFAULT_STATISTICS: {}, DEFAULT_USER_MODEL_OVERRIDES: {},
    normalizeModelMappingsWithDefaults: v => clone(v || {}),
    createDefaultModelMappings: () => ({}),
    sanitizeDeepSeekModelOverrides: x => x,
  }
  const configSecrets = product('store/configSecrets.ts')
  const storeManager = new (product('store/store.ts', {
    electron: { app: {}, safeStorage, BrowserWindow: {} },
    './types': types,
    './configSecrets': configSecrets,
    '../data/builtin-prompts': { BUILTIN_PROMPTS: [] },
    '../requestLogs/manager': { RequestLogManager: class {} },
    '../requestLogs/types': { normalizeRequestLogConfig: x => x },
    '../appLogs/manager': { AppLogManager: class {} },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).StoreManager)()
  storeManager.store = backing
  storeManager.isInitialized = true
  storeManager.setMainWindow({
    isDestroyed: () => false,
    webContents: { send(channel, kind) {
      assert.equal(channel, 'store:changed')
      effects.broadcasts.push(kind)
    } },
  })
  if (failOptionalObservers) {
    storeManager.appLogManager = {
      setMaxEntries() { effects.observerCalls++; throw Error(PRIVATE) },
    }
    storeManager.requestLogManager = {
      setConfig() { effects.observerCalls++; throw Error(PRIVATE) },
    }
  }
  const store = { storeManager }
  const managementAuthMiddleware = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': store,
  }).managementAuthMiddleware
  const apiKeys = product('proxy/routes/management/apiKeys.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../../store/store': store,
  }).default
  const modelRouter = product('proxy/routes/models.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../store/store': store,
    '../modelMapper': { modelMapper: { getMatchingMapping: () => undefined } },
    '../loadbalancer': { loadBalancer: { hasSelectableAccount: () => false } },
  }).default
  const proxyStatusManager = {
    getRunningStatus: () => ({ isRunning: true, uptime: 1 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const proxy = product('proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local77-synthetic' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [modelRouter], './routes/management': [apiKeys],
    '../store/store': store, './status': { proxyStatusManager },
    './localSecurity': product('proxy/localSecurity.ts'),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const send = (method, path, { body, bearer = MGMT } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (bearer) headers.Authorization = 'Bearer ' + bearer
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const pieces = []
      res.on('data', part => pieces.push(part))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(pieces).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, json, raw })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Closed Koa request timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    send, storeManager, effects, durable: () => clone(durable),
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('real OS-protected store accepts management-created key and authorized model HTTP immediately', async t => {
  const f = await fixture()
  t.after(f.close)
  const before = f.durable()
  const unauthorized = await f.send('POST', '/v0/management/api-keys', {
    bearer: '', body: { name: 'Denied' },
  })
  assert.equal(unauthorized.status, 401)
  assert.deepEqual(f.durable(), before)
  const created = await f.send('POST', '/v0/management/api-keys', {
    body: { name: 'Managed from HTTP' },
  })
  assert.equal(created.status, 201, created.raw)
  const key = created.json.data.key
  assert.match(key, /^sk-mgmt-[a-f0-9]{32}$/)
  assert.equal(f.storeManager.getConfig().apiKeys.at(-1).key, key)
  const encrypted = f.durable().config.apiKeys.at(-1).key
  assert.match(encrypted, /^safeStorage:v1:/)
  assert.equal(encrypted.includes(key), false)
  const models = await f.send('GET', '/v1/models', { bearer: key })
  assert.equal(models.status, 200, models.raw)
  assert.equal(f.storeManager.getConfig().apiKeys.at(-1).usageCount, 1)
  assert.equal(f.storeManager.getConfig().apiKeys[0].key, GUI_KEY)
  const listed = await f.send('GET', '/v0/management/api-keys')
  assert.equal(listed.status, 200)
  assert.equal(listed.raw.includes(key), false)
})

test('real StoreManager encrypts a generated sk-mgmt key without weakening the protected-key format', async t => {
  const f = await fixture()
  t.after(f.close)
  const before = f.storeManager.getConfig()
  const generated = 'sk-mgmt-' + 'c'.repeat(32)
  const candidate = vmClone({
    id: 'manual-synthetic-management-key', name: 'Only actual management format',
    key: generated, enabled: true, createdAt: 2, usageCount: 0,
  })
  const updated = f.storeManager.updateConfig({ apiKeys: [...before.apiKeys, candidate] })
  assert.equal(updated.apiKeys.at(-1).key, generated)
  assert.equal(f.storeManager.getConfig().apiKeys.at(-1).key, generated)
  assert.match(f.durable().config.apiKeys.at(-1).key, /^safeStorage:v1:/)
  assert.equal(f.durable().config.apiKeys.at(-1).key.includes(generated), false)
})

test('durable management key regeneration rotates original, preserves other GUI key and usage', async t => {
  const f = await fixture()
  t.after(f.close)
  const created = await f.send('POST', '/v0/management/api-keys', { body: { name: 'Rotate' } })
  assert.equal(created.status, 201, created.raw)
  const first = created.json.data.key
  const id = created.json.data.id
  assert.equal((await f.send('GET', '/v1/models', { bearer: first })).status, 200)
  const regenerated = await f.send('POST', '/v0/management/api-keys/' + id + '/regenerate', { body: {} })
  assert.equal(regenerated.status, 200, regenerated.raw)
  const second = regenerated.json.data.key
  assert.notEqual(first, second)
  assert.equal((await f.send('GET', '/v1/models', { bearer: first })).status, 401)
  assert.equal((await f.send('GET', '/v1/models', { bearer: second })).status, 200)
  assert.equal(f.storeManager.getConfig().apiKeys[0].key, GUI_KEY)
  assert.equal(f.storeManager.getConfig().apiKeys[0].usageCount, 3)
  assert.equal(f.storeManager.getConfig().apiKeys.at(-1).key, second)
  assert.equal(f.storeManager.getConfig().apiKeys.at(-1).usageCount, 1)
  assert.equal(f.durable().config.apiKeys.at(-1).key.startsWith('safeStorage:v1:'), true)
})

test('concurrent authenticated management creates do not erase each other or the GUI key', async t => {
  const f = await fixture()
  t.after(f.close)
  const results = await Promise.all([
    f.send('POST', '/v0/management/api-keys', { body: { name: 'A' } }),
    f.send('POST', '/v0/management/api-keys', { body: { name: 'B' } }),
  ])
  assert.deepEqual(results.map(x => x.status), [201, 201])
  const keys = f.storeManager.getConfig().apiKeys
  assert.equal(keys.length, 3)
  assert.equal(keys[0].key, GUI_KEY)
  assert.equal(new Set(keys.map(x => x.id)).size, 3)
  assert.equal(new Set(keys.map(x => x.key)).size, 3)
  assert.equal(f.durable().config.apiKeys.every(x => x.key.startsWith('safeStorage:v1:') || x.key === GUI_KEY), true)
})

test('actual protected config rejects malformed management-style key while keeping encrypted baseline', async t => {
  const f = await fixture()
  t.after(f.close)
  const before = f.durable()
  assert.throws(() => f.storeManager.updateConfig({ apiKeys: [
    { id: 'bad', enabled: true, key: 'sk-mgmt-invalid', usageCount: 0 },
  ] }))
  assert.deepEqual(f.durable(), before)
})

test('failed native durable write and optional logger faults respect required/optional settlement boundary', async t => {
  const failed = await fixture({ failWrites: true })
  t.after(failed.close)
  const before = failed.durable()
  const refused = await failed.send('POST', '/v0/management/api-keys', {
    body: { name: 'Cannot store' },
  })
  assert.equal(refused.status, 500)
  assert.deepEqual(failed.durable(), before)
  assert.equal(refused.raw.includes(PRIVATE), false)
  assert.equal(refused.raw.includes('sk-mgmt-'), false)

  const optional = await fixture({ failOptionalObservers: true })
  t.after(optional.close)
  const committed = await optional.send('POST', '/v0/management/api-keys', {
    body: { name: 'Optional observer fail' },
  })
  assert.equal(committed.status, 201)
  assert.equal(optional.storeManager.getConfig().apiKeys.at(-1).key, committed.json.data.key)
  assert.equal(optional.effects.observerCalls, 2)
  assert.equal(committed.raw.includes(PRIVATE), false)
})
