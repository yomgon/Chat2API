import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Independent HTTP request-log parity RED for /v1/completions, using the actual
// Koa/bodyparser/auth and production legacy route. No live provider effect.
const requireNode = createRequire(import.meta.url)
const PRIVATE = 'LOCAL47_SYNTHETIC_LEGACY_SECRET_CANARY'
function load(relative, deps = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } },
  ).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (name.startsWith('.')) throw Error('Unexpected product dependency ' + relative + ':' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const completedBody = {
  id: 'synthetic-legacy-id', object: 'chat.completion', created: 1, model: 'wire-legacy',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic legacy completed' } }],
}
const event = value => 'data: ' + JSON.stringify(value) + '\n\n'
const completeStream = event({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: { role: 'assistant', content: 'Synthetic legacy completed' }, finish_reason: null },
] }) + event({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: {}, finish_reason: 'stop' },
] }) + 'data: [DONE]\n\n'

async function fixture({ mode = 'healthy', stream = false } = {}) {
  const events = { sends: 0, accountCommits: 0, success: 0, failure: 0,
    stats: [], logs: [], requestLogs: [], requestLogUpdates: [] }
  const rawStreams = []
  const account = { id: 'synthetic-a', providerId: 'p', name: 'Account', status: 'active' }
  const provider = { id: 'p', name: 'Synthetic', enabled: true }
  const config = {
    enableApiKey: true,
    apiKeys: [{ id: 'key', key: 'synthetic-legacy-local47-key', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin',
    requestLogConfig: { enabled: true, includeBodies: false,
      redactSensitiveData: true, maxEntries: 200 },
  }
  const storeManager = {
    getConfig: () => config, updateConfig() {},
    recordAccountSuccess() {
      if (mode === 'account-settlement-refusal') return false
      events.accountCommits++
      return true
    },
    recordRequestInStats(complete) {
      events.stats.push(complete)
      if (complete && mode === 'postcommit-stats') throw Error(PRIVATE)
    },
    addLog(_level, message) {
      events.logs.push(message)
      if (mode === 'postcommit-log' &&
        (message === 'Legacy completion verified' || message === 'Legacy completion stream verified')) {
        throw Error(PRIVATE)
      }
    },
    addRequestLog(entry) {
      if (mode === 'postcommit-requestlog' && entry.status === 'success') throw Error(PRIVATE)
      const row = { ...entry, id: 'local85-log-' + (events.requestLogs.length + 1) }
      events.requestLogs.push(row)
      return row
    },
    updateRequestLog(id, updates) {
      if (mode === 'postcommit-requestlog' && updates.status === 'success') throw Error(PRIVATE)
      events.requestLogUpdates.push({ id, updates })
      const row = events.requestLogs.find(item => item.id === id)
      if (row) Object.assign(row, updates)
      return Boolean(row)
    },
  }
  const status = {
    recordRequestStart() {},
    recordRequestSuccess() {
      events.success++
      if (mode === 'postcommit-status') throw Error(PRIVATE)
    },
    recordRequestFailure() { events.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const balancer = {
    selectAccount: () => ({ account, provider, actualModel: 'wire-legacy' }),
    clearAccountFailure() {
      if (mode === 'postcommit-clear') throw Error(PRIVATE)
    },
  }
  const forwarder = {
    async forwardChatCompletion() {
      events.sends++
      if (mode === 'provider-failure') return { success: false, status: 503 }
      if (!stream) return { success: true, status: 200, body: completedBody }
      const upstream = new PassThrough()
      rawStreams.push(upstream)
      return { success: true, status: 200, stream: upstream, skipTransform: true }
    },
  }
  const gate = load('streamTerminalGate.ts')
  const legacy = load('legacyCompletion.ts')
  const router = load('routes/completions.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: balancer },
    '../forwarder': { requestForwarder: forwarder },
    '../stream': { streamHandler: { createTransformStream() { throw Error('Synthetic direct stream only') } } },
    '../streamTerminalGate': gate,
    '../legacyCompletion': legacy,
    '../status': { proxyStatusManager: status },
    '../modelMapper': { modelMapper: { getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id } },
    '../../store/store': { storeManager },
  }).default
  const proxy = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local47' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [router], './routes/management': [],
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager },
    './localSecurity': load('localSecurity.ts'),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const post = () => new Promise((resolve, reject) => {
    const chunks = []
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/completions',
      headers: { Host: '127.0.0.1:' + port, Authorization: 'Bearer synthetic-legacy-local47-key',
        'Content-Type': 'application/json' },
    }, res => {
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic legacy local request timeout')))
    req.end(JSON.stringify({ model: 'legacy-model', prompt: 'Synthetic only', stream }))
  })
  async function upstream() {
    for (let i = 0; i < 100 && rawStreams.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(rawStreams.length, 1)
    return rawStreams[0]
  }
  const close = async () => {
    for (const s of rawStreams) if (!s.destroyed) s.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  return { events, post, upstream, close }
}

test('RED: Legacy nonstream HTTP 200 has one traceable successful request log', async t => {
  const f = await fixture()
  t.after(f.close)
  const r = await f.post()
  assert.equal(r.status, 200)
  assert.equal(f.events.sends, 1)
  assert.equal(f.events.accountCommits, 1)
  assert.deepEqual(f.events.stats, [true])
  assert.equal(f.events.requestLogs.length, 1, 'Legacy JSON must not disappear from request logs')
  const [entry] = f.events.requestLogs
  assert.equal(entry.status, 'success')
  assert.equal(entry.statusCode, 200)
  assert.equal(entry.responseStatus, 200)
  assert.equal(entry.url, '/v1/completions')
  assert.equal(entry.model, 'legacy-model')
  assert.equal(entry.actualModel, 'wire-legacy')
  assert.equal(entry.providerId, 'p')
  assert.equal(entry.accountId, 'synthetic-a')
  assert.equal(entry.isStream, false)
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(PRIVATE))
})

test('RED: Legacy SSE provisional error log becomes success only after terminal and account commit', async t => {
  const f = await fixture({ stream: true })
  t.after(f.close)
  const pending = f.post()
  const upstream = await f.upstream()
  for (let i = 0; i < 60 && !f.events.requestLogs.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(f.events.requestLogs.length, 1, 'Legacy SSE needs one fail-closed provisional log')
  assert.equal(f.events.requestLogs[0].status, 'error', 'No success before terminal')
  assert.equal(f.events.accountCommits, 0)
  upstream.end(completeStream)
  const r = await pending
  assert.equal(r.status, 200)
  assert.equal((r.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(f.events.accountCommits, 1)
  assert.deepEqual(f.events.stats, [true])
  assert.equal(f.events.requestLogs.length, 1)
  assert.equal(f.events.requestLogs[0].status, 'success')
  assert.equal(f.events.requestLogs[0].statusCode, 200)
  assert.equal(f.events.requestLogs[0].url, '/v1/completions')
  assert.equal(f.events.requestLogs[0].isStream, true)
  assert.ok(f.events.requestLogUpdates.length >= 1)
})

test('RED: Legacy provider HTTP 503 logs one error without durable success or retry', async t => {
  const f = await fixture({ mode: 'provider-failure' })
  t.after(f.close)
  const r = await f.post()
  assert.equal(r.status, 503)
  assert.equal(f.events.sends, 1)
  assert.equal(f.events.accountCommits, 0)
  assert.deepEqual(f.events.stats, [false])
  assert.equal(f.events.requestLogs.length, 1)
  assert.equal(f.events.requestLogs[0].status, 'error')
  assert.equal(f.events.requestLogs[0].statusCode, 503)
  assert.equal(f.events.requestLogs[0].url, '/v1/completions')
})

test('legacy optional request-log persistence failure never reverses committed JSON or SSE', async t => {
  const plain = await fixture({ mode: 'postcommit-requestlog' })
  t.after(plain.close)
  const reply = await plain.post()
  assert.equal(reply.status, 200)
  assert.equal(plain.events.accountCommits, 1)
  assert.equal(plain.events.sends, 1)
  assert.doesNotMatch(reply.raw, new RegExp(PRIVATE))
  const stream = await fixture({ mode: 'postcommit-requestlog', stream: true })
  t.after(stream.close)
  const pending = stream.post()
  const upstream = await stream.upstream()
  upstream.end(completeStream)
  const s = await pending
  assert.equal(s.status, 200)
  assert.equal((s.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
  assert.equal(stream.events.accountCommits, 1)
  assert.equal(stream.events.sends, 1)
  assert.doesNotMatch(s.raw, new RegExp(PRIVATE))
})

test('Legacy early SSE EOF leaves one error log and never commits a success or [DONE]', async t => {
  const f = await fixture({ stream: true })
  t.after(f.close)
  const pending = f.post()
  const upstream = await f.upstream()
  upstream.end(event({ object: 'chat.completion.chunk', choices: [
    { index: 0, delta: { content: 'Partial only' }, finish_reason: null },
  ] }))
  const r = await pending
  assert.doesNotMatch(r.raw, /data: \[DONE\]/)
  assert.equal(f.events.sends, 1)
  assert.equal(f.events.accountCommits, 0)
  assert.deepEqual(f.events.stats, [false])
  assert.equal(f.events.requestLogs.length, 1)
  assert.equal(f.events.requestLogs[0].status, 'error')
  assert.equal(f.events.requestLogs[0].statusCode, 502)
})

test('Legacy declined durable account settlement is never a successful request log', async t => {
  const n = await fixture({ mode: 'account-settlement-refusal' })
  t.after(n.close)
  const r = await n.post()
  assert.notEqual(r.status, 200)
  assert.equal(n.events.sends, 1)
  assert.equal(n.events.accountCommits, 0)
  assert.deepEqual(n.events.stats, [false])
  assert.equal(n.events.requestLogs.length, 1)
  assert.equal(n.events.requestLogs[0].status, 'error')
  const s = await fixture({ mode: 'account-settlement-refusal', stream: true })
  t.after(s.close)
  const pending = s.post()
  const upstream = await s.upstream()
  upstream.end(completeStream)
  const reply = await pending
  assert.doesNotMatch(reply.raw, /data: \[DONE\]/)
  assert.equal(s.events.sends, 1)
  assert.equal(s.events.accountCommits, 0)
  assert.deepEqual(s.events.stats, [false])
  assert.equal(s.events.requestLogs.length, 1)
  assert.equal(s.events.requestLogs[0].status, 'error')
})
