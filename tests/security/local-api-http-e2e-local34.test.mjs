import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// The real product Koa app, router, body parser, authentication middleware,
// public API handlers and stream terminal gate run over a real loopback socket.
// Only persistence, account selection and the remote provider are synthetic.
// Never open the production port, read an Electron profile or send upstream.
const requireNode = createRequire(import.meta.url)
const source = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const productVersion = JSON.parse(source('package.json')).version
const compiled = path => ts.transpileModule(source(path), {
  fileName: path,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

function loadProduct(path, mocks) {
  const module = { exports: {} }
  runInNewContext(compiled(path), {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw new Error(`Unapproved dependency ${path}: ${name}`)
      return requireNode(name)
    },
    Buffer, TextDecoder, Date, Math, JSON, Error, process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: path, timeout: 2000 })
  return module.exports
}

const chatReply = text => ({
  id: 'synthetic-chat-id', object: 'chat.completion', created: 1, model: 'wire-synthetic',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
})
const sse = chunk => `data: ${JSON.stringify(chunk)}\n\n`
const delta = text => sse({ id: 'synthetic', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
const finish = sse({ id: 'synthetic', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
const done = 'data: [DONE]\n\n'

async function fixture() {
  const events = { sends: [], start: 0, success: 0, failure: 0, settlement: [],
    legacyWrites: [], stats: [], receipts: [], updates: [], keyWrites: 0, logs: [], clear: 0 }
  const account = { id: 'isolated-fixture-account', name: 'fixture', providerId: 'qwen',
    status: 'active', requestCount: 0, todayUsed: 0 }
  const provider = { id: 'qwen', name: 'Synthetic Only', enabled: true, createdAt: 1000 }
  let config = {
    enableApiKey: true, apiKeys: [{ id: 'synthetic-key', key: 'fixture-local-key',
      enabled: true, usageCount: 0, lastUsedAt: 0 }],
    managementApi: { enableManagementApi: false, managementApiSecret: 'fixture-management-secret' },
    modelMappings: { 'aliased-model': { actualModel: 'wire-synthetic', preferredProviderId: 'qwen' } },
    loadBalanceStrategy: 'round-robin',
  }
  let nextResult = { success: true, status: 200, body: chatReply('offline answer') }
  let noAccount = false
  let refuseSettlement = false
  let absentSettlement = false
  const storeManager = {
    getConfig: () => config,
    updateConfig: patch => { config = { ...config, ...patch }; events.keyWrites++ },
    getProviders: () => [provider],
    getAccountsByProviderId: id => id === provider.id ? [account] : [],
    getEffectiveModels: id => id === provider.id
      ? [{ actualModelId: 'wire-synthetic', displayName: 'synthetic-model' }] : [],
    recordAccountSuccess: (id, providerId) => {
      if (refuseSettlement) throw new Error('SYNTHETIC_PRIVATE_PERSISTENCE_ERROR')
      // The real StoreManager returns boolean false when an account has
      // disappeared or changed providers while the request was in flight.
      if (absentSettlement) return false
      events.settlement.push({ id, providerId }); account.requestCount++; account.todayUsed++; return true
    },
    updateAccount: (id, patch) => { events.legacyWrites.push({ id, patch }); Object.assign(account, patch) },
    addLog: (_level, message) => events.logs.push(message),
    addRequestLog: entry => {
      events.receipts.push(entry); return { id: `fixture-log-${events.receipts.length}` }
    },
    updateRequestLog: (id, changes) => { events.updates.push({ id, changes }); return true },
    recordRequestInStats: success => events.stats.push(success),
    getStatistics: () => ({ totalRequests: events.stats.length,
      successRequests: events.stats.filter(Boolean).length, failedRequests: events.stats.filter(x => !x).length,
      totalLatency: 0, modelUsage: {}, providerUsage: {}, accountUsage: {} }),
    getTodayStatistics: () => ({ date: '2026-11-11', totalRequests: 0, successRequests: 0, failedRequests: 0 }),
  }
  const proxyStatusManager = {
    recordRequestStart: () => events.start++,
    recordRequestSuccess: () => events.success++,
    recordRequestFailure: () => events.failure++,
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: events.start, successRequests: events.success,
      failedRequests: events.failure, activeConnections: 0, requestsPerMinute: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const loadBalancer = {
    selectAccount: model => noAccount ? null : ({ account, provider, actualModel: 'wire-synthetic' }),
    // The models route now uses the same side-effect-free selectability
    // contract as the real LoadBalancer, rather than advancing dispatch state.
    hasSelectableAccount: (_model, _strategy, preferredProviderId, preferredAccountId) =>
      !noAccount && (!preferredProviderId || preferredProviderId === provider.id) &&
      (!preferredAccountId || preferredAccountId === account.id),
    clearAccountFailure: () => events.clear++, markAccountFailed: () => {},
  }
  // Use the actual model mapper now shared by the models HTTP route and
  // LoadBalancer, rather than an old two-method stub missing wildcard lookup.
  const modelMapper = loadProduct('src/main/proxy/modelMapper.ts', {
    '../store/store': { storeManager },
  }).modelMapper
  const requestForwarder = {
    forwardChatCompletion: async (...args) => { events.sends.push(args); return nextResult },
  }
  const gate = loadProduct('src/main/proxy/streamTerminalGate.ts', {})
  const legacyCompletion = loadProduct('src/main/proxy/legacyCompletion.ts', {})
  const shared = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer },
    '../modelMapper': { modelMapper },
    '../forwarder': { requestForwarder },
    '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': gate,
    '../legacyCompletion': legacyCompletion,
    '../stream': { streamHandler: { createTransformStream: () => new PassThrough() } },
  }
  const chatRouter = loadProduct('src/main/proxy/routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw new Error('Not requested') },
      transformChunkToAnthropic: () => { throw new Error('Not requested') },
    },
  }).default
  const modelsRouter = loadProduct('src/main/proxy/routes/models.ts', shared).default
  const completionsRouter = loadProduct('src/main/proxy/routes/completions.ts', shared).default
  const managementAuthMiddleware = loadProduct('src/main/proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const managementStatisticsRouter = loadProduct('src/main/proxy/routes/management/statistics.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../status': { proxyStatusManager },
    '../../../store/store': { storeManager },
  }).default
  const managementConfigRouter = loadProduct('src/main/proxy/routes/management/config.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../../store/config': { __esModule: true, default: {
      get: () => config,
      validate: () => ({ valid: true, errors: [] }),
      update: patch => { config = { ...config, ...patch }; return config },
    } },
  }).default
  const managementKeysRouter = loadProduct('src/main/proxy/routes/management/apiKeys.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../../store/store': { storeManager },
  }).default
  const localSecurity = loadProduct('src/main/proxy/localSecurity.ts', {})
  const server = loadProduct('src/main/proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => productVersion } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chatRouter, modelsRouter, completionsRouter],
    './routes/management': [managementStatisticsRouter, managementConfigRouter, managementKeysRouter],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': localSecurity,
  }).proxyServer
  // Direct Koa callback: no application auto-start, login checker or profile.
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port // Runtime private field for exact real Host checking.

  function fetchLocal(path, { method = 'GET', body, key = 'fixture-local-key', origin, host, managementSecret } = {}) {
    const headers = { Host: host ?? `127.0.0.1:${port}` }
    if (key) headers.Authorization = `Bearer ${key}`
    if (origin) headers.Origin = origin
    if (managementSecret) headers['X-Management-Secret'] = managementSecret
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, headers: res.headers, raw, json })
        })
      })
      req.on('error', reject)
      req.setTimeout(2000, () => req.destroy(new Error('Isolated HTTP fixture timed out')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }

  function abortOnFirstData(path, body) {
    const headers = { Host: `127.0.0.1:${port}`, Authorization: 'Bearer fixture-local-key',
      'Content-Type': 'application/json' }
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port,
        method: 'POST', path, headers }, res => {
        res.once('data', () => {
          // This destroys only our local, synthetic HTTP client connection.
          res.destroy()
          resolve()
        })
        res.once('error', () => {})
      })
      req.on('error', reject)
      req.setTimeout(2000, () => req.destroy(new Error('Isolated cancellation timed out')))
      req.end(JSON.stringify(body))
    })
  }

  async function close() {
    listener.closeAllConnections()
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  }
  return { events, account, fetchLocal, abortOnFirstData, close,
    setResult: value => { nextResult = value },
    setNoAccount: value => { noAccount = value },
    setRefuseSettlement: value => { refuseSettlement = value },
    setAbsentSettlement: value => { absentSettlement = value },
    enableManagement: () => { config.managementApi.enableManagementApi = true },
  }
}

test('real HTTP: Host/Origin/API key gate precedes Koa body parsing and public routes are bounded', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.fetchLocal('/health', { host: 'attacker.invalid' })).status, 403)
  assert.equal((await f.fetchLocal('/health', { origin: 'http://localhost:5173' })).status, 403)
  assert.equal((await f.fetchLocal('/v1/models', { key: '' })).status, 401)
  assert.equal((await f.fetchLocal('/v1/models', { key: 'wrong' })).status, 401)
  const root = await f.fetchLocal('/', { key: '' })
  assert.equal(root.status, 200)
  assert.equal(root.json.version, productVersion)
  assert.equal(f.events.sends.length, 0)
})

test('real HTTP: models route respects synthetic active account and alias target', async t => {
  const f = await fixture(); t.after(f.close)
  const list = await f.fetchLocal('/v1/models')
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.data.map(x => x.id).sort(), ['aliased-model', 'synthetic-model'])
  assert.equal((await f.fetchLocal('/v1/models/aliased-model')).json.id, 'aliased-model')
  assert.equal((await f.fetchLocal('/v1/models/missing')).status, 404)
  assert.equal(f.events.sends.length, 0)
})

test('real HTTP: management disabled, missing secret, wrong secret and allowed statistics', async t => {
  const f = await fixture(); t.after(f.close)
  const path = '/v0/management/statistics'
  assert.equal((await f.fetchLocal(path, { key: '' })).json.error.code, 'management_api_disabled')
  f.enableManagement()
  assert.equal((await f.fetchLocal(path, { key: '' })).status, 401)
  assert.equal((await f.fetchLocal(path, { key: '', managementSecret: 'wrong' })).status, 401)
  const authorized = await f.fetchLocal(path, { key: '', managementSecret: 'fixture-management-secret' })
  assert.equal(authorized.status, 200)
  assert.equal(authorized.json.success, true)
  assert.equal(authorized.json.data.totalRequests, 0)
  assert.equal(f.events.sends.length, 0)
})

test('real HTTP: management config and API key routes never expose synthetic credentials', async t => {
  const f = await fixture(); t.after(f.close)
  f.enableManagement()
  const options = { key: '', managementSecret: 'fixture-management-secret' }
  const masked = await f.fetchLocal('/v0/management/config', options)
  assert.equal(masked.status, 200)
  assert.equal(masked.json.data.managementApi.managementApiSecret, '***')
  assert.equal(masked.json.data.apiKeys[0].key, '***')
  const byKey = await f.fetchLocal('/v0/management/api-keys', options)
  assert.equal(byKey.status, 200)
  assert.equal(byKey.json.success, true)
  assert.notEqual(byKey.json.data[0].key, 'fixture-local-key')
  assert.doesNotMatch(masked.raw + byKey.raw, /fixture-local-key|fixture-management-secret/)
  assert.equal(f.events.sends.length, 0)
})

test('real HTTP: chat nonstream success, empty answer rejection and no-account refusal', async t => {
  const f = await fixture(); t.after(f.close)
  const post = body => f.fetchLocal('/v1/chat/completions', { method: 'POST', body })
  const body = { model: 'aliased-model', messages: [{ role: 'user', content: 'synthetic' }] }
  const valid = await post(body)
  assert.equal(valid.status, 200)
  assert.equal(valid.json.choices[0].message.content, 'offline answer')
  assert.equal(f.events.settlement.length, 1)
  f.setResult({ success: true, status: 200, body: chatReply('') })
  const invalid = await post(body)
  assert.equal(invalid.status, 502)
  assert.equal(f.events.settlement.length, 1)
  f.setNoAccount(true)
  assert.equal((await post(body)).status, 503)
  assert.equal(f.events.sends.length, 2)
})

test('real HTTP RED: malformed chat model/message/stream input is rejected before remote selection', async t => {
  const f = await fixture(); t.after(f.close)
  const path = '/v1/chat/completions'
  const post = body => f.fetchLocal(path, { method: 'POST', body })
  const badBodies = [
    { model: 123, messages: [{ role: 'user', content: 'fixture' }] },
    { model: 'aliased-model', messages: [null] },
    { model: 'aliased-model', messages: [{}] },
    { model: 'aliased-model', messages: [{ role: 'user', content: 'fixture' }], stream: 'false' },
  ]
  for (const body of badBodies) {
    const response = await post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.equal(f.events.sends.length, 0)
  assert.equal(f.events.settlement.length, 0)
})

test('real HTTP RED: legacy nonstream must not count incomplete answer', async t => {
  const f = await fixture(); t.after(f.close)
  f.setResult({ success: true, status: 200, body: chatReply('') })
  const response = await f.fetchLocal('/v1/completions', {
    method: 'POST', body: { model: 'aliased-model', prompt: 'fixture prompt' },
  })
  assert.equal(response.status, 502)
  assert.equal(f.events.success, 0)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.legacyWrites.length, 0)
})

test('real HTTP RED: legacy valid answer is text_completion with actual usage provenance', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.fetchLocal('/v1/completions', {
    method: 'POST', body: { model: 'aliased-model', prompt: 'fixture prompt' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.object, 'text_completion')
  assert.equal(response.json.choices[0].text, 'offline answer')
  assert.equal(response.json.choices[0].finish_reason, 'stop')
  assert.deepEqual(response.json.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  assert.equal(f.events.settlement.length, 1)
  assert.equal(f.events.stats.length, 1)
})

test('real HTTP RED: unsupported legacy echo and n>1 are refused before upstream effects', async t => {
  const f = await fixture(); t.after(f.close)
  for (const option of [{ echo: true }, { n: 2 }, { prompt: ['separate', 'prompts'] }]) {
    const result = await f.fetchLocal('/v1/completions', {
      method: 'POST', body: { model: 'aliased-model', prompt: 'fixture', ...option },
    })
    assert.equal(result.status, 400)
  }
  assert.equal(f.events.sends.length, 0)
  assert.equal(f.events.settlement.length, 0)
})

test('real HTTP RED: legacy completed SSE settles at verified EOF, without false early charges', async t => {
  const f = await fixture(); t.after(f.close)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'fixture', stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.events.success, 0)
  assert.equal(f.events.settlement.length, 0)
  upstream.end(delta('streamed text') + finish + done)
  const response = await pending
  assert.equal(response.status, 200)
  assert.match(response.raw, /"object":"text_completion"/)
  assert.match(response.raw, /"text":"streamed text"/)
  assert.equal((response.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(f.events.settlement.length, 1)
  assert.equal(f.events.success, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('real HTTP RED: legacy incomplete streaming response reports failure with no DONE or account success', async t => {
  const f = await fixture(); t.after(f.close)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'fixture', stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  upstream.end(delta('partial but no finish') + done)
  const response = await pending
  assert.doesNotMatch(response.raw, /data: \[DONE\]/)
  assert.match(response.raw, /provider_stream_incomplete/)
  assert.equal(f.events.success, 0)
  assert.equal(f.events.failure, 1)
  assert.equal(f.events.settlement.length, 0)
  assert.deepEqual(f.events.stats, [false])
})

test('real HTTP: legacy SSE preserves reported usage but never fabricates usage', async t => {
  const f = await fixture(); t.after(f.close)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'fixture', stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  const reportedUsage = { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 }
  upstream.end(delta('measured') + finish + sse({ object: 'chat.completion.chunk',
    choices: [], usage: reportedUsage }) + done)
  const response = await pending
  assert.equal(response.status, 200)
  assert.match(response.raw, /"prompt_tokens":4/)
  assert.match(response.raw, /"object":"text_completion"/)
  assert.equal(f.events.settlement.length, 1)
})

test('real HTTP: legacy stream rejects unrepresentable tool-only answer before success', async t => {
  const f = await fixture(); t.after(f.close)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'fixture', stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  upstream.end(sse({ object: 'chat.completion.chunk', choices: [{ index: 0,
    delta: { tool_calls: [{ index: 0, id: 'synthetic-tool',
      function: { name: 'do_not_execute', arguments: '{}' } }] }, finish_reason: null }] }) +
    sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + done)
  const response = await pending
  assert.doesNotMatch(response.raw, /data: \[DONE\]/)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.failure, 1)
})

test('real HTTP: legacy stream local persistence failure withholds terminal DONE', async t => {
  const f = await fixture(); t.after(f.close)
  f.setRefuseSettlement(true)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'fixture', stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  upstream.end(delta('answered') + finish + done)
  const response = await pending
  assert.doesNotMatch(response.raw, /data: \[DONE\]/)
  assert.match(response.raw, /provider_stream_incomplete/)
  assert.doesNotMatch(response.raw, /SYNTHETIC_PRIVATE_PERSISTENCE_ERROR/)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.success, 0)
  assert.deepEqual(f.events.stats, [false])
})

test('real HTTP: canceled legacy stream destroys synthetic upstream and records failure once', async t => {
  const f = await fixture(); t.after(f.close)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const aborting = f.abortOnFirstData('/v1/completions', {
    model: 'aliased-model', prompt: 'fixture', stream: true,
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  upstream.write(delta('partially delivered'))
  await aborting
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(upstream.destroyed, true)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.success, 0)
  assert.deepEqual(f.events.stats, [false])
  assert.equal(f.events.failure, 1)
})

test('real HTTP: actual chat streaming route waits for EOF and settles once', async t => {
  const f = await fixture(); t.after(f.close)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/chat/completions', { method: 'POST',
    body: { model: 'aliased-model', messages: [{ role: 'user', content: 'fixture' }], stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.events.success, 0)
  upstream.end(delta('verified chat') + finish + done)
  const response = await pending
  assert.equal(response.status, 200)
  assert.match(response.raw, /verified chat/)
  assert.equal((response.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(f.events.settlement.length, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('real HTTP RED: chat nonstream rejects StoreManager false settlement, never sends assistant success', async t => {
  const f = await fixture(); t.after(f.close)
  f.setAbsentSettlement(true)
  const response = await f.fetchLocal('/v1/chat/completions', { method: 'POST',
    body: { model: 'aliased-model', messages: [{ role: 'user', content: 'test account disappeared' }] },
  })
  assert.equal(response.status, 500)
  assert.equal(response.json?.choices, undefined)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.success, 0)
  assert.deepEqual(f.events.stats, [false])
})

test('real HTTP RED: legacy nonstream rejects StoreManager false settlement', async t => {
  const f = await fixture(); t.after(f.close)
  f.setAbsentSettlement(true)
  const response = await f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'test account disappeared' },
  })
  assert.equal(response.status, 500)
  assert.equal(response.json?.choices, undefined)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.success, 0)
  assert.deepEqual(f.events.stats, [false])
})

test('real HTTP RED: chat verified stream cannot emit DONE when StoreManager returns false', async t => {
  const f = await fixture(); t.after(f.close)
  f.setAbsentSettlement(true)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/chat/completions', { method: 'POST',
    body: { model: 'aliased-model', messages: [{ role: 'user', content: 'fixture' }], stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  upstream.end(delta('provider actually answered') + finish + done)
  const response = await pending
  assert.doesNotMatch(response.raw, /data: \[DONE\]/)
  assert.match(response.raw, /provider_stream_incomplete/)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.success, 0)
  assert.deepEqual(f.events.stats, [false])
})

test('real HTTP RED: legacy verified stream cannot emit DONE when StoreManager returns false', async t => {
  const f = await fixture(); t.after(f.close)
  f.setAbsentSettlement(true)
  const upstream = new PassThrough()
  f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
  const pending = f.fetchLocal('/v1/completions', { method: 'POST',
    body: { model: 'aliased-model', prompt: 'fixture', stream: true } })
  await new Promise(resolve => setTimeout(resolve, 30))
  upstream.end(delta('provider actually answered') + finish + done)
  const response = await pending
  assert.doesNotMatch(response.raw, /data: \[DONE\]/)
  assert.match(response.raw, /provider_stream_incomplete/)
  assert.equal(f.events.settlement.length, 0)
  assert.equal(f.events.success, 0)
  assert.deepEqual(f.events.stats, [false])
})
