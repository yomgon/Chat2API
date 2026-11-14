import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real StoreManager account methods (extracted without initializing Electron
// storage) + real ModelMapper, LoadBalancer, GET /v1/models, both completion
// routes and management auth, running actual Koa+bodyparser over 127.0.0.1:0.
// No actual account, operating profile, credentials or upstream requests.
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
      TextDecoder, URL, Map, Set, Object,
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
  ]
  const effective = {
    qwen: [{ displayName: 'Fixture Visible', actualModelId: 'qwen-wire-exact' }],
    glm: [{ displayName: 'Fixture Visible', actualModelId: 'glm-wire-other' }],
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
  }]
  const events = { accountWrites: 0, sends: [], accountSettleAccepted: 0, stats: [],
    success: 0, failures: 0, apiKeyUpdates: 0, logAttempts: 0,
    requestLogAttempts: 0, updateRequestLogAttempts: 0, statsAttempts: 0,
    providerStreams: [] }
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
  manager.updateConfig = () => { events.apiKeyUpdates++ }
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
      providerId: provider.id, wire,
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
  const accountsRouter = product('proxy/routes/management/accounts.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: {
      getAll: () => manager.getAccounts(),
      getById: id => manager.getAccountById(id),
    } },
  }, ClockDate).default
  const proxy = product('proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local54-fixture' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models, chat, legacy], './routes/management': [accountsRouter],
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

function assertNeverLeaked(response, canary) {
  assert.equal(response.raw.includes(CREDENTIAL_CANARY), false)
  assert.equal(response.raw.includes('SYNTHETIC_UNTRUSTED_PROVIDER_ERROR_DO_NOT_RETURN'), false)
  assert.equal(response.raw.includes(canary), false)
}

function assertSinglePinnedFailure(f, { statsAvailable = true, legacy = false } = {}) {
  assert.deepEqual(f.events.sends, [{
    requestModel: legacy ? 'qwen-wire-exact' : 'pinned-alias', accountId: 'qwen-account',
    providerId: 'qwen', wire: 'qwen-wire-exact',
  }])
  assert.equal(f.events.success, 0, 'failed upstream must never become success')
  assert.equal(f.events.failures, 1, 'exactly one failure status event')
  assert.equal(f.events.accountWrites, 0, 'no durable success after upstream failure')
  assert.equal(f.events.accountSettleAccepted, 0)
  assert.equal(f.events.statsAttempts, 1, 'exactly one failure stats attempt')
  assert.deepEqual(f.events.stats, statsAvailable ? [false] : [])
  assert.equal(f.events.apiKeyUpdates, 1, 'the real authentication middleware records one API-key use')
}

for (const [label, send, failureCode] of [
  ['chat', sendChat, 'synthetic_upstream_unconfirmed'],
  ['legacy', sendLegacy, null],
  ['chat stream handshake', sendChatStream, 'synthetic_upstream_unconfirmed'],
  ['legacy stream handshake', sendLegacyStream, null],
]) {
  test('local59: provider failure keeps HTTP502, pin and failure accounting: ' + label, async () => {
    const f = await fixture({ providerOutcome: 'failure' })
    try {
      const response = await send(f)
      assert.equal(response.status, 502, response.raw)
      assert.equal(response.json?.error?.type, 'api_error')
      if (failureCode) assert.equal(response.json?.error?.code, failureCode)
      assertSinglePinnedFailure(f, { legacy: send === sendLegacy || send === sendLegacyStream })
      const proxyStats = await f.http('/stats')
      assert.equal(proxyStats.status, 200)
      assert.equal(proxyStats.json.totalRequests, 1)
      assert.equal(proxyStats.json.failedRequests, 1)
      assert.equal(proxyStats.json.successRequests, 0)
      assert.equal(proxyStats.json.activeConnections, 0)
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}

for (const failedSink of ['addLog', 'addRequestLog', 'stats']) {
  test('local59: upstream HTTP502 survives optional ' + failedSink + ' refusal: chat', async () => {
    const f = await fixture({ providerOutcome: 'failure', failingDiagnostics: [failedSink] })
    try {
      const response = await sendChat(f)
      assert.equal(response.status, 502, response.raw)
      assert.equal(response.json?.error?.code, 'synthetic_upstream_unconfirmed')
      assertSinglePinnedFailure(f, { statsAvailable: failedSink !== 'stats' })
      const proxyStats = await f.http('/stats')
      assert.deepEqual({
        total: proxyStats.json.totalRequests, success: proxyStats.json.successRequests,
        failed: proxyStats.json.failedRequests, active: proxyStats.json.activeConnections,
      }, { total: 1, success: 0, failed: 1, active: 0 })
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
  test('local59: upstream HTTP502 survives optional ' + failedSink + ' refusal: legacy', async () => {
    const f = await fixture({ providerOutcome: 'failure', failingDiagnostics: [failedSink] })
    try {
      const response = await sendLegacy(f)
      assert.equal(response.status, 502, response.raw)
      assertSinglePinnedFailure(f, { statsAvailable: failedSink !== 'stats', legacy: true })
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}

for (const send of [sendChatStream, sendLegacyStream]) {
  test('local59: incomplete SSE never emits DONE or charges account: ' +
    (send === sendChatStream ? 'chat' : 'legacy'), async () => {
    const f = await fixture({ streamPayload: 'partial' })
    try {
      const response = await send(f)
      assert.equal(response.raw.includes('[DONE]'), false, response.raw)
      assert.match(response.raw, /error/i)
      assertSinglePinnedFailure(f, { legacy: send === sendLegacyStream })
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}

for (const send of [sendChatStream, sendLegacyStream]) {
  for (const failedSink of send === sendChatStream
    ? ['addLog', 'updateRequestLog', 'stats']
    : ['addLog', 'stats']) {
    test('local59: incomplete SSE preserves fixed error and independent diagnostics after ' +
      failedSink + ' refusal: ' + (send === sendChatStream ? 'chat' : 'legacy'), async () => {
      const f = await fixture({ streamPayload: 'partial', failingDiagnostics: [failedSink] })
      try {
        const response = await send(f)
        assert.match(response.raw, /provider_stream_incomplete/, response.raw)
        assert.equal(response.raw.includes('[DONE]'), false)
        assertSinglePinnedFailure(f, {
          statsAvailable: failedSink !== 'stats', legacy: send === sendLegacyStream,
        })
        assert.ok(f.events.logAttempts >= 1, 'independent failure log must still be attempted')
        if (send === sendChatStream) {
          assert.equal(f.events.updateRequestLogAttempts, 1,
            'provisional receipt update must not depend on a working stats sink')
        }
        assertNeverLeaked(response, f.diagnosticCanary)
      } finally {
        await f.close()
      }
    })
  }
}

for (const send of [sendChat, sendLegacy]) {
  for (const failedSink of ['addLog', 'addRequestLog', 'stats']) {
    test('local59: durable failure retains fixed HTTP500 despite optional ' + failedSink +
      ' fault: ' + (send === sendChat ? 'chat' : 'legacy'), async () => {
      const f = await fixture({ rejectStorage: true, failingDiagnostics: [failedSink] })
      try {
        const response = await send(f)
        assert.equal(response.status, 500, response.raw)
        assert.equal(response.json?.error?.type, 'internal_error', response.raw)
        assert.equal(f.events.accountSettleAccepted, 0)
        assert.equal(f.events.success, 0)
        assert.equal(f.events.failures, 1)
        assert.equal(f.events.sends.length, 1)
        assertNeverLeaked(response, f.diagnosticCanary)
      } finally {
        await f.close()
      }
    })
  }
}

for (const stream of [false, true]) {
  test('local59: configured GLM inline-file request passes route validation to its exact pinned provider; stream=' +
    stream, async () => {
    const f = await fixture()
    try {
      const catalog = await f.http('/v1/models')
      assert.ok(catalog.json.data.some(m => m.id === 'glm-file-alias'))
      const detail = await f.http('/v1/models/glm-file-alias')
      assert.equal(detail.status, 200)
      const response = await sendFileChat(f, 'glm-file-alias', stream)
      assert.equal(response.status, 200, response.raw)
      if (stream) assert.match(response.raw, /\[DONE\]/)
      assert.equal(f.events.sends.length, 1, 'do not drop a supported GLM file before provider validation')
      assert.deepEqual(f.events.sends[0], {
        requestModel: 'glm-file-alias', providerId: 'glm',
        accountId: 'glm-account', wire: 'glm-wire-other',
      })
      assert.equal(f.events.accountSettleAccepted, 1)
      assert.deepEqual(f.events.stats, [true])
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}

for (const stream of [false, true]) {
  test('local59: Qwen must reject GLM-only file part before provider effect; stream=' +
    stream, async () => {
    const f = await fixture()
    try {
      const response = await sendFileChat(f, 'pinned-alias', stream)
      assert.equal(response.status, 400, response.raw)
      assert.deepEqual(f.events.sends, [])
      assert.equal(f.events.accountWrites, 0)
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}

for (const send of [sendChat, sendLegacy]) {
  test('local59: unavailable explicit account pin cannot fail over to other provider: ' +
    (send === sendChat ? 'chat' : 'legacy'), async () => {
    const f = await fixture()
    try {
      f.setPin('missing-account-id')
      const modelList = await f.http('/v1/models')
      assert.equal(modelList.status, 200)
      assert.equal(modelList.json.data.some(m => m.id === 'pinned-alias'), false)
      const model = await f.http(modelDetail)
      assert.equal(model.status, 404)
      assert.equal(model.json.error.code, 'model_not_found')
      const response = await send(f)
      assert.equal(response.status, 503, response.raw)
      assert.equal(response.json?.error?.code, 'no_available_account')
      assert.deepEqual(f.events.sends, [])
      assert.equal(f.events.accountSettleAccepted, 0)
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}

for (const send of [sendChat, sendLegacy, sendChatStream, sendLegacyStream]) {
  test('local59: durable account refusal cannot publish success: ' +
    (send === sendChat ? 'chat nonstream' : send === sendLegacy ? 'legacy nonstream' :
      send === sendChatStream ? 'chat stream' : 'legacy stream'), async () => {
    const f = await fixture({ rejectStorage: true })
    try {
      const response = await send(f)
      assert.notEqual(response.status, 201)
      assert.equal(response.raw.includes('[DONE]'), false)
      assert.equal(f.events.accountSettleAccepted, 0)
      assert.equal(f.events.success, 0)
      assert.equal(f.events.sends.length, 1)
      assertNeverLeaked(response, f.diagnosticCanary)
    } finally {
      await f.close()
    }
  })
}
