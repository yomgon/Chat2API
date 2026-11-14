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

// A first accepted request has already dispatched the same account to the
// provider. The second HTTP request must not dispatch an extra provider effect
// before the first request's one available daily slot has settled.
for (const [firstName, secondName, firstSend, secondSend] of [
  ['chat', 'chat', sendChat, sendChat],
  ['chat', 'legacy', sendChat, sendLegacy],
  ['legacy', 'legacy', sendLegacy, sendLegacy],
]) {
  test(`local54 authenticated ${firstName}+${secondName} overlap respects one daily account slot`, async () => {
    const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
      usageDay: '2026-11-13' })
    let first
    let second
    try {
      first = firstSend(f)
      await f.waitForSends(1)
      assert.deepEqual(f.events.sends[0], {
        requestModel: firstName === 'legacy' ? 'qwen-wire-exact' : 'pinned-alias',
        accountId: 'qwen-account', providerId: 'qwen', wire: 'qwen-wire-exact',
      })
      second = secondSend(f)
      const earlySecond = await Promise.race([
        second,
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 250)),
      ])
      // The second request must be rejected while first upstream is unresolved.
      const dispatchedBeforeSettle = f.events.sends.length
      f.releaseAll()
      const [a, b] = await Promise.all([first, second])
      assert.equal(a.status, 200, a.raw)
      assert.equal(earlySecond.status, 503,
        `Second ${secondName} request was not rejected before upstream dispatch; observed ${dispatchedBeforeSettle} calls`)
      assert.equal(b.status, 503, b.raw)
      assert.equal(dispatchedBeforeSettle, 1, 'Two upstream effects oversubscribed one account slot')
      assert.equal(f.events.accountSettleAccepted, 1)
      assert.equal(f.view().todayUsed, 1)
      assert.equal(f.view().requestCount, 8)
      assert.deepEqual(f.events.sends.map(s => s.providerId), ['qwen'])
      assert.ok(!a.raw.includes(CREDENTIAL_CANARY) && !b.raw.includes(CREDENTIAL_CANARY))
      const exhausted = await secondSend(f)
      assert.equal(exhausted.status, 503, exhausted.raw)
      assert.equal(f.events.sends.length, 1)
    } finally {
      f.releaseAll()
      await Promise.allSettled([first, second].filter(Boolean))
      await f.close()
    }
  })
}

test('pinned catalog hides model during the only in-flight slot, then durable success keeps it exhausted until next day', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    usageDay: '2026-11-13' })
  let first
  try {
    first = sendChat(f)
    await f.waitForSends(1)
    const [list, detail, maskedAccount] = await Promise.all([
      f.http('/v1/models'), f.http(modelDetail), f.http(managementAccount, { management: true }),
    ])
    assert.equal(list.status, 200)
    assert.equal(list.json.data.some(m => m.id === 'pinned-alias'), false)
    assert.equal(detail.status, 404)
    assert.equal(maskedAccount.status, 200)
    assert.equal(maskedAccount.json.data.credentials.token, '***')
    assert.ok(!maskedAccount.raw.includes(CREDENTIAL_CANARY))
    assert.equal(f.events.accountWrites, 0, 'catalog reads may not persist reservations')
    f.release(0)
    assert.equal((await first).status, 200)
    assert.equal(f.events.accountSettleAccepted, 1)
    assert.equal((await sendLegacy(f)).status, 503)
    assert.equal(f.events.sends.length, 1)
    f.setTime(followingDay)
    assert.equal((await f.http(modelDetail)).status, 200)
    const nextDay = sendChat(f)
    await f.waitForSends(2)
    f.release(1)
    assert.equal((await nextDay).status, 200)
    assert.equal(f.view().usageDay, '2026-11-14')
    assert.equal(f.view().todayUsed, 1)
    assert.equal(f.view().requestCount, 9)
  } finally {
    f.releaseAll()
    if (first) await Promise.allSettled([first])
    await f.close()
  }
})

test('pending previous-day operation conservatively consumes new-day slot until late settlement', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    initialTime: beforeMidnight, usageDay: '2026-11-12' })
  let first
  try {
    first = sendChat(f)
    await f.waitForSends(1)
    f.setTime(afterMidnight)
    assert.equal((await f.http(modelDetail)).status, 404)
    assert.equal((await sendChat(f)).status, 503)
    assert.equal(f.events.sends.length, 1)
    f.release(0)
    assert.equal((await first).status, 200)
    assert.equal(f.view().usageDay, '2026-11-13')
    assert.equal(f.view().todayUsed, 1)
    assert.equal((await sendLegacy(f)).status, 503)
    f.setTime(followingDay)
    assert.equal((await f.http(modelDetail)).status, 200)
  } finally {
    f.releaseAll()
    if (first) await Promise.allSettled([first])
    await f.close()
  }
})

test('upstream refusal releases a provisional slot without success accounting, retry or provider substitution', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    usageDay: '2026-11-13' })
  let first
  let explicitSecond
  try {
    first = sendChat(f)
    await f.waitForSends(1)
    assert.equal((await sendLegacy(f)).status, 503)
    f.release(0, { success: false, status: 502,
      failureCode: 'synthetic_upstream_refusal' })
    const failed = await first
    assert.equal(failed.status, 502)
    assert.equal(f.events.accountWrites, 0)
    assert.equal(f.view().todayUsed, 0)
    assert.equal(f.events.sends.length, 1, 'no automatic retry')
    assert.ok(!failed.raw.includes(CREDENTIAL_CANARY))
    // A new, explicit caller request (not a retry) can use the released slot.
    explicitSecond = sendLegacy(f)
    await f.waitForSends(2)
    f.release(1)
    assert.equal((await explicitSecond).status, 200)
    assert.equal(f.events.accountSettleAccepted, 1)
    assert.deepEqual(f.events.sends.map(s => s.providerId), ['qwen', 'qwen'])
  } finally {
    f.releaseAll()
    await Promise.allSettled([first, explicitSecond].filter(Boolean))
    await f.close()
  }
})

test('durable settlement refusal does not leak reservation, fake a success, charge quota or expose secrets', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    usageDay: '2026-11-13', rejectStorage: true })
  const original = f.state()
  let pending
  try {
    pending = sendChat(f)
    await f.waitForSends(1)
    assert.equal((await sendLegacy(f)).status, 503)
    f.release(0)
    const failed = await pending
    assert.equal(failed.status, 500)
    assert.equal(failed.raw.includes(CREDENTIAL_CANARY), false)
    assert.equal(f.events.accountWrites, 1)
    assert.equal(f.events.accountSettleAccepted, 0)
    assert.deepEqual(f.state(), original)
    assert.equal((await f.http(modelDetail)).status, 200)
    assert.equal(f.events.sends.length, 1)
  } finally {
    f.releaseAll()
    if (pending) await Promise.allSettled([pending])
    await f.close()
  }
})

for (const [name, firstSend] of [
  ['chat', sendChatStream], ['legacy', sendLegacyStream],
]) {
  test(`verified ${name} SSE holds slot until clean EOF, not just upstream stream handshake`, async () => {
    const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
      usageDay: '2026-11-13' })
    let first
    const upstream = new PassThrough()
    try {
      first = firstSend(f)
      await f.waitForSends(1)
      f.release(0, { success: true, status: 200, stream: upstream, skipTransform: true })
      // A provider has returned a stream but has not delivered its terminal.
      assert.equal((await f.http(modelDetail)).status, 404)
      assert.equal((await sendChat(f)).status, 503)
      assert.equal(f.events.sends.length, 1)
      assert.equal(f.events.accountWrites, 0)
      upstream.end(completeSse)
      const result = await first
      assert.equal(result.status, 200)
      assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
      assert.match(result.raw, /Synthetic finished answer/)
      if (name === 'legacy') assert.match(result.raw, /text_completion/)
      assert.equal(f.events.accountWrites, 1)
      assert.equal(f.events.accountSettleAccepted, 1)
      assert.equal(f.view().todayUsed, 1)
      assert.equal((await sendChat(f)).status, 503)
      assert.equal(f.events.sends.length, 1)
    } finally {
      if (!upstream.destroyed) upstream.destroy()
      f.releaseAll()
      if (first) await Promise.allSettled([first])
      await f.close()
    }
  })
}

test('failed or incomplete SSE releases its live slot without a false DONE or committed success', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    usageDay: '2026-11-13' })
  const upstream = new PassThrough()
  let first
  try {
    first = sendChatStream(f)
    await f.waitForSends(1)
    f.release(0, { success: true, status: 200, stream: upstream, skipTransform: true })
    assert.equal((await sendLegacy(f)).status, 503)
    upstream.end(sseDelta('Partial answer only'))
    const result = await first
    assert.doesNotMatch(result.raw, /data: \[DONE\]/)
    assert.equal(f.events.accountWrites, 0)
    assert.equal(f.events.accountSettleAccepted, 0)
    assert.equal((await f.http(modelDetail)).status, 200)
    assert.equal(f.events.sends.length, 1)
  } finally {
    if (!upstream.destroyed) upstream.destroy()
    f.releaseAll()
    if (first) await Promise.allSettled([first])
    await f.close()
  }
})

test('SSE durable settlement refusal suppresses DONE and releases the provisional slot', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    usageDay: '2026-11-13', rejectStorage: true })
  const upstream = new PassThrough()
  let first
  try {
    first = sendChatStream(f)
    await f.waitForSends(1)
    f.release(0, { success: true, status: 200, stream: upstream, skipTransform: true })
    upstream.end(completeSse)
    const result = await first
    assert.doesNotMatch(result.raw, /data: \[DONE\]/)
    assert.equal(result.raw.includes(CREDENTIAL_CANARY), false)
    assert.equal(f.events.accountWrites, 1)
    assert.equal(f.events.accountSettleAccepted, 0)
    assert.equal(f.view().todayUsed, 0)
    assert.equal((await f.http(modelDetail)).status, 200)
  } finally {
    if (!upstream.destroyed) upstream.destroy()
    f.releaseAll()
    if (first) await Promise.allSettled([first])
    await f.close()
  }
})

test('aborted client SSE destroys original reader, releases only its own slot and never confirms success', async () => {
  const f = await fixture({ deferred: true, dailyLimit: 1, todayUsed: 0,
    usageDay: '2026-11-13' })
  const upstream = new PassThrough()
  let aborted
  try {
    aborted = f.abortStreamOnFirstData('/v1/chat/completions', {
      model: 'pinned-alias', messages: [{ role: 'user', content: 'Synthetic only' }],
      stream: true,
    })
    await f.waitForSends(1)
    f.release(0, { success: true, status: 200, stream: upstream, skipTransform: true })
    assert.equal((await sendLegacy(f)).status, 503)
    upstream.write(sseDelta('Partial before cancellation'))
    assert.deepEqual(await aborted, { status: 200, aborted: true })
    for (let i = 0; i < 100 && !upstream.destroyed; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(upstream.destroyed, true)
    assert.equal(f.events.accountSettleAccepted, 0)
    assert.equal(f.events.accountWrites, 0)
    assert.equal((await f.http(modelDetail)).status, 200)
    assert.equal(f.events.sends.length, 1, 'no automatic provider retry after cancel')
  } finally {
    if (!upstream.destroyed) upstream.destroy()
    f.releaseAll()
    if (aborted) await Promise.allSettled([aborted])
    await f.close()
  }
})
