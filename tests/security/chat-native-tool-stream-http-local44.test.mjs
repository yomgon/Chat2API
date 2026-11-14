import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Native tool-format streaming is a pre-existing public chat option. Exercise
// the actual auth middleware + Koa route + SSE terminal gate + converter over
// 127.0.0.1:0 only. All accounts, stores and providers are synthetic.
const requireNode = createRequire(import.meta.url)
function product(path, mocks = {}) {
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8'),
    { fileName: path, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } },
  ).outputText
  const module = { exports: {} }
  runInNewContext(js, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw Error('Unexpected product import: ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}
const event = object => 'data: ' + JSON.stringify(object) + '\n\n'
const delta = value => event({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: value, finish_reason: null },
] })
const finish = reason => event({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: {}, finish_reason: reason },
] })
const done = 'data: [DONE]\n\n'

async function fixture() {
  const state = { sends: 0, accountsSettled: 0, statusSuccess: 0, statusFailure: 0, stats: [] }
  const account = { id: 'synthetic-account', providerId: 'qwen', name: 'private-local', status: 'active' }
  const provider = { id: 'qwen', name: 'Synthetic transport', enabled: true }
  const streams = []
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true,
      apiKeys: [{ id: 'fixture-id', key: 'local-only-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess(id, providerId) {
      assert.equal(id, account.id)
      assert.equal(providerId, provider.id)
      state.accountsSettled++
      return true
    },
    recordRequestInStats(ok) { state.stats.push(ok) },
    addRequestLog: () => ({ id: 'private-log' }),
    updateRequestLog() {}, addLog() {},
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { state.statusSuccess++ },
    recordRequestFailure() { state.statusFailure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const requestForwarder = { async forwardChatCompletion() {
    state.sends++
    const stream = new PassThrough()
    streams.push(stream)
    return { success: true, status: 200, stream, skipTransform: true }
  } }
  const converter = product('utils/toolFormatConverter.ts')
  const chat = product('routes/chat.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'wire-model' }),
      clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id,
    } },
    '../status': { proxyStatusManager },
    '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() { throw Error('Only direct SSE') } } },
    '../utils/toolFormatConverter': converter,
    '../../store/store': { storeManager },
  }).default
  const serverProduct = product('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local44-fixture' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat], './routes/management': [],
    './status': { proxyStatusManager }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('localSecurity.ts'),
  }).proxyServer
  const listener = createServer(serverProduct.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  serverProduct.port = port
  const send = tool_format => new Promise((resolve, reject) => {
    const chunks = []
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: {
        Host: '127.0.0.1:' + port,
        Authorization: 'Bearer local-only-key',
        'Content-Type': 'application/json',
      },
    }, response => {
      response.on('data', part => chunks.push(part))
      response.on('error', reject)
      response.on('end', () => resolve({
        status: response.statusCode,
        raw: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.setTimeout(3000, () => request.destroy(Error('Local fixture timeout')))
    request.end(JSON.stringify({
      model: 'local-model', messages: [{ role: 'user', content: 'Only synthetic tools' }],
      stream: true, tool_format,
    }))
  })
  async function getStream() {
    for (let i = 0; i < 120 && !streams.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(streams.length, 1, 'Only one synthetic effect permitted')
    return streams[0]
  }
  return {
    state, send, getStream,
    async close() {
      for (const stream of streams) if (!stream.destroyed) stream.destroy()
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(err => err ? reject(err) : resolve()))
    },
  }
}
const frames = raw => raw.split('\n\n')
  .filter(x => x.startsWith('data: ') && x !== 'data: [DONE]')
  .map(x => JSON.parse(x.slice(6)))
const pieces = args => [
  delta({ role: 'assistant', tool_calls: [{
    index: 0, id: 'local-tool-id', type: 'function',
    function: { name: 'offline_lookup', arguments: args[0] },
  }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: args[1] } }] }),
  finish('tool_calls'), done,
].join('')

test('real authenticated Koa native SSE returns complete tool_use content instead of raw OpenAI tool_calls, with single settled DONE', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send('native')
  const raw = await f.getStream()
  raw.end(pieces(['{"query":', '"synthetic"}']))
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.doesNotMatch(result.raw, /"tool_calls":\[/)
  const events = frames(result.raw)
  const nativeTool = events.flatMap(x => x.choices || [])
    .flatMap(x => Array.isArray(x.delta?.content) ? x.delta.content : [])
    .find(x => x.type === 'tool_use')
  assert.equal(nativeTool?.id, 'local-tool-id')
  assert.equal(nativeTool?.name, 'offline_lookup')
  assert.equal(nativeTool?.input?.query, 'synthetic')
  assert.equal(f.state.sends, 1)
  assert.equal(f.state.accountsSettled, 1)
  assert.equal(f.state.statusSuccess, 1)
  assert.equal(f.state.statusFailure, 0)
  assert.deepEqual(f.state.stats, [true])
})

test('real authenticated Koa native SSE refuses invalid complete tool JSON before account settlement and [DONE]', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send('native')
  const raw = await f.getStream()
  raw.end(pieces(['{NOT_VALID', 'JSON}']))
  const result = await pending
  assert.match(result.raw, /provider_stream_incomplete/)
  assert.doesNotMatch(result.raw, /data: \[DONE\]/)
  assert.equal(f.state.sends, 1)
  assert.equal(f.state.accountsSettled, 0)
  assert.equal(f.state.statusSuccess, 0)
  assert.deepEqual(f.state.stats, [false])
})

test('real authenticated Koa auto SSE still exposes the original OpenAI tool deltas, no native rewriting', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send('auto')
  const raw = await f.getStream()
  raw.end(pieces(['{"query":', '"synthetic"}']))
  const result = await pending
  assert.equal(result.status, 200)
  assert.match(result.raw, /"tool_calls":\[/)
  assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(f.state.accountsSettled, 1)
  assert.deepEqual(f.state.stats, [true])
})

test('real authenticated Koa native SSE plain text still reaches consumer and counts one success', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send('native')
  const raw = await f.getStream()
  raw.end(delta({ role: 'assistant', content: 'hello from synthetic text' }) + finish('stop') + done)
  const result = await pending
  assert.equal(result.status, 200)
  assert.match(result.raw, /hello from synthetic text/)
  assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(f.state.accountsSettled, 1)
  assert.deepEqual(f.state.stats, [true])
})
