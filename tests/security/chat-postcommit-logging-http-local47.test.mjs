import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const SECRET_CANARY = 'LOCAL47_SECRET_CANARY_NEVER_EXPOSE'

function product(path, mocks = {}) {
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8'),
    { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText
  const module = { exports: {} }
  runInNewContext(js, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw Error('Unexpected product import: ' + path + ':' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const completeBody = {
  id: 'synthetic-answer', object: 'chat.completion', created: 1, model: 'wire-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'synthetic complete' } }],
}
const completeSse = [
  'data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'synthetic complete' }, finish_reason: null }] }) + '\n\n',
  'data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
  'data: [DONE]\n\n',
].join('')

async function fixture({ mode = 'ok', stream = false } = {}) {
  const events = { sends: 0, accountCommits: 0, successStatus: 0, failureStatus: 0, stats: [], requestLogs: [], requestUpdates: [], logs: [] }
  const streams = []
  const account = { id: 'a1', providerId: 'p1', name: 'Synthetic Account', status: 'active' }
  const provider = { id: 'p1', name: 'Synthetic Provider', enabled: true }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true,
      apiKeys: [{ id: 'k', key: 'local47-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess() {
      if (mode === 'settlement-refusal') return false
      events.accountCommits++
      return true
    },
    addLog(level, message) {
      events.logs.push([level, message])
      if (mode === 'nonstream-postcommit-log' && level === 'debug' && message === 'Request succeeded') {
        throw new Error(SECRET_CANARY)
      }
      if (mode === 'stream-postcommit-log' && level === 'debug' && message === 'Stream response completed') {
        throw new Error(SECRET_CANARY)
      }
    },
    addRequestLog(entry) {
      events.requestLogs.push(entry.status)
      if (mode === 'nonstream-postcommit-receipt' && entry.status === 'success') throw new Error(SECRET_CANARY)
      return { id: 'log-1' }
    },
    updateRequestLog(id, update) {
      events.requestUpdates.push([id, update.status])
      if (mode === 'stream-postcommit-receipt' && update.status === 'success') throw new Error(SECRET_CANARY)
      return true
    },
    recordRequestInStats(ok) {
      events.stats.push(ok)
      if (mode === 'nonstream-postcommit-stats' && ok === true) throw new Error(SECRET_CANARY)
      if (mode === 'stream-postcommit-stats' && ok === true) throw new Error(SECRET_CANARY)
    },
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { events.successStatus++ },
    recordRequestFailure() { events.failureStatus++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const requestForwarder = { async forwardChatCompletion() {
    events.sends++
    if (!stream) return { success: true, status: 200, body: completeBody }
    const upstream = new PassThrough(); streams.push(upstream)
    return { success: true, status: 200, stream: upstream, skipTransform: true }
  } }
  const chat = product('routes/chat.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: { selectAccount: () => ({ account, provider, actualModel: 'wire-model' }), clearAccountFailure() {}, markAccountFailed() {} } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: { getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id } },
    '../status': { proxyStatusManager }, '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() { throw Error('direct SSE only') } } },
    '../utils/toolFormatConverter': { isAnthropicToolFormat: () => false, transformResponseToAnthropic: x => x, transformChunkToAnthropic: x => x },
    '../../store/store': { storeManager },
  }).default
  const serverProduct = product('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local47' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat], './routes/management': [], './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } }, './localSecurity': product('localSecurity.ts'),
  }).proxyServer
  const listener = createServer(serverProduct.app.callback()); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; serverProduct.port = port
  const post = () => new Promise((resolve, reject) => {
    const chunks = []
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer local47-key', 'Content-Type': 'application/json' } }, res => {
      res.on('data', p => chunks.push(p)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject); req.end(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'synthetic' }], stream }))
  })
  async function getStream() {
    for (let i = 0; i < 100 && streams.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(streams.length, 1)
    return streams[0]
  }
  return { events, post, getStream, close: async () => {
    for (const s of streams) if (!s.destroyed) s.destroy()
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve))
  } }
}

test('positive controls: committed complete nonstream and clean-EOF stream remain successful exactly once', async t => {
  const n = await fixture(); t.after(n.close)
  const nr = await n.post()
  assert.equal(nr.status, 200); assert.match(nr.raw, /synthetic complete/)
  assert.equal(n.events.accountCommits, 1); assert.equal(n.events.successStatus, 1); assert.equal(n.events.failureStatus, 0); assert.deepEqual(n.events.stats, [true])

  const s = await fixture({ stream: true }); t.after(s.close)
  const pending = s.post(); const upstream = await s.getStream(); upstream.end(completeSse)
  const sr = await pending
  assert.equal(sr.status, 200); assert.equal((sr.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(s.events.accountCommits, 1); assert.equal(s.events.successStatus, 1); assert.equal(s.events.failureStatus, 0); assert.deepEqual(s.events.stats, [true])
})

for (const mode of ['nonstream-postcommit-log', 'nonstream-postcommit-receipt', 'nonstream-postcommit-stats']) {
  test(`RED nonstream: ${mode} after committed account success must not turn completed answer into HTTP 500`, async t => {
    const f = await fixture({ mode }); t.after(f.close)
    const r = await f.post()
    assert.equal(f.events.accountCommits, 1)
    assert.equal(r.raw.includes(SECRET_CANARY), false)
    assert.equal(r.status, 200)
    assert.match(r.raw, /synthetic complete/)
    assert.equal(f.events.failureStatus, 0)
  })
}

for (const mode of ['stream-postcommit-receipt', 'stream-postcommit-stats', 'stream-postcommit-log']) {
  test(`RED stream: ${mode} after committed account success must not suppress DONE or relabel success`, async t => {
    const f = await fixture({ mode, stream: true }); t.after(f.close)
    const pending = f.post(); const upstream = await f.getStream(); upstream.end(completeSse)
    const r = await pending
    assert.equal(f.events.accountCommits, 1)
    assert.equal(r.raw.includes(SECRET_CANARY), false)
    assert.equal(r.status, 200)
    assert.equal((r.raw.match(/data: \[DONE\]/g) || []).length, 1)
    assert.doesNotMatch(r.raw, /provider_stream_incomplete/)
    assert.equal(f.events.failureStatus, 0)
  })
}

test('account settlement refusal remains fail-closed and never becomes committed success', async t => {
  const n = await fixture({ mode: 'settlement-refusal' }); t.after(n.close)
  const nr = await n.post()
  assert.equal(n.events.accountCommits, 0); assert.notEqual(nr.status, 200); assert.equal(nr.raw.includes(SECRET_CANARY), false)

  const s = await fixture({ mode: 'settlement-refusal', stream: true }); t.after(s.close)
  const pending = s.post(); const upstream = await s.getStream(); upstream.end(completeSse)
  const sr = await pending
  assert.equal(s.events.accountCommits, 0); assert.doesNotMatch(sr.raw, /data: \[DONE\]/); assert.match(sr.raw, /provider_stream_incomplete/)
})
