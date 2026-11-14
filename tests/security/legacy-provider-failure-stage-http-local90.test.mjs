import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Authenticated, real Koa ProxyServer + real Legacy router. The forwarder is
// strictly inert: all requests stay on ephemeral 127.0.0.1, with no operating
// profile, provider credentials, cookies or remote network side effects.
const nodeRequire = createRequire(import.meta.url)
const ROOT = new URL('../../src/main/', import.meta.url)
const PRIVATE = 'LOCAL90_RAW_PROVIDER_SECRET_NEVER_PUBLISH'
const API_KEY = 'LOCAL90_SYNTHETIC_API_KEY_ONLY'
const wire = 'local90-synthetic-wire'
const requestedModel = 'local90-visible-model'
const clone = value => JSON.parse(JSON.stringify(value))
const compile = file => ts.transpileModule(readFileSync(new URL(file, ROOT), 'utf8'), {
  fileName: file,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText
function product(file, imports = {}) {
  const module = { exports: {} }
  runInNewContext(compile(file), {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    URL, Map, Set, Object, console: { log() {}, error() {}, warn() {} },
    require(id) {
      if (Object.hasOwn(imports, id)) return imports[id]
      if (id.startsWith('.')) throw Error('Forbidden local dependency in ' + file + ': ' + id)
      return nodeRequire(id)
    },
  }, { filename: file, timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({ providerId = 'kimi', status = 401, stage = 'chat-completion',
  rawStage, outcome = 'failure' } = {}) {
  const operations = {
    forwards: 0, settled: 0, started: 0, failed: 0, succeeded: 0,
    selected: 0, released: 0, apiKeyUses: 0, stats: [], logs: [], requestLogs: [],
  }
  const account = { id: 'local90-pinned-account', providerId, status: 'active',
    name: 'Isolated account', credentials: { token: PRIVATE } }
  const provider = { id: providerId, name: 'Isolated provider', enabled: true }
  const selected = { account, provider, actualModel: wire }
  const manager = {
    getConfig: () => ({ loadBalanceStrategy: 'round-robin', enableApiKey: true,
      apiKeys: [{ id: 'key1', key: API_KEY, enabled: true, usageCount: 0 }] }),
    updateConfig() { operations.apiKeyUses++ },
    addLog(level, message, context) { operations.logs.push(clone({ level, message, context })) },
    addRequestLog(entry) {
      operations.requestLogs.push(clone(entry))
      return { id: 'local90-request-log' }
    },
    recordRequestInStats(ok) { operations.stats.push(ok) },
    recordAccountSuccess() { operations.settled++; return true },
  }
  const statusManager = {
    recordRequestStart() { operations.started++ },
    recordRequestFailure() { operations.failed++ },
    recordRequestSuccess() { operations.succeeded++ },
    getStatistics: () => ({ totalRequests: operations.started,
      failedRequests: operations.failed, successRequests: operations.succeeded,
      activeConnections: operations.started - operations.failed - operations.succeeded }),
    getRunningStatus: () => ({ isRunning: true, uptime: 1 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const deps = {
    '@koa/router': nodeRequire('@koa/router'),
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => providerId, getPreferredAccount: () => account.id,
    } },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => { operations.selected++; return selected },
      reserveSelectedAccount: () => () => { operations.released++ },
      clearAccountFailure: () => {},
    } },
    '../forwarder': { requestForwarder: {
      async forwardChatCompletion(request, a, p, model) {
        operations.forwards++
        assert.equal(request.model, wire)
        assert.equal(a, account)
        assert.equal(p, provider)
        assert.equal(model, wire)
        if (outcome === 'incomplete') return { success: true, status: 200,
          body: { choices: [{ message: { role: 'assistant', content: 'partial' },
            finish_reason: null }] } }
        return {
          success: false, status, failureStage: rawStage ?? stage,
          failureCode: 'kimi_upstream_operation_failed',
          error: PRIVATE, headers: { Authorization: PRIVATE },
          body: { error: PRIVATE },
        }
      },
    } },
    '../stream': { streamHandler: {
      createTransformStream() { throw Error('Unexpected streaming conversion') },
    } },
    '../streamTerminalGate': product('proxy/streamTerminalGate.ts'),
    '../legacyCompletion': product('proxy/legacyCompletion.ts'),
    '../status': { proxyStatusManager: statusManager },
    '../../store/store': { storeManager: manager },
  }
  const legacy = product('proxy/routes/completions.ts', deps).default
  const proxy = product('proxy/server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'local90-synthetic' } },
    '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [legacy], './routes/management': [],
    './status': { proxyStatusManager: statusManager },
    '../store/store': { storeManager: manager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('proxy/localSecurity.ts'),
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const http = (stream, authorized = true) => new Promise((resolve, reject) => {
    const req = httpRequest({
      method: 'POST', hostname: '127.0.0.1', port, path: '/v1/completions',
      headers: { Host: '127.0.0.1:' + port,
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (authorized ? API_KEY : 'INVALID_KEY') },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let data
        try { data = JSON.parse(raw) } catch {}
        resolve({ status: response.statusCode, raw, data })
      })
    })
    req.setTimeout(3500, () => req.destroy(Error('Local Koa loopback timed out')))
    req.on('error', reject)
    req.end(JSON.stringify({ model: requestedModel, prompt: 'SYNTHETIC LOCAL90',
      stream }))
  })
  return {
    http, operations,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()))
    },
  }
}

function assertFailedExactlyOnce(f, response) {
  assert.equal(f.operations.forwards, 1, 'one synthetic forward, no retry or fallback')
  assert.equal(f.operations.selected, 1, 'single pinned provider selection')
  assert.equal(f.operations.released, 1, 'in-flight account reservation released')
  assert.equal(f.operations.settled, 0, 'failure must not charge account')
  assert.equal(f.operations.started, 1)
  assert.equal(f.operations.failed, 1)
  assert.equal(f.operations.succeeded, 0)
  assert.equal(f.operations.apiKeyUses, 1)
  assert.deepEqual(f.operations.stats, [false])
  assert.equal(f.operations.requestLogs.length, 1)
  assert.equal(f.operations.requestLogs[0].status, 'error')
  assert.equal(f.operations.requestLogs[0].statusCode, response.status)
  assert.equal(response.raw.includes(PRIVATE), false)
  assert.equal(JSON.stringify(f.operations.requestLogs).includes(PRIVATE), false)
  assert.equal(JSON.stringify(f.operations.logs).includes(PRIVATE), false)
}

const cases = [
  { providerId: 'deepseek', status: 502, stage: 'unclassified' },
  { providerId: 'glm', status: 502, stage: 'auth-preflight' },
  { providerId: 'glm', status: 502, stage: 'response-decoding' },
  { providerId: 'zai', status: 502, stage: 'response-decoding' },
  { providerId: 'qwen-ai', status: 502, stage: 'chat-creation' },
  { providerId: 'qwen-ai', status: 502, stage: 'chat-completion' },
  { providerId: 'qwen-ai', status: 502, stage: 'response-decoding' },
  { providerId: 'kimi', status: 401, stage: 'chat-completion' },
  { providerId: 'kimi', status: 401, stage: 'response-decoding' },
]
for (const sample of cases) for (const stream of [false, true]) {
  test('local90 real authenticated Legacy Koa stage ' + sample.providerId +
    ' ' + sample.stage + ' stream=' + stream, async t => {
    const f = await fixture(sample)
    t.after(f.close)
    const response = await f.http(stream)
    assert.equal(response.status, sample.status, response.raw)
    assert.equal(response.data.error.message, 'Provider completion could not be confirmed')
    assert.equal(response.data.error.type, 'api_error')
    assert.equal(response.data.error.code, null, 'preserve Legacy compatibility')
    assert.equal(response.data.error.stage, sample.stage)
    assertFailedExactlyOnce(f, response)
    assert.equal(f.operations.requestLogs[0].errorMessage,
      'Provider completion could not be confirmed (' + sample.stage + ')')
    assert.equal(JSON.parse(f.operations.requestLogs[0].responseBody).error.stage, sample.stage)
  })
}
for (const stream of [false, true]) {
  test('local90 untrusted failure stage is never exposed, stream=' + stream, async t => {
    const f = await fixture({ rawStage: 'auth-preflight/' + PRIVATE })
    t.after(f.close)
    const response = await f.http(stream)
    assert.equal(response.status, 401)
    assert.equal(response.data.error.stage, 'unclassified')
    assertFailedExactlyOnce(f, response)
    assert.equal(f.operations.requestLogs[0].errorMessage,
      'Provider completion could not be confirmed (unclassified)')
  })
  test('local90 successful forward without confirmed completion has separate code, stream=' +
    stream, async t => {
    const f = await fixture({ outcome: 'incomplete' })
    t.after(f.close)
    const response = await f.http(stream)
    assert.equal(response.status, 502)
    assert.equal(response.data.error.code, 'provider_completion_unconfirmed')
    assert.equal(response.data.error.stage, 'response-decoding')
    assertFailedExactlyOnce(f, response)
  })
}
test('local90 actual local proxy authentication rejects invalid key before forward', async t => {
  const f = await fixture()
  t.after(f.close)
  const response = await f.http(false, false)
  assert.equal(response.status, 401)
  assert.equal(response.data.error.code, 'invalid_api_key')
  assert.equal(f.operations.forwards, 0)
  assert.equal(f.operations.selected, 0)
  assert.equal(f.operations.apiKeyUses, 0)
  assert.equal(f.operations.requestLogs.length, 0)
})
