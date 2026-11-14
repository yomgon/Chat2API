import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

// Independent management->OS-protected StoreManager->ModelMapper/LoadBalancer
// ->OpenAI HTTP (chat/legacy) contract. The only listener is 127.0.0.1:0.
// All provider credentials/upstream are synthetic; there is no provider I/O.
const nodeRequire = createRequire(import.meta.url)
const root = new URL('../../src/main/', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')
const MANAGEMENT = 'mgmt_11111111-1111-4111-8111-111111111111'
const GUI_KEY = 'sk-' + 'G'.repeat(48)
const CREDENTIAL = 'LOCAL78_SYNTHETIC_SECRET_DO_NOT_DISCLOSE'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

async function fixture({ supportedModels = ['wire-synthetic'] } = {}) {
  // A real configSecrets codec rejects foreign-VM object prototypes. Load all
  // production TypeScript modules in one realm and clone durable values there.
  const realm = createContext({
    Buffer, Date, Math, Error, URL, TextDecoder, setImmediate, clearImmediate,
    process: { platform: 'win32', env: {} },
    console: { log() {}, warn() {}, error() {} },
  })
  const vmJSON = runInContext('JSON', realm)
  const vmClone = value => value === undefined ? undefined : vmJSON.parse(JSON.stringify(value))
  function product(path, deps = {}) {
    const module = { exports: {} }
    const code = ts.transpileModule(source(path), {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText
    const execute = runInContext('(function(module,exports,require){\n' + code + '\n})', realm,
      { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
    execute(module, module.exports, id => {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unmapped product dependency: ' + path + ' ' + id)
      return nodeRequire(id)
    })
    return module.exports
  }

  const defaults = {
    managementApi: { enableManagementApi: true, managementApiSecret: MANAGEMENT },
    enableApiKey: true,
    apiKeys: [{ id: 'local78-api-key', name: 'GUI synthetic',
      key: GUI_KEY, enabled: true, usageCount: 0, createdAt: 1 }],
    loadBalanceStrategy: 'round-robin', modelMappings: {},
    proxyPort: 8080, proxyHost: '127.0.0.1', retryCount: 0,
    requestTimeout: 60000, requestLogConfig: { enabled: false },
    logRetentionDays: 7, logLevel: 'error', toolCallingConfig: { advanced: {} },
    sessionConfig: {},
  }
  const durable = { config: clone(defaults), providers: [], accounts: [] }
  const events = { sends: [], success: 0, failures: 0, providerNetwork: 0 }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from('offline-os:' + text, 'utf8'),
    decryptString: data => {
      const dataString = Buffer.from(data).toString('utf8')
      assert.ok(dataString.startsWith('offline-os:'))
      return dataString.slice('offline-os:'.length)
    },
  }
  const types = {
    DEFAULT_CONFIG: vmClone(defaults), BUILTIN_PROVIDERS: [],
    DEFAULT_REQUEST_LOG_CONFIG: { enabled: false },
    DEFAULT_STATISTICS: {}, DEFAULT_USER_MODEL_OVERRIDES: {},
    normalizeModelMappingsWithDefaults: x => vmClone(x || {}),
    createDefaultModelMappings: () => vmClone({}),
    sanitizeDeepSeekModelOverrides: x => x,
  }
  const configSecrets = product('store/configSecrets.ts')
  const storeManager = new (product('store/store.ts', {
    electron: { app: {}, safeStorage, BrowserWindow: {} },
    './types': types, './configSecrets': configSecrets,
    '../data/builtin-prompts': { BUILTIN_PROMPTS: [] },
    '../requestLogs/manager': { RequestLogManager: class {} },
    '../requestLogs/types': { normalizeRequestLogConfig: x => x },
    '../appLogs/manager': { AppLogManager: class {} },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).StoreManager)()
  storeManager.store = {
    get(key) { return vmClone(durable[key]) },
    set(key, value) {
      if (typeof key === 'object') Object.assign(durable, clone(key))
      else durable[key] = clone(value)
    },
  }
  storeManager.isInitialized = true
  storeManager.addLog = () => {}
  storeManager.addRequestLog = () => ({ id: 'offline-log' })
  storeManager.updateRequestLog = () => {}
  storeManager.recordRequestInStats = () => {}
  const store = { storeManager }
  const endpointTrust = product('providers/endpointTrust.ts')
  const providerManager = product('store/providers.ts', {
    './store': store, './types': types,
    '../providers/endpointTrust': endpointTrust,
  }).default
  const accountManager = product('store/accounts.ts', {
    './store': store,
    './validator': { async validateCredentials() {
      return { valid: true, validatedAt: Date.now() }
    } },
  }).default
  const configManager = product('store/config.ts', {
    './store': store, './configSecrets': configSecrets, './types': types,
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).default
  const managementAuthMiddleware = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': store,
  }).managementAuthMiddleware
  const managementDeps = {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
  }
  const providerRoute = product('proxy/routes/management/providers.ts', {
    ...managementDeps,
    '../../../store/providers': { __esModule: true, default: providerManager },
    '../../../providers/endpointTrust': endpointTrust,
  }).default
  const accountRoute = product('proxy/routes/management/accounts.ts', {
    ...managementDeps,
    '../../../store/accounts': { __esModule: true, default: accountManager },
  }).default
  const mappingRoute = product('proxy/routes/management/modelMappings.ts', {
    ...managementDeps,
    '../../../store/config': { __esModule: true, default: configManager },
  }).default
  const modelMapper = product('proxy/modelMapper.ts', { '../store/store': store }).modelMapper
  const loadBalancer = product('proxy/loadbalancer.ts', {
    '../store/store': store, './modelMapper': { modelMapper },
  }).loadBalancer
  const frames = wire => [
    'data: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk',
      model: wire, created: 1, choices: [{ index: 0,
        delta: { role: 'assistant', content: 'Done' }, finish_reason: null }] }) + '\n\n',
    'data: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk',
      model: wire, created: 1, choices: [{ index: 0,
        delta: {}, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const forwarder = {
    async forwardChatCompletion(request, account, provider, wire) {
      events.sends.push({ requested: request.model, wire,
        providerId: provider.id, accountId: account.id,
        stream: request.stream === true })
      if (request.stream) {
        const stream = new PassThrough()
        setImmediate(() => {
          const content = Buffer.from(frames(wire), 'utf8')
          for (let i = 0; i < content.length; i += 5) {
            if (!stream.destroyed) stream.write(content.subarray(i, i + 5))
          }
          if (!stream.destroyed) stream.end()
        })
        return { success: true, status: 200, skipTransform: true, stream }
      }
      return { success: true, status: 200,
        body: { id: 'offline', object: 'chat.completion', created: 1,
          model: wire, choices: [{ index: 0, finish_reason: 'stop',
            message: { role: 'assistant', content: 'Done' } }] } }
    },
  }
  const status = {
    recordRequestStart() {}, recordRequestSuccess() { events.success++ },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: true, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0,
      failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const shared = {
    '@koa/router': nodeRequire('@koa/router'),
    '../../store/store': store, '../modelMapper': { modelMapper },
    '../loadbalancer': { loadBalancer },
    '../forwarder': { requestForwarder: forwarder },
    '../status': { proxyStatusManager: status },
    '../streamTerminalGate': product('proxy/streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('Fake upstream SSE already normalized')
    } } },
  }
  const models = product('proxy/routes/models.ts', shared).default
  const chat = product('proxy/routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': product('proxy/utils/toolFormatConverter.ts'),
  }).default
  const legacy = product('proxy/routes/completions.ts', {
    ...shared,
    '../legacyCompletion': product('proxy/legacyCompletion.ts'),
  }).default
  const proxy = product('proxy/server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'local78-synthetic' } },
    '@koa/router': nodeRequire('@koa/router'), 'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [models, chat, legacy],
    './routes/management': [providerRoute, accountRoute, mappingRoute],
    './status': { proxyStatusManager: status }, '../store/store': store,
    './localSecurity': product('proxy/localSecurity.ts'),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const send = (path, { method = 'GET', body, management = false } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { Host: '127.0.0.1:' + port,
        Authorization: 'Bearer ' + (management ? MANAGEMENT : GUI_KEY) }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
        const parts = []
        res.on('data', piece => parts.push(piece))
        res.on('error', reject)
        res.on('end', () => {
          const raw = Buffer.concat(parts).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, json, raw })
        })
      })
      req.on('error', reject)
      req.setTimeout(4000, () => req.destroy(Error('Closed synthetic HTTP timeout')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const createProviderAccount = async () => {
    const provider = await send('/v0/management/providers/', {
      method: 'POST', management: true,
      body: { name: 'LOCAL78-OFFLINE-PROVIDER', type: 'custom', authType: 'none',
        apiEndpoint: 'https://local78-offline-synthetic.example.org', supportedModels },
    })
    assert.equal(provider.status, 201, provider.raw)
    const providerId = provider.json.data.id
    const account = await send('/v0/management/accounts', {
      method: 'POST', management: true,
      body: { providerId, name: 'LOCAL78-OFFLINE-ACCOUNT',
        credentials: { token: CREDENTIAL } },
    })
    assert.equal(account.status, 201, account.raw)
    assert.equal(account.raw.includes(CREDENTIAL), false)
    assert.equal(durable.accounts.length, 1)
    assert.equal(account.json.data.status, 'inactive')
    const confirmed = await send('/v0/management/accounts/' + account.json.data.id + '/validate', {
      method: 'POST', management: true,
    })
    assert.equal(confirmed.status, 200, confirmed.raw)
    assert.equal(confirmed.json.data.valid, true)
    return { providerId, accountId: account.json.data.id }
  }
  const createMapping = async (alias, actualModel, pin) => {
    const res = await send('/v0/management/model-mappings', {
      method: 'POST', management: true,
      body: { requestModel: alias, actualModel,
        preferredProviderId: pin.providerId, preferredAccountId: pin.accountId },
    })
    assert.equal(res.status, 201, res.raw)
  }
  const post = (path, model, stream = false) => send(path, { method: 'POST',
    body: path.includes('/chat/')
      ? { model, messages: [{ role: 'user', content: 'offline test' }], stream }
      : { model, prompt: 'offline test', stream },
  })
  return { storeManager, events, durable: () => clone(durable),
    send, post, createProviderAccount, createMapping,
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('local78 management mixed-case display target: chat/legacy dispatch and model detail agree', async t => {
  const f = await fixture()
  t.after(f.close)
  const pin = await f.createProviderAccount()
  await f.createMapping('local78-mixed-alias', 'WIRE-SYNTHETIC', pin)
  const chat = await f.post('/v1/chat/completions', 'local78-mixed-alias')
  assert.equal(chat.status, 200, chat.raw)
  const legacy = await f.post('/v1/completions', 'local78-mixed-alias')
  assert.equal(legacy.status, 200, legacy.raw)
  assert.deepEqual(f.events.sends.map(send => send.wire), ['wire-synthetic', 'wire-synthetic'])
  assert.equal(f.events.sends.every(send => send.providerId === pin.providerId &&
    send.accountId === pin.accountId), true, 'strict immutable account selection')
  const list = await f.send('/v1/models')
  assert.equal(list.status, 200, list.raw)
  assert.equal(list.json.data.some(model => model.id === 'local78-mixed-alias'), true,
    'catalog listing must advertise the same dispatchable mapped alias')
  const detail = await f.send('/v1/models/local78-mixed-alias')
  assert.equal(detail.status, 200, detail.raw)
  assert.equal(detail.json.id, 'local78-mixed-alias')
  assert.equal(detail.raw.includes(CREDENTIAL), false)
  assert.equal(f.events.providerNetwork, 0)
})

test('local78 management wildcard catalog target: models/detail parity with actual chat dispatch', async t => {
  const f = await fixture({ supportedModels: ['wire-*'] })
  t.after(f.close)
  const pin = await f.createProviderAccount()
  await f.createMapping('local78-prefix-*', 'wire-actual', pin)
  const chat = await f.post('/v1/chat/completions', 'local78-prefix-demo')
  assert.equal(chat.status, 200, chat.raw)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].wire, 'wire-actual')
  const list = await f.send('/v1/models')
  assert.equal(list.status, 200, list.raw)
  assert.equal(list.json.data.some(model => model.id === 'local78-prefix-*'), true)
  const detail = await f.send('/v1/models/local78-prefix-demo')
  assert.equal(detail.status, 200, detail.raw)
  assert.equal(detail.json.id, 'local78-prefix-demo')
  assert.equal(f.events.providerNetwork, 0)
})

test('local78 exact unmapped wire target remains case-sensitive; disabled strict pin never falls back', async t => {
  const f = await fixture()
  t.after(f.close)
  const pin = await f.createProviderAccount()
  await f.createMapping('local78-protected-alias', 'wire-synthetic', pin)
  assert.equal((await f.send('/v1/models/local78-protected-alias')).status, 200)
  const disabled = await f.send('/v0/management/providers/' + pin.providerId + '/status', {
    method: 'PATCH', management: true, body: { enabled: false },
  })
  assert.equal(disabled.status, 200, disabled.raw)
  assert.equal((await f.send('/v1/models/local78-protected-alias')).status, 404)
  const denied = await f.post('/v1/chat/completions', 'local78-protected-alias')
  assert.equal(denied.status, 503, denied.raw)
  assert.equal(f.events.sends.length, 0)
  assert.equal(f.events.providerNetwork, 0)
})

test('local78 management-mapped chat/legacy SSE requires clean DONE and commits account exactly once', async t => {
  const f = await fixture()
  t.after(f.close)
  const pin = await f.createProviderAccount()
  await f.createMapping('local78-stream-*', 'WIRE-SYNTHETIC', pin)
  for (const path of ['/v1/chat/completions', '/v1/completions']) {
    const detail = await f.send('/v1/models/local78-stream-42')
    assert.equal(detail.status, 200, detail.raw)
    const result = await f.post(path, 'local78-stream-42', true)
    assert.equal(result.status, 200, result.raw)
    assert.equal((result.raw.match(/data: \[DONE\]/g) ?? []).length, 1,
      'one completed terminal frame, never premature or duplicated')
    assert.equal(result.raw.includes(CREDENTIAL), false)
  }
  assert.equal(f.events.sends.length, 2)
  assert.equal(f.events.sends.every(x => x.wire === 'wire-synthetic' &&
    x.providerId === pin.providerId && x.accountId === pin.accountId), true)
  const settled = f.storeManager.getAccountById(pin.accountId)
  assert.equal(settled.requestCount, 2)
  assert.equal(settled.todayUsed, 2)
  assert.equal(f.events.success, 2)
  assert.equal(f.events.failures, 0)
  assert.equal(f.events.providerNetwork, 0)
})

test('local78 management deletion of pinned identity cannot fall back to another live account', async t => {
  const f = await fixture()
  t.after(f.close)
  const pin = await f.createProviderAccount()
  await f.createMapping('local78-delete-pin', 'WIRE-SYNTHETIC', pin)
  const alternative = await f.send('/v0/management/accounts', {
    method: 'POST', management: true,
    body: { providerId: pin.providerId, name: 'LOCAL78-ALTERNATIVE-ACCOUNT',
      credentials: { token: CREDENTIAL } },
  })
  assert.equal(alternative.status, 201, alternative.raw)
  assert.notEqual(alternative.json.data.id, pin.accountId)
  assert.equal((await f.send('/v1/models/local78-delete-pin')).status, 200)
  const before = await f.post('/v1/chat/completions', 'local78-delete-pin')
  assert.equal(before.status, 200, before.raw)
  const deleted = await f.send('/v0/management/accounts/' + pin.accountId, {
    method: 'DELETE', management: true,
  })
  assert.equal(deleted.status, 200, deleted.raw)
  assert.equal(f.storeManager.getAccountById(pin.accountId), undefined)
  const detail = await f.send('/v1/models/local78-delete-pin')
  assert.equal(detail.status, 404, detail.raw)
  const denied = await f.post('/v1/completions', 'local78-delete-pin')
  assert.equal(denied.status, 503, denied.raw)
  assert.equal(f.events.sends.length, 1, 'deleted explicit pin must not route to replacement account')
  assert.equal(f.events.providerNetwork, 0)
})

test('local78 management catalog update immediately changes both model details and dispatch', async t => {
  const f = await fixture()
  t.after(f.close)
  const pin = await f.createProviderAccount()
  await f.createMapping('local78-catalog-live', 'WIRE-SYNTHETIC', pin)
  assert.equal((await f.send('/v1/models/local78-catalog-live')).status, 200)
  const update = async supportedModels => f.send('/v0/management/providers/' + pin.providerId, {
    method: 'PUT', management: true, body: { supportedModels },
  })
  assert.equal((await update(['other-model'])).status, 200)
  assert.equal((await f.send('/v1/models/local78-catalog-live')).status, 404)
  const unavailable = await f.post('/v1/chat/completions', 'local78-catalog-live')
  assert.equal(unavailable.status, 503, unavailable.raw)
  assert.equal(f.events.sends.length, 0)
  assert.equal((await update(['wire-synthetic'])).status, 200)
  assert.equal((await f.send('/v1/models/local78-catalog-live')).status, 200)
  const available = await f.post('/v1/completions', 'local78-catalog-live')
  assert.equal(available.status, 200, available.raw)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].wire, 'wire-synthetic')
  assert.equal(f.events.providerNetwork, 0)
})

test('local82 RED: management provider wildcard display target resolves exact configured wire for chat and legacy', async t => {
  const f = await fixture({ supportedModels: ['Catalog-Display-*'] })
  t.after(f.close)
  const pin = await f.createProviderAccount()
  // Real management HTTP updates the same authoritative provider catalog
  // consumed by getEffectiveModels()/LoadBalancer, not a disconnected fake.
  const updated = await f.send('/v0/management/providers/' + pin.providerId, {
    method: 'PUT', management: true,
    body: { modelMappings: { 'Catalog-Display-*': 'wire-canonical' } },
  })
  assert.equal(updated.status, 200, updated.raw)
  const effective = f.storeManager.getEffectiveModels(pin.providerId)
  assert.equal(effective.length, 1)
  assert.equal(effective[0].displayName, 'Catalog-Display-*')
  assert.equal(effective[0].actualModelId, 'wire-canonical')
  await f.createMapping('local82-variant', 'CATALOG-DISPLAY-Variant', pin)

  const list = await f.send('/v1/models')
  assert.equal(list.status, 200, list.raw)
  assert.equal(list.json.data.some(model => model.id === 'local82-variant'), true)
  const detail = await f.send('/v1/models/local82-variant')
  assert.equal(detail.status, 200, detail.raw)

  for (const url of ['/v1/chat/completions', '/v1/completions']) {
    const response = await f.post(url, 'local82-variant', false)
    assert.equal(response.status, 200, response.raw)
    assert.equal(response.raw.includes(CREDENTIAL), false)
  }
  assert.deepEqual(f.events.sends.map(x => x.wire),
    ['wire-canonical', 'wire-canonical'],
    'The provider wildcard display is a *catalog alias*, never a raw upstream wire model')
  assert.equal(f.events.sends.every(x =>
    x.accountId === pin.accountId && x.providerId === pin.providerId), true)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount, 2)
  assert.equal(f.events.providerNetwork, 0)
})

test('local82 RED: raw wildcard display instance must not bypass configured wire ID on chat and SSE', async t => {
  const f = await fixture({ supportedModels: ['Gen-*'] })
  t.after(f.close)
  const pin = await f.createProviderAccount()
  const update = await f.send('/v0/management/providers/' + pin.providerId, {
    method: 'PUT', management: true,
    body: { modelMappings: { 'Gen-*': 'upstream-gen-fixed' } },
  })
  assert.equal(update.status, 200, update.raw)
  assert.equal((await f.send('/v1/models/gEn-special')).status, 200)

  const chat = await f.post('/v1/chat/completions', 'gEn-special', false)
  assert.equal(chat.status, 200, chat.raw)
  const streamed = await f.post('/v1/chat/completions', 'gEn-special', true)
  assert.equal(streamed.status, 200, streamed.raw)
  assert.equal((streamed.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
  assert.deepEqual(f.events.sends.map(x => x.wire),
    ['upstream-gen-fixed', 'upstream-gen-fixed'])
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount, 2)
  assert.equal(f.events.providerNetwork, 0)
})

test('local82 RED: overlapping catalog wildcard displays choose the most specific wire model', async t => {
  const f = await fixture({ supportedModels: ['Family-*', 'Family-special-*'] })
  t.after(f.close)
  const pin = await f.createProviderAccount()
  const updated = await f.send('/v0/management/providers/' + pin.providerId, {
    method: 'PUT', management: true,
    body: { modelMappings: { 'Family-*': 'wire-broad', 'Family-special-*': 'wire-specific' } },
  })
  assert.equal(updated.status, 200, updated.raw)
  await f.createMapping('local82-special', 'family-SPECIAL-next', pin)
  assert.equal((await f.send('/v1/models/local82-special')).status, 200)
  assert.equal((await f.post('/v1/chat/completions', 'local82-special')).status, 200)
  assert.deepEqual(f.events.sends.map(x => x.wire), ['wire-specific'],
    'The longest matching public display prefix must determine the exact wire ID')
  assert.equal(f.events.sends[0].accountId, pin.accountId)
  assert.equal(f.events.providerNetwork, 0)
})

test('local82 RED: equally specific overlapping wildcard catalog IDs fail closed before a remote effect', async t => {
  const f = await fixture({ supportedModels: ['Conflict-*', 'cOnFlIcT-*'] })
  t.after(f.close)
  const pin = await f.createProviderAccount()
  const updated = await f.send('/v0/management/providers/' + pin.providerId, {
    method: 'PUT', management: true,
    body: { modelMappings: { 'Conflict-*': 'wire-first', 'cOnFlIcT-*': 'wire-other' } },
  })
  assert.equal(updated.status, 200, updated.raw)
  await f.createMapping('local82-conflict', 'conflict-target', pin)
  const detail = await f.send('/v1/models/local82-conflict')
  assert.equal(detail.status, 404, detail.raw)
  const chat = await f.post('/v1/chat/completions', 'local82-conflict')
  assert.equal(chat.status, 503, chat.raw)
  assert.equal(f.events.sends.length, 0, 'Ambiguous wire model cannot be guessed or sent')
  assert.equal(f.events.providerNetwork, 0)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount, 0)
})
