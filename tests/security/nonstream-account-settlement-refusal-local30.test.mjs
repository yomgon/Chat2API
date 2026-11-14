import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Run the actual /v1/chat/completions route, not a recreated settlement
// algorithm. Entirely synthetic account/forwarder, no web request or store IO.
const source = readFileSync(new URL('../../src/main/proxy/routes/chat.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'chat.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
const account = Object.freeze({ id: 'synthetic-account', providerId: 'glm', status: 'active' })
const provider = Object.freeze({ id: 'glm', name: 'Synthetic GLM', enabled: true })
const response = Object.freeze({
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic completed answer' } }],
})
const PRIVATE = 'SYNTHETIC_LOCAL30_ACCOUNT_STORE_REFUSAL_PRIVATE'
const noEffect = () => { throw Error('Unauthorized extra effect') }

function harness(writeFailure) {
  const routes = {}
  class Router { post(path, callback) { routes[path] = callback } }
  const counts = { start: 0, success: 0, fail: 0, account: 0, clear: 0, logs: [], stats: [], requests: 0 }
  const refs = []
  const mocks = {
    '@koa/router': { __esModule: true, default: Router },
    '../modelMapper': { modelMapper: { getPreferredProvider: () => 'glm', getPreferredAccount: () => account.id } },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-wire' }),
      clearAccountFailure: () => { counts.clear++ },
      markAccountFailed: noEffect,
    } },
    '../forwarder': { requestForwarder: { forwardChatCompletion: async () => {
      counts.requests++
      return { success: true, status: 200, body: response }
    } } },
    '../status': { proxyStatusManager: {
      recordRequestStart: () => { counts.start++ },
      recordRequestSuccess: () => { counts.success++ },
      recordRequestFailure: () => { counts.fail++ },
    } },
    '../stream': { streamHandler: { createTransformStream: noEffect } },
    '../streamTerminalGate': { hasCompletedNonStreamAnswer: r =>
      r?.choices?.length === 1 && r.choices[0].message?.role === 'assistant' &&
      r.choices[0].finish_reason === 'stop' && !!r.choices[0].message.content },
    '../../store/store': { storeManager: {
      getConfig: () => ({ retryCount: 0, loadBalanceStrategy: 'round-robin' }),
      recordAccountSuccess: () => {
        counts.account++
        if (writeFailure) throw Object.assign(new Error(PRIVATE), { config: { Authorization: PRIVATE } })
        return true
      },
      addLog: (...args) => refs.push(args),
      addRequestLog: row => { counts.logs.push(row); return { id: 'synthetic-log' } },
      recordRequestInStats: result => { counts.stats.push(result) },
    } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: noEffect,
      transformChunkToAnthropic: noEffect,
    },
  }
  const mod = { exports: {} }
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, Date, Math, JSON, Error,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      throw Error('Forbidden module: ' + name)
    },
  }, { filename: 'chat.ts', timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  assert.ok(routes['/completions'])
  const ctx = {
    status: 200, headers: {}, ip: '127.0.0.1', res: { headersSent: false },
    request: { body: { model: 'synthetic-alias', stream: false,
      messages: [{ role: 'user', content: 'Synthetic only' }] } },
    set() {},
  }
  return { invoke: () => routes['/completions'](ctx), counts, refs, ctx }
}

test('actual route counts one success after a completed assistant answer and persisted account charge', async () => {
  const h = harness(false)
  await h.invoke()
  assert.equal(h.ctx.status, 200)
  assert.equal(h.ctx.body.choices[0].finish_reason, 'stop')
  assert.equal(h.counts.start, 1)
  assert.equal(h.counts.requests, 1)
  assert.equal(h.counts.account, 1)
  assert.equal(h.counts.success, 1)
  assert.equal(h.counts.fail, 0)
  assert.deepEqual(h.counts.stats, [true])
  assert.equal(h.counts.clear, 1)
})

test('actual route account storage refusal cannot double-count success and failure', async () => {
  const h = harness(true)
  await h.invoke()
  assert.equal(h.ctx.status, 500, 'The successful remote answer cannot be settled locally')
  assert.equal(h.ctx.body.error.message, 'Internal proxy error')
  assert.equal(h.counts.start, 1)
  assert.equal(h.counts.requests, 1, 'Never replay a possibly effected provider completion')
  assert.equal(h.counts.account, 1)
  assert.equal(h.counts.success, 0, 'No success until durable account write returns')
  assert.equal(h.counts.fail, 1)
  assert.deepEqual(h.counts.stats, [false])
  assert.equal(h.counts.clear, 0)
  assert.equal(JSON.stringify(h.ctx.body).includes(PRIVATE), false)
  assert.equal(JSON.stringify(h.refs).includes(PRIVATE), false)
  assert.equal(JSON.stringify(h.counts.logs).includes(PRIVATE), false)
})
