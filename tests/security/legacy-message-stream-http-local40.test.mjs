import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Product Koa+body parser+key-auth+legacy route+SSE gate+converter over real
// ephemeral loopback HTTP. All provider/credential/storage state is synthetic.
const requireNode = createRequire(import.meta.url)
const source = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
function product(path, mocks) {
  const compiled = ts.transpileModule(source(path), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw new Error('Unapproved relative module: ' + name)
      return requireNode(name)
    },
    Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const frame = body => `data: ${JSON.stringify(body)}\n\n`
const first = (field, value) => frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, [field]: { role: 'assistant', content: value }, finish_reason: null },
] })
const finish = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: {}, finish_reason: 'stop' },
] })
const done = 'data: [DONE]\n\n'
const body = { model: 'public-synthetic', prompt: 'private local fixture', stream: true }

async function fixture() {
  const events = { sends: 0, accountSuccess: 0, requestStats: [], accepted: 0, failures: 0 }
  const account = { id: 'fixture-account', providerId: 'qwen', name: 'offline', status: 'active' }
  const provider = { id: 'qwen', name: 'Offline', enabled: true }
  const upstreams = []
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true, apiKeys: [{ id: 'k', key: 'fixture-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess() { events.accountSuccess++; return true },
    recordRequestInStats(succeeded) { events.requestStats.push(succeeded) },
    addLog() {},
  }
  const proxyStatusManager = {
    recordRequestStart() {}, recordRequestSuccess() { events.accepted++ },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const requestForwarder = { async forwardChatCompletion() {
    events.sends++
    const stream = new PassThrough()
    upstreams.push(stream)
    return { success: true, status: 200, stream, skipTransform: true }
  } }
  const gate = product('src/main/proxy/streamTerminalGate.ts', {})
  const legacy = product('src/main/proxy/legacyCompletion.ts', {})
  const shared = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'wire-synthetic' }),
      clearAccountFailure() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => 'qwen', getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder }, '../status': { proxyStatusManager },
    '../streamTerminalGate': gate, '../legacyCompletion': legacy,
    '../stream': { streamHandler: { createTransformStream: () => { throw Error('Not expected') } } },
    '../../store/store': { storeManager },
  }
  const legacyRouter = product('src/main/proxy/routes/completions.ts', shared).default
  const security = product('src/main/proxy/localSecurity.ts', {})
  const proxyServer = product('src/main/proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local40-fixture' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [legacyRouter], './routes/management': [],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': security,
  }).proxyServer
  const listener = createServer(proxyServer.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxyServer.port = port

  const send = (key = 'fixture-key') => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/v1/completions',
      method: 'POST', headers }, response => {
      const chunks = []
      let completed = false
      const settle = aborted => {
        if (completed) return
        completed = true
        resolve({ status: response.statusCode,
          raw: Buffer.concat(chunks).toString('utf8'), aborted })
      }
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => settle(false))
      response.on('aborted', () => settle(true))
      response.on('error', () => settle(true))
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('Synthetic request timed out')))
    req.end(JSON.stringify(body))
  })

  return {
    events, upstreams, send,
    async nextStream() {
      for (let i = 0; i < 100 && upstreams.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(upstreams.length, 1, 'Exactly one synthetic forwarder call')
      return upstreams[0]
    },
    async close() {
      for (const stream of upstreams) if (!stream.destroyed) stream.destroy()
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(err => err ? reject(err) : resolve()))
    },
  }
}

for (const field of ['delta', 'message']) {
  test(`actual Koa legacy SSE safely normalizes assistant ${field} answer and settles once at EOF`, async t => {
    const f = await fixture(); t.after(f.close)
    const pending = f.send()
    const stream = await f.nextStream()
    stream.end(first(field, 'hello legacy client') + finish + done)
    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(response.aborted, false)
    assert.match(response.raw, /"object":"text_completion"/)
    assert.match(response.raw, /"text":"hello legacy client"/)
    assert.equal((response.raw.match(/data: \[DONE\]/g) ?? []).length, 1)
    assert.equal(f.events.sends, 1)
    assert.equal(f.events.accountSuccess, 1)
    assert.equal(f.events.accepted, 1)
    assert.deepEqual(f.events.requestStats, [true])
  })
}

test('actual Koa legacy SSE rejects tool messages without fabricating text or a success', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send()
  const stream = await f.nextStream()
  stream.end(frame({ object: 'chat.completion.chunk', choices: [{ index: 0,
    message: { tool_calls: [{ index: 0, id: 'synthetic-tool',
      function: { name: 'offline_only', arguments: '{}' } }] }, finish_reason: null }] }) +
    frame({ object: 'chat.completion.chunk', choices: [{ index: 0,
      delta: {}, finish_reason: 'tool_calls' }] }) + done)
  const response = await pending
  assert.doesNotMatch(response.raw, /data: \[DONE\]/)
  assert.equal(f.events.accountSuccess, 0)
  assert.deepEqual(f.events.requestStats, [false])
  assert.equal(f.events.sends, 1)
})

test('actual Koa legacy SSE rejects unauthorized key before synthetic provider effect', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.send('wrong-key')
  assert.equal(response.status, 401)
  assert.equal(f.events.sends, 0)
  assert.equal(f.events.accountSuccess, 0)
})
