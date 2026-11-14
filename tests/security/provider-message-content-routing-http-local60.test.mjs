import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// local60: Actual StoreManager account methods, ModelMapper, LoadBalancer,
// authenticated Koa/bodyparser and both completion routes on 127.0.0.1:0.
// No operating account or provider network. Deliberately exercise two dedicated
// consumers whose actual prompt converters cannot represent image_url parts.
const requireNode = createRequire(import.meta.url)
const ROOT = new URL('../../src/main/', import.meta.url)
const PROXY_KEY = 'SYNTHETIC_LOCAL53_API_KEY'
const MANAGEMENT_KEY = 'SYNTHETIC_LOCAL53_MANAGEMENT_KEY'
const CREDENTIAL_CANARY = 'SYNTHETIC_LOCAL53_ACCOUNT_SECRET_NO_HTTP'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const beforeMidnight = new Date(2026, 10, 12, 23, 55, 0).getTime()
const afterMidnight = new Date(2026, 10, 13, 0, 5, 0).getTime()
const followingDay = new Date(2026, 10, 14, 0, 5, 0).getTime()

function compile(source, filename) {
  return ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
}

function product(path, dependencies, dateClass) {
  const fileName = path
  const mod = { exports: {} }
  runInNewContext(
    compile(readFileSync(new URL(path, ROOT), 'utf8'), fileName),
    {
      module: mod, exports: mod.exports, Date: dateClass, Buffer, Math, JSON, Error,
      TextDecoder, URL, Map, Set, Object, decodeURIComponent,
      crypto: requireNode('node:crypto').webcrypto,
      console: { log() {}, warn() {}, error() {} }, process: { env: {} },
      require(id) {
        if (Object.hasOwn(dependencies, id)) return dependencies[id]
        if (id.startsWith('.')) throw Error('Unexpected local product dependency ' + path + ': ' + id)
        return requireNode(id)
      },
    }, { filename: fileName, timeout: 2000, codeGeneration: { strings: false, wasm: false } },
  )
  return mod.exports
}

function extractStoreClass() {
  const file = 'store/store.ts'
  const source = readFileSync(new URL(file, ROOT), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = parsed.statements.find(s =>
    ts.isClassDeclaration(s) && s.name?.text === 'StoreManager')
  assert.ok(declaration, 'Actual StoreManager class must exist')
  const names = [
    'ensureInitialized', 'getAccounts', 'getAccountById', 'getAccountsByProviderId',
    'getActiveAccounts', 'recordAccountSuccess', 'getLocalUsageDay',
    'getEffectiveAccountUsage', 'getAccountForCurrentDay',
  ]
  const methods = names.flatMap(name => {
    const found = declaration.members.find(m =>
      ts.isMethodDeclaration(m) && m.name.getText(parsed) === name)
    // New helper methods are optional during the original RED phase.
    if (!found && !['getLocalUsageDay','getEffectiveAccountUsage','getAccountForCurrentDay'].includes(name)) {
      throw Error('Missing required real StoreManager method: ' + name)
    }
    return found ? [found.getText(parsed)] : []
  })
  return compile('export class IsolatedActualStoreManager {\n' +
    methods.join('\n') + '\n}', 'isolated-store-account-methods-local54.ts')
}

async function fixture({
  initialTime = afterMidnight,
  lastUsed = beforeMidnight,
  todayUsed = 2,
  dailyLimit = 2,
  usageDay,
  rejectStorage = false,
  deferred = false,
  providerOutcome = 'success',
  streamPayload = 'complete',
  failingDiagnostics = [],
  rejectMappingStorage = false,
  rejectProviderStorage = false,
} = {}) {
  const clock = { now: initialTime }
  class ClockDate extends Date { static now() { return clock.now } }
  const compiled = extractStoreClass()
  const managerModule = { exports: {} }
  runInNewContext(compiled, {
    module: managerModule, exports: managerModule.exports, Date: ClockDate, Error, Math, JSON,
  }, { filename: 'isolated-actual-store-local54.cjs', timeout: 2000 })
  const manager = new managerModule.exports.IsolatedActualStoreManager()
  const providers = [
    { id: 'qwen', name: 'Pinned Qwen', enabled: true, createdAt: 1000, type: 'builtin' },
    { id: 'glm', name: 'Other GLM', enabled: true, createdAt: 2000, type: 'builtin' },
    { id: 'deepseek', name: 'Pinned DeepSeek', enabled: true, createdAt: 3000, type: 'builtin' },
    { id: 'zai', name: 'Pinned Z.ai', enabled: true, createdAt: 4000, type: 'builtin' },
    { id: 'qwen-ai', name: 'Pinned Qwen International', enabled: true, createdAt: 5000, type: 'builtin' },
    { id: 'kimi', name: 'Pinned Kimi', enabled: true, createdAt: 6000, type: 'builtin' },
  ]
  const effective = {
    qwen: [{ displayName: 'Fixture Visible', actualModelId: 'qwen-wire-exact' }],
    glm: [{ displayName: 'Fixture Visible', actualModelId: 'glm-wire-other' }],
    deepseek: [{ displayName: 'DeepSeek Offline', actualModelId: 'deepseek-wire-exact' }],
    zai: [{ displayName: 'Zai Offline', actualModelId: 'zai-wire-exact' }],
    'qwen-ai': [{ displayName: 'Qwen Intl Offline', actualModelId: 'qwen-ai-wire-exact' }],
    kimi: [{ displayName: 'Kimi Offline', actualModelId: 'kimi-wire-exact' }],
  }
  const config = {
    enableApiKey: true,
    apiKeys: [{ id: 'synthetic-key-id', key: PROXY_KEY,
      enabled: true, usageCount: 0, lastUsedAt: 0 }],
    managementApi: { enableManagementApi: true, managementApiSecret: MANAGEMENT_KEY },
    loadBalanceStrategy: 'round-robin',
    modelMappings: {
      'pinned-alias': {
        requestModel: 'pinned-alias', actualModel: 'qwen-wire-exact',
        preferredProviderId: 'qwen', preferredAccountId: 'qwen-account',
      },
      'glm-file-alias': {
        requestModel: 'glm-file-alias', actualModel: 'glm-wire-other',
        preferredProviderId: 'glm', preferredAccountId: 'glm-account',
      },
      'deepseek-image-alias': {
        requestModel: 'deepseek-image-alias', actualModel: 'deepseek-wire-exact',
        preferredProviderId: 'deepseek', preferredAccountId: 'deepseek-account',
      },
      'zai-image-alias': {
        requestModel: 'zai-image-alias', actualModel: 'zai-wire-exact',
        preferredProviderId: 'zai', preferredAccountId: 'zai-account',
      },
      'qwen-ai-image-alias': {
        requestModel: 'qwen-ai-image-alias', actualModel: 'qwen-ai-wire-exact',
        preferredProviderId: 'qwen-ai', preferredAccountId: 'qwen-ai-account',
      },
      'kimi-image-alias': {
        requestModel: 'kimi-image-alias', actualModel: 'kimi-wire-exact',
        preferredProviderId: 'kimi', preferredAccountId: 'kimi-account',
      },
    },
  }
  const account = {
    id: 'qwen-account', providerId: 'qwen', name: 'Synthetic Qwen',
    credentials: { token: CREDENTIAL_CANARY }, status: 'active',
    todayUsed, dailyLimit, requestCount: 7, lastUsed,
    createdAt: beforeMidnight - 100_000, updatedAt: beforeMidnight,
  }
  if (lastUsed === null) delete account.lastUsed
  if (usageDay !== undefined) account.usageDay = usageDay
  let rows = [account, {
    id: 'glm-account', providerId: 'glm', name: 'Synthetic GLM',
    status: 'active', credentials: { token: CREDENTIAL_CANARY },
    dailyLimit: 0, todayUsed: 0, lastUsed: afterMidnight,
    requestCount: 0, createdAt: beforeMidnight, updatedAt: beforeMidnight,
  }, {
    id: 'deepseek-account', providerId: 'deepseek', name: 'Synthetic DeepSeek',
    status: 'active', credentials: { token: CREDENTIAL_CANARY },
    dailyLimit: 0, todayUsed: 0, lastUsed: afterMidnight,
    requestCount: 0, createdAt: beforeMidnight, updatedAt: beforeMidnight,
  }, ...['zai','qwen-ai','kimi'].map(id => ({
    id: id + '-account', providerId: id, name: 'Synthetic ' + id,
    status: 'active', credentials: { token: CREDENTIAL_CANARY },
    dailyLimit: 0, todayUsed: 0, lastUsed: afterMidnight,
    requestCount: 0, createdAt: beforeMidnight, updatedAt: beforeMidnight,
  }))
  ]
  const events = { accountWrites: 0, sends: [], accountSettleAccepted: 0, stats: [],
    success: 0, failures: 0, apiKeyUpdates: 0, logAttempts: 0,
    requestLogAttempts: 0, updateRequestLogAttempts: 0, statsAttempts: 0,
    providerStreams: [], mappingWriteAttempts: 0, mappingWrites: 0,
    providerWriteAttempts: 0, providerWrites: 0 }
  const diagnosticCanary = 'SYNTHETIC_LOCAL59_OPTIONAL_DIAGNOSTIC_SECRET_DO_NOT_SEND'
  const refuse = kind => {
    if (failingDiagnostics.includes(kind)) throw Error(diagnosticCanary)
  }
  manager.isInitialized = true
  manager.store = {
    get(key) {
      assert.equal(key, 'accounts')
      return clone(rows)
    },
    set(key, next) {
      assert.equal(key, 'accounts')
      events.accountWrites++
      if (rejectStorage) throw Error('SYNTHETIC_LOCAL53_DURABLE_ACCOUNTS_REFUSAL')
      rows = clone(next)
      events.accountSettleAccepted++
    },
  }
  manager.decryptCredentials = value => clone(value)
  manager.getConfig = () => config
  manager.updateConfig = updates => {
    if (Object.prototype.hasOwnProperty.call(updates, 'apiKeys')) events.apiKeyUpdates++
    if (Object.prototype.hasOwnProperty.call(updates, 'modelMappings')) {
      events.mappingWriteAttempts++
      if (rejectMappingStorage) throw Error('SYNTHETIC_PRIVATE_MAPPING_STORAGE_REFUSAL')
      events.mappingWrites++
    }
    Object.assign(config, clone(updates))
    return config
  }
  manager.getProviders = () => providers
  manager.getProviderById = id => providers.find(p => p.id === id)
  manager.getEffectiveModels = id => effective[id] || []
  manager.addLog = () => { events.logAttempts++; refuse('addLog') }
  manager.addRequestLog = () => {
    events.requestLogAttempts++
    refuse('addRequestLog')
    return { id: 'synthetic-request-receipt' }
  }
  manager.updateRequestLog = () => {
    events.updateRequestLogAttempts++
    refuse('updateRequestLog')
    return true
  }
  manager.recordRequestInStats = ok => {
    events.statsAttempts++
    refuse('stats')
    events.stats.push(ok)
  }

  const modelMapper = new (product('proxy/modelMapper.ts', {
    '../store/store': { storeManager: manager },
  }, ClockDate).ModelMapper)()
  const loadBalancer = new (product('proxy/loadbalancer.ts', {
    '../store/store': { storeManager: manager },
    './modelMapper': { modelMapper },
  }, ClockDate).LoadBalancer)()
  // Exercise the actual ProxyStatusManager, not a fake total that could hide
  // double-counted failures from the Electron dashboard / GET /stats consumer.
  const actualStatus = new (product('proxy/status.ts', {}, ClockDate).ProxyStatusManager)()
  const status = {
    recordRequestStart(...args) { actualStatus.recordRequestStart(...args) },
    recordRequestSuccess(latency) {
      events.success++
      actualStatus.recordRequestSuccess(latency)
    },
    recordRequestFailure(latency) {
      events.failures++
      actualStatus.recordRequestFailure(latency)
    },
    getRunningStatus: () => actualStatus.getRunningStatus(),
    getStatistics: () => actualStatus.getStatistics(),
    getPort: () => actualStatus.getPort(),
    getHost: () => actualStatus.getHost(),
  }
  const completion = {
    id: 'synthetic-complete-answer', object: 'chat.completion',
    created: 1, model: 'qwen-wire-exact',
    choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: 'Offline confirmed response' } }],
  }
  const pending = []
  const sendObservers = []
  const notifySend = () => {
    for (const waiter of sendObservers.splice(0)) waiter()
  }
  const forwarder = { async forwardChatCompletion(request, selected, provider, wire) {
    events.sends.push({
      requestModel: request.model, accountId: selected.id,
      providerId: provider.id, wire, messages: clone(request.messages),
    })
    notifySend()
    if (deferred) return await new Promise(resolve => pending.push(resolve))
    if (providerOutcome === 'failure') return {
      success: false, status: 502, failureCode: 'synthetic_upstream_unconfirmed',
      failureStage: 'response-decoding',
      error: 'SYNTHETIC_UNTRUSTED_PROVIDER_ERROR_DO_NOT_RETURN',
    }
    if (request.stream === true) {
      const upstream = new PassThrough()
      events.providerStreams.push(upstream)
      setImmediate(() => upstream.end(streamPayload === 'complete'
        ? completeSse : sseDelta('Synthetic partial content only')))
      return { success: true, status: 200, stream: upstream, skipTransform: true }
    }
    return { success: true, status: 200, body: clone(completion) }
  } }
  const deps = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer },
    '../modelMapper': { modelMapper },
    '../forwarder': { requestForwarder: forwarder },
    '../status': { proxyStatusManager: status },
    '../../store/store': { storeManager: manager },
    '../streamTerminalGate': product('proxy/streamTerminalGate.ts', {}, ClockDate),
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('No stream forwarding in local54 fixture')
    } } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: x => x,
      transformChunkToAnthropic: x => x,
    },
  }
  const models = product('proxy/routes/models.ts', deps, ClockDate).default
  const chat = product('proxy/routes/chat.ts', deps, ClockDate).default
  const legacy = product('proxy/routes/completions.ts', {
    ...deps,
    '../legacyCompletion': product('proxy/legacyCompletion.ts', {}, ClockDate),
  }, ClockDate).default
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager: manager },
  }, ClockDate).managementAuthMiddleware
  const ConfigManager = product('store/config.ts', {
    './store': { storeManager: manager },
    './configSecrets': { redactExportConfigSecrets: value => clone(value) },
    './types': { DEFAULT_CONFIG: {} },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }, ClockDate).default
  const accountsRouter = product('proxy/routes/management/accounts.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: {
      getAll: () => manager.getAccounts(),
      getById: id => manager.getAccountById(id),
    } },
  }, ClockDate).default
  const mappingRouter = product('proxy/routes/management/modelMappings.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager },
  }, ClockDate).default
  const apiKeysRouter = product('proxy/routes/management/apiKeys.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/store': { storeManager: manager },
  }, ClockDate).default
  const ProviderManager = {
    getAll: () => clone(providers),
    getById: id => clone(providers.find(p => p.id === id)),
    update(id, updates) {
      events.providerWriteAttempts++
      if (rejectProviderStorage) throw Error('SYNTHETIC_PRIVATE_PROVIDER_STORAGE_REFUSAL')
      const index = providers.findIndex(p => p.id === id)
      if (index < 0) return undefined
      providers[index] = { ...providers[index], ...clone(updates) }
      events.providerWrites++
      return clone(providers[index])
    },
  }
  const providersRouter = product('proxy/routes/management/providers.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/providers': { __esModule: true, default: ProviderManager },
    '../../../providers/endpointTrust': { ProviderEndpointTrustError: class ProviderEndpointTrustError extends Error {} },
  }, ClockDate).default
  const proxy = product('proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local54-fixture' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models, chat, legacy],
    './routes/management': [accountsRouter, mappingRouter, apiKeysRouter, providersRouter],
    './status': { proxyStatusManager: status }, '../store/store': { storeManager: manager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('proxy/localSecurity.ts', {}, ClockDate),
  }, ClockDate).proxyServer
  const listener = createServer(proxy.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxy.port = port
  const http = (path, { method = 'GET', body, management = false, authorized = true } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { Host: '127.0.0.1:' + port }
      if (authorized) headers.Authorization = 'Bearer ' + (management ? MANAGEMENT_KEY : PROXY_KEY)
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
        const chunks = []
        res.on('data', part => chunks.push(part))
        res.on('error', reject)
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch {}
          resolve({ status: res.statusCode, raw, json })
        })
      })
      req.on('error', reject)
      req.setTimeout(2500, () => req.destroy(Error('Synthetic local54 loopback timeout')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const abortStreamOnFirstData = (path, body) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      Host: '127.0.0.1:' + port,
      Authorization: 'Bearer ' + PROXY_KEY,
      'Content-Type': 'application/json',
    } }, res => {
      let finished = false
      const finish = aborted => {
        if (finished) return
        finished = true
        resolve({ status: res.statusCode, aborted })
      }
      res.once('data', () => { res.destroy(); finish(true) })
      res.once('end', () => finish(false))
      res.once('error', () => finish(true))
      res.once('aborted', () => finish(true))
    })
    req.once('error', reject)
    req.setTimeout(2500, () => req.destroy(Error('Synthetic local54 cancellation timeout')))
    req.end(JSON.stringify(body))
  })
  return {
    events, http, config, clock, state: () => clone(rows),
    mappings: () => clone(config.modelMappings), providers: () => clone(providers),
    diagnosticCanary,
    abortStreamOnFirstData,
    view: () => clone(manager.getAccountById('qwen-account')),
    setTime: t => { clock.now = t },
    setPin: id => { config.modelMappings['pinned-alias'].preferredAccountId = id },
    waitForSends: async count => {
      if (events.sends.length >= count) return
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() =>
          reject(Error('Timed out waiting for synthetic provider dispatch')), 1500)
        const onSend = () => {
          if (events.sends.length < count) { sendObservers.push(onSend); return }
          clearTimeout(timeout)
          resolve()
        }
        sendObservers.push(onSend)
      })
    },
    release: (index, result = { success: true, status: 200, body: clone(completion) }) => {
      assert.ok(pending[index], 'Expected deferred synthetic upstream call')
      pending[index](result)
      pending[index] = null
    },
    releaseAll: () => {
      for (const finish of pending) if (finish) finish({ success: true, status: 200, body: clone(completion) })
      pending.length = 0
    },
    close: async () => {
      listener.closeAllConnections()
      await new Promise((resolve, reject) =>
        listener.close(error => error ? reject(error) : resolve()))
    },
  }
}

const modelDetail = '/v1/models/pinned-alias'
const managementAccount = '/v0/management/accounts/qwen-account'
const sendChat = f => f.http('/v1/chat/completions', {
  method: 'POST', body: {
    model: 'pinned-alias', messages: [{ role: 'user', content: 'Offline synthetic' }],
    stream: false,
  },
})
const sendLegacy = f => f.http('/v1/completions', {
  method: 'POST', body: { model: 'pinned-alias', prompt: 'Offline synthetic', stream: false },
})
const sendChatStream = f => f.http('/v1/chat/completions', {
  method: 'POST', body: { model: 'pinned-alias',
    messages: [{ role: 'user', content: 'Offline synthetic' }], stream: true },
})
const sendLegacyStream = f => f.http('/v1/completions', {
  method: 'POST', body: { model: 'pinned-alias', prompt: 'Offline synthetic', stream: true },
})
const fileParts = [
  { type: 'text', text: 'Process this offline file' },
  { type: 'file', file_url: { url: 'data:text/plain;base64,aGVsbG8=' } },
]
const sendFileChat = (f, model, stream = false, parts = fileParts) =>
  f.http('/v1/chat/completions', {
    method: 'POST', body: { model, messages: [{ role: 'user', content: parts }], stream },
  })
const sseDelta = content => 'data: ' + JSON.stringify({
  object: 'chat.completion.chunk', choices: [
    { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
  ],
}) + '\n\n'
const completeSse = sseDelta('Synthetic finished answer') + 'data: ' + JSON.stringify({
  object: 'chat.completion.chunk', choices: [
    { index: 0, delta: {}, finish_reason: 'stop' },
  ],
}) + '\n\ndata: [DONE]\n\n'

const imageSentinel = 'https://example.invalid/SYNTHETIC_LOCAL60_IMAGE_NOT_TEXT.png'
const mixedImageParts = [
  { type: 'text', text: 'Synthetic text must remain' },
  { type: 'image_url', image_url: { url: imageSentinel } },
]
const imageOnlyParts = [{ type: 'image_url', image_url: { url: imageSentinel } }]
const exactPinnedModels = [
  ['qwen', 'pinned-alias', 'qwen-account', 'qwen-wire-exact'],
  ['deepseek', 'deepseek-image-alias', 'deepseek-account', 'deepseek-wire-exact'],
]
const allUnsupportedImageModels = [
  ...exactPinnedModels,
  ['zai', 'zai-image-alias', 'zai-account', 'zai-wire-exact'],
  ['qwen-ai', 'qwen-ai-image-alias', 'qwen-ai-account', 'qwen-ai-wire-exact'],
  ['kimi', 'kimi-image-alias', 'kimi-account', 'kimi-wire-exact'],
]
const requestImage = (f, model, parts, stream) => f.http('/v1/chat/completions', {
  method: 'POST', body: { model, messages: [{ role: 'user', content: parts }], stream },
})

function runSourceProjection(providerId, parts) {
  const file = providerId === 'qwen' ? 'proxy/adapters/qwen.ts' : 'proxy/adapters/deepseek.ts'
  const source = readFileSync(new URL(file, ROOT), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const method = providerId === 'qwen'
    ? parsed.statements.find(node => ts.isFunctionDeclaration(node) &&
      node.name?.text === 'extractTextContent')
    : parsed.statements.find(node => ts.isClassDeclaration(node) &&
      node.name?.text === 'DeepSeekAdapter')?.members.find(node =>
      ts.isMethodDeclaration(node) && node.name.getText(parsed) === 'messagesToPrompt')
  assert.ok(method, 'Must execute real dedicated consumer text projector: ' + providerId)
  const js = providerId === 'qwen'
    ? compile(method.getText(parsed) + '\nexports.project = extractTextContent;', file)
    : compile('class SyntheticAdapter {' + method.getText(parsed) +
      '}\nexports.project = value => new SyntheticAdapter().messagesToPrompt(value, false);', file)
  const module = { exports: {} }
  runInNewContext(js, {
    module, exports: module.exports,
    getProviderToolProfile: () => ({ }),
    String, Object, Array, JSON, Error, Math,
  }, { timeout: 2000 })
  const projected = providerId === 'qwen'
    ? module.exports.project(parts)
    : module.exports.project([{ role: 'user', content: parts }])
  return projected
}

for (const [providerId] of exactPinnedModels) {
  test('local60 closed adapter enforces ' + providerId + ' text-only image boundary', () => {
    if (providerId === 'deepseek') {
      // This direct projector now fails closed on image content rather than
      // silently shortening the prompt. Public Koa also rejects it before
      // selecting/sending a DeepSeek operation below.
      assert.throws(() => runSourceProjection(providerId, mixedImageParts),
        /DeepSeek message content is not supported/)
      assert.throws(() => runSourceProjection(providerId, imageOnlyParts),
        /DeepSeek message content is not supported/)
      return
    }
    const textOnly = runSourceProjection(providerId, mixedImageParts)
    assert.equal(typeof textOnly, 'string')
    assert.match(textOnly, /Synthetic text must remain/)
    assert.equal(textOnly.includes(imageSentinel), false)
    const imageOnly = runSourceProjection(providerId, imageOnlyParts)
    assert.equal(imageOnly.includes(imageSentinel), false)
  })
}

for (const [providerId, model, accountId, wire] of allUnsupportedImageModels) {
  for (const [contentType, parts] of [
    ['mixed', mixedImageParts], ['image-only', imageOnlyParts],
  ]) for (const stream of [false, true]) {
    test('local60 auth Koa rejects ' + providerId + ' unsupported ' +
      contentType + ' image before provider effect: stream=' + stream, async () => {
      const f = await fixture()
      try {
        const models = await f.http('/v1/models')
        assert.equal(models.status, 200)
        assert.ok(models.json.data.some(item => item.id === model))
        const detail = await f.http('/v1/models/' + model)
        assert.equal(detail.status, 200)
        const response = await requestImage(f, model, parts, stream)
        assert.equal(response.status, 400, response.raw)
        assert.equal(response.json?.error?.type, 'invalid_request_error')
        assert.equal(response.json?.error?.param, 'messages')
        assert.equal(response.raw.includes(imageSentinel), false)
        assert.equal(response.raw.includes(CREDENTIAL_CANARY), false)
        assert.deepEqual(f.events.sends, [], 'No provider effect or implicit fallback allowed')
        assert.equal(f.events.accountWrites, 0)
        assert.equal(f.events.accountSettleAccepted, 0)
        assert.deepEqual(f.events.stats, [])
        assert.equal(f.events.apiKeyUpdates, 3,
          'Actual loopback API key auth for list, detail and rejected request')
        assert.ok(accountId && wire)
      } finally { await f.close() }
    })
  }
}

for (const stream of [false, true]) {
  test('local60 GLM supported image part remains deliverable by its pinned route: stream=' + stream, async () => {
    const f = await fixture()
    try {
      const response = await requestImage(f, 'glm-file-alias', mixedImageParts, stream)
      assert.equal(response.status, 200, response.raw)
      if (stream) assert.match(response.raw, /\[DONE\]/)
      assert.deepEqual(f.events.sends.map(({ messages: _messages, ...wire }) => wire), [{
        requestModel: 'glm-file-alias', accountId: 'glm-account',
        providerId: 'glm', wire: 'glm-wire-other',
      }])
      assert.deepEqual(f.events.sends[0].messages[0].content, mixedImageParts)
      assert.equal(f.events.accountSettleAccepted, 1)
      assert.deepEqual(f.events.stats, [true])
    } finally { await f.close() }
  })
}

const management = (f, path, method, body, authorized = true) =>
  f.http(path, { method, body, management: true, authorized })

for (const [label, method, path, body] of [
  ['missing API-key create body', 'POST', '/v0/management/api-keys', undefined],
  ['null API-key create body', 'POST', '/v0/management/api-keys', null],
  ['missing provider status body', 'PATCH', '/v0/management/providers/qwen/status', undefined],
  ['null provider status body', 'PATCH', '/v0/management/providers/qwen/status', null],
  ['empty mapping update', 'PUT', '/v0/management/model-mappings/pinned-alias', {}],
  ['mapping update with only unknown metadata', 'PUT',
    '/v0/management/model-mappings/pinned-alias', { unknown: 'stale-inert-body' }],
]) {
  test('local60 management invalid ' + label + ' must be 400 and make zero persisted mutations', async () => {
    const f = await fixture()
    try {
      const beforeMappings = f.mappings()
      const beforeProviders = f.providers()
      const response = await management(f, path, method, body)
      assert.equal(response.status, 400, response.raw)
      if (body === null) {
        // koa-bodyparser's strict JSON grammar rejects the primitive before
        // the route runs. This is already a real HTTP 400, not a route 500.
        // Its native Koa error response does not promise a management envelope.
        assert.match(response.raw, /Bad Request/)
      } else {
        assert.equal(response.json?.success, false)
        assert.equal(response.json?.error?.code, 'invalid_request')
      }
      assert.equal(response.raw.includes(CREDENTIAL_CANARY), false)
      assert.equal(response.raw.includes('SYNTHETIC_PRIVATE'), false)
      assert.deepEqual(f.mappings(), beforeMappings)
      assert.deepEqual(f.providers(), beforeProviders)
      assert.equal(f.events.mappingWriteAttempts, 0)
      assert.equal(f.events.providerWriteAttempts, 0)
      assert.equal(f.events.apiKeyUpdates, 0)
      assert.deepEqual(f.events.sends, [])
    } finally { await f.close() }
  })
}

test('local60 authenticated model mapping PUT changes both chat and legacy wire/pin and catalog', async () => {
  const f = await fixture()
  try {
    const update = await management(f, '/v0/management/model-mappings/pinned-alias', 'PUT', {
      actualModel: 'glm-wire-other', preferredProviderId: 'glm',
      preferredAccountId: 'glm-account',
    })
    assert.equal(update.status, 200, update.raw)
    assert.equal(update.json?.data?.preferredAccountId, 'glm-account')
    assert.equal(f.events.mappingWriteAttempts, 1)
    assert.equal(f.events.mappingWrites, 1)
    const list = await f.http('/v1/models')
    const detail = await f.http('/v1/models/pinned-alias')
    assert.ok(list.json?.data?.some(row => row.id === 'pinned-alias'))
    assert.equal(detail.status, 200)
    for (const [path, body] of [
      ['/v1/chat/completions', { model: 'pinned-alias',
        messages: [{ role: 'user', content: 'offline' }], stream: false }],
      ['/v1/completions', { model: 'pinned-alias', prompt: 'offline', stream: false }],
    ]) {
      const result = await f.http(path, { method: 'POST', body })
      assert.equal(result.status, 200, result.raw)
    }
    assert.deepEqual(f.events.sends.map(x => ({
      providerId: x.providerId, accountId: x.accountId, wire: x.wire,
    })), Array.from({ length: 2 }, () => ({
      providerId: 'glm', accountId: 'glm-account', wire: 'glm-wire-other',
    })))
    assert.equal(f.events.accountSettleAccepted, 2)
    assert.deepEqual(f.events.stats, [true, true])
  } finally { await f.close() }
})

test('local60 committed mapping mutation survives optional log fault but durable refusal is fail-closed', async () => {
  const f = await fixture({ failingDiagnostics: ['addLog'] })
  try {
    const response = await management(f, '/v0/management/model-mappings/pinned-alias', 'PUT', {
      actualModel: 'glm-wire-other', preferredProviderId: 'glm',
      preferredAccountId: 'glm-account',
    })
    assert.equal(response.status, 200, response.raw)
    assert.equal(f.events.mappingWrites, 1)
    assert.ok(f.events.logAttempts >= 1)
    assert.equal(f.mappings()['pinned-alias'].preferredAccountId, 'glm-account')
  } finally { await f.close() }
  const g = await fixture({ rejectMappingStorage: true })
  try {
    const before = g.mappings()
    const response = await management(g, '/v0/management/model-mappings/pinned-alias', 'PUT', {
      actualModel: 'glm-wire-other', preferredProviderId: 'glm',
      preferredAccountId: 'glm-account',
    })
    assert.equal(response.status, 500, response.raw)
    assert.equal(response.json?.success, false)
    assert.equal(response.raw.includes('SYNTHETIC_PRIVATE'), false)
    assert.deepEqual(g.mappings(), before)
    assert.equal(g.events.mappingWriteAttempts, 1)
    assert.equal(g.events.mappingWrites, 0)
    assert.deepEqual(g.events.sends, [])
  } finally { await g.close() }
})

test('local60 management provider disabled status immediately updates catalog and blocks pinned chat/legacy', async () => {
  const f = await fixture()
  try {
    const disabled = await management(f, '/v0/management/providers/qwen/status', 'PATCH', {
      enabled: false,
    })
    assert.equal(disabled.status, 200, disabled.raw)
    assert.equal(f.events.providerWrites, 1)
    const list = await f.http('/v1/models')
    assert.equal(list.json?.data?.some(item => item.id === 'pinned-alias'), false)
    const detail = await f.http('/v1/models/pinned-alias')
    assert.equal(detail.status, 404)
    const chat = await f.http('/v1/chat/completions', {
      method: 'POST', body: { model: 'pinned-alias',
        messages: [{ role: 'user', content: 'offline' }], stream: false },
    })
    const legacy = await f.http('/v1/completions', {
      method: 'POST', body: { model: 'pinned-alias', prompt: 'offline', stream: false },
    })
    assert.equal(chat.status, 503)
    assert.equal(legacy.status, 503)
    assert.equal(chat.json.error.code, 'no_available_account')
    assert.equal(legacy.json.error.code, 'no_available_account')
    assert.deepEqual(f.events.sends, [])
    assert.equal(f.events.accountSettleAccepted, 0)
  } finally { await f.close() }
})

test('local60 unauthorized management mutation remains 401, no provider/model write', async () => {
  const f = await fixture()
  try {
    const result = await management(f, '/v0/management/model-mappings/pinned-alias',
      'PUT', { actualModel: 'glm-wire-other' }, false)
    assert.equal(result.status, 401, result.raw)
    assert.equal(f.events.mappingWriteAttempts, 0)
    assert.equal(f.events.providerWrites, 0)
  } finally { await f.close() }
})

test('local60 management must not report successful creation of unpersistable __proto__ model alias', async () => {
  const f = await fixture()
  try {
    const beforeMappings = f.mappings()
    const response = await management(f, '/v0/management/model-mappings', 'POST', {
      requestModel: '__proto__', actualModel: 'glm-wire-other',
      preferredProviderId: 'glm', preferredAccountId: 'glm-account',
    })
    assert.equal(response.status, 400, response.raw)
    assert.equal(response.json?.success, false)
    assert.equal(response.json?.error?.code, 'invalid_request')
    assert.deepEqual(f.mappings(), beforeMappings)
    assert.equal(f.events.mappingWriteAttempts, 0)
    assert.equal(f.events.mappingWrites, 0)
    const list = await f.http('/v1/models')
    assert.equal(list.json.data.some(item => item.id === '__proto__'), false)
    const detail = await f.http('/v1/models/__proto__')
    assert.equal(detail.status, 404)
    assert.deepEqual(f.events.sends, [])
  } finally { await f.close() }
})

test('local60 management permits ordinary own constructor alias while retaining exact model pin', async () => {
  const f = await fixture()
  try {
    const created = await management(f, '/v0/management/model-mappings', 'POST', {
      requestModel: 'constructor', actualModel: 'glm-wire-other',
      preferredProviderId: 'glm', preferredAccountId: 'glm-account',
    })
    assert.equal(created.status, 201, created.raw)
    assert.equal(Object.hasOwn(f.mappings(), 'constructor'), true)
    const detail = await f.http('/v1/models/constructor')
    assert.equal(detail.status, 200)
    assert.equal(f.events.mappingWrites, 1)
  } finally { await f.close() }
})

for (const [providerId, model, accountId, wire] of allUnsupportedImageModels) {
  for (const stream of [false, true]) {
    test('local60 ordinary text still completes on exact ' + providerId +
      ' account with no fallback after image preflight; stream=' + stream, async () => {
      const f = await fixture()
      try {
        const response = await f.http('/v1/chat/completions', {
          method: 'POST', body: {
            model, stream, messages: [{ role: 'user', content: 'ordinary local text' }],
          },
        })
        assert.equal(response.status, 200, response.raw)
        if (stream) assert.match(response.raw, /\[DONE\]/)
        assert.deepEqual(f.events.sends.map(({ messages: _messages, ...x }) => x), [{
          requestModel: model, providerId, accountId, wire,
        }])
        assert.equal(f.events.accountSettleAccepted, 1)
        assert.equal(f.events.success, 1)
        assert.equal(f.events.failures, 0)
        assert.deepEqual(f.events.stats, [true])
        assert.equal(response.raw.includes(CREDENTIAL_CANARY), false)
      } finally { await f.close() }
    })
  }
}

test('local60 in-flight old pinned request settles its original identity despite concurrent management remap', async () => {
  const f = await fixture({ deferred: true })
  try {
    const first = f.http('/v1/chat/completions', {
      method: 'POST', body: {
        model: 'pinned-alias', stream: false,
        messages: [{ role: 'user', content: 'one original Qwen request' }],
      },
    })
    await f.waitForSends(1)
    assert.equal(f.events.sends[0].accountId, 'qwen-account')
    const updated = await management(f, '/v0/management/model-mappings/pinned-alias',
      'PUT', { actualModel: 'glm-wire-other', preferredProviderId: 'glm',
        preferredAccountId: 'glm-account' })
    assert.equal(updated.status, 200, updated.raw)
    const catalog = await f.http('/v1/models/pinned-alias')
    assert.equal(catalog.status, 200)
    const completion = model => ({
      id: 'synthetic-inflight-' + model, object: 'chat.completion',
      model, created: 1, choices: [{
        index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'offline confirmed' },
      }],
    })
    f.release(0, { success: true, status: 200, body: completion('qwen-wire-exact') })
    const firstReply = await first
    assert.equal(firstReply.status, 200, firstReply.raw)
    const second = f.http('/v1/completions', {
      method: 'POST', body: {
        model: 'pinned-alias', prompt: 'one new GLM request', stream: false,
      },
    })
    await f.waitForSends(2)
    f.release(1, { success: true, status: 200, body: completion('glm-wire-other') })
    const secondReply = await second
    assert.equal(secondReply.status, 200, secondReply.raw)
    assert.deepEqual(f.events.sends.map(x => ({
      providerId: x.providerId, accountId: x.accountId, wire: x.wire,
    })), [
      { providerId: 'qwen', accountId: 'qwen-account', wire: 'qwen-wire-exact' },
      { providerId: 'glm', accountId: 'glm-account', wire: 'glm-wire-other' },
    ])
    assert.equal(f.events.accountWrites, 2)
    assert.equal(f.events.accountSettleAccepted, 2)
    assert.deepEqual(f.events.stats, [true, true])
    assert.equal(f.events.success, 2)
    assert.equal(f.events.failures, 0)
  } finally { f.releaseAll(); await f.close() }
})
