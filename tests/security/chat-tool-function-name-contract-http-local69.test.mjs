import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual authenticated ProxyServer + bodyparser + chat route + SSE terminal
// gate, with six independently pinned synthetic account/provider identities.
// The closed forwarder models an already-decoded consumer answer, including a
// hallucinated/undeclared tool name, never a real provider network operation.
const requireNode = createRequire(import.meta.url)
const PRIVATE = 'OFFLINE_LOCAL69_NAME_POLICY_CANARY'
const PROVIDERS = ['deepseek', 'qwen', 'glm', 'zai', 'qwen-ai', 'kimi']
const TOOLS = [
  { type: 'function', function: { name: 'local_lookup', description: 'Synthetic only',
    parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
  { type: 'function', function: { name: 'secondary_lookup', description: 'Synthetic only',
    parameters: { type: 'object', properties: { key: { type: 'string' } } } } },
]
const call = name => ({
  id: 'offline-call-' + name, type: 'function',
  function: { name, arguments: JSON.stringify({ query: PRIVATE }) },
})
const event = item => 'data: ' + JSON.stringify(item) + '\n\n'
function makeReply(kind, toolName) {
  if (kind === 'plain') return {
    id: 'offline-answer', object: 'chat.completion', model: 'synthetic-wire', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Ordinary synthetic answer' },
      finish_reason: 'stop' }],
  }
  const calls = kind === 'duplicate' || kind === 'unique'
    ? [call('local_lookup'), call('secondary_lookup')] : [call(toolName)]
  if (kind === 'duplicate') calls[1].id = calls[0].id
  return {
    id: 'offline-tool-answer', object: 'chat.completion', model: 'synthetic-wire', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls },
      finish_reason: 'tool_calls' }],
  }
}
function makeSse(kind, toolName) {
  if (kind === 'plain') return [
    event({ object: 'chat.completion.chunk', id: 'offline-sse', choices: [{
      index: 0, delta: { role: 'assistant', content: 'Ordinary synthetic answer' }, finish_reason: null,
    }] }),
    event({ object: 'chat.completion.chunk', id: 'offline-sse', choices: [{
      index: 0, delta: {}, finish_reason: 'stop',
    }] }),
    'data: [DONE]\n\n',
  ].join('')
  const calls = kind === 'duplicate' || kind === 'unique'
    ? [call('local_lookup'), call('secondary_lookup')] : [call(toolName)]
  if (kind === 'duplicate') calls[1].id = calls[0].id
  return [
    event({ object: 'chat.completion.chunk', id: 'offline-sse', choices: [{
      index: 0, delta: { role: 'assistant', tool_calls: calls.map((item, index) => ({
        index, id: item.id, type: item.type, function: item.function,
      })) }, finish_reason: null,
    }] }),
    event({ object: 'chat.completion.chunk', id: 'offline-sse', choices: [{
      index: 0, delta: {}, finish_reason: 'tool_calls',
    }] }),
    'data: [DONE]\n\n',
  ].join('')
}
function product(relative, mocked = {}) {
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    } },
  ).outputText
  const module = { exports: {} }
  runInNewContext(js, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocked, name)) return mocked[name]
      if (name.startsWith('.')) throw new Error('Unexpected product import: ' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture(providerId, {
  replyKind = 'tool', toolName = 'unlisted_exfiltration_tool',
  settlementRefused = false, loggerRefused = false, streamBroken = false,
} = {}) {
  const events = { sends: [], account: 0, success: 0, failure: 0, stats: [],
    logWrites: 0, selectedWireIds: [] }
  const account = { id: 'synthetic-' + providerId + '-account', providerId, name: 'offline',
    status: 'active', credentials: { token: 'LOCAL_PRIVATE_CREDENTIAL' } }
  const provider = { id: providerId, name: 'Offline ' + providerId, enabled: true,
    type: 'built-in' }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true, apiKeys: [{ id: 'synthetic-api-key-id',
        key: 'offline-valid-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false },
      loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess(id, selectedProviderId) {
      assert.equal(id, account.id)
      assert.equal(selectedProviderId, providerId)
      if (settlementRefused) return false
      events.account++
      return true
    },
    recordRequestInStats(ok) { events.stats.push(ok) },
    addRequestLog() {
      events.logWrites++
      if (loggerRefused) throw Error('PRIVATE_OPTIONAL_LOG_WRITE_REFUSAL')
      return { id: 'offline-log' }
    },
    updateRequestLog() {}, addLog() {},
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { events.success++ },
    recordRequestFailure() { events.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0,
      failedRequests: 0, activeConnections: 0 }),
    getHost: () => '127.0.0.1', getPort: () => 8080,
  }
  const deps = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => {
        events.selectedWireIds.push('synthetic-exact-wire')
        return { account, provider, actualModel: 'synthetic-exact-wire' }
      },
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => providerId, getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: { async forwardChatCompletion(request,
      chosenAccount, chosenProvider, actualModel) {
      assert.equal(chosenAccount, account)
      assert.equal(chosenProvider, provider)
      assert.equal(actualModel, 'synthetic-exact-wire')
      events.sends.push(JSON.parse(JSON.stringify(request)))
      if (request.stream === true) {
        const upstream = new PassThrough()
        setImmediate(() => {
          const wire = makeSse(replyKind, toolName)
          if (streamBroken) upstream.end(wire.slice(0, wire.indexOf('data: [DONE]')))
          else {
            // Split every logical tool call and UTF-8 frame across bytes.
            const bytes = Buffer.from(wire, 'utf8')
            for (let start = 0; start < bytes.length; start += 7) {
              upstream.write(bytes.subarray(start, start + 7))
            }
            upstream.end()
          }
        })
        return { success: true, status: 200, skipTransform: true, stream: upstream }
      }
      return { success: true, status: 200, body: makeReply(replyKind, toolName) }
    } } },
    '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('Unexpected fake stream normalization')
    } } },
    '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }
  const chat = product('routes/chat.ts', deps).default
  const proxyServer = product('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'offline-local69' } },
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
  const send = (patch = {}, key = 'offline-valid-key') => new Promise((resolve, reject) => {
    const chunks = []
    const req = httpRequest({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json' },
    }, res => {
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
    req.setTimeout(3000, () => req.destroy(new Error('Local synthetic HTTP timeout')))
    req.end(JSON.stringify({
      model: 'display-model-pinned-to-' + providerId,
      messages: [{ role: 'user', content: 'Only offline declared tools' }],
      stream: false, ...patch,
    }))
  })
  return { send, events, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

// Function declarations sent through the public OpenAI-compatible endpoint
// require a unique, bounded ASCII function name; accepting control characters,
// whitespace or duplicate names mutates prompt tools and makes result routing
// ambiguous. Reject malformed requests *before* selecting a provider account.
const standard = name => ({ type: 'function', function: {
  name, description: 'Closed synthetic tool', parameters: { type: 'object' },
} })
const invalid = [
  { label: 'newline control in function name', name: 'local_lookup\nINJECTED_ROLE' },
  { label: 'embedded space in function name', name: 'local lookup' },
  { label: 'dot in function name', name: 'local.lookup' },
  { label: 'non-ASCII function name', name: '검색_도구' },
  { label: '65-character function name', name: 'x'.repeat(65) },
  { label: 'leading whitespace in function name', name: ' local_lookup' },
]
for (const providerId of PROVIDERS) {
  for (const stream of [false, true]) {
    for (const bad of invalid) {
      test('local69 ' + providerId + ' stream=' + stream + ': reject ' + bad.label, async () => {
        const f = await fixture(providerId, { replyKind: 'plain' })
        try {
          const r = await f.send({ tools: [standard(bad.name)], tool_choice: 'auto', stream })
          assert.equal(r.status, 400, r.raw)
          assert.equal(r.json?.error?.type, 'invalid_request_error')
          assert.equal(r.json?.error?.param, 'tools')
          assert.equal(r.json?.error?.code, 'invalid_completion_parameter')
          assert.equal(f.events.sends.length, 0, 'No provider effect for invalid tool name')
          assert.equal(f.events.account, 0)
          assert.equal(f.events.success, 0)
          assert.deepEqual(f.events.stats, [])
          assert.equal(r.raw.includes('LOCAL_PRIVATE_CREDENTIAL'), false)
          assert.equal(r.raw.includes(PRIVATE), false)
        } finally { await f.close() }
      })
    }
    test('local69 ' + providerId + ' stream=' + stream + ': duplicate declared names rejected', async () => {
      const f = await fixture(providerId, { replyKind: 'plain' })
      try {
        const r = await f.send({ tools: [standard('local_lookup'), standard('local_lookup')],
          tool_choice: 'auto', stream })
        assert.equal(r.status, 400, r.raw)
        assert.equal(r.json?.error?.param, 'tools')
        assert.equal(f.events.sends.length, 0)
        assert.equal(f.events.account, 0)
        assert.deepEqual(f.events.stats, [])
      } finally { await f.close() }
    })
    test('local69 ' + providerId + ' stream=' + stream + ': distinct conforming names remain accepted', async () => {
      const f = await fixture(providerId, { replyKind: 'plain' })
      try {
        const r = await f.send({ tools: [standard('local_lookup'), standard('SECONDARY-TOOL_2')],
          tool_choice: 'auto', stream })
        assert.equal(r.status, 200, r.raw)
        if (stream) assert.equal(r.raw.includes('data: [DONE]'), true)
        assert.equal(f.events.sends.length, 1)
        assert.equal(f.events.account, 1)
        assert.equal(f.events.success, 1)
        assert.deepEqual(f.events.stats, [true])
      } finally { await f.close() }
    })
    test('local69 ' + providerId + ' stream=' + stream + ': exact 64-char legal function name accepted', async () => {
      const f = await fixture(providerId, { replyKind: 'plain' })
      try {
        const r = await f.send({ tools: [standard('x'.repeat(64))], tool_choice: 'auto', stream })
        assert.equal(r.status, 200, r.raw)
        if (stream) assert.equal(r.raw.includes('data: [DONE]'), true)
        assert.equal(f.events.sends.length, 1)
        assert.equal(f.events.account, 1)
      } finally { await f.close() }
    })
  }
}
test('local69 invalid auth never reaches provider even when function names are valid', async () => {
  const f = await fixture('qwen', { replyKind: 'plain' })
  try {
    const r = await f.send({ tools: [standard('local_lookup')], tool_choice: 'auto' }, 'invalid-key')
    assert.equal(r.status, 401)
    assert.equal(f.events.sends.length, 0)
    assert.equal(f.events.account, 0)
  } finally { await f.close() }
})
test('local69 valid response with optional logger failure still preserves committed result', async () => {
  const f = await fixture('glm', { replyKind: 'plain', loggerRefused: true })
  try {
    const r = await f.send({ tools: [standard('local_lookup')], tool_choice: 'auto' })
    assert.equal(r.status, 200, r.raw)
    assert.equal(f.events.account, 1)
    assert.deepEqual(f.events.stats, [true])
    assert.equal(r.raw.includes('PRIVATE_OPTIONAL_LOG_WRITE_REFUSAL'), false)
  } finally { await f.close() }
})
test('local69 valid SSE with refused account settlement never publishes DONE', async () => {
  const f = await fixture('zai', { replyKind: 'plain', settlementRefused: true })
  try {
    const r = await f.send({ tools: [standard('local_lookup')], tool_choice: 'auto', stream: true })
    assert.equal(r.raw.includes('data: [DONE]'), false)
    assert.equal(f.events.account, 0)
    assert.deepEqual(f.events.stats, [false])
  } finally { await f.close() }
})
