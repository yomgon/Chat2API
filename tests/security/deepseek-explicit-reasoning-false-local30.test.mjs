import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Actual DeepSeek option resolver and completion payload, with every provider
// operation replaced by an in-memory stub. No application, account, network,
// challenge file, operating credentials, retry or cleanup is ever loaded.
function load(relative, dependencies = {}) {
  const source = readFileSync(new URL('../../src/main/proxy/adapters/' + relative, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { fileName: relative,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true } }).outputText
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Date, Math, Buffer, Error,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw Error('Forbidden synthetic import: ' + name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

const options = load('providerModelOptions.ts')
const payloads = []
const syntheticAxios = { post: async (url, body, config) => {
  assert.equal(url, 'https://chat.deepseek.com/api/v0/chat/completion')
  assert.equal(config.maxRedirects, 0)
  payloads.push(body)
  return { status: 503, data: { destroy() {} }, headers: {} }
} }
const { DeepSeekAdapter } = load('deepseek.ts', {
  axios: { __esModule: true, default: syntheticAxios },
  '../../lib/challenge': { getDeepSeekHash() { throw Error('No real PoW') } },
  './providerModelOptions': options,
  '../toolCalling/providerProfiles': { getProviderToolProfile() { throw Error('No tools') } },
})

for (const [label, flags, expected] of [
  ['explicit false with thinking alias', { reasoning_effort: false }, false],
  ['omitted option with thinking alias', {}, true],
  ['explicit high with thinking alias', { reasoning_effort: 'high' }, true],
  ['explicit false without thinking alias', { reasoning_effort: false, originalModel: 'Plain' }, false],
]) {
  test('DeepSeek actual chat payload respects request priority: ' + label, async () => {
    const adapter = new DeepSeekAdapter({ id: 'deepseek' },
      { id: 'synthetic-only', credentials: { token: 'synthetic-private-not-real' } })
    adapter.acquireToken = async () => 'synthetic-valid-token'
    adapter.createSession = async () => 'synthetic-session'
    adapter.getChallenge = async () => ({})
    adapter.calculateChallengeAnswer = async () => 'synthetic-challenge-answer'
    adapter.messagesToPrompt = () => 'synthetic-prompt'
    const before = payloads.length
    const response = await adapter.chatCompletion({
      model: 'deepseek-v4-flash',
      originalModel: 'deepseek-v4-flash-think',
      messages: [{ role: 'user', content: 'synthetic text only' }],
      stream: false,
      ...flags,
    })
    assert.equal(response.response.status, 503, 'Never invent completed provider response')
    assert.equal(payloads.length, before + 1)
    assert.equal(payloads.at(-1).thinking_enabled, expected)
    assert.equal(payloads.at(-1).model_type, 'default')
  })
}

test('Direct resolver has identical false/omitted/true priority with public aliases', () => {
  const baseline = { model: 'deepseek-v4-pro', originalModel: 'deepseek-v4-pro-r1' }
  assert.equal(options.resolveDeepSeekChatOptions({ ...baseline, reasoning_effort: false }).thinkingEnabled, false)
  assert.equal(options.resolveDeepSeekChatOptions({ ...baseline }).thinkingEnabled, true)
  assert.equal(options.resolveDeepSeekChatOptions({ ...baseline, reasoning_effort: 'low' }).thinkingEnabled, true)
  assert.equal(options.resolveDeepSeekChatOptions({ ...baseline, reasoning_effort: false }).modelType, 'expert')
})
