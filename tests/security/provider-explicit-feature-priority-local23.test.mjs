import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as stream from 'node:stream'
import * as zlib from 'node:zlib'
import crypto from 'node:crypto'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'

// Actual product option resolver, Qwen adapter + Qwen forwarder and GLM
// completion payload, with no accounts/files/HTTP/provider effects.
const source = rel => readFileSync(new URL('../../src/main/proxy/' + rel, import.meta.url), 'utf8')
const compile = (text, name) => ts.transpileModule(text, {
  fileName: name,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const blocked = () => { throw Error('Provider network and local account effects forbidden in local23') }
const logs = []
const quiet = Object.fromEntries(['log', 'error', 'warn', 'info'].map(level =>
  [level, (...args) => logs.push({ level, args })]))

function load(code, deps, name, globals = {}) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, Date, Math, URL, URLSearchParams, Error,
    console: quiet, setTimeout, clearTimeout,
    require(specifier) {
      if (Object.hasOwn(deps, specifier)) return deps[specifier]
      throw Error('Unexpected import in ' + name + ': ' + specifier)
    },
    ...globals,
  }, { filename: name, timeout: 1500 })
  return mod.exports
}
const common = {
  '../../providers/qwenTicket': QWEN_TICKET_MODULE,
  stream,
  crypto,
  zlib,
  '../utils/tools': {
    toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '',
    shouldInjectToolPrompt: () => false, hasToolPromptInjected: () => false,
  },
  '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
  '../utils/streamToolHandler': { createBaseChunk: (id, model, created) =>
    ({ id, model, created, object: 'chat.completion.chunk' }) },
  '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
  '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  '../../store/store': { storeManager: {} },
  'eventsource-parser': { createParser: blocked },
  'form-data': { __esModule: true, default: class FormData {} },
  'mime-types': {}, path: {},
  'zstd-codec': { ZstdCodec: { run: blocked } },
}

const opts = load(compile(source('adapters/providerModelOptions.ts'), 'providerModelOptions.ts'),
  {}, 'providerModelOptions.ts')
test('DeepSeek explicit web_search false overrides a search-bearing display alias', () => {
  for (const [provided, expected] of [[undefined, true], [false, false], [true, true]]) {
    const result = opts.resolveDeepSeekChatOptions({
      model: 'expert',
      originalModel: 'deepseek-v4-pro-search',
      ...(provided === undefined ? {} : { web_search: provided }),
    })
    assert.equal(result.modelType, 'expert')
    assert.equal(result.searchEnabled, expected)
  }
})

const qwenCalls = []
const qwen = load(compile(source('adapters/qwen.ts'), 'qwen.ts'), {
  ...common,
  axios: { __esModule: true, default: {
    create: () => ({ post: async (_url, payload, config) => {
      qwenCalls.push({ payload, config })
      return { status: 502, headers: {}, data: {} }
    } }),
    post: blocked, get: blocked,
  } },
}, 'qwen.ts')
test('Qwen China preserves explicit search/thinking false and infers only when absent', async () => {
  for (const [provided, expected] of [[undefined, true], [false, false], [true, true]]) {
    const before = qwenCalls.length
    const request = {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max-think-search',
      messages: [{ role: 'user', content: 'synthetic message' }],
      ...(provided === undefined ? {} : { enableThinking: provided, enableWebSearch: provided }),
    }
    const adapter = new qwen.QwenAdapter({ id: 'qwen' }, {
      id: 'synthetic', credentials: { ticket: 'SYNTHETIC_TICKET_PRIVATE' },
    })
    await adapter.chatCompletion(request)
    assert.equal(qwenCalls.length, before + 1)
    const body = qwenCalls.at(-1).payload
    assert.equal(body.enable_search, expected, 'actual Qwen wire search flag')
    assert.equal(body.deep_search === '1', expected, 'actual Qwen deep-search flag')
  }
})

const ast = ts.createSourceFile('forwarder.ts', source('forwarder.ts'), ts.ScriptTarget.Latest, true)
let forwardQwenMethod
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardQwen')
    forwardQwenMethod = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(typeof forwardQwenMethod, 'string')
const sent = []
const forwarderModule = load(compile('class OfflineForwarder {' + forwardQwenMethod +
  '} exports.OfflineForwarder=OfflineForwarder', 'forwardQwen.ts'), {}, 'forwardQwen.ts', {
  QwenAdapter: class {
    async chatCompletion(request) {
      sent.push(request)
      // Deliberately reject: payload inspection is not a synthetic model answer.
      return { response: { status: 401, headers: {}, data: {} }, sessionId: '', reqId: '' }
    }
  },
})
test('actual forwardQwen keeps missing feature flags distinct from explicit false', async () => {
  const forwarder = new forwarderModule.OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = req => ({
    messages: req.messages, tools: undefined, plan: {},
  })
  const provider = { id: 'qwen', apiEndpoint: 'https://synthetic.invalid' }
  const account = { id: 'synthetic-account', credentials: {} }
  for (const [flags, expected] of [
    [{}, undefined], [{ web_search: false }, false], [{ web_search: true, reasoning_effort: 'high' }, true],
  ]) {
    const before = sent.length
    await forwarder.forwardQwen({
      model: 'Qwen3.7-Max-search', messages: [{ role: 'user', content: 'synthetic' }],
      ...flags,
    }, account, provider, 'Qwen3.7-Max', Date.now())
    assert.equal(sent.length, before + 1)
    assert.equal(sent.at(-1).enableWebSearch, expected)
    assert.equal(sent.at(-1).enableThinking,
      flags.reasoning_effort === undefined ? undefined : true)
  }
})

const glmCalls = []
const glm = load(compile(source('adapters/glm.ts'), 'glm.ts'), {
  ...common,
  axios: { __esModule: true, default: {
    post: async (_url, payload, config) => {
      glmCalls.push({ payload, config })
      return { status: 502, headers: {}, data: {} }
    }, get: blocked,
  } },
}, 'glm.ts')
test('GLM explicit deep_research false overrides deepresearch display alias', async () => {
  for (const [provided, expected] of [[undefined, 'deep_research'], [false, undefined], [true, 'deep_research']]) {
    const adapter = new glm.GLMAdapter({ id: 'glm' }, {
      id: 'synthetic', credentials: {},
    })
    adapter.acquireToken = async () => 'SYNTHETIC_GLMTOKEN'
    adapter.extractFileUrls = () => ({ fileUrls: [], imageUrls: [] })
    adapter.messagesToPrompt = messages => messages
    const before = glmCalls.length
    await adapter.chatCompletion({
      model: 'glm-4.7',
      originalModel: 'GLM-4.7-deepresearch',
      messages: [{ role: 'user', content: 'synthetic question' }],
      ...(provided === undefined ? {} : { deep_research: provided }),
    })
    assert.equal(glmCalls.length, before + 1)
    assert.equal(glmCalls.at(-1).payload.meta_data.chat_mode, expected)
  }
})
