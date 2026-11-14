import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real Koa server, koa-bodyparser, API key middleware and chat route.
// Synthetic in-memory store, account and forwarding transport only.
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
const declared = [{
  type: 'function',
  function: { name: 'local_lookup', description: 'Only an in-memory fixture',
    parameters: { type: 'object', properties: { query: { type: 'string' } } } },
}]

async function fixture() {
  const events = { sends: [], accountSettlements: 0, success: 0, failure: 0, stats: [] }
  const account = { id: 'synthetic-account', providerId: 'qwen', name: 'in-memory', status: 'active' }
  const provider = { id: 'qwen', name: 'Synthetic', enabled: true }
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
  const chat = product('routes/chat.ts', {
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
      return { success: true, status: 200, body: completedReply }
    } } },
    '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('Unexpected stream in fixture')
    } } },
    '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }).default
  const proxyServer = product('server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'offline-local43' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat], './routes/management': [],
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
  function post(patch = {}, key = 'only-in-memory-bearer', extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const chunks = []
      const request = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
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
      request.end(JSON.stringify({ ...base, ...patch }))
    })
  }
  return { events, post, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

// Headers are an optional legacy/SDK feature interface. A body field owns
// the final value when provided; when absent, an invalid untrusted header
// must be rejected before account selection, provider effect, or settlement.
for (const invalid of ['ultra', 'none', 'false', 'unsupported-effort']) {
  test('local58 authenticated chat rejects invalid X-Reasoning-Effort header ' + invalid +
    ' before any upstream dispatch', async t => {
    const f = await fixture()
    t.after(f.close)
    const response = await f.post({}, 'only-in-memory-bearer', {
      'X-Reasoning-Effort': invalid,
    })
    assert.equal(response.status, 400, response.raw)
    assert.equal(response.json?.error?.type, 'invalid_request_error')
    assert.equal(response.json?.error?.param, 'reasoning_effort')
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountSettlements, 0)
    assert.equal(f.events.success, 0)
    assert.equal(f.events.stats.length, 0)
  })
}

test('local58 valid X-Reasoning-Effort high reaches exactly one original provider wire request', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({}, 'only-in-memory-bearer', { 'X-Reasoning-Effort': 'high' })
  assert.equal(response.status, 200, response.raw)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].reasoning_effort, 'high')
  assert.equal(f.events.accountSettlements, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('local58 body reasoning_effort false dominates contradictory header without changing safe opt-out', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({ reasoning_effort: false, web_search: false },
    'only-in-memory-bearer', { 'X-Reasoning-Effort': 'ultra', 'X-Web-Search': 'true' })
  assert.equal(response.status, 200, response.raw)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].reasoning_effort, false)
  assert.equal(f.events.sends[0].web_search, false)
  assert.equal(f.events.accountSettlements, 1)
})

test('local58 supported camelCase reasoningEffort false also dominates invalid fallback header', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({ reasoningEffort: false },
    'only-in-memory-bearer', { 'X-Reasoning-Effort': 'unsupported-effort' })
  assert.equal(response.status, 200, response.raw)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].reasoning_effort, false)
  assert.equal(f.events.sends[0].reasoningEffort, undefined)
  assert.equal(f.events.accountSettlements, 1)
})

test('local58 explicit body high has priority over a valid lower reasoning header', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({ reasoning_effort: 'high' },
    'only-in-memory-bearer', { 'X-Reasoning-Effort': 'low' })
  assert.equal(response.status, 200, response.raw)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].reasoning_effort, 'high')
})

test('local58 invalid-header unauthorized client still fails auth before provider effects', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({}, 'incorrect-private-key', {
    'X-Reasoning-Effort': 'ultra',
  })
  assert.equal(response.status, 401)
  assert.equal(f.events.sends.length, 0)
  assert.equal(f.events.accountSettlements, 0)
})
