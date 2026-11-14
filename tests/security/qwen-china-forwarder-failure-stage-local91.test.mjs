import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual production RequestForwarder.forwardQwen method; no operating store,
// vendor host, credential or network connection. Adapter/handler transport
// objects are synthetic and kept inside a closed VM.
const src = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('forwarder.ts', src, ts.ScriptTarget.Latest, true)
let method
const visit = node => {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardQwen') method = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(method, 'Production Qwen dedicated forwarder must be present')
const code = ts.transpileModule(
  'class OfflineQwenForwarder {' + method + '}\nexports.OfflineQwenForwarder = OfflineQwenForwarder',
  { fileName: 'forwardQwen.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } },
).outputText
const PRIVATE = 'LOCAL91_PRIVATE_SYNTHETIC_QWEN_AXIOS_TOKEN'
const model = 'qwen-china-effective-wire-exact'
const fail = () => { throw Error('No authorized extra operation') }
const completed = { choices: [{
  message: { role: 'assistant', content: 'Offline completed answer' }, finish_reason: 'stop',
}] }

function fixture({ status = 502, stage = 'status', stream = false } = {}) {
  const calls = { forward: 0, handler: 0, cleanup: 0, transformed: 0 }
  const raw = new PassThrough({ autoDestroy: false })
  const provider = { id: 'qwen', apiEndpoint: 'https://chat.qwen.ai', type: 'builtin' }
  const account = { id: 'exact-pinned-account', providerId: 'qwen',
    credentials: { ticket: PRIVATE } }
  class QwenAdapter {
    constructor(p, a) { assert.equal(p, provider); assert.equal(a, account) }
    async chatCompletion(request) {
      calls.forward++
      assert.equal(request.model, model, 'exact selected catalog wire')
      assert.equal(request.originalModel, 'visible-qwen-alias')
      assert.equal(request.stream, stream)
      if (stage === 'preflight') throw Error('Raw Authorization ' + PRIVATE)
      return { response: { status, data: raw, headers: { 'x-raw-private': PRIVATE } },
        sessionId: 'synthetic-session', reqId: 'synthetic-request' }
    }
    async deleteSession() { calls.cleanup++; return fail() }
  }
  class QwenHandler {
    async handleNonStream(input) {
      calls.handler++
      assert.equal(input, raw)
      if (stage === 'decoder') throw Error('Raw stream Error Authorization ' + PRIVATE)
      return completed
    }
    async handleStream(input) {
      calls.handler++
      assert.equal(input, raw)
      if (stage === 'decoder') throw Error('Raw stream Error Authorization ' + PRIVATE)
      return input
    }
    getSessionId() { return 'synthetic-session' }
  }
  const mod = { exports: {} }
  runInNewContext(code, {
    module: mod, exports: mod.exports, Date, Math, Error, Buffer,
    QwenAdapter, QwenStreamHandler: QwenHandler, shouldDeleteSession: () => false,
    hasCompletedNonStreamAnswer: x => x === completed,
    unconfirmedProviderCompletion: () => fail(),
    console: { log() {}, error() {}, warn() {} },
  }, { filename: 'qwen-forwarder-real-method-local91', timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  const fwd = new mod.exports.OfflineQwenForwarder()
  fwd.transformRequestForPromptToolUse = request => {
    calls.transformed++
    return { messages: request.messages, tools: undefined, plan: {} }
  }
  fwd.extractHeaders = () => ({})
  fwd.applyToolCallsToResponse = () => {}
  const request = { model: 'visible-qwen-alias', stream,
    messages: [{ role: 'user', content: 'SYNTHETIC_REQUEST_NO_REMOTE' }] }
  const execute = () => fwd.forwardQwen(request, account, provider, model, Date.now())
  return { calls, raw, execute }
}

for (const stream of [false, true]) for (const status of [401, 429, 502, 302, 201]) {
  test('local91 Qwen China actual completed HTTP rejection status=' + status +
    ' stream=' + stream + ' has fixed stage, safe status and closes raw reader', async () => {
    const f = fixture({ status, stream })
    const result = await f.execute()
    assert.equal(result.success, false)
    assert.equal(result.status, status >= 400 && status <= 599 ? status : 502)
    assert.equal(result.failureStage, 'chat-completion')
    assert.equal(result.failureCode, 'qwen_upstream_operation_failed')
    assert.equal(result.error, 'Qwen provider operation failed')
    assert.equal(f.raw.destroyed, true)
    assert.equal(f.calls.forward, 1)
    assert.equal(f.calls.handler, 0)
    assert.equal(f.calls.cleanup, 0)
    assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  })
}

for (const stream of [false, true]) for (const stage of ['preflight', 'decoder']) {
  test('local91 Qwen China ' + stage + ' stream=' + stream +
    ' cannot leak raw Axios error or leave live raw stream', async () => {
    const f = fixture({ status: 200, stage, stream })
    const result = await f.execute()
    assert.equal(result.success, false)
    assert.equal(result.status, 502)
    assert.equal(result.failureStage,
      stage === 'preflight' ? 'unclassified' : 'response-decoding')
    assert.equal(result.failureCode, 'qwen_upstream_operation_failed')
    assert.equal(result.error, 'Qwen provider operation failed')
    assert.equal(f.raw.destroyed, stage === 'decoder',
      'Only a returned upstream body is owned and can be canceled by the forwarder')
    assert.equal(f.calls.forward, 1)
    assert.equal(f.calls.handler, stage === 'decoder' ? 1 : 0)
    assert.equal(f.calls.cleanup, 0)
    assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  })
}

for (const stream of [false, true]) {
  test('local91 confirmed Qwen China ' + (stream ? 'streaming' : 'JSON') +
    ' success remains successful and does not trigger cleanup', async () => {
    const f = fixture({ status: 200, stage: 'success', stream })
    const result = await f.execute()
    assert.equal(result.success, true)
    assert.equal(result.status, 200)
    if (stream) {
      assert.equal(result.stream, f.raw)
      assert.equal(result.skipTransform, true)
    } else {
      assert.equal(result.body, completed)
    }
    assert.equal(f.calls.forward, 1)
    assert.equal(f.calls.handler, 1)
    assert.equal(f.calls.cleanup, 0)
    f.raw.destroy()
  })
}
