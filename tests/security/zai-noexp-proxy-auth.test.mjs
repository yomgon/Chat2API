import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'

// The concrete Z.ai adapter and shared claims helper execute with bounded,
// synthetic Axios transports. This file never opens Electron, a real account,
// the user's profile, or a provider network connection.
const root = fileURLToPath(new URL('../../', import.meta.url))
const requireNode = createRequire(import.meta.url)
const source = relative => readFileSync(path.join(root, relative), 'utf8')
const helperPath = 'src/main/oauth/zaiSession.ts'
const adapterPath = 'src/main/proxy/adapters/zai.ts'
const SENTINEL = 'SYNTHETIC_PRIVATE_TOKEN_VALUE_NOT_FOR_LOGS'
const logs = []
const fakeConsole = Object.fromEntries(['log','error','warn','info'].map(level =>
  [level, (...args) => logs.push({ level, args })]))

function loadTs(relative, deps) {
  const result = ts.transpileModule(source(relative), {
    fileName: relative,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  })
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports,
    require: specifier => {
      if (Object.hasOwn(deps, specifier)) return deps[specifier]
      throw new Error('Unauthorized test module import: ' + specifier)
    },
    console: fakeConsole, Buffer, TextDecoder, URL, URLSearchParams, Date, Error,
    setTimeout, clearTimeout,
  }, { filename: relative, timeout: 1500 })
  return module.exports
}

const claims = loadTs(helperPath, { crypto })
const epoch = () => Math.floor(Date.now() / 1000)
function jwt(payload = {}, options = {}) {
  const header = Buffer.from(JSON.stringify({ alg: options.alg || 'HS256', typ: 'JWT' })).toString('base64url')
  const body = { id: 'safely-bound-subject', email: 'fixture@example.invalid', ...payload }
  if (options.expires !== false) {
    body.exp = Object.prototype.hasOwnProperty.call(payload, 'exp') ? payload.exp : epoch() + 3600
  }
  return [header, Buffer.from(JSON.stringify(body)).toString('base64url'), 'fake_signature'].join('.')
}
function init(options = {}) {
  logs.length = 0
  const calls = []
  let postCount = 0
  const reply = options.reply || { status: 200, headers: { 'content-type': 'application/json' },
    data: { id: 'safely-bound-subject', token: jwt({}, { expires: false }) } }
  const axios = {
    get: async (...args) => {
      calls.push({ kind: 'GET', args })
      if (options.throwOnGet) throw Object.assign(new Error(SENTINEL), {
        request: { headers: { Authorization: SENTINEL } },
      })
      return typeof reply === 'function' ? reply() : reply
    },
    post: async (...args) => {
      calls.push({ kind: 'POST', args })
      postCount++
      if (options.throwOnPostAt === postCount) {
        throw Object.assign(new Error(SENTINEL), {
          config: { url: `https://chat.z.ai/?token=${SENTINEL}`,
            headers: { Authorization: `Bearer ${SENTINEL}`, Cookie: `token=${SENTINEL}` } },
        })
      }
      if (options.badCreate && postCount === 1) return { status: 200, data: {} }
      return postCount === 1
        ? { status: 201, data: { id: 'synthetic-chat-id' } }
        : { status: 200, data: new PassThrough() }
    },
  }
  const deps = {
    axios: { __esModule: true, default: axios },
    crypto, stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': claims,
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createBaseChunk: () => ({}),
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: () => ({ chunks: [] }),
      flushToolCallBuffer: () => [],
    },
  }
  const { ZaiAdapter } = loadTs(adapterPath, deps)
  const account = token => ({ id: 'fixed-id', providerId: 'zai', credentials: { token } })
  const adapter = token => new ZaiAdapter({ id: 'zai' }, account(token))
  return { adapter, calls }
}

test('official no-exp JWT cannot be declared locally unexpired by old helper', () => {
  const token = jwt({}, { expires: false })
  assert.equal(claims.readZaiSessionClaims(token), null)
  const meta = claims.readZaiTokenIdentity(token)
  assert.ok(meta)
  assert.equal(meta.expiryKnown, false)
  assert.equal(meta.expiresAt, undefined)
  assert.equal(meta.subject, 'safely-bound-subject')
})

test('Z.ai adapter routing accepts only the built-in identity or exact official chat origin', () => {
  const { ZaiAdapter } = loadTs(adapterPath, {
    axios: { __esModule: true, default: {} }, crypto, stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': claims,
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createBaseChunk: () => ({}), createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: () => ({ chunks: [] }), flushToolCallBuffer: () => [],
    },
  })
  assert.equal(ZaiAdapter.isZaiProvider({ id: 'zai' }), true)
  assert.equal(ZaiAdapter.isZaiProvider({ id: 'custom', apiEndpoint: 'https://chat.z.ai/api/v1' }), true)
  for (const invalid of [
    'https://chat.z.ai.evil.example.com/', 'https://evil-chat.z.ai.example.com/',
    'https://z.ai/', 'http://chat.z.ai/', 'https://user:password@chat.z.ai/',
    'https://chat.z.ai:444/', 'bad-url', null,
  ]) {
    assert.equal(ZaiAdapter.isZaiProvider({ id: 'unrelated', apiEndpoint: invalid }), false)
  }
})

test('no-exp JWT requires a fixed first-party authenticated GET before any remote chat effect', async () => {
  const token = jwt({}, { expires: false })
  const h = init()
  const a = h.adapter(token)
  assert.equal(await a.ensureToken(), token)
  assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.kind, 'GET')
  assert.equal(call.args[0], 'https://chat.z.ai/api/v1/auths/')
  assert.equal(call.args[1].method, undefined)
  assert.equal(call.args[1].maxRedirects, 0)
  assert.equal(call.args[1].maxContentLength, 65536)
  assert.ok(call.args[1].timeout > 0 && call.args[1].timeout <= 12000)
  assert.equal(call.args[1].headers.Authorization, 'Bearer ' + token)
  assert.equal(call.args[1].headers.Cookie, 'token=' + token)
  assert.equal(h.calls.some(c => c.kind === 'POST'), false)
  assert.equal(logs.flatMap(entry => entry.args).some(value => String(value).includes(token)), false)
})

test('no-exp authentication rejects non-200, redirect, bad schema and cross-subject responses with zero POST', async () => {
  const token = jwt({}, { expires: false })
  for (const reply of [
    { status: 401, headers: { 'content-type': 'application/json' }, data: { id: 'safely-bound-subject' } },
    { status: 403, headers: { 'content-type': 'application/json' }, data: { id: 'safely-bound-subject' } },
    { status: 302, headers: { 'location': 'https://evil.invalid/' }, data: null },
    { status: 200, headers: { 'content-type': 'text/html' }, data: { id: 'safely-bound-subject' } },
    { status: 200, headers: { 'content-type': 'application/json' }, data: { id: 'different-user' } },
    { status: 200, headers: { 'content-type': 'application/json' }, data: [] },
    { status: 200, headers: { 'content-type': 'application/json' }, data: { id: 'safely-bound-subject', token: jwt({id:'different-user'}, { expires: false }) } },
    { status: 200, headers: { 'content-type': 'application/json' }, data: { id: 'safely-bound-subject', token: jwt({exp: epoch()-3600}) } },
    { status: 200, headers: { 'content-type': 'application/json' }, data: { id: 'safely-bound-subject', token: 'malformed' } },
  ]) {
    const h = init({ reply })
    await assert.rejects(h.adapter(token).ensureToken(), /Z\.ai web session was not verified/)
    assert.deepEqual(h.calls.map(c => c.kind), ['GET'])
  }
})

test('no-exp network error is redacted and never triggers retry', async () => {
  const token = jwt({}, { expires: false })
  const h = init({ throwOnGet: true })
  const error = await h.adapter(token).ensureToken().catch(e => e)
  assert.equal(error.message, 'Z.ai web session was not verified; reconnect this account')
  assert.deepEqual(h.calls.map(c => c.kind), ['GET'])
  for (const item of logs.flatMap(entry => entry.args)) {
    assert.equal(String(item).includes(SENTINEL), false)
    assert.equal(String(item).includes(token), false)
  }
})

test('an authenticated same-identity replacement token is used only for the current operation', async () => {
  const saved = jwt({}, { expires: false })
  const issued = jwt({ rotation: 'different-synthetic-issuance' }, { expires: false })
  assert.notEqual(saved, issued)
  const h = init({ reply: { status: 200, headers: { 'content-type': 'application/json' },
    data: { id: 'safely-bound-subject', token: issued } } })
  const a = h.adapter(saved)
  assert.equal(await a.ensureToken(), issued)
  const chat = await a.createChat('glm-5', 'test-only-content')
  assert.equal(chat.chatId, 'synthetic-chat-id')
  assert.deepEqual(h.calls.map(call => call.kind), ['GET', 'GET', 'POST'])
  assert.equal(h.calls[2].args[2].headers.Authorization, 'Bearer ' + issued)
  assert.equal(h.calls[2].args[2].headers.Cookie, 'token=' + issued)
  assert.equal(a.getToken(), saved, 'no store mutation or hidden token replacement')
})

test('known-unexpired exp token requires no extra auth GET; expired or invalid claims create no network call', async () => {
  const h = init()
  const valid = jwt()
  assert.equal(await h.adapter(valid).ensureToken(), valid)
  for (const bad of [
    jwt({ exp: epoch() - 200 }),
    jwt({ exp: epoch() + 5 }),
    jwt({ exp: null }),
    jwt({ nbf: epoch() + 3600 }, { expires: false }),
    jwt({ email: 'fake@guest.com' }, { expires: false }),
    jwt({}, { alg: 'none', expires: false }),
    'bad-token',
  ]) await assert.rejects(h.adapter(bad).ensureToken())
  assert.equal(h.calls.length, 0, 'metadata rejection is local and before all effects')
})

test('a failed first-party preflight cannot create a chat, while verified identity permits one create effect', async () => {
  const token = jwt({}, { expires: false })
  const failed = init({ reply: { status: 403, headers: { 'content-type': 'application/json' }, data: {} } })
  await assert.rejects(failed.adapter(token).createChat('glm-5', 'synthetic prompt'))
  assert.deepEqual(failed.calls.map(c => c.kind), ['GET'])
  const good = init()
  const chat = await good.adapter(token).createChat('glm-5', 'synthetic prompt')
  assert.equal(chat.chatId, 'synthetic-chat-id')
  assert.deepEqual(good.calls.map(c => c.kind), ['GET', 'POST'])
  assert.equal(good.calls[1].args[0], 'https://chat.z.ai/api/v1/chats/new')
})

test('one complete chat operation uses one auth GET and the SAME rotated token for both POST effects', async () => {
  const saved = jwt({}, { expires: false })
  const issued = jwt({ rotation: 'issued-for-this-operation' }, { expires: false })
  const invalidNext = jwt({ rotation: 'would-be-second-get' }, { expires: false })
  let authReads = 0
  const h = init({ reply: () => ({ status: 200, headers: { 'content-type': 'application/json' },
    data: { id: 'safely-bound-subject', token: ++authReads === 1 ? issued : invalidNext } }) })
  const a = h.adapter(saved)
  const result = await a.chatCompletion({ model: 'glm-5', messages: [{ role: 'user', content: 'Test only.' }], stream: false })
  assert.equal(result.chatId, 'synthetic-chat-id')
  assert.equal(result.response.status, 200)
  assert.equal(authReads, 1, 'a rotated auth token must not be replaced between create and completion')
  assert.deepEqual(h.calls.map(c => c.kind), ['GET', 'POST', 'POST'])
  const create = h.calls[1], completion = h.calls[2]
  assert.equal(create.args[0], 'https://chat.z.ai/api/v1/chats/new')
  assert.equal(create.args[2].headers.Authorization, `Bearer ${issued}`)
  assert.equal(create.args[2].headers.Cookie, `token=${issued}`)
  assert.equal(new URL(completion.args[0]).origin, 'https://chat.z.ai')
  assert.equal(new URL(completion.args[0]).pathname, '/api/v2/chat/completions')
  assert.equal(completion.args[1].stream, true,
    'the Z.ai transport must request SSE even for downstream non-stream JSON clients')
  assert.equal(new URL(completion.args[0]).searchParams.get('token'), issued)
  assert.equal(completion.args[2].headers.Authorization, `Bearer ${issued}`)
  assert.equal(completion.args[2].headers.Cookie, `token=${issued}`)
  assert.equal(a.getToken(), saved, 'an official rotation must not silently change the saved account')
})

test('both upstream modes stay SSE while OpenAI caller stream preference remains local-only', async () => {
  const token = jwt({}, { expires: false })
  for (const requestedStream of [false, true]) {
    const h = init()
    await h.adapter(token).chatCompletion({ model:'x-preview-l',
      messages:[{ role:'user',content:'synthetic only' }], stream:requestedStream })
    assert.deepEqual(h.calls.map(c=>c.kind), ['GET','POST','POST'])
    assert.equal(h.calls[2].args[1].stream, true)
    assert.equal(h.calls[2].args[2].responseType, 'stream')
  }
})

test('a failed preflight, malformed create response or failed POST cannot trigger a completion or retry', async () => {
  const token = jwt({}, { expires: false })
  const authFailed = init({ reply: { status: 403, headers: { 'content-type': 'application/json' }, data: {} } })
  await assert.rejects(authFailed.adapter(token).chatCompletion({ model: 'glm-5', messages: [{ role: 'user', content: 'test' }] }))
  assert.deepEqual(authFailed.calls.map(c => c.kind), ['GET'])

  const badCreate = init({ badCreate: true })
  await assert.rejects(badCreate.adapter(token).chatCompletion({ model: 'glm-5', messages: [{ role: 'user', content: 'test' }] }),
    /creation response was invalid; no automatic retry/)
  assert.deepEqual(badCreate.calls.map(c => c.kind), ['GET', 'POST'])

  for (const [at, expectedMessage] of [
    [1, 'Z.ai chat creation outcome unknown; no automatic retry'],
    [2, 'Z.ai chat completion outcome unknown; no automatic retry'],
  ]) {
    const h = init({ throwOnPostAt: at })
    const failure = await h.adapter(token).chatCompletion({ model: 'glm-5', messages: [{ role: 'user', content: 'test' }] }).catch(e => e)
    assert.equal(failure.message, expectedMessage)
    assert.deepEqual(h.calls.map(c => c.kind), at === 1 ? ['GET','POST'] : ['GET','POST','POST'])
    assert.equal(JSON.stringify(logs).includes(SENTINEL), false)
    assert.equal(JSON.stringify(logs).includes(token), false)
  }
})

test('streaming provider error never echoes the upstream error body, headers or query token', async () => {
  const h = init()
  // Read the real stream handler from the same source as the adapter harness.
  const deps = {
    axios: { __esModule: true, default: { get() {}, post() {} } },
    crypto, stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': claims,
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createBaseChunk: () => ({}), createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: () => ({ chunks: [] }), flushToolCallBuffer: () => [],
    },
  }
  const { ZaiStreamHandler } = loadTs(adapterPath, deps)
  const upstream = new PassThrough()
  const output = await new ZaiStreamHandler('glm-5').handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk.toString()))
  const ended = new Promise((resolve, reject) => { output.once('end', resolve); output.once('error', reject) })
  const fakeError = { detail: SENTINEL, request: { headers: { Authorization: SENTINEL },
    url: `https://chat.z.ai/?token=${SENTINEL}` } }
  upstream.end(`data: ${JSON.stringify({ type: 'chat:completion', data: {
    phase: 'answer', delta_content: SENTINEL, error: fakeError,
  }, error: fakeError })}\n\n`)
  await ended
  const emitted = chunks.join('')
  assert.match(emitted, /Z\.ai upstream returned a model error/)
  assert.match(emitted, /"error"/)
  assert.equal(emitted.includes(SENTINEL), false)
  assert.equal(JSON.stringify(logs).includes(SENTINEL), false)
  assert.equal(h.calls.length, 0, 'stream-only test must create no network operation')
})
