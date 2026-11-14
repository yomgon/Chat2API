import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
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
      if (name.startsWith('.')) throw Error('Unexpected product import: ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const event = object => 'data: ' + JSON.stringify(object) + '\n\n'
const chunk = delta => event({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })
const finish = event({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
const done = 'data: [DONE]\n\n'

async function fixture() {
  const state = { sends: 0, settled: 0, failures: 0 }
  const streams = []
  const account = { id: 'local45-account', providerId: 'qwen', name: 'synthetic', status: 'active' }
  const provider = { id: 'qwen', name: 'Synthetic', enabled: true }
  const storeManager = {
    getConfig: () => ({ enableApiKey: true,
      apiKeys: [{ id: 'k', key: 'local45-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false }, loadBalanceStrategy: 'round-robin' }),
    updateConfig() {}, addRequestLog: () => ({ id: 'log' }), updateRequestLog() {}, addLog() {},
    recordRequestInStats(ok) { if (!ok) state.failures++ },
    recordAccountSuccess() { state.settled++; return true },
  }
  const proxyStatusManager = {
    recordRequestStart() {}, recordRequestSuccess() {}, recordRequestFailure() {},
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ activeConnections: 0 }), getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const requestForwarder = { async forwardChatCompletion() {
    state.sends++
    const stream = new PassThrough(); streams.push(stream)
    return { success: true, status: 200, stream, skipTransform: true }
  } }
  const converter = product('utils/toolFormatConverter.ts')
  const chat = product('routes/chat.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: { selectAccount: () => ({ account, provider, actualModel: 'wire' }), clearAccountFailure() {}, markAccountFailed() {} } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: { getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id } },
    '../status': { proxyStatusManager }, '../streamTerminalGate': product('streamTerminalGate.ts'),
    '../stream': { streamHandler: { createTransformStream() { throw Error('direct SSE only') } } },
    '../utils/toolFormatConverter': converter, '../../store/store': { storeManager },
  }).default
  const serverProduct = product('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local45' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat], './routes/management': [], './status': { proxyStatusManager },
    '../store/store': { storeManager }, './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('localSecurity.ts'),
  }).proxyServer
  const listener = createServer(serverProduct.app.callback()); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; serverProduct.port = port
  const send = () => new Promise((resolve, reject) => {
    const parts = []
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer local45-key', 'Content-Type': 'application/json' } }, res => {
      res.on('data', p => parts.push(p)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('error', reject); req.end(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'synthetic' }], stream: true, tool_format: 'native' }))
  })
  async function stream() {
    for (let i = 0; i < 100 && streams.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(streams.length, 1)
    return streams[0]
  }
  return { state, send, stream, close: async () => { for (const s of streams) if (!s.destroyed) s.destroy(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)) } }
}

function frames(raw) {
  return raw.split('\n\n').filter(x => x.startsWith('data: ') && x !== 'data: [DONE]').map(x => JSON.parse(x.slice(6)))
}

test('native SSE assembles interleaved multi-index split names/arguments and preserves mixed text', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send(); const upstream = await f.stream()
  upstream.end([
    chunk({ role: 'assistant', content: 'Planning ', tool_calls: [
      { index: 1, id: 'call-b', type: 'function', function: { name: 'wea', arguments: '{"city":' } },
      { index: 0, id: 'call-a', type: 'function', function: { name: 'look', arguments: '{"q":' } },
    ] }),
    chunk({ content: 'tools.', tool_calls: [
      { index: 0, function: { name: 'up', arguments: '"alpha"}' } },
      { index: 1, function: { name: 'ther', arguments: '"Seoul"}' } },
    ] }),
    finish, done,
  ].join(''))
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1)
  assert.doesNotMatch(result.raw, /"tool_calls":\[/)
  assert.match(result.raw, /Planning /)
  assert.match(result.raw, /tools\./)
  const content = frames(result.raw).flatMap(frame => frame.choices ?? [])
    .flatMap(choice => Array.isArray(choice.delta?.content) ? choice.delta.content : [])
    .filter(item => item?.type === 'tool_use')
  assert.deepEqual(content.map(x => ({ id: x.id, name: x.name, input: x.input })), [
    { id: 'call-a', name: 'lookup', input: { q: 'alpha' } },
    { id: 'call-b', name: 'weather', input: { city: 'Seoul' } },
  ])
  assert.equal(f.state.sends, 1); assert.equal(f.state.settled, 1); assert.equal(f.state.failures, 0)
})

test('native SSE fails closed when one interleaved call never completes its split function name', async t => {
  const f = await fixture(); t.after(f.close)
  const pending = f.send(); const upstream = await f.stream()
  upstream.end(chunk({ role: 'assistant', tool_calls: [
    { index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    { index: 1, id: 'call-b', type: 'function', function: { arguments: '{}' } },
  ] }) + finish + done)
  const result = await pending
  assert.match(result.raw, /provider_stream_incomplete/)
  assert.doesNotMatch(result.raw, /data: \[DONE\]/)
  assert.equal(f.state.settled, 0)
})
