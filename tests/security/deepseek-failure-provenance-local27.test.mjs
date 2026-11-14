import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// The current first-party DeepSeek forwarder, with an inert adapter and an
// in-memory stream. No token, profile, OS store, provider POST or HTTP server.
const source = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('forwarder.ts', source, ts.ScriptTarget.Latest, true)
const methods = []
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardDeepSeek')
    methods.push(node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(methods.length, 1)
const compiled = ts.transpileModule('class OfflineForwarder {' + methods[0] +
  '} exports.OfflineForwarder=OfflineForwarder', { fileName: 'forwardDeepSeek.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const PRIVATE = 'SYNTHETIC_PRIVATE_DEEPSEEK_TOKEN_IN_AXIOS_URL'
const blocked = () => { throw Error('Unauthorized extra synthetic or live effect') }

function setup({ stage, stream = false, status = 200 } = {}) {
  const effects = [], input = new PassThrough({ autoDestroy: false })
  const response = { status, data: input, headers: {} }
  class FakeDeepSeekAdapter {
    async chatCompletion(request) {
      effects.push(['completion', request.model, request.originalModel])
      if (stage === 'preflight') {
        const error = new Error('Authorization Bearer ' + PRIVATE)
        error.response = { status: 403, data: { private: PRIVATE } }
        error.config = { url: 'https://synthetic.invalid/?token=' + PRIVATE }
        throw error
      }
      return { response, sessionId: 'synthetic-session' }
    }
    async deleteSession() { return blocked() }
  }
  class FakeHandler {
    handleNonStream() {
      if (stage === 'decoder') throw Error('Decoder URL secret=' + PRIVATE)
      return { choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'Synthetic completed answer' } }] }
    }
    async handleStream() {
      if (stage === 'decoder') throw Error('Decoder stream secret=' + PRIVATE)
      return new PassThrough()
    }
  }
  const context = {
    module: { exports: {} }, Date, Math, Error,
    DeepSeekAdapter: FakeDeepSeekAdapter,
    DeepSeekStreamHandler: FakeHandler,
    shouldDeleteSession: () => false,
    hasCompletedNonStreamAnswer: result =>
      result?.choices?.[0]?.finish_reason === 'stop' &&
      !!result.choices[0].message?.content,
    unconfirmedProviderCompletion: blocked,
  }
  context.exports = context.module.exports
  vm.runInNewContext(compiled, context, { filename: 'forwardDeepSeek.ts', timeout: 1600 })
  const forwarder = new context.module.exports.OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = req => ({
    messages: req.messages, tools: undefined, plan: {},
  })
  forwarder.applyToolCallsToResponse = () => {}
  forwarder.extractHeaders = () => ({})
  const request = { model: 'synthetic-deepseek-display', stream,
    messages: [{ role: 'user', content: 'SYNTHETIC_NO_NETWORK' }] }
  const execute = () => forwarder.forwardDeepSeek(request,
    { id: 'synthetic-account', credentials: {} },
    { id: 'deepseek', apiEndpoint: 'https://chat.deepseek.com' },
    'synthetic-wire-model', Date.now())
  return { execute, effects, input }
}

for (const stream of [false, true]) {
  test('DeepSeek ' + (stream ? 'stream' : 'nonstream') +
    ' preflight exception reports fixed diagnostics without private raw Error', async () => {
    const h = setup({ stage: 'preflight', stream })
    const result = await h.execute()
    assert.equal(result.success, false)
    assert.equal(result.status, 502, 'No observed completion response; synthetic local failure')
    assert.equal(result.failureStage, 'unclassified')
    assert.equal(result.failureCode, 'deepseek_upstream_operation_failed')
    assert.equal(result.error, 'DeepSeek provider operation failed')
    assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE))
    assert.equal(h.effects.length, 1, 'No automatic retry')
    assert.equal(h.effects[0][1], 'synthetic-wire-model')
  })

  test('DeepSeek ' + (stream ? 'stream' : 'nonstream') +
    ' decoder failure closes original stream and cannot reflect provider detail', async () => {
    const h = setup({ stage: 'decoder', stream })
    const result = await h.execute()
    assert.equal(result.success, false)
    assert.equal(result.status, 502)
    assert.equal(result.failureStage, 'response-decoding')
    assert.equal(result.failureCode, 'deepseek_upstream_operation_failed')
    assert.equal(result.error, 'DeepSeek provider operation failed')
    assert.equal(h.input.destroyed, true, 'Original upstream stream must not leak')
    assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE))
    assert.equal(h.effects.length, 1)
  })
}

for (const [status, clientStatus] of [[401, 401], [429, 429], [302, 502], [599, 599], [200, 200]]) {
  test('DeepSeek actual returned HTTP ' + status + ' has correct local status and no retry', async () => {
    const h = setup({ status })
    const result = await h.execute()
    assert.equal(result.success, status === 200)
    assert.equal(result.status, clientStatus)
    if (status !== 200) {
      assert.equal(result.failureStage, 'chat-completion')
      assert.equal(result.failureCode, 'deepseek_upstream_operation_failed')
      assert.equal(h.input.destroyed, true)
    }
    assert.equal(h.effects.length, 1)
  })
}
