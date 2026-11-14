import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { createParser } from 'eventsource-parser'
import vm from 'node:vm'
import ts from 'typescript'

// Current production adapter and forwardQwen method, intercepted at the Axios
// transport boundary. Never open provider sockets, browser, sessions or files.
const req = createRequire(import.meta.url)
const source = relative => readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8')
const compile = (code, filename) => ts.transpileModule(code, { fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
const adapterCode = compile(source('proxy/adapters/qwen.ts'), 'qwen.ts')
const ticketCode = compile(source('providers/qwenTicket.ts'), 'qwenTicket.ts')
const forwarderSource = source('proxy/forwarder.ts')
const tree = ts.createSourceFile('forwarder.ts', forwarderSource, ts.ScriptTarget.Latest, true)
const methods = []
function walk(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'forwardQwen')
    methods.push(node.getText(tree))
  ts.forEachChild(node, walk)
}
walk(tree)
assert.equal(methods.length, 1, 'Must use the production Qwen forwarder')
const forwarderCode = compile('class OfflineForwarder {' + methods[0] +
  '} exports.OfflineForwarder = OfflineForwarder', 'forwardQwen.ts')
const PRIVATE = 'SYNTHETIC_QWEN_CHINA_PRIVATE_LOCAL86'
const blocked = () => { throw Error('Unexpected extra session, cleanup, network or retry operation') }

function load(code, deps, globals = {}, name = 'Qwen offline') {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, URL, Date, Math, Error,
    TextDecoder, Uint8Array, setTimeout, clearTimeout,
    console: Object.fromEntries(['log', 'warn', 'error'].map(name => [name, () => {}])),
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      throw Error('Unexpected dependency in synthetic test: ' + id)
    },
    ...globals,
  }, { filename: name, timeout: 1800 })
  return mod.exports
}

function harness(credentials = { ticket: PRIVATE }, overrides = {}) {
  const posts = [], selected = []
  const axios = {
    create: () => ({
      async post(url, data, config) {
        posts.push({ url, data, config })
        return { status: 503, headers: {}, data: { destroy() {} } }
      },
      get: blocked, delete: blocked, request: blocked,
    }),
    post: blocked, get: blocked, delete: blocked,
  }
  const ticket = load(ticketCode, {}, {}, 'production-qwenTicket.ts')
  const exports = load(adapterCode, {
    axios: { __esModule: true, default: axios },
    stream: { PassThrough }, zlib: req('node:zlib'),
    'zstd-codec': { ZstdCodec: { run: blocked } },
    'eventsource-parser': { createParser },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
    '../utils/tools': { hasToolPromptInjected: () => false,
      shouldInjectToolPrompt: () => false,
      toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: c => ({ content: c, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: () => ({}) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
    '../../providers/qwenTicket': ticket,
  }, {}, 'actual-qwen-china.ts')
  const provider = { id: 'qwen', type: 'builtin', name: 'Qwen China', enabled: true,
    apiEndpoint: 'https://chat2.qianwen.com', ...overrides }
  const account = { id: 'synthetic-qwen-china-account', providerId: 'qwen', credentials }
  class ObservedAdapter extends exports.QwenAdapter {
    async chatCompletion(request) { selected.push(request); return super.chatCompletion(request) }
  }
  const { OfflineForwarder } = load(forwarderCode, {}, {
    QwenAdapter: ObservedAdapter, QwenStreamHandler: class { constructor() { blocked() } },
    shouldDeleteSession: blocked, hasCompletedNonStreamAnswer: blocked,
    unconfirmedProviderCompletion: blocked,
  }, 'actual-forwardQwen.ts')
  const forwarder = new OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = req => ({ messages: req.messages,
    tools: undefined, plan: { mode: 'disabled', shouldParseResponse: false } })
  return { provider, account, posts, selected, forwarder, adapter: new exports.QwenAdapter(provider, account) }
}

for (const [description, display, wire, reasoning, expectedDeepSearch] of [
  ['literal catalog model looks like legacy alias', 'Qwen China Display', 'Qwen3.6', undefined, '0'],
  ['literal catalog thinking switch must not select another model',
    'Qwen3-Max-thinking', 'Qwen3-Max', 'high', '1'],
  ['ordinary literal wire remains unchanged', 'Exact Catalog', 'tongyi-catalog-wire', undefined, '0'],
]) {
  test('RED production forwardQwen preserves selected exact wire: ' + description, async () => {
    const h = harness()
    const result = await h.forwarder.forwardQwen({ model: display, stream: false,
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
      messages: [{ role: 'user', content: 'LOCAL86_QWEN_WIRE_NO_REPLAY' }] },
    h.account, h.provider, wire, Date.now())
    assert.equal(result.success, false)
    assert.equal(result.status, 503)
    assert.equal(h.selected.length, 1)
    assert.equal(h.posts.length, 1, 'One synthetic upstream attempt; automatic retry0')
    assert.equal(h.posts[0].data.model, wire, 'Exact catalog wire must not be remapped')
    assert.equal(h.posts[0].data.deep_search, expectedDeepSearch)
    assert.equal(h.posts[0].config.maxRedirects, 0)
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  })
}

test('direct legacy Qwen adapter still maps old display-name alias without resolved flag', async () => {
  const h = harness()
  const { response } = await h.adapter.chatCompletion({ model: 'Qwen3.6',
    messages: [{ role: 'user', content: 'LOCAL86_DIRECT_LEGACY_COMPAT' }] })
  assert.equal(response.status, 503)
  assert.equal(h.posts.length, 1)
  assert.equal(h.posts[0].data.model, 'Qwen')
})

for (const [label, credentials] of [
  ['conflicting aliases', { ticket: PRIVATE, tongyi_sso_ticket: 'DIFFERENT_SYNTHETIC' }],
  ['object ticket coerces into Cookie header', { ticket: { token: PRIVATE } }],
  ['array ticket coerces into Cookie header', { ticket: [PRIVATE] }],
  ['newline in cookie ticket', { ticket: PRIVATE + '\r\nInjected: true' }],
  ['semicolon adds a second cookie', { ticket: PRIVATE + '; admin=1' }],
  ['malformed secondary with valid primary', { ticket: PRIVATE, tongyi_sso_ticket: { key: 'bad' } }],
]) {
  test('Qwen China proxy fails closed before any POST for invalid credential: ' + label, async () => {
    const h = harness(credentials)
    const thrown = await h.adapter.chatCompletion({ model: 'Qwen3.6',
      messages: [{ role: 'user', content: 'LOCAL86_INVALID_TICKET_NO_EFFECT' }] }).catch(e => e)
    assert.ok(thrown instanceof Error || typeof thrown?.message === 'string')
    assert.equal(h.posts.length, 0, 'No provider POST with ambiguous or malformed ticket')
    assert.ok(!String(thrown.message).includes(PRIVATE))
  })
}

test('legacy tongyi_sso_ticket-only account remains compatible with the proxy', async () => {
  const h = harness({ tongyi_sso_ticket: PRIVATE })
  await h.adapter.chatCompletion({ model: 'Qwen3.6',
    messages: [{ role: 'user', content: 'LOCAL86_SECONDARY_ALIAS' }] })
  assert.equal(h.posts.length, 1)
  assert.equal(h.posts[0].config.headers.Cookie, 'tongyi_sso_ticket=' + PRIVATE)
})

test('legacy blank primary may use verified secondary alias without changing stored credentials', async () => {
  const credentials = Object.freeze({ ticket: '', tongyi_sso_ticket: PRIVATE })
  const h = harness(credentials)
  await h.adapter.chatCompletion({ model: 'Qwen3.6',
    messages: [{ role: 'user', content: 'LOCAL86_BLANK_PRIMARY_COMPAT' }] })
  assert.equal(h.posts.length, 1)
  assert.equal(h.posts[0].config.headers.Cookie, 'tongyi_sso_ticket=' + PRIVATE)
  assert.equal(credentials.ticket, '')
})
