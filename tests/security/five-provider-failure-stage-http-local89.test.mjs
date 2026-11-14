import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as send } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Execute actual production Chat Koa router at ephemeral 127.0.0.1:0. The
// selected first-party forwarder is an inert result provider: no real Axios,
// operating account/store, browser, Electron, or upstream provider effect.
const nodeRequire = createRequire(import.meta.url)
const source = rel => readFileSync(new URL('../../src/main/proxy/' + rel, import.meta.url), 'utf8')
const compile = rel => ts.transpileModule(source(rel), {
  fileName: rel, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText
const PRIVATE = 'LOCAL89_PRIVATE_PROVIDER_CANARY_NOT_FOR_CLIENT'
const clone = x => JSON.parse(JSON.stringify(x))
const gate = (() => {
  const module = { exports: {} }
  runInNewContext(compile('streamTerminalGate.ts'), {
    module, exports: module.exports, Buffer, TextDecoder, Date, Error,
    require(id) {
      if (id === 'stream') return { PassThrough }
      throw Error('Forbidden terminal dependency: ' + id)
    },
  }, { timeout: 2000 })
  return module.exports
})()

async function fixture({ providerId, status, stage, code, rawStage }) {
  const operations = { forwards: 0, settled: 0, marks: 0, released: 0,
    started: 0, failed: 0, succeeded: 0, stats: [], logs: [], requestLogs: [] }
  const account = { id: 'local89-existing-' + providerId, providerId, status: 'active',
    name: 'Local synthetic', credentials: { token: PRIVATE } }
  const provider = { id: providerId, name: 'Synthetic ' + providerId, enabled: true }
  const model = 'local89-test-wire'
  const manager = {
    getConfig: () => ({ loadBalanceStrategy: 'round-robin', retryCount: 0 }),
    addLog(level, message, meta) { operations.logs.push({ level, message, meta: clone(meta) }) },
    addRequestLog(entry) {
      operations.requestLogs.push(clone(entry))
      return { id: 'synthetic-diagnostic-log' }
    },
    recordRequestInStats(ok) { operations.stats.push(ok) },
    recordAccountSuccess() { operations.settled++; return true },
  }
  const selection = { account, provider, actualModel: model }
  const routeModules = {
    '@koa/router': nodeRequire('@koa/router'),
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => providerId,
      getPreferredAccount: () => account.id,
      hasAmbiguousMatchingMapping: () => false,
    } },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => selection,
      reserveSelectedAccount: () => () => { operations.released++ },
      markAccountFailed: () => { operations.marks++ },
      clearAccountFailure: () => {},
    } },
    '../forwarder': { requestForwarder: {
      async forwardChatCompletion(req, a, p, actual) {
        operations.forwards++
        assert.equal(a, account)
        assert.equal(p, provider)
        assert.equal(req.model, 'local89-test-model')
        assert.equal(actual, model)
        return { success: false, status,
          failureStage: rawStage ?? stage, failureCode: code, latency: 1,
          error: PRIVATE, response: { data: PRIVATE },
          headers: { authorization: PRIVATE }, providerSessionId: PRIVATE }
      },
    } },
    '../stream': { streamHandler: { createTransformStream() { throw Error('Unexpected remote stream') } } },
    '../streamTerminalGate': gate,
    '../status': { proxyStatusManager: {
      recordRequestStart() { operations.started++ },
      recordRequestSuccess() { operations.succeeded++ },
      recordRequestFailure() { operations.failed++ },
    } },
    '../../store/store': { storeManager: manager },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic() { throw Error('Unexpected conversion') },
      transformChunkToAnthropic() { throw Error('Unexpected chunk conversion') },
    },
  }
  const mod = { exports: {} }
  runInNewContext(compile('routes/chat.ts'), {
    module: mod, exports: mod.exports, Date, Math, JSON, Error, Buffer,
    console: { log() {}, error() {}, warn() {} },
    require(id) {
      if (Object.hasOwn(routeModules, id)) return routeModules[id]
      if (id.startsWith('.')) throw Error('Forbidden product import: ' + id)
      return nodeRequire(id)
    },
  }, { filename: 'real-chat-router-local89.ts', timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  const router = mod.exports.default
  assert.ok(router && typeof router.routes === 'function')
  const app = new (nodeRequire('koa'))()
  app.use(nodeRequire('koa-bodyparser')())
  app.use(router.routes())
  app.use(router.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const sendChat = stream => new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'local89-test-model',
      messages: [{ role: 'user', content: 'LOCAL89 OFFLINE ONLY' }],
      stream,
    })
    const req = send({
      method: 'POST', hostname: '127.0.0.1', port,
      path: '/v1/chat/completions',
      headers: { Host: '127.0.0.1:' + port, 'Content-Type': 'application/json' },
    }, response => {
      const parts = []
      response.on('data', chunk => parts.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8')
        let data
        try { data = JSON.parse(raw) } catch {}
        resolve({ status: response.statusCode, raw, data })
      })
    })
    req.setTimeout(3500, () => req.destroy(Error('Synthetic Koa HTTP timed out')))
    req.on('error', reject)
    req.end(payload)
  })
  return {
    operations, sendChat,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error =>
        error ? reject(error) : resolve()))
    },
  }
}
const cases = [
  { providerId: 'deepseek', status: 502, stage: 'unclassified', code: 'deepseek_upstream_operation_failed' },
  { providerId: 'glm', status: 502, stage: 'auth-preflight', code: 'glm_upstream_operation_failed' },
  { providerId: 'glm', status: 502, stage: 'response-decoding', code: 'glm_upstream_operation_failed' },
  { providerId: 'zai', status: 502, stage: 'response-decoding', code: undefined,
    expectCode: 'zai_response_decoding_failed' },
  { providerId: 'qwen-ai', status: 502, stage: 'chat-creation', code: 'qwen_ai_upstream_operation_failed' },
  { providerId: 'qwen-ai', status: 502, stage: 'chat-completion', code: 'qwen_ai_upstream_operation_failed' },
  { providerId: 'qwen-ai', status: 502, stage: 'response-decoding', code: 'qwen_ai_upstream_operation_failed' },
  { providerId: 'kimi', status: 401, stage: 'chat-completion', code: 'kimi_upstream_operation_failed' },
  { providerId: 'kimi', status: 401, stage: 'response-decoding', code: 'kimi_upstream_operation_failed' },
]
for (const sample of cases) for (const stream of [false, true]) {
  test('real Koa public error preserves safe stage: ' + sample.providerId +
      ' ' + sample.stage + ' status=' + sample.status + ' stream=' + stream, async t => {
    const f = await fixture(sample)
    t.after(f.close)
    const result = await f.sendChat(stream)
    assert.equal(result.status, sample.status)
    assert.equal(result.data.error.message, 'Provider request failed')
    assert.equal(result.data.error.type, 'api_error')
    assert.equal(result.data.error.code, sample.expectCode ?? sample.code)
    assert.equal(result.data.error.stage, sample.stage,
      'The typed provider stage must survive HTTP, not only optional system logging')
    assert.equal(f.operations.forwards, 1)
    assert.equal(f.operations.settled, 0)
    assert.equal(f.operations.started, 1)
    assert.equal(f.operations.failed, 1)
    assert.equal(f.operations.succeeded, 0)
    assert.deepEqual(f.operations.stats, [false])
    assert.equal(f.operations.requestLogs.length, 1)
    assert.equal(f.operations.requestLogs[0].errorMessage,
      'Provider request failed (' + sample.stage + ')',
      'The React request-log detail must distinguish error phases')
    assert.equal(JSON.parse(f.operations.requestLogs[0].responseBody).error.stage, sample.stage)
    assert.equal(result.raw.includes(PRIVATE), false)
    assert.equal(JSON.stringify(f.operations.logs).includes(PRIVATE), false)
  })
}
test('untrusted synthetic stage text cannot become a client-visible string or stored diagnostics', async t => {
  const f = await fixture({
    providerId: 'kimi', status: 502,
    stage: 'unclassified', rawStage: 'auth-preflight/' + PRIVATE,
    code: 'kimi_upstream_operation_failed',
  })
  t.after(f.close)
  const response = await f.sendChat(false)
  assert.equal(response.status, 502)
  assert.equal(response.data.error.stage, 'unclassified')
  assert.equal(f.operations.requestLogs[0].errorMessage, 'Provider request failed (unclassified)')
  assert.equal(JSON.stringify({ response, logs: f.operations.logs }).includes(PRIVATE), false)
  assert.equal(f.operations.forwards, 1)
})
