import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
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
    methods.join('\n') + '\n}', 'isolated-store-account-methods-local53.ts')
}

async function fixture({
  initialTime = afterMidnight,
  lastUsed = beforeMidnight,
  todayUsed = 2,
  dailyLimit = 2,
  usageDay,
  rejectStorage = false,
} = {}) {
  const clock = { now: initialTime }
  class ClockDate extends Date { static now() { return clock.now } }
  const compiled = extractStoreClass()
  const managerModule = { exports: {} }
  runInNewContext(compiled, {
    module: managerModule, exports: managerModule.exports, Date: ClockDate, Error, Math, JSON,
  }, { filename: 'isolated-actual-store-local53.cjs', timeout: 2000 })
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
    success: 0, failures: 0, apiKeyUpdates: 0 }
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
  manager.addLog = () => {}
  manager.addRequestLog = () => ({ id: 'synthetic-request-receipt' })
  manager.updateRequestLog = () => true
  manager.recordRequestInStats = ok => { events.stats.push(ok) }

  const modelMapper = new (product('proxy/modelMapper.ts', {
    '../store/store': { storeManager: manager },
  }, ClockDate).ModelMapper)()
  const loadBalancer = new (product('proxy/loadbalancer.ts', {
    '../store/store': { storeManager: manager },
    './modelMapper': { modelMapper },
  }, ClockDate).LoadBalancer)()
  const status = {
    recordRequestStart() {},
    recordRequestSuccess() { events.success++ },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0,
      activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const completion = {
    id: 'synthetic-complete-answer', object: 'chat.completion',
    created: 1, model: 'qwen-wire-exact',
    choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: 'Offline confirmed response' } }],
  }
  const forwarder = { async forwardChatCompletion(request, selected, provider, wire) {
    events.sends.push({
      requestModel: request.model, accountId: selected.id,
      providerId: provider.id, wire,
    })
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
      throw Error('No stream forwarding in local53 fixture')
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
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local53-fixture' } },
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
      req.setTimeout(2500, () => req.destroy(Error('Synthetic local53 loopback timeout')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  return {
    events, http, config, clock, state: () => clone(rows),
    view: () => clone(manager.getAccountById('qwen-account')),
    setTime: t => { clock.now = t },
    setPin: id => { config.modelMappings['pinned-alias'].preferredAccountId = id },
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

test('historical exhausted account unlocks only on next local calendar day across models list/detail and authenticated chat', async t => {
  const f = await fixture()
  t.after(f.close)
  const original = f.state()
  assert.equal(original[0].todayUsed, 2)
  const list = await f.http('/v1/models')
  const detail = await f.http(modelDetail)
  const managed = await f.http(managementAccount, { management: true })
  assert.equal(list.status, 200)
  assert.ok(list.json.data.some(x => x.id === 'pinned-alias'))
  assert.equal(detail.status, 200)
  assert.equal(managed.status, 200)
  assert.equal(managed.json.data.todayUsed, 0)
  assert.equal(managed.json.data.credentials.token, '***')
  assert.equal(managed.raw.includes(CREDENTIAL_CANARY), false)
  assert.equal(f.events.accountWrites, 0, 'GET catalog/admin cannot persist or reset credentials')
  assert.deepEqual(f.state(), original, 'Read-only day rollover leaves ciphertext and storage unchanged')
  const result = await sendChat(f)
  assert.equal(result.status, 200)
  assert.match(result.raw, /Offline confirmed response/)
  assert.deepEqual(f.events.sends, [{
    requestModel: 'pinned-alias', accountId: 'qwen-account',
    providerId: 'qwen', wire: 'qwen-wire-exact',
  }])
  const stored = f.state()[0]
  assert.equal(stored.todayUsed, 1)
  assert.equal(stored.requestCount, 8)
  assert.equal(stored.usageDay, '2026-11-13')
  assert.equal(stored.credentials.token, CREDENTIAL_CANARY)
  assert.equal(f.events.accountWrites, 1)
})

test('single local day admits remaining quota only, then hides pinned model with zero extra upstream effects', async t => {
  const f = await fixture()
  t.after(f.close)
  assert.equal((await sendChat(f)).status, 200)
  assert.equal((await sendChat(f)).status, 200)
  const blocked = await sendChat(f)
  assert.equal(blocked.status, 503)
  assert.equal(blocked.json.error.code, 'no_available_account')
  assert.equal((await f.http(modelDetail)).status, 404)
  assert.equal((await f.http('/v1/models')).json.data.some(m => m.id === 'pinned-alias'), false)
  assert.equal(f.events.sends.length, 2)
  assert.equal(f.events.accountWrites, 2)
  assert.equal(f.state()[0].todayUsed, 2)
  f.setTime(followingDay)
  assert.equal((await f.http(modelDetail)).status, 200)
  assert.equal(f.view().todayUsed, 0)
  assert.equal(f.state()[0].todayUsed, 2, 'Read is not a persistent reset')
  assert.equal((await sendChat(f)).status, 200)
  assert.equal(f.state()[0].todayUsed, 1)
  assert.equal(f.state()[0].requestCount, 10)
  assert.equal(f.state()[0].usageDay, '2026-11-14')
})

test('current-day exhausted and future-dated accounts do not bypass limit or silently fallback to another provider', async t => {
  for (const properties of [
    { lastUsed: afterMidnight, usageDay: undefined },
    { lastUsed: followingDay, usageDay: '2026-11-14' },
  ]) {
    const f = await fixture(properties)
    t.after(f.close)
    assert.equal((await f.http(modelDetail)).status, 404)
    assert.equal((await f.http('/v1/models')).json.data.some(m => m.id === 'pinned-alias'), false)
    const result = await sendChat(f)
    assert.equal(result.status, 503)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountWrites, 0)
  }
})

test('lost explicit account pin cannot be replaced by another provider even after rollover', async t => {
  const f = await fixture()
  t.after(f.close)
  f.setPin('deleted-account')
  assert.equal((await f.http(modelDetail)).status, 404)
  assert.equal((await sendChat(f)).status, 503)
  assert.equal(f.events.sends.length, 0)
})

test('durable account refusal after next-day selection reports HTTP error and preserves complete prior record', async t => {
  const f = await fixture({ rejectStorage: true })
  t.after(f.close)
  const before = f.state()
  assert.equal((await f.http(modelDetail)).status, 200)
  const result = await sendChat(f)
  assert.notEqual(result.status, 200)
  assert.equal(result.raw.includes(CREDENTIAL_CANARY), false)
  assert.deepEqual(f.state(), before)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.accountWrites, 1)
  assert.equal(f.events.accountSettleAccepted, 0)
})

test('legacy nonstream /v1/completions shares day boundary, exact provider pin and one committed account write', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await sendLegacy(f)
  assert.equal(response.status, 200)
  assert.equal(response.json.choices[0].text, 'Offline confirmed response')
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].providerId, 'qwen')
  assert.equal(f.state()[0].todayUsed, 1)
  assert.equal(f.state()[0].usageDay, '2026-11-13')
  assert.equal(f.events.accountWrites, 1)
})

test('unknown legacy usage timestamp keeps existing quota consumed instead of granting unproved extra allowance', async t => {
  const f = await fixture({ lastUsed: null })
  t.after(f.close)
  assert.equal((await f.http(modelDetail)).status, 404)
  assert.equal((await sendChat(f)).status, 503)
  assert.equal(f.events.accountWrites, 0)
  assert.equal(f.events.sends.length, 0)
})

test('expired explicit usage day overrides unrelated newer lastUsed metadata for safe calendar rollover', async t => {
  const f = await fixture({
    lastUsed: afterMidnight, usageDay: '2026-11-12',
  })
  t.after(f.close)
  assert.equal((await f.http(modelDetail)).status, 200)
  assert.equal((await sendChat(f)).status, 200)
  assert.equal(f.state()[0].todayUsed, 1)
  assert.equal(f.state()[0].usageDay, '2026-11-13')
})
