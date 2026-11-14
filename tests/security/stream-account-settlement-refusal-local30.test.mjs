import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough, Transform } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Real product route + terminal gate, isolated in memory. Never opens the
// listener, real Electron store, external account or upstream connection.
const file = name => readFileSync(new URL('../../src/main/proxy/' + name, import.meta.url), 'utf8')
const compile = name => ts.transpileModule(file(name), {
  fileName: name, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  },
}).outputText
const evalCode = (code, dependencies, fileName) => {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      throw Error('Forbidden import in closed offline fixture ' + id)
    },
  }, { filename: fileName, timeout: 1500, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}
const gate = evalCode(compile('streamTerminalGate.ts'), { stream: { PassThrough, Transform } }, 'terminal.ts')
const PRIVATE = 'SYNTHETIC_ONLY_STREAM_STORE_REFUSAL_PRIVATE_LOCAL30'
const frame = body => 'data: ' + JSON.stringify(body) + '\n\n'
const answer = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: { role: 'assistant', content: 'Synthetic answer confirmed' }, finish_reason: null },
] })
const finish = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: {}, finish_reason: 'stop' },
] })
const done = 'data: [DONE]\n\n'

function harness(refuse) {
  const callbacks = {}
  const raw = new PassThrough()
  class Router { post(name, callback) { callbacks[name] = callback } }
  const events = { start: 0, success: 0, failure: 0, accountWrites: 0,
    stats: [], logs: [], requestCount: 0, clear: 0, failedAccount: 0 }
  const account = { id: 'synthetic-account', providerId: 'glm', status: 'active' }
  const provider = { id: 'glm', name: 'Synthetic GLM', enabled: true }
  const mods = {
    '@koa/router': { __esModule: true, default: Router },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-wire' }),
      clearAccountFailure: () => { events.clear++ },
      markAccountFailed: () => { events.failedAccount++ },
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: async () => {
        events.requestCount++
        return { success: true, status: 200, stream: raw, skipTransform: true }
      },
    } },
    '../status': { proxyStatusManager: {
      recordRequestStart: () => events.start++,
      recordRequestSuccess: () => events.success++,
      recordRequestFailure: () => events.failure++,
    } },
    '../streamTerminalGate': gate,
    '../stream': { streamHandler: { createTransformStream() { throw Error('Unexpected transform') } } },
    '../../store/store': { storeManager: {
      getConfig: () => ({ loadBalanceStrategy: 'round-robin' }),
      recordAccountSuccess: () => {
        events.accountWrites++
        if (refuse) throw new Error(PRIVATE)
        return true
      },
      recordRequestInStats: ok => events.stats.push(ok),
      addRequestLog: log => { events.logs.push(log); return { id: 'synthetic-log' } },
      updateRequestLog: (id, changes) => events.logs.push({ id, changes }),
      addLog: (type, message, fields) => {
        assert.equal(JSON.stringify({ type, message, fields }).includes(PRIVATE), false)
      },
    } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic() { throw Error('No Anthropic') },
      transformChunkToAnthropic() { throw Error('No Anthropic') },
    },
  }
  evalCode(compile('routes/chat.ts'), mods, 'route.ts')
  const ctx = {
    status: 200, headers: {}, ip: '127.0.0.1',
    res: { headersSent: false }, set() {},
    request: { body: { model: 'synthetic-alias', stream: true,
      messages: [{ role: 'user', content: 'Synthetic only' }] } },
  }
  return { ctx, raw, events, invoke: () => callbacks['/completions'](ctx) }
}

async function streamRequest(refuse) {
  const h = harness(refuse)
  await h.invoke()
  const out = []
  const drained = new Promise((resolve, reject) => {
    h.ctx.body.on('data', chunk => out.push(chunk.toString()))
    h.ctx.body.once('end', resolve)
    h.ctx.body.once('error', reject)
  })
  h.raw.write(answer + finish + done)
  assert.equal(h.events.success, 0, 'Do not settle until actual raw EOF')
  assert.equal(h.events.accountWrites, 0, 'No account write before raw EOF')
  h.raw.end()
  await drained
  return { ...h, wire: out.join('') }
}

test('actual route streaming terminal settles account and success exactly once', async () => {
  const r = await streamRequest(false)
  assert.equal(r.events.requestCount, 1)
  assert.equal(r.events.accountWrites, 1)
  assert.equal(r.events.success, 1)
  assert.equal(r.events.failure, 0)
  assert.deepEqual(r.events.stats, [true])
  assert.equal((r.wire.match(/data: \[DONE\]/g) ?? []).length, 1)
  assert.match(r.wire, /"finish_reason":"stop"/)
})

test('real stream account storage refusal cannot publish DONE or count success', async () => {
  const r = await streamRequest(true)
  assert.equal(r.events.requestCount, 1, 'No automatic resend')
  assert.equal(r.events.accountWrites, 1, 'Attempt once')
  assert.equal(r.events.success, 0)
  assert.equal(r.events.failure, 1)
  assert.deepEqual(r.events.stats, [false])
  assert.equal(r.events.clear, 0)
  assert.equal(r.wire.includes('data: [DONE]'), false)
  assert.equal(r.wire.includes('"finish_reason":"stop"'), false)
  assert.match(r.wire, /"code":"provider_stream_incomplete"/)
  assert.equal(r.wire.includes(PRIVATE), false)
  assert.equal(JSON.stringify(r.events.logs).includes(PRIVATE), false)
})

test('actual terminal gate never emits DONE when successful settlement callback throws', async () => {
  const raw = new PassThrough()
  const results = []
  const out = gate.createOpenAIStreamTerminalGate(raw, completed => {
    results.push(completed)
    if (completed) throw new Error(PRIVATE)
  })
  const pieces = []
  const drained = new Promise((resolve, reject) => {
    out.on('data', part => pieces.push(part.toString()))
    out.once('end', resolve)
    out.once('error', reject)
  })
  raw.end(answer + finish + done)
  await drained
  assert.deepEqual(results, [true])
  const wire = pieces.join('')
  assert.equal(wire.includes('data: [DONE]'), false)
  assert.equal(wire.includes('"finish_reason":"stop"'), false)
  assert.match(wire, /"code":"provider_stream_incomplete"/)
  assert.equal(wire.includes(PRIVATE), false)
})
