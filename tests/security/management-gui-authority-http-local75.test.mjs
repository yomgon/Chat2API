import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { randomUUID, randomBytes } from 'node:crypto'
import ts from 'typescript'

// Real ProxyServer (host/origin and API key authorization), actual management
// auth/router, ModelMapper/LoadBalancer/models, Electron preload and the exact
// trusted IPC handler bodies, plus real renderer proxyStore.saveAppConfig.
// Closed synthetic durable snapshots, accounts/catalog and Electron bridges;
// one short-lived 127.0.0.1:0 listener, no operating profile or upstream calls.
const nodeRequire = createRequire(import.meta.url)
const ROOT = new URL('../../', import.meta.url)
const MANAGEMENT_SECRET = 'SYNTHETIC_LOCAL75_MANAGEMENT_SECRET'
const OLD_KEY = 'SYNTHETIC_LOCAL75_OLD_PROXY_KEY'
const SECRET_CANARY = 'SYNTHETIC_LOCAL75_INTERNAL_SECRET_MUST_NOT_ESCAPE'
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
const source = relative => readFileSync(new URL(relative, ROOT), 'utf8')
const compile = (code, filename) => ts.transpileModule(code, {
  fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
function product(relative, deps = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(compile(source(relative), relative), {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    TextDecoder, setImmediate, clearImmediate, process: { env: {} },
    crypto: globalThis.crypto,
    console: { log() {}, warn() {}, error() {} },
    ...globals,
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unmapped test dependency: ' + relative + ' => ' + id)
      return nodeRequire(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

// Extract the actual callback from handleTrusted, not a model of what the main
// process should do. The outer trusted-sender guard remains separately covered
// by trusted-ipc-sender tests; this harness invokes it as an authorized owner.
function loadIpcCallback(channelName, globals) {
  const src = source('src/main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', src, ts.ScriptTarget.Latest, true)
  let callback
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'handleTrusted' && node.arguments.length >= 2
      && ts.isPropertyAccessExpression(node.arguments[0])
      && node.arguments[0].expression.getText(tree) === 'IpcChannels'
      && node.arguments[0].name.text === channelName) {
      callback = node.arguments[1].getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!callback) return undefined
  const module = { exports: {} }
  runInNewContext(compile('exports.handler = ' + callback, 'trusted-ipc-handler.ts'), {
    module, exports: module.exports, Error, Date, randomUUID, randomBytes,
    ...globals, console: { log() {}, warn() {}, error() {} },
  }, { filename: 'trusted-ipc-handler.cjs', timeout: 2000 })
  return module.exports.handler
}

async function fixture({ refuseWrites = false } = {}) {
  let config = {
    managementApi: { enableManagementApi: true, managementApiSecret: MANAGEMENT_SECRET },
    enableApiKey: true,
    apiKeys: [{ id: 'key-a', name: 'First', key: OLD_KEY, enabled: true,
      createdAt: 1, usageCount: 0 }],
    proxyPort: 8080, proxyHost: '127.0.0.1', retryCount: 0, requestTimeout: 60000,
    logRetentionDays: 30, loadBalanceStrategy: 'round-robin',
    modelMappings: {},
  }
  const provider = { id: 'deepseek', name: 'DeepSeek Synthetic', type: 'builtin',
    enabled: true, createdAt: 1 }
  const account = { id: 'account-a', providerId: provider.id, status: 'active' }
  const effects = { writes: 0, dispatched: 0 }
  const storeManager = {
    getConfig: () => clone(config),
    updateConfig(patch) {
      effects.writes++
      if (refuseWrites) throw Error(SECRET_CANARY)
      config = { ...config, ...clone(patch) }
      return clone(config)
    },
    getProviders: () => [clone(provider)],
    getAccountsByProviderId: id => id === provider.id ? [clone(account)] : [],
    getEffectiveModels: id => id === provider.id
      ? [{ displayName: 'catalog', actualModelId: 'wire-model' }] : [],
    addLog() {},
  }
  const storeDep = { storeManager }
  const ConfigManager = product('src/main/store/config.ts', {
    './store': storeDep,
    './configSecrets': { redactExportConfigSecrets: x => x },
    './types': { DEFAULT_CONFIG: clone(config) },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).default
  const managementAuthMiddleware = product('src/main/proxy/middleware/managementAuth.ts', {
    '../../store/store': storeDep,
  }).managementAuthMiddleware
  const sharedMgmt = {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
  }
  const keyRouter = product('src/main/proxy/routes/management/apiKeys.ts', {
    ...sharedMgmt, '../../../store/store': storeDep,
  }).default
  const configRouter = product('src/main/proxy/routes/management/config.ts', {
    ...sharedMgmt, '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const mappingRouter = product('src/main/proxy/routes/management/modelMappings.ts', {
    ...sharedMgmt, '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const modelMapper = product('src/main/proxy/modelMapper.ts', {
    '../store/store': storeDep,
  }).modelMapper
  const loadBalancer = product('src/main/proxy/loadbalancer.ts', {
    '../store/store': storeDep, './modelMapper': { modelMapper },
  }).loadBalancer
  const modelRouter = product('src/main/proxy/routes/models.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../store/store': storeDep,
    '../modelMapper': { modelMapper }, '../loadbalancer': { loadBalancer },
  }).default
  const proxyStatusManager = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0,
      failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const proxy = product('src/main/proxy/server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'synthetic-local75' } },
    '@koa/router': nodeRequire('@koa/router'), 'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [modelRouter], './routes/management': [keyRouter, configRouter, mappingRouter],
    '../store/store': storeDep, './status': { proxyStatusManager },
    './localSecurity': product('src/main/proxy/localSecurity.ts'),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const request = (path, { method = 'GET', body, key = MANAGEMENT_SECRET,
    origin } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (key) headers.Authorization = 'Bearer ' + key
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (origin) headers.Origin = origin
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const parts = []
      res.on('data', part => parts.push(part))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3500, () => req.destroy(Error('Synthetic loopback request timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

  const events = new Map()
  const windowBroadcasts = []
  const untrustedWindowBroadcasts = []
  let rejectPostcommitBroadcast = false
  const IpcChannels = product('src/main/ipc/channels.ts').IpcChannels
  const ownerWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => {
      if (rejectPostcommitBroadcast) throw Error(SECRET_CANARY)
      windowBroadcasts.push({ channel, payload })
    } },
  }
  const otherWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) =>
      untrustedWindowBroadcasts.push({ channel, payload }) },
  }
  // A remote OAuth/login window can coexist with the privileged owner.
  // Full AppConfig (including keys/secrets) must never be sent to it.
  const BrowserWindow = { getAllWindows: () => [ownerWindow, otherWindow] }
  const handlers = Object.fromEntries(
    Object.keys(IpcChannels).filter(name => name === 'CONFIG_UPDATE' || name.startsWith('API_KEYS_'))
      .map(name => [IpcChannels[name], loadIpcCallback(name, {
        storeManager, BrowserWindow, IpcChannels, mainWindow: ownerWindow,
      })]).filter(([, callback]) => typeof callback === 'function'),
  )
  let bridge
  product('src/preload/index.ts', {
    electron: {
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          if (!handlers[channel]) throw Error('Unregistered trusted IPC: ' + channel)
          return handlers[channel]({}, ...args)
        },
        on: (channel, callback) => events.set(channel, callback),
        removeListener: (channel, callback) => {
          if (events.get(channel) === callback) events.delete(channel)
        },
        send() {},
      },
      contextBridge: { exposeInMainWorld(name, api) {
        assert.equal(name, 'electronAPI')
        bridge = api
      } },
    },
    '../main/ipc/channels': { IpcChannels },
  })
  assert.ok(bridge)
  const rendererProxyStore = product('src/renderer/src/stores/proxyStore.ts', {
    zustand: nodeRequire('zustand'),
  }, { window: { electronAPI: {
    config: { get: () => Promise.resolve(clone(config)), update: bridge.config.update },
  } } }).useProxyStore
  return {
    request, bridge, events, windowBroadcasts, untrustedWindowBroadcasts, rendererProxyStore,
    failPostcommitBroadcast: () => { rejectPostcommitBroadcast = true },
    state: () => clone(config), effects,
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('management key regeneration survives later unrelated stale Electron GUI proxy settings save', async t => {
  const f = await fixture()
  t.after(f.close)
  await f.rendererProxyStore.getState().fetchAppConfig()
  const regenerated = await f.request('/v0/management/api-keys/key-a/regenerate', {
    method: 'POST', body: {},
  })
  assert.equal(regenerated.status, 200, regenerated.raw)
  const fresh = regenerated.json.data.key
  assert.notEqual(fresh, OLD_KEY)
  assert.equal((await f.request('/v1/models', { key: fresh })).status, 200)
  assert.equal((await f.request('/v1/models', { key: OLD_KEY })).status, 401)

  assert.equal(await f.rendererProxyStore.getState().saveAppConfig({ retryCount: 2 }), true)
  assert.equal(f.state().retryCount, 2)
  assert.equal(f.state().apiKeys[0].key, fresh, 'stale GUI config cannot reenable revoked secret')
  assert.equal((await f.request('/v1/models', { key: OLD_KEY })).status, 401)
  assert.equal((await f.request('/v1/models', { key: fresh })).status, 200)
})

test('management mapping create remains in model list/detail after stale GUI proxy-only save', async t => {
  const f = await fixture()
  t.after(f.close)
  await f.rendererProxyStore.getState().fetchAppConfig()
  const created = await f.request('/v0/management/model-mappings', {
    method: 'POST', body: { requestModel: 'alias-managed',
      actualModel: 'wire-model', preferredProviderId: 'deepseek', preferredAccountId: 'account-a' },
  })
  assert.equal(created.status, 201, created.raw)
  assert.equal((await f.request('/v1/models/alias-managed', { key: OLD_KEY })).status, 200)
  assert.equal(await f.rendererProxyStore.getState().saveAppConfig({ retryCount: 3 }), true)
  assert.equal(f.state().retryCount, 3)
  assert.equal(f.state().modelMappings['alias-managed']?.actualModel, 'wire-model')
  const after = await f.request('/v1/models/alias-managed', { key: OLD_KEY })
  assert.equal(after.status, 200, after.raw)
  assert.equal(after.json.owned_by, 'model-mapping')
})

test('committed GUI config update remains successful if optional legacy window broadcast fails', async t => {
  const f = await fixture()
  t.after(f.close)
  await f.rendererProxyStore.getState().fetchAppConfig()
  f.failPostcommitBroadcast()
  assert.equal(await f.rendererProxyStore.getState().saveAppConfig({ retryCount: 2 }), true)
  assert.equal(f.state().retryCount, 2, 'authoritative durable setting committed')
  assert.equal(f.windowBroadcasts.length, 0)
})

test('trusted config IPC never broadcasts credential-bearing AppConfig to another OAuth window', async t => {
  const f = await fixture()
  t.after(f.close)
  await f.rendererProxyStore.getState().fetchAppConfig()
  assert.equal(await f.rendererProxyStore.getState().saveAppConfig({ retryCount: 4 }), true)
  assert.equal(f.windowBroadcasts.length, 1)
  assert.equal(f.untrustedWindowBroadcasts.length, 0,
    'other windows must not receive private API keys or management secrets')
  assert.equal(f.state().retryCount, 4)
})

test('stale GUI model-mapping draft cannot erase a newly committed management mapping', async t => {
  const f = await fixture()
  t.after(f.close)
  await f.rendererProxyStore.getState().fetchAppConfig()
  const created = await f.request('/v0/management/model-mappings', {
    method: 'POST', body: { requestModel: 'management-authoritative',
      actualModel: 'wire-model', preferredProviderId: 'deepseek',
      preferredAccountId: 'account-a' },
  })
  assert.equal(created.status, 201, created.raw)
  assert.equal((await f.request('/v1/models/management-authoritative', { key: OLD_KEY })).status, 200)
  const saved = await f.rendererProxyStore.getState().saveAppConfig({
    modelMappings: {
      'gui-edit': { requestModel: 'gui-edit', actualModel: 'wire-model',
        preferredProviderId: 'deepseek', preferredAccountId: 'account-a' },
    },
  })
  assert.equal(saved, false, 'outdated bulk draft must report a conflict, not silent success')
  assert.equal(f.state().modelMappings['management-authoritative']?.actualModel, 'wire-model')
  assert.equal(f.state().modelMappings['gui-edit'], undefined)
  assert.equal((await f.request('/v1/models/management-authoritative', { key: OLD_KEY })).status, 200)
})

test('unchanged GUI mapping baseline can commit a targeted user mapping edit', async t => {
  const f = await fixture()
  t.after(f.close)
  await f.rendererProxyStore.getState().fetchAppConfig()
  const saved = await f.rendererProxyStore.getState().saveAppConfig({
    modelMappings: {
      'gui-edit': { requestModel: 'gui-edit', actualModel: 'wire-model',
        preferredProviderId: 'deepseek', preferredAccountId: 'account-a' },
    },
  })
  assert.equal(saved, true)
  assert.equal(f.state().modelMappings['gui-edit']?.actualModel, 'wire-model')
  assert.equal((await f.request('/v1/models/gui-edit', { key: OLD_KEY })).status, 200)
})

test('generic trusted config IPC refuses stale bulk apiKeys write after management deletion', async t => {
  const f = await fixture()
  t.after(f.close)
  const staleKeys = f.state().apiKeys
  assert.equal((await f.request('/v0/management/api-keys/key-a', {
    method: 'DELETE',
  })).status, 200)
  assert.equal((await f.request('/v1/models', { key: OLD_KEY })).status, 503)
  await assert.rejects(f.bridge.config.update({ apiKeys: staleKeys }),
    /API key|dedicated|protected/i)
  assert.equal(f.state().apiKeys.length, 0)
  assert.equal((await f.request('/v1/models', { key: OLD_KEY })).status, 503)
})

test('GUI keyed API key mutations use latest authority instead of replacing entire list', async t => {
  const f = await fixture()
  t.after(f.close)
  assert.equal(typeof f.bridge.apiKeys?.create, 'function')
  assert.equal(typeof f.bridge.apiKeys?.setEnabled, 'function')
  assert.equal(typeof f.bridge.apiKeys?.delete, 'function')
  const created = await f.request('/v0/management/api-keys', {
    method: 'POST', body: { name: 'Managed second' },
  })
  assert.equal(created.status, 201)
  const second = created.json.data
  const result = await f.bridge.apiKeys.setEnabled('key-a', false)
  assert.equal(result.enabled, false)
  assert.equal(f.state().apiKeys.find(k => k.id === second.id)?.key, second.key)
  assert.equal((await f.request('/v1/models', { key: OLD_KEY })).status, 401)
  assert.equal((await f.request('/v1/models', { key: second.key })).status, 200)

  const guiCreated = await f.bridge.apiKeys.create('GUI third')
  assert.ok(guiCreated.key.startsWith('sk-'))
  assert.equal(f.state().apiKeys.find(k => k.id === guiCreated.id)?.key, guiCreated.key)
  assert.equal(await f.bridge.apiKeys.delete('key-a'), true)
  assert.equal(f.state().apiKeys.length, 2)
  assert.equal((await f.request('/v1/models', { key: guiCreated.key })).status, 200)
  assert.equal((await f.request('/v1/models', { key: second.key })).status, 200)
})

test('management mutation authorization, storage refusal and secret masking remain fail closed', async t => {
  const f = await fixture({ refuseWrites: true })
  t.after(f.close)
  const before = f.state()
  const unauthed = await f.request('/v0/management/api-keys', {
    method: 'POST', key: '', body: { name: 'Denied' },
  })
  assert.equal(unauthed.status, 401)
  const refusal = await f.request('/v0/management/api-keys/key-a/regenerate', {
    method: 'POST', body: {},
  })
  assert.equal(refusal.status, 500)
  assert.equal(refusal.raw.includes(SECRET_CANARY), false)
  assert.equal(refusal.raw.includes(MANAGEMENT_SECRET), false)
  assert.equal(refusal.raw.includes(OLD_KEY), false)
  assert.deepEqual(f.state(), before)
})
