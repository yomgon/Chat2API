import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

// Real forwardGLM method from the product; all remote effects are synthetic
// and denied. A transport/decoder error may contain credentials or an
// arbitrary attachment URL. It must never become a raw ForwardResult.
const product = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('forwarder.ts', product, ts.ScriptTarget.Latest, true)
const method = (() => {
  let found
  const walk = node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'forwardGLM') found = node.getText(tree)
    ts.forEachChild(node, walk)
  }
  walk(tree)
  assert.ok(found)
  return found
})()
const compiled = ts.transpileModule('class OfflineForwarder { ' + method + ' }\nexports.OfflineForwarder = OfflineForwarder', {
  fileName: 'forwarder.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const SECRET = 'SYNTHETIC_PRIVATE_BEARER_AND_INTERNAL_URL_LOCAL25'

function setup(stage, stream) {
  const effects = []
  const original = new PassThrough({ autoDestroy: false })
  let decodeCount = 0
  class StubGLM {
    async chatCompletion() {
      effects.push('synthetic-completion-attempt')
      if (stage === 'preflight') throw new Error('Authorization Bearer ' + SECRET)
      return {
        response: { status: 200, headers: {}, data: original },
        conversationId: 'synthetic-only',
      }
    }
    async deleteConversation() { effects.push('forbidden-delete') }
  }
  class StubHandler {
    constructor() { decodeCount++ }
    handleStream() { throw new Error('https://127.0.0.1/internal?token=' + SECRET) }
    handleNonStream() { throw new Error('https://127.0.0.1/internal?token=' + SECRET) }
  }
  const globals = {
    module: { exports: {} }, exports: {},
    Promise, Date, Math, Error,
    GLMAdapter: StubGLM, GLMStreamHandler: StubHandler,
    shouldDeleteSession: () => true,
    hasCompletedNonStreamAnswer: () => true,
    unconfirmedProviderCompletion: () => { throw Error('Unexpected completion') },
  }
  globals.exports = globals.module.exports
  vm.runInNewContext(compiled, globals, { filename: 'forwarder.ts', timeout: 1500 })
  const forwarder = new globals.module.exports.OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages, plan: null, tools: undefined,
  })
  forwarder.applyToolCallsToResponse = () => { throw Error('Unexpected application') }
  return {
    effects, original, get decodeCount() { return decodeCount },
    call: () => forwarder.forwardGLM({
      model: 'synthetic-glm-display', stream,
      messages: [{ role: 'user', content: 'Synthetic-only question' }],
    }, { id: 'synthetic-account', credentials: {} }, {
      id: 'glm', name: 'Synthetic GLM', apiEndpoint: 'https://synthetic.invalid',
    }, 'synthetic-glm-wire', Date.now()),
  }
}

for (const stream of [false, true]) {
  test('GLM real forwarder ' + (stream ? 'stream' : 'nonstream') + ' preflight failure never reflects raw error', async () => {
    const fixture = setup('preflight', stream)
    const result = await fixture.call()
    assert.equal(result.success, false)
    assert.equal(result.status, 502)
    assert.equal(result.error, 'GLM provider operation failed')
    assert.equal(result.failureStage, 'unclassified')
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
    assert.deepEqual(fixture.effects, ['synthetic-completion-attempt'])
    assert.equal(fixture.decodeCount, 0)
  })

  test('GLM real forwarder ' + (stream ? 'stream' : 'nonstream') + ' decoder failure closes original body and reports fixed error', async () => {
    const fixture = setup('response', stream)
    const result = await fixture.call()
    assert.equal(result.success, false)
    assert.equal(result.status, 502)
    assert.equal(result.error, 'GLM provider operation failed')
    assert.equal(result.failureStage, 'response-decoding')
    assert.equal(fixture.original.destroyed, true, 'do not leave upstream response open after failed decoder')
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
    assert.deepEqual(fixture.effects, ['synthetic-completion-attempt'])
    assert.equal(fixture.decodeCount, 1)
  })
}
