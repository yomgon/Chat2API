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
  function post(patch = {}, key = 'only-in-memory-bearer') {
    return new Promise((resolve, reject) => {
      const chunks = []
      const request = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json' },
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

const unsupported = [
  { field: 'tools', payload: { tools: { type: 'function', function: { name: 'not_an_array' } } } },
  { field: 'tools', payload: { tools: [null] } },
  { field: 'tools', payload: { tools: [{ type: 'function', function: { name: 123 } }] } },
  { field: 'tools', payload: { tools: [{ type: 'extension', function: { name: 'unexpected' } }] } },
  { field: 'tool_choice', payload: { tools: declared, tool_choice: 'invalid-choice' } },
  { field: 'tool_choice', payload: { tools: declared,
    tool_choice: { type: 'function', function: { name: 234 } } } },
  { field: 'tool_choice', payload: { tool_choice: 'required' } },
  { field: 'tool_choice', payload: { tools: declared,
    tool_choice: { type: 'function', function: { name: 'not_declared' } } } },
  { field: 'tool_format', payload: { tool_format: 'unsupported-format' } },
  { field: 'tool_format', payload: { tool_format: true } },
  { field: 'web_search', payload: { web_search: 'false' } },
  { field: 'web_search', payload: { web_search: 1 } },
  { field: 'deep_research', payload: { deep_research: 'false' } },
  { field: 'reasoning_effort', payload: { reasoning_effort: { mode: 'high' } } },
  { field: 'reasoning_effort', payload: { reasoning_effort: 'unsupported-effort' } },
  { field: 'reasoningEffort', payload: { reasoningEffort: ['high'] } },
]

for (const { field, payload } of unsupported) {
  test(`actual authenticated Koa refuses invalid ${field} before synthetic provider effect: ${JSON.stringify(payload)}`, async t => {
    const f = await fixture()
    t.after(f.close)
    const response = await f.post(payload)
    assert.equal(response.status, 400)
    assert.equal(response.json?.error?.type, 'invalid_request_error')
    assert.equal(response.json?.error?.param, field)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.accountSettlements, 0)
    assert.equal(f.events.success, 0)
    assert.equal(f.events.stats.length, 0)
  })
}

test('real Koa keeps valid declared function and tool_choice none through one authorized synthetic forward', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({ tools: declared, tool_choice: 'none', tool_format: 'auto' })
  assert.equal(response.status, 200)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].tools[0].function.name, 'local_lookup')
  assert.equal(f.events.sends[0].tool_choice, 'none')
  assert.equal(f.events.accountSettlements, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('real Koa preserves supported explicit false feature opt-outs in the single synthetic upstream request', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({
    web_search: false,
    deep_research: false,
    reasoning_effort: false,
    reasoningEffort: 'high',
  })
  assert.equal(response.status, 200)
  assert.equal(f.events.sends.length, 1)
  assert.equal(f.events.sends[0].web_search, false)
  assert.equal(f.events.sends[0].deep_research, false)
  assert.equal(f.events.sends[0].reasoning_effort, false)
  assert.equal(f.events.sends[0].reasoningEffort, undefined)
  assert.equal(f.events.accountSettlements, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('actual Koa API key gate rejects unauthorized tool request before any synthetic effect', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.post({ tools: declared }, 'incorrect-private-key')
  assert.equal(response.status, 401)
  assert.equal(f.events.sends.length, 0)
  assert.equal(f.events.accountSettlements, 0)
})
