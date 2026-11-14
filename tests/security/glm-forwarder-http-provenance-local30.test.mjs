import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

// Exercise the real product forwardGLM method in a closed VM. Numeric HTTP
// responses are synthetic; there is no imported provider client or network.
const source = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('forwarder.ts', source, ts.ScriptTarget.Latest, true)
let method
const visit = node => {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardGLM') {
    method = node.getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(method, 'must exercise the real GLM forwarder')
const js = ts.transpileModule(
  'class OfflineForwarder { ' + method + ' }\nexports.OfflineForwarder = OfflineForwarder',
  { fileName: 'forwarder.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } },
).outputText

const SECRET = 'SYNTHETIC_GLMPROVIDER_PRIVATE_BODY_LOCAL30'

function harness(status, stream) {
  const events = []
  const raw = new PassThrough({ autoDestroy: false })
  // Model replies and secrets must never be consumed on non-200.
  raw.end('Authorization Bearer ' + SECRET)
  class StubGLMAdapter {
    async chatCompletion() {
      events.push('single-synthetic-completion')
      return { response: { status, headers: { 'set-cookie': SECRET }, data: raw },
        conversationId: 'synthetic-conversation' }
    }
    async deleteConversation() { events.push('forbidden-cleanup') }
  }
  class UnexpectedHandler {
    constructor() { events.push('forbidden-decoder') }
  }
  const module = { exports: {} }
  vm.runInNewContext(js, {
    module, exports: module.exports, Date, Math, Promise, Error,
    GLMAdapter: StubGLMAdapter,
    GLMStreamHandler: UnexpectedHandler,
    shouldDeleteSession: () => true,
    hasCompletedNonStreamAnswer: () => { throw Error('forbidden completion validation') },
    unconfirmedProviderCompletion: () => { throw Error('forbidden synthetic answer') },
  }, { filename: 'forwarder.ts', timeout: 1500 })
  const forwarder = new module.exports.OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages, tools: undefined, plan: { mode: 'disabled' },
  })
  forwarder.applyToolCallsToResponse = () => { throw Error('forbidden tool parse') }
  return {
    raw, events,
    forward: () => forwarder.forwardGLM({
      model: 'synthetic-display', stream,
      messages: [{ role: 'user', content: 'synthetic only' }],
    }, { id: 'synthetic-account', credentials: {} }, { id: 'glm' },
    'synthetic-wire', Date.now()),
  }
}

for (const stream of [false, true]) {
  for (const [upstreamStatus, expectedLocalStatus] of [
    [401, 401], [503, 503], [302, 502], [206, 502], ['200', 502],
  ]) {
    test(`GLM ${stream ? 'stream' : 'nonstream'} known non-200 ${upstreamStatus} is fixed chat-completion failure`, async () => {
      const fixture = harness(upstreamStatus, stream)
      const result = await fixture.forward()
      assert.equal(result.success, false)
      assert.equal(result.status, expectedLocalStatus)
      assert.equal(result.error, 'Provider completion did not return HTTP 200')
      assert.equal(result.failureStage, 'chat-completion')
      assert.equal(result.failureCode, 'glm_upstream_operation_failed')
      assert.equal(fixture.raw.destroyed, true, 'abort original transport')
      assert.deepEqual(fixture.events, ['single-synthetic-completion'], 'no decode, retry or delete')
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET), 'no private response data')
      assert.equal(Object.hasOwn(result, 'upstreamHttpStatus'), false,
        'route must continue to distinguish local status from proven upstream status')
    })
  }
}
