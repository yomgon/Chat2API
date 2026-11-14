import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { PassThrough } from 'node:stream'
import * as streams from 'node:stream'
import * as zlib from 'node:zlib'
import crypto from 'node:crypto'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'

// The REAL consumer-web adapters and forwarder methods are exercised with
// synthetic Axios results only. No app, profiles, provider network, real keys,
// browser state, deletion, retry or other external effect can occur.
const source = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
const compile = (code, name) => ts.transpileModule(code, {
  fileName: name, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
const denied = () => { throw Error('No real provider operation allowed in redirect test') }
const quiet = { log() {}, warn() {}, error() {}, info() {} }
function evaluate(code, modules = {}, globals = {}, name = 'offline.ts') {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports,
    Buffer, Date, Math, Error, URL, URLSearchParams, Promise,
    console: quiet, setTimeout, clearTimeout,
    ...globals,
    require(specifier) {
      if (Object.hasOwn(modules, specifier)) return modules[specifier]
      throw Error('Unexpected offline module ' + name + ' / ' + specifier)
    },
  }, { filename: name, timeout: 1500 })
  return mod.exports
}

const models = evaluate(compile(source('adapters/providerModelOptions.ts'), 'providerModelOptions.ts'))
const generic = {
  '../../providers/qwenTicket': QWEN_TICKET_MODULE,
  stream: streams, zlib, crypto, path: {},
  'zstd-codec': { ZstdCodec: { run: denied } },
  'eventsource-parser': { createParser: denied },
  'form-data': { __esModule: true, default: class FormData {} },
  'mime-types': {},
  '../../store/store': { storeManager: {} },
  '../../lib/challenge': { getDeepSeekHash: denied },
  './providerModelOptions': models,
  '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  '../utils/tools': { hasToolPromptInjected: () => false, shouldInjectToolPrompt: () => false,
    toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
  '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
  '../utils/streamToolHandler': { createBaseChunk: (id, model, created) =>
    ({ id, model, created, object: 'chat.completion.chunk' }) },
  '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
}

for (const provider of ['deepseek', 'qwen', 'glm']) {
  test(provider + ' actual credentialed completion request disables redirect following', async () => {
    const calls = []
    const stubAxios = {
      __esModule: true,
      default: {
        get: denied,
        post: async (url, body, config) => {
          calls.push({ url, body, config })
          return { status: 302, headers: { location: 'https://unsafe.example.invalid/' },
            data: new PassThrough() }
        },
        create: () => ({ post: async (url, body, config) => {
          calls.push({ url, body, config })
          return { status: 302, headers: { location: 'https://unsafe.example.invalid/' },
            data: new PassThrough() }
        } }),
      },
    }
    const module = evaluate(compile(source('adapters/' + provider + '.ts'), provider + '.ts'),
      { ...generic, axios: stubAxios }, {}, provider + '.ts')
    const name = provider === 'deepseek' ? 'DeepSeekAdapter'
      : provider === 'qwen' ? 'QwenAdapter' : 'GLMAdapter'
    const credentials = provider === 'qwen'
      ? { ticket: 'SYNTHETIC_TICKET_ONLY' } : { token: 'SYNTHETIC_TOKEN_ONLY' }
    const adapter = new module[name]({ id: provider, apiEndpoint: 'https://synthetic.invalid' },
      { id: 'synthetic-fixed-account', providerId: provider, credentials })
    if (provider === 'deepseek') {
      adapter.acquireToken = async () => 'synthetic-access-token'
      adapter.createSession = async () => 'synthetic-session'
      adapter.getChallenge = async () => ({})
      adapter.calculateChallengeAnswer = async () => 'synthetic-pow'
      adapter.messagesToPrompt = () => 'synthetic message'
    }
    if (provider === 'glm') {
      adapter.acquireToken = async () => 'synthetic-access-token'
      adapter.extractFileUrls = () => ({ fileUrls: [], imageUrls: [] })
      adapter.messagesToPrompt = messages => messages
    }
    await adapter.chatCompletion({
      model: provider === 'qwen' ? 'Qwen3.7-Max' : 'synthetic-model',
      messages: [{ role: 'user', content: 'synthetic question' }],
      web_search: false,
    })
    assert.equal(calls.length, 1, 'only one mocked completion POST')
    assert.equal(calls[0].config.maxRedirects, 0, 'no follow-redirect credential forwarding')
    assert.match(calls[0].url, /^https:\/\//)
    if (provider === 'qwen') {
      assert.equal(calls[0].config.validateStatus?.(302), true,
        'Qwen must return the refused redirect to its own fail-closed forwarder')
    }
  })
}

const forwardAst = ts.createSourceFile('forwarder.ts', source('forwarder.ts'), ts.ScriptTarget.Latest, true)
const names = ['forwardDeepSeek', 'forwardGLM', 'forwardQwen']
const methods = new Map()
function visit(node) {
  if (ts.isMethodDeclaration(node)) {
    const label = node.name.getText(forwardAst)
    if (names.includes(label)) methods.set(label, node.getText(forwardAst))
  }
  ts.forEachChild(node, visit)
}
visit(forwardAst)
assert.equal(methods.size, 3)

for (const provider of ['deepseek', 'qwen', 'glm']) {
  test(provider + ' real forwarder rejects a provider HTTP 302/201 before parsing or cleanup', async () => {
    const statusValues = [302, 201, 403]
    for (const upstreamStatus of statusValues) {
      const effects = []
      const body = new PassThrough({ autoDestroy: false })
      const StubAdapter = class {
        async chatCompletion() {
          effects.push('mocked-post')
          return { response: { status: upstreamStatus, data: body,
            headers: { location: 'https://unsafe.example.invalid/' } },
            sessionId: 'synthetic-session', reqId: 'synthetic-req',
            conversationId: 'synthetic-conversation' }
        }
        async deleteSession() { effects.push('unexpected-delete') }
        async deleteConversation() { effects.push('unexpected-delete') }
      }
      const NoDecoder = class {
        constructor() { effects.push('unexpected-decoder') }
      }
      const globals = {
        DeepSeekAdapter: StubAdapter, QwenAdapter: StubAdapter, GLMAdapter: StubAdapter,
        DeepSeekStreamHandler: NoDecoder, QwenStreamHandler: NoDecoder, GLMStreamHandler: NoDecoder,
        shouldDeleteSession: () => true,
        unconfirmedProviderCompletion: () => { throw Error('Unexpected synthetic success') },
        hasCompletedNonStreamAnswer: () => true,
      }
      const code = compile('class OfflineForwarder {' + methods.get({
        deepseek: 'forwardDeepSeek', qwen: 'forwardQwen', glm: 'forwardGLM',
      }[provider]) + '} exports.OfflineForwarder=OfflineForwarder', 'forwarder.ts')
      const { OfflineForwarder } = evaluate(code, {}, globals, 'forwarder.ts')
      const forwarder = new OfflineForwarder()
      forwarder.transformRequestForPromptToolUse = request => ({
        messages: request.messages, plan: {}, tools: undefined,
      })
      forwarder.applyToolCallsToResponse = () => denied()
      const result = await forwarder[{
        deepseek: 'forwardDeepSeek', qwen: 'forwardQwen', glm: 'forwardGLM',
      }[provider]]({ model: 'synthetic-display',
        messages: [{ role: 'user', content: 'synthetic prompt' }], stream: false,
      }, { id: 'synthetic-account', credentials: {} },
      { id: provider, apiEndpoint: 'https://synthetic.invalid' }, 'synthetic-model', Date.now())

      assert.equal(result.success, false)
      assert.equal(result.status, upstreamStatus === 403 ? 403 : 502,
        'unexpected 2xx/3xx cannot be reported as a valid model completion')
      assert.equal(body.destroyed, true, 'do not leave rejected HTTP body open')
      assert.deepEqual(effects, ['mocked-post'], 'no decode, cleanup or retry')
      assert.equal(JSON.stringify(result).includes('https://unsafe.example.invalid'), false)
    }
  })
}
