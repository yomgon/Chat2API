import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// local61: Actual Koa ProxyServer, trusted loopback API-key middleware and
// chat route. Completely synthetic account, credential, store and forwarder.
// Invalid options must fail BEFORE provider or accounting effects.
const requireNode = createRequire(import.meta.url)
function product(path, mocked = {}) {
  const source = readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocked, name)) return mocked[name]
      if (name.startsWith('.')) throw Error('Unexpected local product import: ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const completedReply = {
  object: 'chat.completion', id: 'offline-reply', model: 'synthetic-wire', created: 1,
  choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: 'Offline answer' } }],
}
const sseEvent = chunk => 'data: ' + JSON.stringify({
  id: 'offline-chat-stream', object: 'chat.completion.chunk',
  choices: [{ index: 0, ...chunk }],
}) + '\n\n'
const completeSse = sseEvent({ delta: { role: 'assistant', content: 'Offline stream answer' }, finish_reason: null }) +
  sseEvent({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n'
const declared = [{
  type: 'function',
  function: { name: 'local_lookup', description: 'Only an in-memory fixture',
    parameters: { type: 'object', properties: { query: { type: 'string' } } } },
}]

async function fixture({ providerId = 'qwen' } = {}) {
  const events = { sends: [], accountSettlements: 0, success: 0, failure: 0, stats: [] }
  const account = { id: 'synthetic-account', providerId, name: 'in-memory', status: 'active' }
  const provider = { id: providerId, name: 'Synthetic', enabled: true }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true, apiKeys: [{
        id: 'offline-auth', key: 'only-in-memory-bearer', usageCount: 0, enabled: true,
      }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess() { events.accountSettlements++; return true },
    recordRequestInStats(success) { events.stats.push(success) },
    addRequestLog: () => ({ id: 'offline-log' }), updateRequestLog() {}, addLog() {},
  }
  const proxyStatusManager = {
    recordRequestStart() {}, recordRequestSuccess() { events.success++ },
    recordRequestFailure() { events.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const routeDeps = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-wire' }),
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: { async forwardChatCompletion(request) {
      events.sends.push(JSON.parse(JSON.stringify(request)))
      if (request.stream === true) {
        const input = new PassThrough()
        setImmediate(() => input.end(completeSse))
        return { success: true, status: 200, skipTransform: true, stream: input }
      }
      return { success: true, status: 200, body: completedReply }
    } } },
    '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('Unexpected stream in fixture')
    } } },
  }
  const chat = product('routes/chat.ts', {
    ...routeDeps,
    '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }).default
  const legacy = product('routes/completions.ts', {
    ...routeDeps,
    '../legacyCompletion': product('legacyCompletion.ts'),
  }).default
  const proxyServer = product('server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'offline-local43' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat, legacy], './routes/management': [],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('localSecurity.ts'),
  }).proxyServer
  const server = createServer(proxyServer.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxyServer.port = port
  const base = {
    model: 'offline-display-model',
    messages: [{ role: 'user', content: 'No external effects' }],
    stream: false,
  }
  function post(patch = {}, key = 'only-in-memory-bearer', extraHeaders = {},
    route = '/v1/chat/completions') {
    return new Promise((resolve, reject) => {
      const chunks = []
      const request = httpRequest({
        hostname: '127.0.0.1', port, path: route, method: 'POST',
        headers: { Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json', ...extraHeaders },
      }, response => {
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: response.statusCode, json, raw })
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.setTimeout(3000, () => request.destroy(Error('Isolated HTTP timeout')))
      const legacyBase = { model: base.model, prompt: 'No external effects', stream: false }
      request.end(JSON.stringify({ ...(route === '/v1/completions' ? legacyBase : base), ...patch }))
    })
  }
  return { events, post, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

const invalid = [
  ['presence_penalty', { presence_penalty: -2.01 }],
  ['presence_penalty', { presence_penalty: 2.01 }],
  ['presence_penalty', { presence_penalty: '0.2' }],
  ['presence_penalty', { presence_penalty: [] }],
  ['frequency_penalty', { frequency_penalty: -2.01 }],
  ['frequency_penalty', { frequency_penalty: 2.01 }],
  ['frequency_penalty', { frequency_penalty: false }],
  ['frequency_penalty', { frequency_penalty: { value: 1 } }],
  ['logit_bias', { logit_bias: 'invalid' }],
  ['logit_bias', { logit_bias: [1, 2] }],
  ['logit_bias', { logit_bias: { '123': 101 } }],
  ['logit_bias', { logit_bias: { '123': -101 } }],
  ['logit_bias', { logit_bias: { '123': '1' } }],
  ['logit_bias', { logit_bias: { '123': true } }],
  ['web_search_options', { web_search_options: [] }],
  ['web_search_options', { web_search_options: 'low' }],
  ['web_search_options', { web_search_options: { search_context_size: 'ultra' } }],
  ['web_search_options', { web_search_options: { user_location: [] } }],
  ['web_search_options', { web_search_options: { user_location: { type: 'precise' } } }],
  ['web_search_options', { web_search_options: {
    user_location: { type: 'approximate', approximate: { country: 123 } },
  } }],
]
for (const [field, body] of invalid) {
  test('local61 actual auth Koa rejects invalid ' + field + ' before provider effect: ' +
    JSON.stringify(body), async () => {
    const f = await fixture()
    try {
      const response = await f.post(body)
      assert.equal(response.status, 400, response.raw)
      assert.equal(response.json?.error?.type, 'invalid_request_error')
      assert.equal(response.json?.error?.param, field)
      assert.equal(response.json?.error?.code, 'invalid_completion_parameter')
      assert.equal(f.events.sends.length, 0)
      assert.equal(f.events.accountSettlements, 0)
      assert.equal(f.events.success, 0)
      assert.equal(f.events.stats.length, 0)
    } finally { await f.close() }
  })
}

for (const [headerName, field, value] of [
  ['X-Web-Search', 'web_search', 'sometimes'],
  ['X-Web-Search', 'web_search', '1'],
  ['X-Web-Search', 'web_search', 'TRUE'],
  ['X-Deep-Research', 'deep_research', 'maybe'],
  ['X-Deep-Research', 'deep_research', 'enabled'],
  ['X-Deep-Research', 'deep_research', 'FALSE'],
]) {
  test('local61 invalid ' + headerName + ' cannot be silently ignored when body absent: ' + value,
    async () => {
      const f = await fixture()
      try {
        const response = await f.post({}, 'only-in-memory-bearer', { [headerName]: value })
        assert.equal(response.status, 400, response.raw)
        assert.equal(response.json?.error?.param, field)
        assert.equal(f.events.sends.length, 0)
        assert.equal(f.events.accountSettlements, 0)
        assert.equal(f.events.success, 0)
      } finally { await f.close() }
    })
}

for (const [headerName, field] of [
  ['X-Web-Search', 'web_search'],
  ['X-Deep-Research', 'deep_research'],
]) {
  test('local61 explicit ' + headerName + ' false survives to provider, prevents model-alias activation',
    async () => {
      const f = await fixture()
      try {
        const response = await f.post({
          model: 'synthetic-search-alias',
        }, 'only-in-memory-bearer', { [headerName]: 'false' })
        assert.equal(response.status, 200, response.raw)
        assert.equal(f.events.sends.length, 1)
        assert.equal(f.events.sends[0][field], false)
        assert.equal(f.events.accountSettlements, 1)
        assert.deepEqual(f.events.stats, [true])
      } finally { await f.close() }
    })
}

test('local61 custom forwarder preserves valid OpenAI option bounds and nested web search', async () => {
  // The six dedicated web adapters do not implement nondefault penalties or
  // logit bias. This older mock-forwarder success contract instead exercises
  // the generic/custom provider branch, which actually forwards these values.
  const f = await fixture({ providerId: 'synthetic-custom' })
  try {
    const valid = {
      presence_penalty: -2, frequency_penalty: 2,
      logit_bias: { '10': 0, '11': -100, '12': 100 },
      web_search_options: {
        search_context_size: 'medium',
        user_location: { type: 'approximate', approximate: { country: 'KR', city: 'offline' } },
      },
    }
    const response = await f.post(valid)
    assert.equal(response.status, 200, response.raw)
    assert.equal(f.events.sends.length, 1)
    for (const key of Object.keys(valid)) assert.deepEqual(f.events.sends[0][key], valid[key])
    assert.equal(f.events.accountSettlements, 1)
    assert.deepEqual(f.events.stats, [true])
  } finally { await f.close() }
})

test('local61 valid body explicit feature false overrides even unsupported header fallback', async () => {
  const f = await fixture()
  try {
    const response = await f.post({ web_search: false, deep_research: false },
      'only-in-memory-bearer', { 'X-Web-Search': 'invalid', 'X-Deep-Research': 'invalid' })
    assert.equal(response.status, 200, response.raw)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.sends[0].web_search, false)
    assert.equal(f.events.sends[0].deep_research, false)
  } finally { await f.close() }
})

test('local61 untrusted API key cannot trigger provider send or account settlement', async () => {
  const f = await fixture()
  try {
    const response = await f.post({ web_search_options: ['bad'] }, 'wrong-api-key')
    assert.equal(response.status, 401, response.raw)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountSettlements, 0)
  } finally { await f.close() }
})

for (const [header, field] of [
  ['X-Web-Search', 'web_search'], ['X-Deep-Research', 'deep_research'],
]) {
  test('local61 streaming feature header false is committed only after verified SSE completion: ' +
    header, async () => {
    const f = await fixture()
    try {
      const response = await f.post({ stream: true }, 'only-in-memory-bearer', { [header]: 'false' })
      assert.equal(response.status, 200, response.raw)
      assert.ok(response.raw.includes('data: [DONE]'), response.raw)
      assert.equal(f.events.sends.length, 1)
      assert.equal(f.events.sends[0][field], false)
      assert.equal(f.events.accountSettlements, 1)
      assert.equal(f.events.success, 1)
      assert.deepEqual(f.events.stats, [true])
    } finally { await f.close() }
  })
}

for (const [field, value] of [
  ['presence_penalty', 9],
  ['frequency_penalty', '2'],
  ['logit_bias', { '3': 200 }],
  ['web_search_options', { search_context_size: 'too-large' }],
]) {
  test('local61 streaming invalid options must refuse before SSE handshake or charge: ' + field, async () => {
    const f = await fixture()
    try {
      const response = await f.post({ stream: true, [field]: value })
      assert.equal(response.status, 400, response.raw)
      assert.equal(response.json?.error?.param, field)
      assert.equal(response.raw.includes('[DONE]'), false)
      assert.equal(f.events.sends.length, 0)
      assert.equal(f.events.accountSettlements, 0)
      assert.equal(f.events.success, 0)
    } finally { await f.close() }
  })
}

test('local61 DeepSeek actual search alias resolver honors a body-normalized false header', async () => {
  const f = await fixture()
  try {
    const response = await f.post({ model: 'deepseek-v4-flash-search' },
      'only-in-memory-bearer', { 'X-Web-Search': 'false' })
    assert.equal(response.status, 200, response.raw)
    assert.equal(f.events.sends.length, 1)
    const opts = product('adapters/providerModelOptions.ts').resolveDeepSeekChatOptions({
      ...f.events.sends[0],
      model: 'deepseek-v4-flash',
      originalModel: 'deepseek-v4-flash-search',
    })
    assert.equal(opts.searchEnabled, false,
      'Do not turn on a paid inferred search after an explicit false header')
    assert.equal(f.events.accountSettlements, 1)
  } finally { await f.close() }
})

for (const [field, value] of [
  ['presence_penalty', '2'],
  ['presence_penalty', -2.01],
  ['frequency_penalty', 2.01],
  ['frequency_penalty', { value: 1 }],
  ['logit_bias', { '10': '100' }],
  ['logit_bias', { '10': 101 }],
]) {
  for (const stream of [false, true]) {
    test('local61 legacy refuses invalid ' + field + ' before upstream effect, stream=' +
      stream + ': ' + JSON.stringify(value), async () => {
      const f = await fixture()
      try {
        const response = await f.post({ stream, [field]: value },
          'only-in-memory-bearer', {}, '/v1/completions')
        assert.equal(response.status, 400, response.raw)
        assert.equal(response.json?.error?.param, field)
        assert.equal(response.json?.error?.code, 'invalid_completion_parameter')
        assert.equal(response.raw.includes('[DONE]'), false)
        assert.equal(f.events.sends.length, 0)
        assert.equal(f.events.accountSettlements, 0)
        assert.equal(f.events.success, 0)
        assert.equal(f.events.stats.length, 0)
      } finally { await f.close() }
    })
  }
}

for (const stream of [false, true]) {
  test('local61 custom legacy preserves valid bounded penalties and logit_bias through one pinned forwarding; stream=' +
    stream, async () => {
    const f = await fixture({ providerId: 'synthetic-custom' })
    try {
      const response = await f.post({
        stream, presence_penalty: -2, frequency_penalty: 2,
        logit_bias: { '12': -100, '13': 100 },
      }, 'only-in-memory-bearer', {}, '/v1/completions')
      assert.equal(response.status, 200, response.raw)
      if (stream) assert.equal(response.raw.includes('[DONE]'), true, response.raw)
      assert.equal(f.events.sends.length, 1)
      assert.equal(f.events.sends[0].presence_penalty, -2)
      assert.equal(f.events.sends[0].frequency_penalty, 2)
      assert.deepEqual(f.events.sends[0].logit_bias, { '12': -100, '13': 100 })
      assert.equal(f.events.accountSettlements, 1)
      assert.equal(f.events.success, 1)
      assert.deepEqual(f.events.stats, [true])
    } finally { await f.close() }
  })
}
