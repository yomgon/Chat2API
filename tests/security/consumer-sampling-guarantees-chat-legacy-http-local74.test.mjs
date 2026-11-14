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
const PRIV = 'PRIVATE_LOCAL74_CREDENTIAL_MUST_NOT_ESCAPE'
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
    enableApiKey: true, apiKeys: [{ id: 'local74-key', key: 'local74-bearer',
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
    addLog() { if (loggerRefused) throw Error('PRIVATE_DIAGNOSTIC_LOCAL74') },
    addRequestLog() {
      if (loggerRefused) throw Error('PRIVATE_DIAGNOSTIC_LOCAL74')
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
        providerId: selectedProvider.id, accountId: selectedAccount.id,
        stream: request.stream === true,
        sampling: {
          max_tokens: request.max_tokens, temperature: request.temperature,
          top_p: request.top_p, presence_penalty: request.presence_penalty,
          frequency_penalty: request.frequency_penalty,
          logit_bias: request.logit_bias,
        },
      })
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
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'offline-local74' } },
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
    apiKey = 'local74-bearer' } = {}) => new Promise((resolve, reject) => {
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
  const post = (kind, stream = false, apiKey, extra = {}) => send(
    kind === 'chat' ? '/v1/chat/completions' : '/v1/completions', {
      apiKey,
      body: kind === 'chat'
        ? { model: requested, messages: [{ role: 'user', content: 'Offline only' }], stream, ...extra }
        : { model: requested, prompt: 'Offline only', stream, ...extra },
    })
  return { requested, provider, account, wire, events, send, post,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    },
  }
}

// Actual dedicated web adapters accept a temperature field but never use it;
// their forwarder methods omit max_tokens, top_p, penalties and logit_bias
// entirely. The generic/custom provider's wire forwards these fields and
// must not lose its existing contract. Before changing production, prove the
// six dedicated provider routes can claim HTTP 200/DONE despite being unable
// to honor the client's explicit sampling/length guarantee.
const unsupported = [
  { name: 'token limit', key: 'max_tokens', value: 1 },
  { name: 'nondefault temperature', key: 'temperature', value: 0.3 },
  { name: 'nondefault nucleus threshold', key: 'top_p', value: 0.6 },
  { name: 'presence penalty', key: 'presence_penalty', value: 0.4 },
  { name: 'frequency penalty', key: 'frequency_penalty', value: -0.5 },
  { name: 'nonempty logit bias', key: 'logit_bias', value: { '42': 50 } },
]
const harmlessDefaultSampling = {
  temperature: 1, top_p: 1, presence_penalty: 0,
  frequency_penalty: 0, logit_bias: {},
}
for (const providerId of providerIds) {
  for (const kind of ['chat', 'legacy']) {
    for (const stream of [false, true]) {
      for (const option of unsupported) {
        test('local74 ' + providerId + ' ' + kind + ' stream=' + stream +
          ': no false success for unsupported ' + option.name, async () => {
          const f = await fixture(providerId)
          try {
            const r = await f.post(kind, stream, undefined, { [option.key]: option.value })
            assert.equal(r.status, 400, r.raw)
            assert.equal(r.json?.error?.type, 'invalid_request_error')
            assert.equal(r.json?.error?.param, option.key)
            assert.equal(f.events.sends.length, 0, 'Never send an unhonorable option')
            assert.equal(f.events.accountSuccess, 0, 'Never charge a rejected option')
            assert.equal(f.events.successes, 0)
            assert.deepEqual(f.events.stats, [])
            assert.equal(r.raw.includes(PRIV), false)
            assert.equal(r.raw.includes('PRIVATE_DIAGNOSTIC_LOCAL74'), false)
            assert.equal(r.raw.includes('data: [DONE]'), false)
          } finally { await f.close() }
        })
      }
      test('local74 ' + providerId + ' ' + kind + ' stream=' + stream +
        ': catalog/model/detail/pin and harmless defaults remain valid', async () => {
        const f = await fixture(providerId)
        try {
          const list = await f.send('/v1/models')
          assert.equal(list.status, 200, list.raw)
          assert.equal(list.json.data.some(x => x.id === f.requested), true)
          assert.equal((await f.send('/v1/models/' + f.requested)).status, 200)
          const r = await f.post(kind, stream, undefined, harmlessDefaultSampling)
          assert.equal(r.status, 200, r.raw)
          if (stream) assert.equal((r.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
          else assert.equal(r.json?.object, kind === 'chat' ? 'chat.completion' : 'text_completion')
          assert.equal(f.events.sends.length, 1)
          assert.equal(f.events.sends[0].providerId, providerId)
          assert.equal(f.events.sends[0].accountId, f.account.id)
          assert.equal(f.events.sends[0].wire, f.wire)
          assert.equal(f.events.accountSuccess, 1)
          assert.deepEqual(f.events.stats, [true])
        } finally { await f.close() }
      })
    }
  }
}

test('local74 non-dedicated custom provider preserves sampling request passthrough', async () => {
  const f = await fixture('custom-offline')
  try {
    const extra = { max_tokens: 2, temperature: 0.3, top_p: 0.6,
      presence_penalty: 0.4, frequency_penalty: -0.5, logit_bias: { '42': 50 } }
    const result = await f.post('chat', false, undefined, extra)
    assert.equal(result.status, 200, result.raw)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.sends[0].wire, f.wire)
    assert.deepEqual(f.events.sends[0].sampling, extra)
    assert.equal(f.events.accountSuccess, 1)
  } finally { await f.close() }
})
test('local74 bad bearer rejects before any provider choice', async () => {
  const f = await fixture('qwen')
  try {
    const r = await f.post('chat', true, 'invalid-bearer', { max_tokens: 1 })
    assert.equal(r.status, 401, r.raw)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountSuccess, 0)
  } finally { await f.close() }
})
test('local74 stale strict account pin denies before provider send', async () => {
  const f = await fixture('glm', { stalePin: true })
  try {
    const r = await f.post('legacy', false, undefined, { max_tokens: 1 })
    assert.equal(r.status, 503, r.raw)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountSuccess, 0)
  } finally { await f.close() }
})
test('local74 valid default cannot publish DONE if mandatory account storage refuses', async () => {
  const f = await fixture('kimi', { storeRefused: true, loggerRefused: true })
  try {
    const r = await f.post('chat', true, undefined, harmlessDefaultSampling)
    assert.equal(r.raw.includes('data: [DONE]'), false)
    assert.equal(f.events.accountSuccess, 0)
    assert.equal(f.events.sends.length, 1)
    assert.equal(r.raw.includes(PRIV), false)
  } finally { await f.close() }
})
test('local74 optional logger rejection cannot revoke completed default response', async () => {
  const f = await fixture('zai', { loggerRefused: true })
  try {
    const r = await f.post('legacy', false, undefined, harmlessDefaultSampling)
    assert.equal(r.status, 200, r.raw)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.accountSuccess, 1)
    assert.equal(r.raw.includes('PRIVATE_DIAGNOSTIC_LOCAL74'), false)
  } finally { await f.close() }
})
