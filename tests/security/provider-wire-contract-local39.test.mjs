import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Actual Z.ai adapter + actual forwardZai method, fully synthetic transport.
// No operating profile, credentials, GUI, provider network, retry or cleanup.
const root = new URL('../../', import.meta.url)
const source = relative => readFileSync(new URL('src/main/' + relative, root), 'utf8')
const compile = (text, fileName) => ts.transpileModule(text, {
  fileName,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

const adapterCode = compile(source('proxy/adapters/zai.ts'), 'zai.ts')
const identityCode = compile(source('oauth/zaiSession.ts'), 'zaiSession.ts')
const forwardSource = source('proxy/forwarder.ts')
const forwardAst = ts.createSourceFile('forwarder.ts', forwardSource, ts.ScriptTarget.Latest, true)
let forwardZai
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(forwardAst) === 'forwardZai') forwardZai = node.getText(forwardAst)
  ts.forEachChild(node, visit)
}
visit(forwardAst)
assert.equal(typeof forwardZai, 'string')
const forwardCode = compile('class OfflineForwarder {' + forwardZai + '} exports.OfflineForwarder=OfflineForwarder', 'forwardZai.ts')

const PRIVATE = 'SYNTHETIC_ZAI_LOCAL39_PRIVATE'
const SUBJECT = 'synthetic-local39-subject'
const jwtPart = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = [jwtPart({ alg: 'HS256', typ: 'JWT' }), jwtPart({ id: SUBJECT }), 'synthetic-signature'].join('.')
const rawChatId = 'chat/segment?query#fragment\r\n' + PRIVATE
const encodedChatId = encodeURIComponent(rawChatId)

function load(code, dependencies, globals = {}) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, URL, URLSearchParams, Date, Math, Error, TextDecoder,
    console: { log() {}, warn() {}, error() {}, info() {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected local39 dependency ' + name)
    },
    ...globals,
  }, { filename: 'local39-' + Math.random(), timeout: 2000 })
  return mod.exports
}

function harness() {
  const calls = []
  let forbidden = 0
  const blocked = () => { forbidden++; throw new Error('Forbidden local39 external effect') }
  const identity = load(identityCode, { crypto })
  const axios = {
    async get(url, config) {
      calls.push({ method: 'GET', url, config })
      return { status: 200, headers: { 'content-type': 'application/json' }, data: { id: SUBJECT, token } }
    },
    async post(url, body, config) {
      calls.push({ method: 'POST', url, body, config })
      const posts = calls.filter(call => call.method === 'POST').length
      if (posts === 1) return { status: 201, headers: {}, data: { id: rawChatId } }
      if (posts === 2) return { status: 503, headers: {}, data: { destroy() {} } }
      return blocked()
    },
    async delete(url, config) {
      calls.push({ method: 'DELETE', url, config })
      return { status: 204, headers: {}, data: true }
    },
    create: () => ({ get: blocked, post: blocked, delete: blocked, request: blocked }),
    request: blocked,
  }
  const product = load(adapterCode, {
    axios: { __esModule: true, default: axios }, crypto, stream: { PassThrough },
    'eventsource-parser': { createParser: blocked },
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': identity,
    '../promptToolUse': { hasToolUse: blocked, parseToolUse: blocked },
    '../utils/toolParser': { parseToolCallsFromText: blocked },
    '../utils/streamToolHandler': {
      createToolCallState: () => ({}), processStreamContent: blocked,
      flushToolCallBuffer: blocked, createBaseChunk: blocked,
    },
  })
  const { OfflineForwarder } = load(forwardCode, {}, {
    ZaiAdapter: product.ZaiAdapter,
    ZaiProxyFailure: product.ZaiProxyFailure,
    ZaiStreamHandler: class { constructor() { blocked() } },
    shouldDeleteSession: () => false,
    hasCompletedNonStreamAnswer: blocked,
    unconfirmedProviderCompletion: blocked,
    safeWebErrorStatus: () => undefined,
  })
  const forwarder = new OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({ messages: request.messages, plan: { mode: 'disabled' } })
  forwarder.extractHeaders = () => ({})
  const provider = { id: 'zai', apiEndpoint: 'https://chat.z.ai' }
  const account = { id: 'synthetic-local39', providerId: 'zai', credentials: { token } }
  return { calls, forbidden: () => forbidden, product, forwarder, provider, account }
}

test('Z.ai treats provider chat IDs as opaque data when composing completion metadata and Referer', async () => {
  const h = harness()
  const result = await h.forwarder.forwardZai({
    model: 'Synthetic Display', messages: [{ role: 'user', content: 'synthetic local39' }], stream: false,
    web_search: false, reasoning_effort: false,
  }, h.account, h.provider, 'Synthetic_Wire.v39', Date.now())
  assert.equal(result.success, false)
  assert.equal(result.status, 503)
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST'])
  const completion = h.calls[2]
  assert.equal(completion.body.chat_id, rawChatId, 'JSON identity stays exact')
  assert.equal(completion.config.headers.Referer, 'https://chat.z.ai/c/' + encodedChatId,
    'untrusted provider ID must be encoded before entering an HTTP header URL')
  const params = new URL(completion.url).searchParams
  assert.equal(params.get('current_url'), 'https://chat.z.ai/c/' + encodedChatId)
  assert.equal(params.get('pathname'), '/c/' + encodedChatId)
  assert.equal(h.forbidden(), 0)
})

test('Z.ai deleteChat encodes an opaque provider chat ID as one path segment', async () => {
  const h = harness()
  const adapter = new h.product.ZaiAdapter(h.provider, h.account)
  const ok = await adapter.deleteChat(rawChatId)
  assert.equal(ok, true)
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'DELETE'])
  assert.equal(h.calls[1].url, 'https://chat.z.ai/api/v1/chats/' + encodedChatId)
  assert.equal(h.forbidden(), 0)
})
