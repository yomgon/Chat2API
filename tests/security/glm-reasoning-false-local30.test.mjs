import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Actual GLMAdapter.chatCompletion compiled from the current product, with
// a blocked authentication/upload environment and a synthetic HTTP 503 only.
const source = readFileSync(new URL('../../src/main/proxy/adapters/glm.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('glm.ts', source, ts.ScriptTarget.Latest, true)
const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'GLMAdapter')
assert.ok(klass)
const method = klass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'chatCompletion')
assert.ok(method)
const compiled = ts.transpileModule('class OfflineGLM {' + method.getText(ast) +
  '} exports.OfflineGLM=OfflineGLM', {
  fileName: 'glm-chatCompletion.ts',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const bodies = []
const network = { post: async (url, body, options) => {
  assert.equal(url, 'https://chatglm.cn/chatglm/backend-api/assistant/stream')
  assert.equal(options.maxRedirects, 0)
  bodies.push(body)
  return { status: 503, data: {}, headers: {} }
} }
const blocked = () => { throw Error('Forbidden GLM credential/upload/extra synthetic effect') }
const mod = { exports: {} }
vm.runInNewContext(compiled, {
  module: mod, exports: mod.exports, Date, Error,
  axios: network,
  generateSign: () => ({ sign: 'synthetic', timestamp: 'synthetic', nonce: 'synthetic' }),
  uuid: () => 'synthetic', GLM_API_BASE: 'https://chatglm.cn/chatglm',
  DEFAULT_ASSISTANT_ID: 'synthetic-default-id', FAKE_HEADERS: {},
  hasToolPromptInjected: () => false,
  toolsToSystemPrompt: blocked, TOOL_WRAP_HINT: '',
  console: { log() {}, error() {}, warn() {} },
}, { filename: 'glm-chatCompletion.ts', timeout: 2000, codeGeneration: { strings: false, wasm: false } })

for (const [label, flags, expected] of [
  ['explicit false with thinking alias', { reasoning_effort: false }, undefined],
  ['omitted reasoning with thinking alias', {}, 'zero'],
  ['explicit high with thinking alias', { reasoning_effort: 'high' }, 'zero'],
  ['explicit false without thinking alias', { reasoning_effort: false, originalModel: 'GLM-5.3' }, undefined],
  ['explicit deep_research still overrides reasoning', { deep_research: true, reasoning_effort: false }, 'deep_research'],
]) {
  test('GLM actual completion payload respects explicit reasoning option: ' + label, async () => {
    const instance = new mod.exports.OfflineGLM()
    instance.prepareAttachments = async () => []
    instance.acquireToken = async () => 'synthetic-not-real'
    instance.messagesToPrompt = () => [{ role: 'user', content: [{ type: 'text', text: 'synthetic-only' }] }]
    instance.uploadFile = blocked
    const before = bodies.length
    const result = await instance.chatCompletion({
      model: 'glm-5.3', originalModel: 'GLM-5.3-think',
      messages: [{ role: 'user', content: 'Synthetic question' }],
      stream: false, ...flags,
    })
    assert.equal(result.response.status, 503, 'Never manufacture a model success')
    assert.equal(bodies.length, before + 1)
    assert.equal(bodies.at(-1).meta_data.chat_mode, expected)
    assert.equal(bodies.at(-1).assistant_id, 'synthetic-default-id')
  })
}
