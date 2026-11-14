import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual Koa, koa-bodyparser, local API-key authorization and legacy
// route/terminal converter. Closed synthetic upstream, store and account only.
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
  const events = { sends: 0, accountCommits: 0, success: 0, failure: 0, stats: [], logs: [] }
  const rawStreams = []
  const account = { id: 'synthetic-a', providerId: 'p', name: 'Account', status: 'active' }
  const provider = { id: 'p', name: 'Synthetic', enabled: true }
  const config = {
    enableApiKey: true,
    apiKeys: [{ id: 'key', key: 'synthetic-legacy-local47-key', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin',
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

test('healthy verified legacy nonstream and SSE each settle once and return text_completion', async t => {
  const nonstream = await fixture()
  t.after(nonstream.close)
  const n = await nonstream.post()
  assert.equal(n.status, 200)
  assert.equal(JSON.parse(n.raw).object, 'text_completion')
  assert.match(JSON.parse(n.raw).choices[0].text, /Synthetic legacy completed/)
  assert.equal(nonstream.events.accountCommits, 1)
  assert.equal(nonstream.events.success, 1)
  assert.deepEqual(nonstream.events.stats, [true])

  const stream = await fixture({ stream: true })
  t.after(stream.close)
  const promise = stream.post()
  const source = await stream.upstream()
  source.end(completeStream)
  const s = await promise
  assert.equal(s.status, 200)
  assert.match(s.raw, /"object":"text_completion"/)
  assert.equal((s.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
  assert.equal(stream.events.accountCommits, 1)
  assert.equal(stream.events.success, 1)
  assert.deepEqual(stream.events.stats, [true])
})

for (const mode of ['postcommit-stats', 'postcommit-log', 'postcommit-status', 'postcommit-clear']) {
  test('legacy nonstream postcommit ' + mode + ' cannot turn a committed answer into HTTP 500', async t => {
    const f = await fixture({ mode })
    t.after(f.close)
    const response = await f.post()
    assert.equal(f.events.accountCommits, 1)
    assert.equal(f.events.sends, 1)
    assert.equal(response.raw.includes(PRIVATE), false)
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.raw).object, 'text_completion')
    assert.equal(f.events.failure, 0)
  })
  test('legacy SSE postcommit ' + mode + ' cannot hide already committed [DONE]', async t => {
    const f = await fixture({ mode, stream: true })
    t.after(f.close)
    const promise = f.post()
    const source = await f.upstream()
    source.end(completeStream)
    const response = await promise
    assert.equal(f.events.accountCommits, 1)
    assert.equal(f.events.sends, 1)
    assert.equal(response.raw.includes(PRIVATE), false)
    assert.equal(response.status, 200)
    assert.equal((response.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
    assert.equal(f.events.failure, 0)
  })
}

test('legacy refused account write remains fail-closed without [DONE], success or remote retry', async t => {
  const nonstream = await fixture({ mode: 'account-settlement-refusal' })
  t.after(nonstream.close)
  const n = await nonstream.post()
  assert.equal(nonstream.events.sends, 1)
  assert.equal(nonstream.events.accountCommits, 0)
  assert.notEqual(n.status, 200)

  const stream = await fixture({ mode: 'account-settlement-refusal', stream: true })
  t.after(stream.close)
  const pending = stream.post()
  const source = await stream.upstream()
  source.end(completeStream)
  const s = await pending
  assert.equal(stream.events.accountCommits, 0)
  assert.equal(stream.events.sends, 1)
  assert.doesNotMatch(s.raw, /data: \[DONE\]/)
  assert.match(s.raw, /provider_stream_incomplete/)
})
