import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import ts from 'typescript'

// Execute the actual adapters and Z.ai identity checks in closed VMs. Only
// synthetic Axios spies exist: no Electron, store, profile or HTTP is loaded.
// The completion spy always throws after capturing its payload. These tests
// prove request preparation and effect counts, never real model completion.
const PRIVATE = 'SYNTHETIC_LOCAL22_PRIVATE_INPUT_OR_TRANSPORT_DETAIL'
const SUBJECT = 'synthetic-local22-subject'
const CHAT_ID = 'synthetic-local22-chat'
const providers = ['qwen-ai', 'zai']
const origin = { 'qwen-ai': 'https://chat.qwen.ai', zai: 'https://chat.z.ai' }
const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
function compile(file) {
  const result = ts.transpileModule(source(file), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  })
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return result.outputText
}
const adapterCode = Object.fromEntries(providers.map(id =>
  [id, compile('src/main/proxy/adapters/' + id + '.ts')]))
const claimsCode = compile('src/main/oauth/zaiSession.ts')
function load(code, dependencies, logs = []) {
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, URLSearchParams, TextDecoder,
    Date, Error, setTimeout, clearTimeout,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    require: id => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      throw new Error('Forbidden local22 dependency: ' + id)
    },
  }, { timeout: 2000, filename: 'consumer-message-wire-local22.cjs' })
  return module.exports
}
const claims = load(claimsCode, { crypto })
const plain = value => JSON.parse(JSON.stringify(value))
const part = text => ({ type: 'text', text })
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function syntheticToken(withExpiry) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      id: SUBJECT, email: 'local22@example.invalid',
      ...(withExpiry ? { exp: Math.floor(Date.now() / 1000) + 3600 } : {}),
    })).toString('base64url'),
    'synthetic_signature',
  ].join('.')
}
function harness(id, { unknownExpiry = false } = {}) {
  const calls = []
  const logs = []
  const forbidden = []
  const token = id === 'qwen-ai' ? 'SYNTHETIC_LOCAL22_QWEN_TOKEN' : syntheticToken(!unknownExpiry)
  const issuedToken = id === 'zai' ? syntheticToken(true) : token
  const deny = action => () => {
    forbidden.push(action)
    throw new Error('Forbidden synthetic action: ' + action)
  }
  const createPath = id === 'zai' ? '/api/v1/chats/new' : '/api/v2/chats/new'
  const completePath = '/api/v2/chat/completions'
  const axios = {
    get: async (url, config) => {
      calls.push({ method: 'GET', url, config })
      assert.equal(id, 'zai')
      assert.equal(url, origin.zai + '/api/v1/auths/')
      return { status: 200, headers: { 'content-type': 'application/json' },
        data: { id: SUBJECT, token: issuedToken } }
    },
    post: async (url, body, config) => {
      const parsed = new URL(url)
      calls.push({ method: 'POST', url, body: plain(body), config })
      assert.equal(parsed.origin, origin[id])
      if (parsed.pathname === createPath) {
        return { status: 201, data: id === 'zai' ? { id: CHAT_ID } : { data: { id: CHAT_ID } } }
      }
      assert.equal(parsed.pathname, completePath, 'no invented upstream endpoint')
      throw Object.assign(new Error(PRIVATE), {
        config: { headers: { Authorization: token }, url: url + PRIVATE },
        response: { data: { detail: PRIVATE } },
      })
    },
  }
  for (const action of ['delete', 'request', 'put', 'patch']) axios[action] = deny(action)
  axios.create = () => axios
  const dependencies = {
    axios: { __esModule: true, default: axios },
    crypto,
    stream: { PassThrough },
    'eventsource-parser': { createParser: deny('response parser') },
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': claims,
    '../promptToolUse': { hasToolUse: deny('response tools'), parseToolUse: deny('response tools') },
    '../utils/toolParser': { parseToolCallsFromText: deny('response tools') },
    '../utils/streamToolHandler': {
      createToolCallState: deny('response tool state'), createBaseChunk: deny('response chunk'),
      processStreamContent: deny('response stream'), flushToolCallBuffer: deny('response flush'),
    },
  }
  const exported = load(adapterCode[id], dependencies, logs)
  const Adapter = id === 'zai' ? exported.ZaiAdapter : exported.QwenAiAdapter
  const Failure = id === 'zai' ? exported.ZaiProxyFailure : exported.QwenAiProxyFailure
  const provider = freeze({ id, enabled: true, apiEndpoint: origin[id], modelMappings: {} })
  const account = freeze({ id: 'synthetic-fixed-account', providerId: id,
    credentials: { token } })
  const adapter = new Adapter(provider, account)
  const model = id === 'zai' ? 'glm-5' : 'qwen3.7-max'
  async function attempt(messages, options = {}) {
    const request = freeze({ model, messages, stream: false, ...options })
    const before = JSON.stringify(request)
    let error
    try {
      await adapter.chatCompletion(request)
    } catch (caught) {
      error = caught
    }
    assert.equal(JSON.stringify(request), before, 'request must remain unchanged')
    assert.equal(account.credentials.token, token, 'stored identity must not change')
    assert.equal(forbidden.length, 0, 'no auxiliary effects or response fabrication')
    const diagnostic = inspect([error, logs], { depth: null })
    for (const secret of [PRIVATE, token, issuedToken]) {
      assert.equal(diagnostic.includes(secret), false, 'fixed diagnostic must omit private values')
    }
    return error
  }
  return { id, calls, token, issuedToken, account, Failure, attempt, createPath, completePath }
}
async function captureWire(h, messages, options = {}) {
  const error = await h.attempt(messages, options)
  assert.ok(error instanceof h.Failure, 'only fixed provider failure may cross the adapter')
  assert.equal(error.stage, 'chat-completion', 'the spy stops only after capturing the real payload')
  const posts = h.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2, 'one create and one completion, no replay')
  assert.equal(new URL(posts[0].url).pathname, h.createPath)
  assert.equal(new URL(posts[1].url).pathname, h.completePath)
  for (const call of posts) {
    assert.equal(call.config.maxRedirects, 0)
    assert.equal(call.config.headers.Authorization, 'Bearer ' + h.issuedToken)
  }
  assert.equal(posts[1].body.chat_id, CHAT_ID)
  assert.equal(posts[1].body.model, h.id === 'zai' ? 'glm-5' : 'qwen3.7-max')
  assert.equal(posts[1].body.stream, true, 'upstream SSE contract unchanged')
  assert.equal(posts[1].config.responseType, 'stream')
  return { body: posts[1].body, create: posts[0].body }
}
async function assertRejectedBeforePost(id, messages, options = {}) {
  const h = harness(id, options)
  const error = await h.attempt(messages)
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0,
    'unsupported input must fail before either state-changing POST')
  assert.ok(error instanceof h.Failure, 'malformed input uses a fixed local failure')
  assert.equal(error.stage, 'chat-creation')
  assert.equal(error.message, id === 'zai'
    ? 'Z.ai request messages are not supported'
    : 'Qwen AI request messages are not supported')
  assert.equal(error.upstreamStatus, undefined)
  assert.equal(error.upstreamHttpStatus, undefined, 'local rejection must not invent an upstream status')
  assert.equal(h.calls.filter(call => call.method === 'GET').length,
    id === 'zai' && options.unknownExpiry ? 1 : 0)
}

for (const id of providers) {
  test(id + ': string input preserves every character and existing effect sequence', async () => {
    const content = '  한글 😀\nsecond line  '
    const h = harness(id)
    const { body } = await captureWire(h, [{ role: 'user', content }])
    assert.equal(body.messages[0].content, content)
    assert.equal(h.calls.filter(call => call.method === 'GET').length, 0)
  })
  test(id + ': leading systems and all text parts reach the wire once in input order', async () => {
    const h = harness(id)
    const { body, create } = await captureWire(h, [
      { role: 'system', content: [part('SYSTEM-A '), part('SYSTEM-B\n')] },
      { role: 'system', content: 'SYSTEM-C' },
      { role: 'user', content: [part('USER-A '), part(''), part('USER-B 😀')] },
    ])
    const expected = 'SYSTEM-A SYSTEM-B\n\n\nSYSTEM-C\n\nUser: USER-A USER-B 😀'
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0].role, 'user')
    assert.equal(body.messages[0].content, expected)
    assert.doesNotMatch(body.messages[0].content, /\[object Object\]/)
    if (id === 'zai') {
      assert.equal(body.signature_prompt, expected)
      assert.equal(Object.values(create.chat.history.messages)[0].content, expected)
    }
  })
  test(id + ': a text-part array is equivalent to its exact concatenated text', async () => {
    const messages = [{ role: 'user', content: [part('one'), part('\ntwo'), part(' three')] }]
    const array = await captureWire(harness(id), messages)
    const string = await captureWire(harness(id), [{ role: 'user', content: 'one\ntwo three' }])
    assert.equal(array.body.messages[0].content, string.body.messages[0].content)
  })
}

const invalidInputs = [
  ['missing messages', undefined],
  ['null messages', null],
  ['non-array messages', { role: 'user', content: PRIVATE }],
  ['empty messages', []],
  ['null message', [null]],
  ['array message', [[]]],
  ['primitive message', [PRIVATE]],
  ['unsupported role', [{ role: 'developer', content: PRIVATE }]],
  ['missing content', [{ role: 'user' }]],
  ['null content', [{ role: 'user', content: null }]],
  ['numeric content', [{ role: 'user', content: 3 }]],
  ['object content', [{ role: 'user', content: { text: PRIVATE } }]],
  ['empty parts', [{ role: 'user', content: [] }]],
  ['primitive part', [{ role: 'user', content: [PRIVATE] }]],
  ['null part', [{ role: 'user', content: [null] }]],
  ['missing part text', [{ role: 'user', content: [{ type: 'text' }] }]],
  ['non-string part text', [{ role: 'user', content: [{ type: 'text', text: { private: PRIVATE } }] }]],
  ['image-only input', [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PRIVATE } }] }]],
  ['text followed by image', [{ role: 'user', content: [part('must not send partial'),
    { type: 'image_url', image_url: { url: PRIVATE } }] }]],
  ['file input', [{ role: 'user', content: [{ type: 'file', file: { file_data: PRIVATE } }] }]],
  ['text part with extra attachment', [{ role: 'user',
    content: [{ type: 'text', text: 'keep', image_url: { url: PRIVATE } }] }]],
  ['message file metadata', [{ role: 'user', content: 'keep', files: [PRIVATE] }]],
  ['message attachment metadata', [{ role: 'user', content: 'keep', attachments: [PRIVATE] }]],
  ['named message semantics', [{ role: 'user', content: 'keep', name: PRIVATE }]],
  ['tool call metadata', [{ role: 'user', content: 'keep',
    tool_calls: [{ id: PRIVATE, type: 'function', function: { name: 'lookup', arguments: '{}' } }] }]],
  ['tool result role', [{ role: 'tool', content: 'keep', tool_call_id: PRIVATE }]],
  ['system-only input', [{ role: 'system', content: PRIVATE }]],
  ['late system would reorder meaning', [
    { role: 'user', content: 'first' }, { role: 'system', content: PRIVATE },
    { role: 'user', content: 'last' },
  ]],
]
for (const id of providers) {
  for (const [label, messages] of invalidInputs) {
    test(id + ': ' + label + ' rejects before any POST', () => assertRejectedBeforePost(id, messages))
  }
}
for (const [label, messages] of [
  ['two user messages', [{ role: 'user', content: 'first' }, { role: 'user', content: 'last' }]],
  ['user-assistant-user history', [{ role: 'user', content: 'first' },
    { role: 'assistant', content: 'previous reply' }, { role: 'user', content: 'last' }]],
  ['assistant prefill', [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'prefix' }]],
  ['assistant before user', [{ role: 'assistant', content: 'prefix' }, { role: 'user', content: 'question' }]],
]) {
  test('qwen-ai: ' + label + ' cannot silently shrink to one user', () =>
    assertRejectedBeforePost('qwen-ai', messages))
}

test('zai: text history retains user/assistant roles, ordering and last-user signature', async () => {
  const { body, create } = await captureWire(harness('zai'), [
    { role: 'system', content: [part('RULE-A '), part('RULE-B')] },
    { role: 'user', content: [part('FIRST '), part('QUESTION')] },
    { role: 'assistant', content: [part('FIRST '), part('ANSWER')] },
    { role: 'user', content: [part('LAST '), part('QUESTION')] },
  ])
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'RULE-A RULE-B\n\nUser: FIRST QUESTION' },
    { role: 'assistant', content: 'FIRST ANSWER' },
    { role: 'user', content: 'LAST QUESTION' },
  ])
  assert.equal(body.signature_prompt, 'LAST QUESTION')
  assert.equal(Object.values(create.chat.history.messages)[0].content, 'LAST QUESTION')
})
test('zai: representable nonalternating text history is preserved without invented turns', async () => {
  const messages = [
    { role: 'assistant', content: 'PREFIX' },
    { role: 'user', content: 'USER-ONE' },
    { role: 'user', content: 'USER-TWO' },
    { role: 'assistant', content: 'SUFFIX' },
  ]
  const { body } = await captureWire(harness('zai'), messages)
  assert.deepEqual(body.messages, messages)
  assert.equal(body.signature_prompt, 'USER-TWO')
})
test('zai: leading system cannot be relocated past an initial assistant', () =>
  assertRejectedBeforePost('zai', [
    { role: 'system', content: 'RULE' }, { role: 'assistant', content: 'PREFIX' },
    { role: 'user', content: 'QUESTION' },
  ]))
test('zai: assistant-only input has no current user and rejects before POST', () =>
  assertRejectedBeforePost('zai', [{ role: 'assistant', content: 'PREFIX' }]))
test('zai: no-exp auth remains one GET and cannot authorize malformed-message POSTs', () =>
  assertRejectedBeforePost('zai', [{ role: 'user', content: [part('text'),
    { type: 'file', file: { file_data: PRIVATE } }] }], { unknownExpiry: true }))
test('zai: no-exp identity and both authorized payloads remain pinned while normalizing text', async () => {
  const h = harness('zai', { unknownExpiry: true })
  const { body } = await captureWire(h, [{ role: 'user', content: [part('one '), part('two')] }])
  assert.equal(body.messages[0].content, 'one two')
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST'])
})

for (const originalModel of ['Synthetic Plain', 'Synthetic Think R1 Search']) {
  for (const web_search of [undefined, false, true]) {
    for (const reasoning_effort of [undefined, false, true, 'low', 'medium', 'high']) {
      test('zai options: ' + originalModel + '/search=' + web_search + '/reason=' + reasoning_effort,
        async () => {
          const h = harness('zai')
          const options = { originalModel,
            ...(web_search === undefined ? {} : { web_search }),
            ...(reasoning_effort === undefined ? {} : { reasoning_effort }) }
          const { body } = await captureWire(h, [{ role: 'user', content: 'option fixture' }], options)
          assert.equal(body.features.auto_web_search,
            web_search === undefined ? originalModel.toLowerCase().includes('search') : web_search)
          assert.equal(body.features.enable_thinking, reasoning_effort !== false,
            'the existing missing-option default remains enabled, explicit false wins')
          assert.equal(body.features.web_search, false, 'native auto_web_search field remains the existing contract')
          assert.equal(body.model, 'glm-5', 'aliases must not replace the selected wire model')
        })
    }
  }
}
