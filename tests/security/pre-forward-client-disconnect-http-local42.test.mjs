import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real Koa auth/bodyparser/route and response lifecycle. The forwarder is an
// intentionally deferred, synthetic transport; abort is only the loopback
// client socket. No profile, external provider, port8080 or credentials.
const requireNode = createRequire(import.meta.url)
function product(path, mocks = {}) {
  const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8'),
    {
      fileName: path,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw new Error('Unexpected module: ' + name)
      return requireNode(name)
    },
    Buffer, TextDecoder, Math, Date, JSON, Error,
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const reply = {
  object: 'chat.completion', id: 'offline-answer', created: 1, model: 'wire-synthetic',
  choices: [{
    index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: 'synthetic completed answer' },
  }],
}
const normalized = [
  'data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [
    { index: 0, delta: { role: 'assistant', content: 'synthetic stream answer' }, finish_reason: null },
  ] }),
  'data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [
    { index: 0, delta: {}, finish_reason: 'stop' },
  ] }),
  'data: [DONE]',
].join('\n\n') + '\n\n'

async function fixture() {
  const events = { sends: 0, settled: 0, stats: [], success: 0, failure: 0, logs: [] }
  const pending = []
  const account = { id: 'synthetic-account', providerId: 'qwen', name: 'local-only', status: 'active' }
  const provider = { id: 'qwen', name: 'Offline only', enabled: true }
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true,
      apiKeys: [{ id: 'auth-id', key: 'offline-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false },
      loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess() { events.settled++; return true },
    recordRequestInStats(value) { events.stats.push(value) },
    addRequestLog(entry) { events.logs.push(entry.status); return { id: 'offline-log' } },
    updateRequestLog() {},
    addLog() {},
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { events.success++ },
    recordRequestFailure() { events.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const requestForwarder = {
    forwardChatCompletion() {
      events.sends++
      return new Promise(resolve => pending.push(resolve))
    },
  }
  const gate = product('streamTerminalGate.ts')
  const legacy = product('legacyCompletion.ts')
  const shared = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'wire-synthetic' }),
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../status': { proxyStatusManager },
    '../streamTerminalGate': gate,
    '../legacyCompletion': legacy,
    '../stream': { streamHandler: { createTransformStream() {
      throw new Error('Raw stream normalization was not requested')
    } } },
    '../../store/store': { storeManager },
  }
  const chat = product('routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }).default
  const completions = product('routes/completions.ts', shared).default
  const localSecurity = product('localSecurity.ts')
  const server = product('server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'local42-synthetic' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat, completions], './routes/management': [],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': localSecurity,
  }).proxyServer
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port

  async function untilForwarderCall() {
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(pending.length, 1, 'One queued upstream operation')
  }

  async function untilAccounting() {
    for (let i = 0; i < 100 && events.stats.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function send(route, stream, disconnect = false) {
    const body = route === 'chat' ? {
      model: 'synthetic-model', messages: [{ role: 'user', content: 'test' }], stream,
    } : { model: 'synthetic-model', prompt: 'test', stream }
    const path = route === 'chat' ? '/v1/chat/completions' : '/v1/completions'
    let request
    const outcome = new Promise((resolve, reject) => {
      request = httpRequest({
        hostname: '127.0.0.1', port, method: 'POST', path,
        headers: {
          Host: '127.0.0.1:' + port,
          Authorization: 'Bearer offline-key',
          'Content-Type': 'application/json',
        },
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          resolve({ status: response.statusCode, raw: Buffer.concat(chunks).toString('utf8') })
        })
        response.on('error', error => disconnect ? resolve({ aborted: true }) : reject(error))
      })
      request.on('error', error => disconnect ? resolve({ aborted: true }) : reject(error))
      request.setTimeout(3000, () => request.destroy(new Error('Loopback fixture timed out')))
      request.end(JSON.stringify(body))
    })
    return { request, outcome }
  }

  return {
    events, pending, send, untilForwarderCall, untilAccounting,
    async close() {
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    },
  }
}

for (const route of ['chat', 'legacy']) {
  for (const stream of [false, true]) {
    test(`real Koa ${route} ${stream ? 'stream' : 'nonstream'}: client disconnect while awaiting provider cannot count delivered success`, async t => {
      const f = await fixture(); t.after(f.close)
      const operation = f.send(route, stream, true)
      await f.untilForwarderCall()
      operation.request.destroy()
      await operation.outcome
      // Let the owning Koa request observe the closed downstream socket
      // before synthetic upstream completion arrives.
      await new Promise(resolve => setTimeout(resolve, 30))
      const source = stream ? new PassThrough() : null
      f.pending[0]({
        success: true, status: 200, body: stream ? undefined : reply,
        ...(stream ? { stream: source, skipTransform: true } : {}),
      })
      await f.untilAccounting()
      assert.equal(f.events.sends, 1, 'Never replay consumed provider effect')
      assert.equal(f.events.settled, 0, 'Client-canceled response cannot be charged as a confirmed local success')
      assert.equal(f.events.success, 0)
      assert.equal(f.events.failure, 1)
      assert.deepEqual(f.events.stats, [false])
      if (source) assert.equal(source.destroyed, true, 'Canceled stream must close synthetic provider reader')
    })
  }
}

test('real Koa connected nonstream answer still settles exactly once after provider resolves', async t => {
  const f = await fixture(); t.after(f.close)
  const operation = f.send('chat', false)
  await f.untilForwarderCall()
  f.pending[0]({ success: true, status: 200, body: reply })
  const response = await operation.outcome
  assert.equal(response.status, 200)
  assert.match(response.raw, /synthetic completed answer/)
  assert.equal(f.events.sends, 1)
  assert.equal(f.events.settled, 1)
  assert.equal(f.events.success, 1)
  assert.deepEqual(f.events.stats, [true])
})
