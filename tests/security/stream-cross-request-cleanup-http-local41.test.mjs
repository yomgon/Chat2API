import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual StreamHandler/SSEParser, chat+legacy route, terminal gate, Koa,
// koa-bodyparser and local API key authentication. Upstream streams and every
// account/storage/credential are synthetic. Ephemeral 127.0.0.1 port only.
const requireNode = createRequire(import.meta.url)
const source = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
function load(path, mocks = {}) {
  const js = ts.transpileModule(source(path), {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  runInNewContext(js, {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw new Error('Unapproved product dependency: ' + name)
      return requireNode(name)
    },
    Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const sseData = text => 'data: ' + JSON.stringify({
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
})
const sseFinish = 'data: ' + JSON.stringify({
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
})
const finish = '\n\n' + sseFinish + '\n\n'

async function fixture() {
  const events = { sends: [], settled: [], stats: [], success: 0, failures: 0, status: 0 }
  const streams = new Map()
  const provider = { id: 'qwen', name: 'Closed Synthetic Provider', enabled: true }
  const account = { id: 'synthetic-id', providerId: 'qwen', name: 'Synthetic Account', status: 'active' }
  const config = {
    enableApiKey: true,
    apiKeys: [{ id: 'fixture-key', key: 'synthetic-only-bearer', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false },
    loadBalanceStrategy: 'round-robin',
  }
  const storeManager = {
    getConfig: () => config, updateConfig() {},
    addLog() {}, addRequestLog: () => ({ id: 'fixture-local' }),
    updateRequestLog() { return true },
    recordAccountSuccess(accountId, providerId) {
      assert.equal(accountId, account.id)
      assert.equal(providerId, provider.id)
      events.settled.push(accountId)
      return true
    },
    recordRequestInStats: accepted => events.stats.push(accepted),
  }
  const proxyStatusManager = {
    recordRequestStart() { events.status++ },
    recordRequestSuccess() { events.success++ },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const requestForwarder = {
    async forwardChatCompletion(request) {
      const label = request.messages[0].content
      assert.equal(typeof label, 'string')
      assert.equal(streams.has(label), false, 'No retries or duplicate provider effects')
      const raw = new PassThrough()
      streams.set(label, raw)
      events.sends.push(label)
      return { success: true, status: 200, stream: raw, skipTransform: false }
    },
  }
  const streamHandler = load('stream.ts', {
    './utils/toolParser/index': {
      // No tool calls occur in these tests; the actual StreamHandler parser,
      // JSON/SSE conversion and terminal checks execute unchanged.
      parseToolCalls: value => ({ content: value, toolCalls: [] }),
    },
  }).streamHandler
  const gate = load('streamTerminalGate.ts', {})
  const legacy = load('legacyCompletion.ts', {})
  const dependencies = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-wire' }),
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../status': { proxyStatusManager },
    '../stream': { streamHandler },
    '../streamTerminalGate': gate,
    '../legacyCompletion': legacy,
    '../../store/store': { storeManager },
  }
  const chat = load('routes/chat.ts', {
    ...dependencies,
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw Error('Unsupported in test') },
      transformChunkToAnthropic: () => { throw Error('Unsupported in test') },
    },
  }).default
  const legacyRouter = load('routes/completions.ts', dependencies).default
  const localSecurity = load('localSecurity.ts', {})
  const proxyServer = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local41-synthetic' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat, legacyRouter], './routes/management': [],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': localSecurity,
  }).proxyServer
  const listener = createServer(proxyServer.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxyServer.port = port

  function send(label, route = 'chat', { abortOnData = false } = {}) {
    const isChat = route === 'chat'
    const path = isChat ? '/v1/chat/completions' : '/v1/completions'
    const body = isChat
      ? { model: 'synthetic-model', messages: [{ role: 'user', content: label }], stream: true }
      : { model: 'synthetic-model', prompt: label, stream: true }
    return new Promise((resolve, reject) => {
      const chunks = []
      let resolved = false
      const req = httpRequest({
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: {
          Host: '127.0.0.1:' + port,
          Authorization: 'Bearer synthetic-only-bearer',
          'Content-Type': 'application/json',
        },
      }, response => {
        const settle = aborted => {
          if (resolved) return
          resolved = true
          resolve({ status: response.statusCode, aborted,
            raw: Buffer.concat(chunks).toString('utf8') })
        }
        response.on('data', chunk => {
          chunks.push(chunk)
          if (abortOnData) {
            response.destroy()
            settle(true)
          }
        })
        response.on('end', () => settle(false))
        response.on('aborted', () => settle(true))
        response.on('error', () => settle(true))
      })
      req.on('error', reject)
      req.setTimeout(4000, () => req.destroy(new Error('Isolated loopback timeout')))
      req.end(JSON.stringify(body))
    })
  }

  async function getRaw(label) {
    for (let i = 0; i < 100 && !streams.has(label); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(streams.has(label), 'Exactly one synthetic provider stream for ' + label)
    return streams.get(label)
  }
  return {
    events, send, getRaw,
    async close() {
      for (const raw of streams.values()) if (!raw.destroyed) raw.destroy()
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(e => e ? reject(e) : resolve()))
    },
  }
}

test('concurrent actual Koa normalized chat streams cannot merge per-request SSE frame buffers', async t => {
  const f = await fixture(); t.after(f.close)
  const reqA = f.send('REQUEST_A')
  const reqB = f.send('REQUEST_B')
  const rawA = await f.getRaw('REQUEST_A')
  const rawB = await f.getRaw('REQUEST_B')

  // A complete line without its blank-line delimiter is a legal incomplete
  // SSE event. B legitimately starts with empty lines, then its own event.
  // The two transports never contain each other's answer bytes.
  rawA.write(sseData('PRIVATE_ONLY_FOR_REQUEST_A'))
  rawB.end('\n\n' + sseData('PUBLIC_ONLY_FOR_REQUEST_B') + finish + 'data: [DONE]\n\n')
  const b = await reqB
  rawA.end(finish + 'data: [DONE]\n\n')
  const a = await reqA

  assert.equal(a.aborted, false)
  assert.equal(b.aborted, false)
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.match(a.raw, /PRIVATE_ONLY_FOR_REQUEST_A/)
  assert.doesNotMatch(a.raw, /PUBLIC_ONLY_FOR_REQUEST_B/)
  assert.match(b.raw, /PUBLIC_ONLY_FOR_REQUEST_B/)
  assert.doesNotMatch(b.raw, /PRIVATE_ONLY_FOR_REQUEST_A/, 'No cross-client answer disclosure')
  for (const response of [a, b]) {
    assert.equal((response.raw.match(/data: \[DONE\]/g) || []).length, 1)
  }
  assert.equal(f.events.sends.length, 2, 'No retry or fallback')
  assert.equal(f.events.settled.length, 2)
  assert.equal(f.events.success, 2)
  assert.deepEqual(f.events.stats.sort(), [true, true])
})

for (const route of ['chat', 'legacy']) {
  test(`actual Koa ${route} canceled normalized consumer closes the raw upstream reader without accounting success`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'CANCELED_' + route
    const aborting = f.send(label, route, { abortOnData: true })
    const raw = await f.getRaw(label)
    raw.write(sseData('partial consumer data') + '\n\n')
    const response = await aborting
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(response.aborted, true)
    assert.equal(raw.destroyed, true, 'HTTP abort must cancel the raw provider reader')
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 0)
    assert.equal(f.events.success, 0)
    assert.equal(f.events.failures, 1)
    assert.deepEqual(f.events.stats, [false])
  })

  test(`actual Koa ${route} normalizer reconstructs split multibyte UTF-8 without replacing Korean/emoji text`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'UTF8_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    const expected = '한글 😀'
    const bytes = Buffer.from(sseData(expected) + finish + 'data: [DONE]\n\n')
    const marker = bytes.indexOf(Buffer.from('한'))
    assert.ok(marker > 0)
    raw.write(bytes.subarray(0, marker + 1))
    raw.end(bytes.subarray(marker + 1))
    const result = await pending
    assert.equal(result.aborted, false)
    assert.equal(result.status, 200)
    assert.ok(result.raw.includes(expected), 'No Unicode replacement or answer corruption')
    assert.doesNotMatch(result.raw, /provider_stream_incomplete|\uFFFD/)
    assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal(f.events.settled.length, 1)
    assert.deepEqual(f.events.stats, [true])
  })

  test(`actual Koa ${route} normalizer rejects malformed original UTF-8 before publishing terminal or account success`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'INVALID_UTF8_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    const prefix = Buffer.from('data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"')
    const suffix = Buffer.from('"},"finish_reason":null}]}\n\n' + sseFinish + '\n\ndata: [DONE]\n\n')
    raw.end(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]))
    const result = await pending
    assert.equal(result.aborted, false)
    assert.match(result.raw, /provider_stream_incomplete/)
    assert.doesNotMatch(result.raw, /data: \[DONE\]/)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 0)
    assert.equal(f.events.success, 0)
    assert.deepEqual(f.events.stats, [false])
  })

  test(`actual Koa ${route} SSE parser retains an event when the blank delimiter arrives in another chunk`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'LINE_SPLIT_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    const expected = 'ANSWER_AFTER_SPLIT_' + route
    raw.write(sseData(expected) + '\n')
    await new Promise(resolve => setImmediate(resolve))
    raw.end('\n' + sseFinish + '\n\ndata: [DONE]\n\n')
    const result = await pending
    assert.equal(result.aborted, false)
    assert.equal(result.status, 200)
    assert.match(result.raw, new RegExp(expected))
    assert.doesNotMatch(result.raw, /provider_stream_incomplete/)
    assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 1)
    assert.deepEqual(f.events.stats, [true])
  })

  test(`actual Koa ${route} SSE parser accepts standards-compliant CRLF event delimiters`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'CRLF_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    const expected = 'ANSWER_CRLF_' + route
    raw.end(sseData(expected) + '\r\n\r\n' + sseFinish + '\r\n\r\n' + 'data: [DONE]\r\n\r\n')
    const result = await pending
    assert.equal(result.aborted, false)
    assert.equal(result.status, 200)
    assert.match(result.raw, new RegExp(expected))
    assert.doesNotMatch(result.raw, /provider_stream_incomplete/)
    assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 1)
    assert.deepEqual(f.events.stats, [true])
  })

  test(`actual Koa ${route} normalizer forwards one genuine upstream [DONE] before local settlement`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'PROVEN_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    raw.end(sseData('verified upstream done') + finish + 'data: [DONE]\n\n')
    const result = await pending
    assert.equal(result.aborted, false)
    assert.equal(result.status, 200)
    assert.match(result.raw, /verified upstream done/)
    assert.doesNotMatch(result.raw, /provider_stream_incomplete/)
    assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 1)
    assert.equal(f.events.success, 1)
    assert.deepEqual(f.events.stats, [true])
  })

  test(`actual Koa ${route} normalizer cannot invent [DONE] when raw stream ends without it`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'NO_DONE_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    raw.end(sseData('incomplete without terminal') + finish)
    const result = await pending
    assert.equal(result.aborted, false)
    assert.match(result.raw, /provider_stream_incomplete/)
    assert.doesNotMatch(result.raw, /data: \[DONE\]/)
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 0)
    assert.equal(f.events.success, 0)
    assert.equal(f.events.failures, 1)
    assert.deepEqual(f.events.stats, [false])
  })

  test(`actual Koa ${route} normalized malformed upstream closes original raw transport and settles failure once`, async t => {
    const f = await fixture(); t.after(f.close)
    const label = 'FAILED_' + route
    const pending = f.send(label, route)
    const raw = await f.getRaw(label)
    // The transform passes invalid JSON as a candidate SSE frame. The gate
    // refuses it. Its close must also cancel the original provider reader.
    raw.write('data: {INVALID_SYNTHETIC_JSON}\n\n')
    const result = await pending
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(result.aborted, false)
    assert.match(result.raw, /provider_stream_incomplete/)
    assert.doesNotMatch(result.raw, /data: \[DONE\]/)
    assert.equal(raw.destroyed, true, 'A failed normalized stream must close its raw transport')
    assert.equal(f.events.sends.length, 1)
    assert.equal(f.events.settled.length, 0)
    assert.equal(f.events.success, 0)
    assert.equal(f.events.failures, 1)
    assert.deepEqual(f.events.stats, [false])
  })
}
