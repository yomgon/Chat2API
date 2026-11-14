import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real management auth/route + real ProviderManager over Koa and bodyparser.
// The only deleted records are synthetic in-memory accounts; no actual
// Electron storage, remote service, profile, login or network beyond port0.
const requireNode = createRequire(import.meta.url)
const SECRET = 'SYNTHETIC_LOCAL49_MANAGEMENT_SECRET'
const PRIVATE = 'SYNTHETIC_LOCAL49_SECRET_NEVER_LOG'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
function load(relative, deps) {
  const mod = { exports: {} }
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'), {
      fileName: relative, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      },
    },
  ).outputText
  runInNewContext(js, {
    module: mod, exports: mod.exports, Date, Math, JSON, Error, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (name.startsWith('.')) throw Error('Unexpected product dependency ' + relative + ':' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function fixture({ deleteWriteRefused = false, accountWriteRefused = false, postcommitLogRefused = false,
  createWriteRefused = false, updateWriteRefused = false } = {}) {
  let providers = [
    { id: 'custom-p', name: 'Synthetic Custom', type: 'custom', apiEndpoint: 'https://synthetic.example.com', enabled: true, headers: {} },
    { id: 'builtin-p', name: 'Synthetic Builtin', type: 'builtin', apiEndpoint: 'https://synthetic.example.org', enabled: true, headers: {} },
  ]
  let accounts = [
    { id: 'child-a1', providerId: 'custom-p', credentials: { token: PRIVATE }, status: 'active' },
    { id: 'child-a2', providerId: 'custom-p', credentials: { token: PRIVATE }, status: 'active' },
    { id: 'unrelated', providerId: 'builtin-p', credentials: { token: PRIVATE }, status: 'active' },
  ]
  const effects = { earlyAccountDeletes: 0, providerDeleteAttempts: 0, infoLogs: 0,
    providerCreateAttempts: 0, providerUpdateAttempts: 0 }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true, apiKeys: [],
      managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    }),
    getProviderById: id => clone(providers.find(p => p.id === id)),
    getProviders: () => clone(providers),
    generateId: () => 'new-custom-p',
    getAccountsByProviderId: id => clone(accounts.filter(a => a.providerId === id)),
    addProvider(provider) {
      effects.providerCreateAttempts++
      if (createWriteRefused) throw Error('Synthetic durable provider create refusal')
      providers = [...providers, clone(provider)]
    },
    updateProvider(id, updates) {
      effects.providerUpdateAttempts++
      if (updateWriteRefused) throw Error('Synthetic durable provider update refusal')
      const index = providers.findIndex(p => p.id === id)
      if (index === -1) return null
      providers = providers.map((p, i) => i === index ? { ...p, ...clone(updates) } : p)
      return clone(providers[index])
    },
    deleteAccount(id) {
      effects.earlyAccountDeletes++
      if (accountWriteRefused) throw Error('Synthetic early account write refused')
      const before = accounts.length
      accounts = accounts.filter(a => a.id !== id)
      return before !== accounts.length
    },
    deleteProvider(id) {
      effects.providerDeleteAttempts++
      // This is the real StoreManager cascade contract: deleting a provider
      // also deletes all of its own accounts. A rejected initial provider
      // write must not consume a separate earlier account deletion.
      if (deleteWriteRefused) throw Error('Synthetic provider write refused')
      const prior = providers.length
      providers = providers.filter(p => p.id !== id)
      accounts = accounts.filter(a => a.providerId !== id)
      return prior !== providers.length
    },
    addLog(level) {
      if (level === 'info') {
        effects.infoLogs++
        if (postcommitLogRefused) throw Error('Synthetic postcommit log failure')
      }
    },
  }
  const actualTrust = load('providers/endpointTrust.ts', {})
  const providerManager = load('store/providers.ts', {
    './store': { storeManager },
    './types': { BUILTIN_PROVIDERS: [{ id: 'builtin-p' }] },
    '../providers/endpointTrust': actualTrust,
  }).ProviderManager
  const auth = load('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const routes = load('proxy/routes/management/providers.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/providers': { __esModule: true, default: providerManager },
    '../../../providers/endpointTrust': actualTrust,
  }).default
  const Koa = requireNode('koa')
  const app = new Koa()
  app.use(requireNode('koa-bodyparser')())
  app.use(routes.routes())
  app.use(routes.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const request = (id, authorized = true) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + SECRET
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'DELETE', path: '/v0/management/providers/' + encodeURIComponent(id), headers,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, raw, json: JSON.parse(raw) })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic provider delete HTTP timeout')))
    req.end()
  })
  const crud = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + SECRET
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, raw, json: JSON.parse(raw) })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic provider CRUD HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    request, crud, effects,
    state: () => clone({ providers, accounts }),
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('provider delete storage refusal must not delete any bound accounts or alter provider', async t => {
  const f = await fixture({ deleteWriteRefused: true })
  t.after(f.close)
  const before = f.state()
  const response = await f.request('custom-p')
  assert.equal(response.status, 500)
  assert.equal(response.raw.includes(PRIVATE), false)
  assert.deepEqual(f.state(), before, 'Failed provider deletion cannot orphan encrypted accounts')
  assert.equal(f.effects.providerDeleteAttempts, 1)
  assert.equal(f.effects.earlyAccountDeletes, 0, 'Only StoreManager may perform atomic provider/account cascade')
  assert.equal(f.effects.infoLogs, 0)
})

test('account storage refusal cannot turn a successful provider delete into a partial operation', async t => {
  const f = await fixture({ accountWriteRefused: true })
  t.after(f.close)
  const response = await f.request('custom-p')
  assert.equal(response.status, 200)
  assert.equal(response.json.success, true)
  assert.equal(f.effects.earlyAccountDeletes, 0)
  assert.equal(f.effects.providerDeleteAttempts, 1)
  const state = f.state()
  assert.equal(state.providers.some(p => p.id === 'custom-p'), false)
  assert.equal(state.accounts.some(a => a.providerId === 'custom-p'), false)
  assert.equal(state.accounts.find(a => a.id === 'unrelated')?.providerId, 'builtin-p')
})

test('normal provider cascade is performed once without double-deleting child accounts', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.request('custom-p')
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.data, { id: 'custom-p', deleted: true })
  assert.equal(f.effects.providerDeleteAttempts, 1)
  assert.equal(f.effects.earlyAccountDeletes, 0)
  assert.equal(f.state().providers.length, 1)
  assert.equal(f.state().accounts.length, 1)
  assert.equal(f.effects.infoLogs, 1)
})

test('management auth, built-in restriction and missing identity never invoke storage deletion', async t => {
  const f = await fixture()
  t.after(f.close)
  const before = f.state()
  const unauthorized = await f.request('custom-p', false)
  assert.equal(unauthorized.status, 401)
  const builtin = await f.request('builtin-p')
  assert.notEqual(builtin.status, 200)
  const missing = await f.request('missing-p')
  assert.equal(missing.status, 404)
  assert.equal(f.effects.earlyAccountDeletes, 0)
  assert.equal(f.effects.providerDeleteAttempts, 0)
  assert.deepEqual(f.state(), before)
})

test('provider delete that committed its cascade is HTTP 200 even if optional postcommit log fails', async t => {
  const f = await fixture({ postcommitLogRefused: true })
  t.after(f.close)
  const response = await f.request('custom-p')
  assert.equal(f.effects.providerDeleteAttempts, 1)
  assert.equal(f.state().providers.some(p => p.id === 'custom-p'), false)
  assert.equal(f.state().accounts.some(a => a.providerId === 'custom-p'), false)
  assert.equal(response.status, 200)
  assert.equal(response.json.success, true)
  assert.equal(f.effects.infoLogs, 1)
})

test('provider create must return the immutable new ID after durable create even if diagnostics log fails', async t => {
  const f = await fixture({ postcommitLogRefused: true }); t.after(f.close)
  const response = await f.crud('/v0/management/providers', {
    method: 'POST', body: {
      name: 'Second synthetic custom', authType: 'token',
      apiEndpoint: 'https://second.example.com', headers: {},
    },
  })
  assert.equal(f.state().providers.some(p => p.id === 'new-custom-p'), true)
  assert.equal(f.effects.providerCreateAttempts, 1)
  assert.equal(f.effects.infoLogs, 1)
  assert.equal(response.status, 201)
  assert.equal(response.json.data.id, 'new-custom-p')
})

test('committed provider update and status change return actual values despite failed optional log', async t => {
  const f = await fixture({ postcommitLogRefused: true }); t.after(f.close)
  const update = await f.crud('/v0/management/providers/custom-p', {
    method: 'PUT', body: { name: 'Renamed synthetic provider' },
  })
  assert.equal(f.state().providers.find(p => p.id === 'custom-p')?.name, 'Renamed synthetic provider')
  assert.equal(update.status, 200)
  assert.equal(update.json.data.name, 'Renamed synthetic provider')
  const status = await f.crud('/v0/management/providers/custom-p/status', {
    method: 'PATCH', body: { enabled: false },
  })
  assert.equal(f.state().providers.find(p => p.id === 'custom-p')?.enabled, false)
  assert.equal(status.status, 200)
  assert.equal(status.json.data.enabled, false)
  assert.equal(f.effects.providerUpdateAttempts, 2)
  assert.equal(f.effects.infoLogs, 2)
})

test('provider create/update true durable write refusal remains failure with no mutation or diagnostic success', async t => {
  const f = await fixture({ createWriteRefused: true, updateWriteRefused: true }); t.after(f.close)
  const before = f.state()
  const create = await f.crud('/v0/management/providers', {
    method: 'POST', body: {
      name: 'Blocked synthetic provider', authType: 'token',
      apiEndpoint: 'https://blocked.example.com',
    },
  })
  const update = await f.crud('/v0/management/providers/custom-p', {
    method: 'PUT', body: { name: 'Blocked change' },
  })
  assert.deepEqual([create.status, update.status], [500, 500])
  assert.deepEqual(f.state(), before)
  assert.equal(f.effects.providerCreateAttempts, 1)
  assert.equal(f.effects.providerUpdateAttempts, 1)
  assert.equal(f.effects.infoLogs, 0)
  assert.equal((create.raw + update.raw).includes(PRIVATE), false)
})

function actualStoreManagerHarness({ refuseFinalWrite = false } = {}) {
  const provider = {
    id: 'custom-p', name: 'Synthetic provider', type: 'custom',
    apiEndpoint: 'https://synthetic.example.com', headers: {},
  }
  const unrelated = {
    id: 'builtin-p', name: 'Synthetic preserved provider',
    type: 'builtin', apiEndpoint: 'https://synthetic.example.org', headers: {},
  }
  let durable = {
    providers: [provider, unrelated],
    accounts: [
      { id: 'bound-1', providerId: 'custom-p', credentials: { token: PRIVATE } },
      { id: 'bound-2', providerId: 'custom-p', credentials: { token: PRIVATE } },
      { id: 'unrelated', providerId: 'builtin-p', credentials: { token: PRIVATE } },
    ],
  }
  const effects = { setCalls: 0 }
  const memoryStore = {
    get(key) { return clone(durable[key]) },
    set(key, value) {
      effects.setCalls++
      // A real electron-store object-form set commits multiple keys together
      // in one configuration write. Simulate a failure before that commit.
      if (refuseFinalWrite && (typeof key === 'object' || key === 'accounts')) {
        throw Error('Synthetic atomic persistence refusal')
      }
      if (typeof key === 'object') durable = { ...durable, ...clone(key) }
      else durable = { ...durable, [key]: clone(value) }
    },
  }
  const loaded = load('store/store.ts', {
    electron: { app: {}, safeStorage: {} },
    './types': { BUILTIN_PROVIDERS: [{ id: 'builtin-p' }] },
    '../data/builtin-prompts': {},
    '../requestLogs/manager': {}, '../requestLogs/types': {},
    '../../shared/toolCalling': {}, '../appLogs/manager': {},
    './configSecrets': {},
  })
  const manager = new loaded.StoreManager()
  manager.store = memoryStore
  manager.isInitialized = true
  return { manager, effects, state: () => clone(durable) }
}

test('actual StoreManager deleteProvider fails atomically if its shared providers/accounts write is refused', () => {
  const f = actualStoreManagerHarness({ refuseFinalWrite: true })
  const before = f.state()
  assert.throws(() => f.manager.deleteProvider('custom-p'), /Synthetic atomic persistence refusal/)
  assert.deepEqual(f.state(), before, 'Neither provider nor account may disappear on failed durable write')
  assert.equal(f.effects.setCalls, 1, 'Provider and accounts must be persisted in a single write')
})

test('actual StoreManager successful custom provider cascade is one atomic write with unrelated data intact', () => {
  const f = actualStoreManagerHarness()
  assert.equal(f.manager.deleteProvider('custom-p'), true)
  assert.equal(f.effects.setCalls, 1)
  assert.equal(f.state().providers.length, 1)
  assert.equal(f.state().accounts.length, 1)
  assert.equal(f.state().accounts[0].id, 'unrelated')
  assert.equal(f.manager.deleteProvider('custom-p'), false)
  assert.equal(f.effects.setCalls, 1)
  assert.throws(() => f.manager.deleteProvider('builtin-p'), /Built-in providers cannot be deleted/)
  assert.equal(f.effects.setCalls, 1)
})

function rendererCustomProviderFixture() {
  let providers = [{
    id: 'original-custom', name: 'Original', type: 'custom', authType: 'token',
    apiEndpoint: 'https://custom.example.com', headers: {}, enabled: true,
  }]
  const events = { writes: 0, postcommitLogs: 0 }
  const storeManager = {
    getProviderById: id => clone(providers.find(p => p.id === id)),
    getProviders: () => clone(providers),
    getAccountsByProviderId: () => [],
    generateId: () => 'new-renderer-custom',
    addProvider(provider) { events.writes++; providers = [...providers, clone(provider)] },
    updateProvider(id, updates) {
      events.writes++
      const index = providers.findIndex(p => p.id === id)
      if (index === -1) return null
      providers = providers.map((p, i) => i === index ? { ...p, ...clone(updates) } : p)
      return clone(providers[index])
    },
    addLog() { events.postcommitLogs++; throw Error('Synthetic renderer diagnostics failure') },
  }
  const trust = load('providers/endpointTrust.ts', {})
  const manager = load('providers/custom.ts', {
    '../store/store': { storeManager },
    './builtin': { getBuiltinProvider: () => undefined },
    './endpointTrust': trust,
  }).CustomProviderManager
  return { manager, events, state: () => clone(providers) }
}

test('actual renderer CustomProviderManager.create preserves committed ID when info logger fails', () => {
  const f = rendererCustomProviderFixture()
  const created = f.manager.create({
    name: 'Secondary', authType: 'token',
    apiEndpoint: 'https://secondary.example.com', headers: {},
  })
  assert.equal(f.state().length, 2)
  assert.equal(f.events.writes, 1)
  assert.equal(f.events.postcommitLogs, 1)
  assert.equal(created.id, 'new-renderer-custom')
})

test('actual renderer CustomProviderManager.update returns committed provider after info logger failure', () => {
  const f = rendererCustomProviderFixture()
  const updated = f.manager.update('original-custom', { name: 'Renamed' })
  assert.equal(f.state()[0].name, 'Renamed')
  assert.equal(f.events.writes, 1)
  assert.equal(f.events.postcommitLogs, 1)
  assert.equal(updated.id, 'original-custom')
  assert.equal(updated.name, 'Renamed')
})
