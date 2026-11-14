import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Independent, closed actual ProxyServer+Koa+bodyparser+API-key HTTP fixture.
// All identities, storage, provider effects, and replies are synthetic.
const nodeRequire = createRequire(import.meta.url)

function actualSource(relative, mocked = {}) {
  const code = readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(code, {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocked, name)) return mocked[name]
      if (name.startsWith('.')) throw new Error('Unmocked product module: ' + name)
      return nodeRequire(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const completedReply = {
  id: 'offline-answer', object: 'chat.completion', model: 'offline-wire', created: 1,
  choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: 'Local synthetic answer' } }],
}
const sse = [
  'data: ' + JSON.stringify({ object: 'chat.completion.chunk', id: 'offline-sse',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Local streamed answer' }, finish_reason: null }] }),
  'data: ' + JSON.stringify({ object: 'chat.completion.chunk', id: 'offline-sse',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]',
].join('\n\n') + '\n\n'

async function createFixture() {
  const observed = { forwarded: [], settled: 0, success: 0, failure: 0, statistics: [] }
  const account = { id: 'local-only-account', providerId: 'qwen', name: 'closed', status: 'active' }
  const provider = { id: 'qwen', name: 'Synthetic Qwen', enabled: true }
  const storeManager = {
    getConfig: () => ({ enableApiKey: true,
      apiKeys: [{ id: 'local-only-api-key', enabled: true, usageCount: 0, key: 'offline-secret-not-for-network' }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin' }),
    updateConfig() {},
    recordAccountSuccess() { observed.settled++; return true },
    recordRequestInStats(isSuccess) { observed.statistics.push(isSuccess) },
    addRequestLog: () => ({ id: 'fake-request-log' }),
    updateRequestLog() {}, addLog() {},
  }
  const statusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { observed.success++ },
    recordRequestFailure() { observed.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const deps = {
    '@koa/router': nodeRequire('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'offline-wire' }),
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: { async forwardChatCompletion(request) {
      observed.forwarded.push(JSON.parse(JSON.stringify(request)))
      if (request.stream === true) {
        const input = new PassThrough()
        setImmediate(() => input.end(sse))
        return { success: true, status: 200, skipTransform: true, stream: input }
      }
      return { success: true, status: 200, body: completedReply }
    } } },
    '../status': { proxyStatusManager: statusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': actualSource('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() {
      throw new Error('Unexpected stream transform')
    } } },
  }
  const chat = actualSource('routes/chat.ts', {
    ...deps,
    '../utils/toolFormatConverter': actualSource('utils/toolFormatConverter.ts'),
  }).default
  const proxyServer = actualSource('server.ts', {
    koa: nodeRequire('koa'),
    electron: { app: { getVersion: () => 'offline-local62' } },
    '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [chat], './routes/management': [],
    './status': { proxyStatusManager: statusManager },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': actualSource('localSecurity.ts'),
  }).proxyServer
  const server = createServer(proxyServer.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  // The real ProxyServer host-authority gate uses its configured bound port.
  // The fixture runs at OS-assigned port 0, not the default product port 8080.
  proxyServer.port = port
  function post(patch = {}, headers = {}, key = 'offline-secret-not-for-network') {
    return new Promise((resolve, reject) => {
      const chunks = []
      const req = httpRequest({ hostname: '127.0.0.1', port,
        path: '/v1/chat/completions', method: 'POST',
        headers: { Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json', ...headers } }, res => {
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, json, raw })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(3000, () => req.destroy(new Error('Synthetic HTTP timeout')))
      req.end(JSON.stringify({
        model: 'offline-display-search', messages: [{ role: 'user', content: 'Do not use a network' }],
        stream: false, ...patch,
      }))
    })
  }
  return { post, observed, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

for (const [stream, options] of [
  [false, {}],
  [true, {}],
  [false, { search_context_size: 'medium',
    user_location: { type: 'approximate', approximate: { country: 'KR', city: 'offline' } } }],
  [true, { search_context_size: 'low' }],
]) {
  test('local62 valid OpenAI web_search_options activates actual selected chat request stream=' +
    stream + ' options=' + JSON.stringify(options), async () => {
    const f = await createFixture()
    try {
      const response = await f.post({ stream, web_search_options: options })
      assert.equal(response.status, 200, response.raw)
      if (stream) assert.match(response.raw, /data: \[DONE\]/)
      assert.equal(f.observed.forwarded.length, 1)
      assert.equal(f.observed.forwarded[0].web_search, true,
        'Supplying web_search_options must not silently produce a no-search provider request')
      assert.deepEqual(f.observed.forwarded[0].web_search_options, options)
      assert.equal(f.observed.settled, 1)
      assert.deepEqual(f.observed.statistics, [true])
    } finally { await f.close() }
  })
}

for (const [label, patch, headers, expected] of [
  ['explicit body false', { web_search: false, web_search_options: {} }, {}, false],
  ['explicit header false', { web_search_options: {} }, { 'X-Web-Search': 'false' }, false],
  ['explicit header true', { web_search_options: {} }, { 'X-Web-Search': 'true' }, true],
  ['explicit body true', { web_search: true, web_search_options: {} }, { 'X-Web-Search': 'false' }, true],
  ['absent options', {}, {}, undefined],
  ['null options', { web_search_options: null }, {}, undefined],
]) {
  test('local62 ' + label + ' search activation precedence', async () => {
    const f = await createFixture()
    try {
      const response = await f.post(patch, headers)
      assert.equal(response.status, 200, response.raw)
      assert.equal(f.observed.forwarded.length, 1)
      assert.equal(f.observed.forwarded[0].web_search, expected)
      assert.equal(f.observed.settled, 1)
      assert.deepEqual(f.observed.statistics, [true])
    } finally { await f.close() }
  })
}

test('local62 malformed web search options never initiate a provider operation or charge', async () => {
  const f = await createFixture()
  try {
    const response = await f.post({ stream: true,
      web_search_options: { search_context_size: 'unbounded' } })
    assert.equal(response.status, 400, response.raw)
    assert.equal(response.json?.error?.param, 'web_search_options')
    assert.equal(f.observed.forwarded.length, 0)
    assert.equal(f.observed.settled, 0)
    assert.equal(f.observed.statistics.length, 0)
  } finally { await f.close() }
})

test('local62 unauthenticated request cannot activate search or send provider operation', async () => {
  const f = await createFixture()
  try {
    const response = await f.post({ web_search_options: {} }, {}, 'wrong-key')
    assert.equal(response.status, 401, response.raw)
    assert.equal(f.observed.forwarded.length, 0)
    assert.equal(f.observed.settled, 0)
  } finally { await f.close() }
})
