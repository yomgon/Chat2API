import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// local63 independent, closed authenticated ProxyServer+Koa/bodyparser HTTP.
// Standard API guarantees that cannot be honored must not silently return a
// successful but semantically false answer, or create provider/account effects.
// All identities, storage, provider effects and replies are synthetic.
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

async function createFixture({ providerId = 'qwen' } = {}) {
  const observed = { forwarded: [], settled: 0, success: 0, failure: 0, statistics: [] }
  const account = { id: 'local-only-account', providerId, name: 'closed', status: 'active' }
  const provider = { id: providerId, name: 'Synthetic', enabled: true }
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
  const legacy = actualSource('routes/completions.ts', {
    ...deps,
    '../legacyCompletion': actualSource('legacyCompletion.ts'),
  }).default
  const proxyServer = actualSource('server.ts', {
    koa: nodeRequire('koa'),
    electron: { app: { getVersion: () => 'offline-local62' } },
    '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [chat, legacy], './routes/management': [],
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
  function post(patch = {}, headers = {}, key = 'offline-secret-not-for-network',
    route = '/v1/chat/completions') {
    return new Promise((resolve, reject) => {
      const chunks = []
      const req = httpRequest({ hostname: '127.0.0.1', port,
        path: route, method: 'POST',
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
      const isLegacy = route === '/v1/completions'
      const body = isLegacy
        ? { model: 'offline-display', prompt: 'Do not use a network', stream: false, ...patch }
        : { model: 'offline-display', messages: [{ role: 'user', content: 'Do not use a network' }],
          stream: false, ...patch }
      req.end(JSON.stringify(body))
    })
  }
  return { post, observed, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

// These options describe actual answer guarantees rather than merely hints.
// Chat2API's website consumers and custom forwarder currently return a single
// freeform text answer and do not implement log-probability metadata, seed
// determinism or JSON-schema/JSON-object output validation.
const unsupportedChat = [
  ['response_format', { response_format: { type: 'json_object' } }],
  ['response_format', { response_format: { type: 'json_schema',
    json_schema: { name: 'private_structured_answer', schema: { type: 'object' } } } }],
  ['logprobs', { logprobs: true }],
  ['top_logprobs', { top_logprobs: 3 }],
  ['seed', { seed: 42 }],
]

for (const [field, patch] of unsupportedChat) {
  for (const stream of [false, true]) {
    test('local63 unsupported chat guarantee rejected before provider/account effect: ' +
      field + ' stream=' + stream, async () => {
      const f = await createFixture()
      try {
        const response = await f.post({ ...patch, stream })
        assert.equal(response.status, 400, response.raw)
        assert.equal(response.json?.error?.type, 'invalid_request_error')
        assert.equal(response.json?.error?.param, field)
        assert.equal(response.json?.error?.code, 'unsupported_completion_parameter')
        assert.equal(response.raw.includes('data: [DONE]'), false)
        assert.equal(f.observed.forwarded.length, 0)
        assert.equal(f.observed.settled, 0)
        assert.equal(f.observed.statistics.length, 0)
        assert.equal(f.observed.success, 0)
      } finally { await f.close() }
    })
  }
}

// Legacy conversion always returns logprobs:null and only one sampled choice.
// It also never applies an infill suffix. Silent HTTP 200 would misrepresent
// what the user asked the API to produce.
const unsupportedLegacy = [
  ['best_of', { best_of: 2 }],
  ['logprobs', { logprobs: 2 }],
  ['suffix', { suffix: 'offline-suffix' }],
]
for (const [field, patch] of unsupportedLegacy) {
  for (const stream of [false, true]) {
    test('local63 unsupported legacy guarantee rejected before provider/account effect: ' +
      field + ' stream=' + stream, async () => {
      const f = await createFixture()
      try {
        const response = await f.post({ ...patch, stream }, {}, 'offline-secret-not-for-network',
          '/v1/completions')
        assert.equal(response.status, 400, response.raw)
        assert.equal(response.json?.error?.type, 'invalid_request_error')
        assert.equal(response.json?.error?.param, field)
        assert.equal(response.json?.error?.code, 'unsupported_completion_parameter')
        assert.equal(response.raw.includes('data: [DONE]'), false)
        assert.equal(f.observed.forwarded.length, 0)
        assert.equal(f.observed.settled, 0)
        assert.equal(f.observed.statistics.length, 0)
      } finally { await f.close() }
    })
  }
}

for (const route of ['/v1/chat/completions', '/v1/completions']) {
  for (const stream of [false, true]) {
    test('local63 custom-provider valid sampling request commits once: ' +
      route + ' stream=' + stream, async () => {
      // A generic provider forwards these sampling options; the six consumer
      // adapters do not. Keep the original success/settlement assertion on the
      // actual generic-provider contract rather than asserting false web
      // capabilities. Local74 independently rejects unsupported web options.
      const f = await createFixture({ providerId: 'synthetic-custom' })
      try {
        const response = await f.post({ stream, max_tokens: 32, temperature: 0.5 }, {},
          'offline-secret-not-for-network', route)
        assert.equal(response.status, 200, response.raw)
        if (stream) assert.match(response.raw, /data: \[DONE\]/)
        assert.equal(f.observed.forwarded.length, 1)
        assert.equal(f.observed.settled, 1)
        assert.deepEqual(f.observed.statistics, [true])
      } finally { await f.close() }
    })
  }
  test('local63 invalid token rejects before provider effects: ' + route, async () => {
    const f = await createFixture()
    try {
      const response = await f.post({ stream: false }, {}, 'invalid-key', route)
      assert.equal(response.status, 401, response.raw)
      assert.equal(f.observed.forwarded.length, 0)
      assert.equal(f.observed.settled, 0)
    } finally { await f.close() }
  })
}

for (const [route, patch] of [
  ['/v1/chat/completions', { logprobs: false }],
  ['/v1/chat/completions', { response_format: { type: 'text' } }],
  ['/v1/completions', { best_of: 1 }],
  ['/v1/completions', { suffix: null }],
]) {
  test('local63 harmless explicit default does not disable ordinary success: ' +
    route + ' ' + JSON.stringify(patch), async () => {
    const f = await createFixture()
    try {
      const response = await f.post(patch, {}, 'offline-secret-not-for-network', route)
      assert.equal(response.status, 200, response.raw)
      assert.equal(f.observed.forwarded.length, 1)
      assert.equal(f.observed.settled, 1)
    } finally { await f.close() }
  })
}
