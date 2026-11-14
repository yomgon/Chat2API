import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real ProxyServer/host+API-key middleware/bodyparser, models/chat/legacy
// route handlers, ModelMapper/LoadBalancer and terminal gate. Provider/model
// catalogs/account identities/storage/upstream are strictly synthetic. The
// only socket is this test's 127.0.0.1:0 local listener.
const requireNode = createRequire(import.meta.url)
const providerIds = ['deepseek', 'qwen', 'glm', 'zai', 'qwen-ai', 'kimi']
const PRIV = 'PRIVATE_LOCAL72_CREDENTIAL_MUST_NOT_ESCAPE'
const read = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
function product(relative, mocked = {}) {
  const code = ts.transpileModule(read(relative), {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocked, name)) return mocked[name]
      if (name.startsWith('.')) throw Error('Unexpected product dependency: ' + relative + ' ' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  return module.exports
}
const responseFrame = body => 'data: ' + JSON.stringify(body) + '\n\n'
const frame = (wire, content = 'Synthetic answer') => [
  responseFrame({ id: 'synthetic-response', object: 'chat.completion.chunk', created: 1,
    model: wire, choices: [{ index: 0, delta: { role: 'assistant', content },
      finish_reason: null }] }),
  responseFrame({ id: 'synthetic-response', object: 'chat.completion.chunk', created: 1,
    model: wire, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
].join('')

async function fixture(providerId, {
  catalogEmpty = false, wildcard = false, rawUnmapped = false,
  disabled = false, stalePin = false, storeRefused = false, loggerRefused = false,
} = {}) {
  const wire = 'exact-wire-' + providerId
  const requested = wildcard ? 'public-special-42' : rawUnmapped ? 'unmapped-opaque-id' : 'public-model'
  const key = wildcard ? 'public-*' : 'public-model'
  const account = { id: 'exact-' + providerId + '-account', name: 'Offline',
    providerId, status: 'active', credentials: { token: PRIV } }
  const provider = { id: providerId, name: 'Offline ' + providerId, enabled: !disabled, createdAt: 1 }
  const events = { sends: [], accountSuccess: 0, stats: [], failures: 0,
    successes: 0, apiKeyWrites: 0 }
  const config = {
    enableApiKey: true, apiKeys: [{ id: 'local72-key', key: 'local72-bearer',
      enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false },
    retryCount: 0, loadBalanceStrategy: 'round-robin',
    modelMappings: rawUnmapped ? {} : {
      [key]: { requestModel: key, actualModel: wire, preferredProviderId: providerId,
        preferredAccountId: stalePin ? 'deleted-account' : account.id },
    },
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig(next) { Object.assign(config, next); events.apiKeyWrites++; return config },
    getProviders: () => [provider],
    getAccountsByProviderId: id => id === providerId ? [account] : [],
    getEffectiveModels: id => id === providerId && !catalogEmpty
      ? [{ displayName: 'catalog-' + providerId, actualModelId: wire }] : [],
    recordAccountSuccess(id, owner) {
      assert.equal(id, account.id)
      assert.equal(owner, providerId)
      if (storeRefused) return false
      events.accountSuccess++
      return true
    },
    recordRequestInStats(ok) { events.stats.push(ok) },
    addLog() { if (loggerRefused) throw Error('PRIVATE_DIAGNOSTIC_LOCAL72') },
    addRequestLog() {
      if (loggerRefused) throw Error('PRIVATE_DIAGNOSTIC_LOCAL72')
      return { id: 'offline-log' }
    },
    updateRequestLog() {},
  }
  const s = { '../store/store': { storeManager } }
  const modelMapper = product('modelMapper.ts', s).modelMapper
  const loadBalancer = product('loadbalancer.ts', { ...s,
    './modelMapper': { modelMapper } }).loadBalancer
  const forwarder = {
    async forwardChatCompletion(request, selectedAccount, selectedProvider, actualModel) {
      assert.equal(selectedAccount.id, account.id)
      assert.equal(selectedProvider.id, providerId)
      events.sends.push({ model: request.model, wire: actualModel,
        providerId: selectedProvider.id, accountId: selectedAccount.id, stream: request.stream === true })
      if (request.stream) {
        const stream = new PassThrough()
        setImmediate(() => {
          const bytes = Buffer.from(frame(actualModel), 'utf8')
          for (let offset = 0; offset < bytes.length; offset += 7)
            if (!stream.destroyed) stream.write(bytes.subarray(offset, offset + 7))
          if (!stream.destroyed) stream.end()
        })
        return { success: true, status: 200, skipTransform: true, stream }
      }
      return { success: true, status: 200, body: {
        id: 'synthetic-response', object: 'chat.completion', created: 1, model: actualModel,
        choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: 'Synthetic answer',
        } }],
      } }
    },
  }
  const status = {
    recordRequestStart() {}, recordRequestSuccess() { events.successes++ },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0,
      activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const gate = product('streamTerminalGate.ts')
  const shared = {
    '@koa/router': requireNode('@koa/router'),
    '../modelMapper': { modelMapper },
    '../loadbalancer': { loadBalancer },
    '../forwarder': { requestForwarder: forwarder },
    '../status': { proxyStatusManager: status },
    '../../store/store': { storeManager },
    '../streamTerminalGate': gate,
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('Fake upstream already emits valid SSE')
    } } },
  }
  const models = product('routes/models.ts', shared).default
  const chat = product('routes/chat.ts', { ...shared,
    '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }).default
  const legacy = product('routes/completions.ts', { ...shared,
    '../legacyCompletion': product('legacyCompletion.ts'),
  }).default
  const proxy = product('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'offline-local72' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models, chat, legacy], './routes/management': [],
    './status': { proxyStatusManager: status }, '../store/store': { storeManager },
    './localSecurity': product('localSecurity.ts'),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const send = (path, { body, method = body === undefined ? 'GET' : 'POST',
    apiKey = 'local72-bearer' } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', part => chunks.push(part))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch { json = null }
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(4000, () => req.destroy(Error('Closed HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const post = (kind, stream = false, apiKey) => send(
    kind === 'chat' ? '/v1/chat/completions' : '/v1/completions', {
      apiKey,
      body: kind === 'chat'
        ? { model: requested, messages: [{ role: 'user', content: 'Offline only' }], stream }
        : { model: requested, prompt: 'Offline only', stream },
    })
  return { requested, provider, account, wire, events, send, post,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    },
  }
}

for (const id of providerIds) {
  for (const wildcard of [false, true]) {
    for (const kind of ['chat', 'legacy']) {
      for (const stream of [false, true]) {
        test('local72 ' + id + ' ' + (wildcard ? 'wildcard' : 'exact') + ' ' + kind +
          ' stream=' + stream + ': absent target catalog refuses mapped provider dispatch', async () => {
          const f = await fixture(id, { catalogEmpty: true, wildcard })
          try {
            const list = await f.send('/v1/models')
            assert.equal(list.status, 200)
            assert.equal(list.json?.data?.some(x => x.id === f.requested), false)
            const detail = await f.send('/v1/models/' + f.requested)
            assert.equal(detail.status, 404)
            const result = await f.post(kind, stream)
            assert.equal(result.status, 503, result.raw)
            assert.equal(result.json?.error?.code, 'no_available_account')
            assert.equal(f.events.sends.length, 0, 'No unmapped upstream provider operation')
            assert.equal(f.events.accountSuccess, 0)
            assert.deepEqual(f.events.stats, [])
            assert.equal(result.raw.includes(PRIV), false)
            assert.equal(result.raw.includes('PRIVATE_DIAGNOSTIC_LOCAL72'), false)
          } finally { await f.close() }
        })
      }
    }
  }
  for (const kind of ['chat', 'legacy']) {
    for (const stream of [false, true]) {
      test('local72 ' + id + ' ' + kind + ' stream=' + stream +
        ': configured exact catalog and immutable account pin still work', async () => {
        const f = await fixture(id)
        try {
          const list = await f.send('/v1/models')
          assert.equal(list.status, 200, list.raw)
          assert.equal(list.json?.data?.some(x => x.id === f.requested), true)
          assert.equal((await f.send('/v1/models/' + f.requested)).status, 200)
          const r = await f.post(kind, stream)
          assert.equal(r.status, 200, r.raw)
          if (stream) assert.equal((r.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
          else assert.equal(r.json?.object, kind === 'chat' ? 'chat.completion' : 'text_completion')
          assert.equal(f.events.sends.length, 1)
          assert.equal(f.events.sends[0].wire, f.wire)
          assert.equal(f.events.sends[0].providerId, id)
          assert.equal(f.events.sends[0].accountId, f.account.id)
          assert.equal(f.events.accountSuccess, 1)
          assert.deepEqual(f.events.stats, [true])
        } finally { await f.close() }
      })
    }
  }
  test('local72 ' + id + ': raw no-catalog unmapped passthrough stays available', async () => {
    const f = await fixture(id, { catalogEmpty: true, rawUnmapped: true })
    try {
      const r = await f.post('chat')
      assert.equal(r.status, 200, r.raw)
      assert.equal(f.events.sends.length, 1)
      assert.equal(f.events.sends[0].wire, f.requested)
      assert.equal(f.events.accountSuccess, 1)
    } finally { await f.close() }
  })
  test('local72 ' + id + ': stale exact account pin stays fail closed', async () => {
    const f = await fixture(id, { stalePin: true })
    try {
      assert.equal((await f.send('/v1/models/' + f.requested)).status, 404)
      const r = await f.post('legacy')
      assert.equal(r.status, 503, r.raw)
      assert.equal(f.events.sends.length, 0)
      assert.equal(f.events.accountSuccess, 0)
    } finally { await f.close() }
  })
}
test('local72 real bearer authentication rejects unauthorized caller before selection', async () => {
  const f = await fixture('qwen')
  try {
    const r = await f.post('chat', false, 'invalid-api-key')
    assert.equal(r.status, 401)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountSuccess, 0)
    assert.equal(r.raw.includes(PRIV), false)
  } finally { await f.close() }
})
test('local72 mandatory account storage refusal does not issue successful response', async () => {
  const f = await fixture('glm', { storeRefused: true, loggerRefused: true })
  try {
    const r = await f.post('chat', false)
    assert.notEqual(r.status, 200, r.raw)
    assert.equal(f.events.accountSuccess, 0)
    assert.equal(f.events.sends.length, 1)
    assert.equal(r.raw.includes(PRIV), false)
    assert.equal(r.raw.includes('PRIVATE_DIAGNOSTIC_LOCAL72'), false)
  } finally { await f.close() }
})
test('local72 optional logger refusal after successful account commit retains success', async () => {
  const f = await fixture('zai', { loggerRefused: true })
  try {
    const r = await f.post('chat', false)
    assert.equal(r.status, 200, r.raw)
    assert.equal(f.events.accountSuccess, 1)
    assert.equal(r.raw.includes('PRIVATE_DIAGNOSTIC_LOCAL72'), false)
  } finally { await f.close() }
})
