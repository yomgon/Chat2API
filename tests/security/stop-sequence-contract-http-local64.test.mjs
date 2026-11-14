import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// local64 isolated authenticated Koa HTTP. Consumer-web adapters do not accept
// the public OpenAI stop field; a valid request must not publish untrimmed text.
// Closed synthetic provider/credentials/accounts; no remote effect or cleanup.
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

const privateTail = 'PRIVATE_CANARY_AFTER_STOP_🚫'
const defaultText = '서두😃<END>' + privateTail
function buildSse(parts, incomplete = false) {
  const frames = parts.map(content => 'data: ' + JSON.stringify({
    object: 'chat.completion.chunk', id: 'offline-sse',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  }))
  if (!incomplete) frames.push('data: ' + JSON.stringify({
    object: 'chat.completion.chunk', id: 'offline-sse',
    choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
  }))
  frames.push('data: [DONE]')
  return frames.join('\n\n') + '\n\n'
}

async function createFixture({
  text = defaultText,
  parts = ['서두😃<EN', 'D>' + privateTail],
  byteSplit = false,
  incomplete = false,
  refuseSettlement = false,
  rawSse = undefined,
} = {}) {
  const observed = { forwarded: [], settled: 0, success: 0, failure: 0, statistics: [] }
  const account = { id: 'local-only-account', providerId: 'qwen', name: 'closed', status: 'active' }
  const provider = { id: 'qwen', name: 'Synthetic Qwen', enabled: true }
  const storeManager = {
    getConfig: () => ({ enableApiKey: true,
      apiKeys: [{ id: 'local-only-api-key', enabled: true, usageCount: 0, key: 'offline-secret-not-for-network' }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin' }),
    updateConfig() {},
    recordAccountSuccess() {
      if (refuseSettlement) throw new Error('Private storage refusal must not leak')
      observed.settled++; return true
    },
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
        const bytes = Buffer.from(rawSse ?? buildSse(parts, incomplete), 'utf8')
        setImmediate(() => {
          if (byteSplit) for (let i = 0; i < bytes.length; i++) input.write(bytes.subarray(i, i + 1))
          else input.write(bytes)
          input.end()
        })
        return { success: true, status: 200, skipTransform: true, stream: input }
      }
      return { success: true, status: 200, body: {
        id: 'offline-answer', object: 'chat.completion', model: 'offline-wire', created: 1,
        choices: [{ index: 0, finish_reason: 'length',
          message: { role: 'assistant', content: text } }],
      } }
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
    electron: { app: { getVersion: () => 'offline-local64' } },
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

// All asserted input and output bytes are synthetic and stay on 127.0.0.1:0.
// A website adapter returning a completed model answer without understanding
// stop must be normalized locally before account charge and downstream DONE.
const routes = ['/v1/chat/completions', '/v1/completions']
const completeText = defaultText

function visibleText(response, legacy) {
  if (response.json) {
    const choice = response.json.choices?.[0]
    return { content: legacy ? choice?.text : choice?.message?.content, finish: choice?.finish_reason }
  }
  let content = ''
  let finish = null
  for (const line of response.raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6)
    if (data === '[DONE]') continue
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }
    const choice = parsed.choices?.[0]
    if (!choice) continue
    content += legacy ? (choice.text ?? '') : (choice.delta?.content ?? '')
    if (choice.finish_reason != null) finish = choice.finish_reason
  }
  return { content, finish }
}

for (const route of routes) {
  const legacy = route === '/v1/completions'
  for (const stream of [false, true]) {
    test('local64 stop cuts provider text without exposing suffix: route=' + route + ' stream=' + stream,
      async () => {
      const f = await createFixture({ byteSplit: stream })
      try {
        const response = await f.post({ stop: '<END>', stream }, {}, 'offline-secret-not-for-network', route)
        assert.equal(response.status, 200, response.raw)
        const result = visibleText(response, legacy)
        assert.equal(result.content, '서두😃')
        assert.equal(result.finish, 'stop')
        assert.equal(response.raw.includes(privateTail), false)
        if (stream) assert.ok(response.raw.includes('data: [DONE]'), response.raw)
        assert.equal(f.observed.forwarded.length, 1)
        assert.equal(f.observed.forwarded[0].stop, '<END>')
        assert.equal(f.observed.settled, 1)
        assert.deepEqual(f.observed.statistics, [true])
      } finally { await f.close() }
    })
  }

  for (const stream of [false, true]) {
    test('local64 multiple stops choose earliest UTF-8 codepoint match: route=' + route +
      ' stream=' + stream, async () => {
      const f = await createFixture({ byteSplit: stream })
      try {
        const response = await f.post({ stop: ['not-present', '<END>', '😃'], stream }, {},
          'offline-secret-not-for-network', route)
        assert.equal(response.status, 200, response.raw)
        assert.equal(visibleText(response, legacy).content, '서두')
        assert.equal(response.raw.includes(privateTail), false)
        assert.equal(f.observed.settled, 1)
      } finally { await f.close() }
    })
  }

  for (const stream of [false, true]) {
    test('local64 absent stop does not alter provider content or finish: route=' + route +
      ' stream=' + stream, async () => {
      const f = await createFixture({ byteSplit: stream })
      try {
        const response = await f.post({ stream }, {}, 'offline-secret-not-for-network', route)
        assert.equal(response.status, 200, response.raw)
        assert.equal(visibleText(response, legacy).content, completeText)
        assert.equal(visibleText(response, legacy).finish, 'length')
        if (stream) assert.ok(response.raw.includes('data: [DONE]'), response.raw)
        assert.equal(f.observed.settled, 1)
      } finally { await f.close() }
    })
  }

  for (const stream of [false, true]) {
    test('local64 stop at beginning can return empty completed answer: route=' + route +
      ' stream=' + stream, async () => {
      const f = await createFixture({ byteSplit: stream })
      try {
        const response = await f.post({ stop: '서두', stream }, {}, 'offline-secret-not-for-network', route)
        assert.equal(response.status, 200, response.raw)
        assert.equal(visibleText(response, legacy).content, '')
        assert.equal(visibleText(response, legacy).finish, 'stop')
        if (stream) assert.ok(response.raw.includes('data: [DONE]'), response.raw)
        assert.equal(f.observed.settled, 1)
        assert.equal(response.raw.includes(privateTail), false)
      } finally { await f.close() }
    })
  }

  for (const stop of ['', ['safe', ''], [''], [1]]) {
    test('local64 invalid or empty stop never dispatches or charges: route=' + route +
      ' stop=' + JSON.stringify(stop), async () => {
      const f = await createFixture()
      try {
        const response = await f.post({ stop, stream: true }, {}, 'offline-secret-not-for-network', route)
        assert.equal(response.status, 400, response.raw)
        assert.equal(response.json?.error?.type, 'invalid_request_error')
        assert.equal(response.json?.error?.param, 'stop')
        assert.equal(f.observed.forwarded.length, 0)
        assert.equal(f.observed.settled, 0)
        assert.deepEqual(f.observed.statistics, [])
        assert.equal(response.raw.includes('data: [DONE]'), false)
      } finally { await f.close() }
    })
  }

  test('local64 incomplete upstream never sends DONE or accounts success with stop: route=' + route,
    async () => {
    const f = await createFixture({ incomplete: true, byteSplit: true })
    try {
      const response = await f.post({ stop: '<END>', stream: true }, {},
        'offline-secret-not-for-network', route)
      assert.equal(response.raw.includes('data: [DONE]'), false)
      assert.equal(f.observed.settled, 0)
      assert.equal(f.observed.success, 0)
      assert.deepEqual(f.observed.statistics, [false])
    } finally { await f.close() }
  })

  test('local64 account durable write refusal never sends DONE after valid stop: route=' + route,
    async () => {
    const f = await createFixture({ refuseSettlement: true, byteSplit: true })
    try {
      const response = await f.post({ stop: '<END>', stream: true }, {},
        'offline-secret-not-for-network', route)
      assert.equal(response.raw.includes('data: [DONE]'), false)
      assert.equal(response.raw.includes('Private storage refusal'), false)
      assert.equal(f.observed.settled, 0)
      assert.equal(f.observed.success, 0)
      assert.deepEqual(f.observed.statistics, [false])
    } finally { await f.close() }
  })

  test('local64 unauthenticated stop request cannot send provider operation: route=' + route,
    async () => {
    const f = await createFixture()
    try {
      const response = await f.post({ stop: '<END>' }, {}, 'invalid-token', route)
      assert.equal(response.status, 401, response.raw)
      assert.equal(f.observed.forwarded.length, 0)
      assert.equal(f.observed.settled, 0)
    } finally { await f.close() }
  })
}

// A stop transformer is not an upstream protocol sanitizer. Invalid SSE
// events, assistant roles and terminal reasons must still reach the existing
// strict gate and fail, even if their content contains a requested stop.
const rawChoice = (role, content, finish = null) => 'data: ' + JSON.stringify({
  id: 'offline-sse', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { role, content }, finish_reason: finish }],
}) + '\n\n'
const rawFinish = reason => 'data: ' + JSON.stringify({
  id: 'offline-sse', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
}) + '\n\n'
const rawDone = 'data: [DONE]\n\n'
const badRawStreams = [
  ['invalid event name',
    'event: private\n' + rawChoice('assistant', '<END>' + privateTail) +
    rawFinish('stop') + rawDone],
  ['unknown SSE field',
    'unknown: private\n' + rawChoice('assistant', '<END>' + privateTail) +
    rawFinish('stop') + rawDone],
  ['invalid assistant role',
    rawChoice('user', '<END>' + privateTail) + rawFinish('stop') + rawDone],
  ['invalid finish reason',
    rawChoice('assistant', '<END>' + privateTail) + rawFinish('fabricated') + rawDone],
  ['undeclared tool finish',
    rawChoice('assistant', '<END>' + privateTail) + rawFinish('tool_calls') + rawDone],
]
for (const route of routes) {
  for (const [label, rawSse] of badRawStreams) {
    test('local64 malformed source must remain unconfirmed after stop: ' +
      route + ' ' + label, async () => {
      const f = await createFixture({ rawSse, byteSplit: true })
      try {
        const response = await f.post({ stop: '<END>', stream: true }, {},
          'offline-secret-not-for-network', route)
        assert.equal(response.raw.includes('data: [DONE]'), false,
          'Stop matching cannot launder an invalid upstream terminal')
        assert.equal(response.raw.includes(privateTail), false)
        assert.equal(f.observed.settled, 0)
        assert.equal(f.observed.success, 0)
        assert.deepEqual(f.observed.statistics, [false])
      } finally { await f.close() }
    })
  }
}
