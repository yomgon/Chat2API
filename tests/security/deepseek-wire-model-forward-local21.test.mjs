import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { resolveDeepSeekChatOptions } from '../../src/main/proxy/adapters/providerModelOptions.ts'

// Run the actual dedicated forwarder against an inert synthetic adapter.
// The real account store, network, browser and provider POST are never loaded.
const source = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { fileName: 'forwarder.ts', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText

function harness(requestedModel, wireModel, extras = {}) {
  const sent = []
  const FakeAdapter = class {
    static isDeepSeekProvider(provider) { return provider.id === 'deepseek' }
    static isGLMProvider() { return false }
    static isKimiProvider() { return false }
    static isQwenProvider() { return false }
    static isQwenAiProvider() { return false }
    static isZaiProvider() { return false }
    static isMimoProvider() { return false }
    static isMiniMaxProvider() { return false }
    static isPerplexityProvider() { return false }
    async chatCompletion(request) {
      sent.push(structuredClone(request))
      return { response: { status: 200, headers: {}, data: new PassThrough() }, sessionId: 'synthetic' }
    }
  }
  class Handler {
    async handleNonStream() { return { choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: 'synthetic completed answer' } }] } }
  }
  const deps = {
    axios: { __esModule: true, default: { create: () => ({}) } },
    http2: { __esModule: true, default: {} },
    stream: { PassThrough },
    '../store/store': { storeManager: { getConfig: () => ({ retryCount: 3 }) } },
    './status': { proxyStatusManager: {} },
    './streamTerminalGate': { hasCompletedNonStreamAnswer: value =>
      value?.choices?.[0]?.finish_reason === 'stop' &&
      typeof value.choices[0].message?.content === 'string' &&
      !!value.choices[0].message.content.trim() },
    './adapters/deepseek': { DeepSeekAdapter: FakeAdapter },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: Handler },
    './adapters/glm': { GLMAdapter: FakeAdapter, GLMStreamHandler: Handler },
    './adapters/kimi': { KimiAdapter: FakeAdapter, KimiProxyFailure: class extends Error {}, KimiStreamHandler: Handler },
    './adapters/mimo': { MimoAdapter: FakeAdapter, MimoStreamHandler: Handler },
    './adapters/qwen': { QwenAdapter: FakeAdapter, QwenStreamHandler: Handler },
    './adapters/qwen-ai': { QwenAiAdapter: FakeAdapter, QwenAiProxyFailure: class extends Error {}, QwenAiStreamHandler: Handler },
    './adapters/zai': { ZaiAdapter: FakeAdapter, ZaiProxyFailure: class extends Error {}, ZaiStreamHandler: Handler },
    './adapters/minimax': { MiniMaxAdapter: FakeAdapter, MiniMaxStreamHandler: Handler },
    './adapters/perplexity': { PerplexityAdapter: FakeAdapter },
    './adapters/perplexity-stream': { PerplexityStreamHandler: Handler },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class {} },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => false } },
    './services/contextManagementService': { createContextManagementService: () => { throw Error('Unexpected extra model effect') } },
  }
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Buffer, URL, Error,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      throw Error('Forbidden synthetic import: ' + name)
    },
    console: { log() {}, error() {}, warn() {} },
  }, { filename: 'forwarder.ts', timeout: 2000 })
  const forwarder = new mod.exports.RequestForwarder()
  forwarder.transformRequestForPromptToolUse = req => ({ messages: req.messages, tools: undefined, plan: {} })
  forwarder.applyToolCallsToResponse = () => {}
  const request = { model: requestedModel, messages: [{ role: 'user', content: 'synthetic' }],
    stream: false, ...extras }
  const dispatch = () => forwarder.forwardChatCompletion(request,
    { id: 'synthetic', providerId: 'deepseek', status: 'active', credentials: {} },
    { id: 'deepseek', enabled: true, apiEndpoint: 'https://chat.deepseek.com' },
    wireModel, { requestId: 'synthetic', model: requestedModel, actualModel: wireModel,
      startTime: Date.now(), isStream: false })
  return { dispatch, sent }
}

test('DeepSeek discovered web label must send its exact expert wire ID', async () => {
  const h = harness('专家模式', 'expert')
  assert.equal((await h.dispatch()).success, true)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].model, 'expert')
  assert.equal(resolveDeepSeekChatOptions(h.sent[0]).modelType, 'expert')
})

test('Explicit mapped default overrides a misleading expert-like public alias', async () => {
  const h = harness('deepseek-v4-pro-search', 'default')
  assert.equal((await h.dispatch()).success, true)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].model, 'default')
  assert.equal(h.sent[0].originalModel, 'deepseek-v4-pro-search')
  assert.deepEqual(resolveDeepSeekChatOptions(h.sent[0]), {
    modelType: 'default', searchEnabled: true, thinkingEnabled: false,
  })
})

test('Legacy unmapped model and explicit feature flags remain meaningful', async () => {
  const h = harness('deepseek-v4-pro-think', 'deepseek-v4-pro',
    { web_search: true, reasoning_effort: 'high' })
  assert.equal((await h.dispatch()).success, true)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].model, 'deepseek-v4-pro')
  assert.deepEqual(resolveDeepSeekChatOptions(h.sent[0]), {
    modelType: 'expert', searchEnabled: true, thinkingEnabled: true,
  })
})
