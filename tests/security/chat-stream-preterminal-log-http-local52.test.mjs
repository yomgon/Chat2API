import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real authenticated ProxyServer -> actual Koa chat route -> actual terminal
// gate, using a single closed synthetic stream transport and memory storage.
// Focus: optional provisional request-log failure *before* SSE terminal gate.
// This is not the already-fixed local47 post-commit diagnostics contract.
const nodeRequire = createRequire(import.meta.url)
const API_KEY = 'synthetic-local52-proxy-key'
const CREDENTIAL = 'SYNTHETIC_LOCAL52_STREAM_CREDENTIAL_CANARY'
const DIAGNOSTICS = 'SYNTHETIC_LOCAL52_PRETERMINAL_DIAGNOSTICS_REFUSAL'

const delta = content => 'data: ' + JSON.stringify({
  object: 'chat.completion.chunk', choices: [
    { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
  ],
}) + '\n\n'
const finish = 'data: ' + JSON.stringify({
  object: 'chat.completion.chunk', choices: [
    { index: 0, delta: {}, finish_reason: 'stop' },
  ],
}) + '\n\n'
const COMPLETE_SSE = delta('synthetic complete answer') + finish + 'data: [DONE]\n\n'

function product(relative, deps = {}) {
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } },
  ).outputText
  const module = { exports: {} }
  runInNewContext(js, {
    module, exports: module.exports, Date, Math, JSON, Error, Buffer, TextDecoder,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected product import: ' + relative + ':' + id)
      return nodeRequire(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({ failProvisionalReceipt = false, refuseAccountSettlement = false } = {}) {
  const events = {
    upstreamCalls: 0, accountWrites: 0, accountCommitted: 0, successStatus: 0,
    failureStatus: 0, stats: [], logAttempts: 0, logUpdates: 0,
    failureLogs: 0,
  }
  const streams = []
  const account = { id: 'synthetic-account', providerId: 'synthetic-provider',
    name: 'Synthetic account', status: 'active', credentials: { token: CREDENTIAL } }
  const provider = { id: 'synthetic-provider', name: 'Synthetic provider', enabled: true }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true,
      apiKeys: [{ id: 'synthetic-key-id', key: API_KEY, enabled: true,
        usageCount: 0, lastUsedAt: 0 }],
      managementApi: { enableManagementApi: false },
      loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess(id, providerId) {
      assert.equal(id, account.id)
      assert.equal(providerId, provider.id)
      events.accountWrites++
      if (refuseAccountSettlement) return false
      events.accountCommitted++
      return true
    },
    recordRequestInStats(success) { events.stats.push(success) },
    addRequestLog(entry) {
      events.logAttempts++
      if (failProvisionalReceipt) throw Error(DIAGNOSTICS)
      return { id: 'synthetic-log-id' }
    },
    updateRequestLog() { events.logUpdates++ },
    addLog(level) { if (level === 'error') events.failureLogs++ },
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { events.successStatus++ },
    recordRequestFailure() { events.failureStatus++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({
      totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0,
    }),
    getPort: () => 8080,
    getHost: () => '127.0.0.1',
  }
  const requestForwarder = {
    async forwardChatCompletion() {
      events.upstreamCalls++
      const upstream = new PassThrough()
      streams.push(upstream)
      return { success: true, status: 200, stream: upstream, skipTransform: true }
    },
  }
  const chat = product('routes/chat.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({
        account, provider, actualModel: 'synthetic-wire-id',
      }),
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../status': { proxyStatusManager },
    '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() {
      throw Error('Only synthetic native SSE is allowed')
    } } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: body => body,
      transformChunkToAnthropic: body => body,
    },
    '../../store/store': { storeManager },
  }).default
  const proxy = product('server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'local52-synthetic' } },
    '@koa/router': nodeRequire('@koa/router'), 'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [chat], './routes/management': [],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('localSecurity.ts'),
  }).proxyServer
  const listener = createServer(proxy.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxy.port = port
  const post = ({ abortOnData = false } = {}) => new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        Host: '127.0.0.1:' + port,
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
      },
    }, res => {
      const done = aborted => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8'), aborted })
      }
      res.on('data', chunk => {
        chunks.push(chunk)
        if (abortOnData) { res.destroy(); done(true) }
      })
      res.on('aborted', () => done(true))
      res.on('error', () => done(true))
      res.on('end', () => done(false))
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic local52 SSE HTTP timeout')))
    req.end(JSON.stringify({
      model: 'synthetic-display-model',
      messages: [{ role: 'user', content: 'Synthetic only' }],
      stream: true,
    }))
  })
  const getStream = async () => {
    for (let i = 0; i < 120 && streams.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(streams.length, 1, 'No duplicate provider effects or retries')
    return streams[0]
  }
  const close = async () => {
    for (const stream of streams) {
      if (!stream.destroyed) stream.destroy()
    }
    listener.closeAllConnections()
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  }
  return { events, streams, post, getStream, close }
}

test('actual authenticated SSE keeps normal terminal and single account commit when provisional diagnostics fail', async t => {
  const f = await fixture({ failProvisionalReceipt: true })
  t.after(f.close)
  const pending = f.post()
  const source = await f.getStream()
  source.end(COMPLETE_SSE)
  const result = await pending
  assert.equal(f.events.upstreamCalls, 1)
  assert.equal(f.events.logAttempts, 1)
  assert.equal(result.status, 200)
  assert.equal(result.raw.includes(DIAGNOSTICS) || result.raw.includes(CREDENTIAL), false)
  assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.match(result.raw, /synthetic complete answer/)
  assert.equal(f.events.accountWrites, 1)
  assert.equal(f.events.accountCommitted, 1)
  assert.equal(f.events.failureStatus, 0)
  assert.equal(f.events.successStatus, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('healthy provisional request log still records and finalizes successful SSE exactly once', async t => {
  const f = await fixture()
  t.after(f.close)
  const pending = f.post()
  const source = await f.getStream()
  source.end(COMPLETE_SSE)
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(f.events.logAttempts, 1)
  assert.equal(f.events.logUpdates, 1)
  assert.equal(f.events.accountCommitted, 1)
  assert.deepEqual(f.events.stats, [true])
})

test('when provisional log failed, account settlement refusal still suppresses DONE and success', async t => {
  const f = await fixture({ failProvisionalReceipt: true, refuseAccountSettlement: true })
  t.after(f.close)
  const pending = f.post()
  const source = await f.getStream()
  source.end(COMPLETE_SSE)
  const result = await pending
  assert.equal(f.events.upstreamCalls, 1)
  assert.equal(f.events.accountWrites, 1)
  assert.equal(f.events.accountCommitted, 0)
  assert.equal(f.events.successStatus, 0)
  assert.doesNotMatch(result.raw, /data: \[DONE\]/)
  assert.equal(result.raw.includes(DIAGNOSTICS) || result.raw.includes(CREDENTIAL), false)
  assert.deepEqual(f.events.stats, [false])
})

test('with failed provisional log, incomplete SSE never becomes a successful terminal', async t => {
  const f = await fixture({ failProvisionalReceipt: true })
  t.after(f.close)
  const pending = f.post()
  const source = await f.getStream()
  source.end(delta('partial only'))
  const result = await pending
  assert.equal(f.events.accountCommitted, 0)
  assert.equal(f.events.successStatus, 0)
  assert.equal(f.events.failureStatus, 1)
  assert.doesNotMatch(result.raw, /data: \[DONE\]/)
  assert.equal(result.raw.includes(DIAGNOSTICS), false)
})

test('HTTP client cancellation after failed provisional log destroys original upstream reader without success', async t => {
  const f = await fixture({ failProvisionalReceipt: true })
  t.after(f.close)
  const pending = f.post({ abortOnData: true })
  const source = await f.getStream()
  source.write(delta('partial consumer content'))
  const result = await pending
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(result.aborted, true)
  assert.equal(f.events.upstreamCalls, 1)
  assert.equal(source.destroyed, true)
  assert.equal(f.events.accountCommitted, 0)
  assert.equal(f.events.successStatus, 0)
  assert.equal(f.events.failureStatus, 1)
  assert.deepEqual(f.events.stats, [false])
  assert.equal(result.raw.includes(DIAGNOSTICS) || result.raw.includes(CREDENTIAL), false)
})
