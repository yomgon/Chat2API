import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { inspect } from 'node:util'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// Execute the actual adapter and identity parser using synthetic transports only.
// No Electron, store, profile, OAuth login or real HTTP implementation is loaded.
const requireNode = createRequire(import.meta.url)
const adapterPath = 'src/main/proxy/adapters/zai.ts'
const helperPath = 'src/main/oauth/zaiSession.ts'
const readSource = relative => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const ORIGIN = 'https://chat.z.ai'
const AUTH_URL = ORIGIN + '/api/v1/auths/'
const CREATE_PATH = '/api/v1/chats/new'
const COMPLETE_PATH = '/api/v2/chat/completions'
const SUBJECT = 'synthetic-local19-subject'
const CANARY = 'SYNTHETIC_LOCAL19_PRIVATE_ERROR_DETAIL'

let adapterSource = readSource(adapterPath)
// Opt-in RED control: replay the historical double-auth bug only inside the VM.
// This never rewrites production source and is not a claim that today's source
// still has the bug. The normal test run always executes the unmodified file.
if (process.env.ZAI_LOCAL19_REPLAY_DOUBLE_AUTH === '1') {
  const pinned = 'const chatResult = await this.createChatWithVerifiedToken(mappedModel, signaturePrompt, token)'
  assert.equal(adapterSource.split(pinned).length, 2, 'historical control must replace exactly one call site')
  adapterSource = adapterSource.replace(pinned,
    'const chatResult = await this.createChat(mappedModel, signaturePrompt)')
}

function compile(source, fileName) {
  const result = ts.transpileModule(source, { fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true } })
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return result.outputText
}
const adapterJs = compile(adapterSource, adapterPath)
const helperJs = compile(readSource(helperPath), helperPath)

function load(compiled, filename, dependencies, logs = []) {
  const module = { exports: {} }
  const console = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level =>
    [level, (...args) => logs.push({ level, args })]))
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require: id => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      throw new Error('Forbidden test import: ' + id)
    },
    console, Buffer, TextDecoder, URL, URLSearchParams, Date, Error, setTimeout, clearTimeout,
  }, { filename, timeout: 1500 })
  return module.exports
}
const claims = load(helperJs, helperPath, { crypto })

function token(label, subject = SUBJECT, extra = {}) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: subject, email: 'local19@example.invalid',
      fixture: label, ...extra })).toString('base64url'),
    'synthetic_signature',
  ].join('.')
}
const storedToken = token('stored')
const issuedA = token('issued-A')
const issuedB = token('issued-B')
const authReply = (issued = issuedA, subject = SUBJECT) => ({ status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  data: { id: subject, token: issued } })
const request = label => ({ model: 'glm-5', messages: [{ role: 'user', content: label }],
  stream: false, reasoning_effort: false, web_search: false })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function privateTransportError() {
  return Object.assign(new Error(CANARY), { config: {
    url: ORIGIN + COMPLETE_PATH + '?token=' + issuedA,
    headers: { Authorization: 'Bearer ' + issuedA, Cookie: 'token=' + issuedA },
  }, response: { data: { error: { detail: CANARY } } } })
}

function harness(options = {}) {
  const calls = []
  const logs = []
  const streams = []
  const forbidden = []
  let gets = 0
  let creates = 0
  let completions = 0
  const axios = {
    get: async (url, config) => {
      const call = { method: 'GET', url, config }
      calls.push(call)
      assert.equal(url, AUTH_URL, 'the only authentication request is the fixed first-party GET')
      gets++
      return options.onGet ? options.onGet(call, gets) : authReply(gets === 1 ? issuedA : issuedB)
    },
    post: async (url, body, config) => {
      const call = { method: 'POST', url, body, config }
      calls.push(call)
      const parsed = new URL(url)
      assert.equal(parsed.origin, ORIGIN, 'credentials must stay on the official provider origin')
      if (parsed.pathname === CREATE_PATH) {
        creates++
        return options.onCreate ? options.onCreate(call, creates)
          : { status: 201, data: { id: 'synthetic-chat-' + creates } }
      }
      assert.equal(parsed.pathname, COMPLETE_PATH, 'no alternate effect, refresh, login or retry path')
      completions++
      if (options.onComplete) return options.onComplete(call, completions)
      const stream = new PassThrough()
      streams.push(stream)
      return { status: 200, data: stream }
    },
  }
  for (const name of ['request', 'create', 'delete', 'put', 'patch']) {
    axios[name] = () => { forbidden.push(name); throw new Error('Forbidden synthetic transport: ' + name) }
  }
  const exported = load(adapterJs, adapterPath, {
    axios: { __esModule: true, default: axios }, crypto, stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': claims,
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createBaseChunk: () => ({}), createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: () => ({ chunks: [] }), flushToolCallBuffer: () => [],
    },
  }, logs)
  const provider = Object.freeze({ id: 'zai', apiEndpoint: ORIGIN, enabled: true })
  const makeAccount = (credential = storedToken, id = 'synthetic-account') => Object.freeze({
    id, providerId: provider.id, credentials: Object.freeze({ token: credential }),
  })
  const account = makeAccount(options.storedToken ?? storedToken)
  const makeAdapter = account => new exported.ZaiAdapter(provider, account)
  return { ...exported, calls, logs, forbidden, account, makeAccount, makeAdapter,
    adapter: makeAdapter(account), cleanup: () => streams.forEach(stream => stream.destroy()) }
}

function assertPinnedPost(call, expectedToken, subject = SUBJECT) {
  const url = new URL(call.url)
  assert.equal(url.origin, ORIGIN)
  assert.equal(call.method, 'POST')
  assert.equal(call.config.headers.Authorization, 'Bearer ' + expectedToken)
  assert.equal(call.config.headers.Cookie, 'token=' + expectedToken)
  assert.equal(call.config.maxRedirects, 0)
  if (url.pathname === COMPLETE_PATH) {
    assert.equal(url.searchParams.get('token'), expectedToken)
    assert.equal(url.searchParams.get('user_id'), subject)
    assert.equal(call.body.stream, true, 'preserve local.18 upstream SSE contract')
    assert.equal(call.config.responseType, 'stream')
    assert.equal(call.body.background_tasks.title_generation, false)
    assert.equal(call.body.background_tasks.tags_generation, false)
  } else {
    assert.equal(url.pathname, CREATE_PATH)
  }
}
function assertPrivate(h, value = '', extraTokens = []) {
  const output = inspect([value, h.logs], { depth: null })
  for (const secret of [CANARY, storedToken, issuedA, issuedB, ...extraTokens]) {
    assert.equal(output.includes(secret), false, 'synthetic credentials and provider details must stay private')
  }
  assert.equal(h.forbidden.length, 0, 'no fallback transport or auxiliary operation')
  assert.equal(h.account.credentials.token, storedToken)
}
async function assertFailure(h, stage, methods, status) {
  let failure
  await assert.rejects(h.adapter.chatCompletion(request('synthetic failure')), error => {
    failure = error
    return error instanceof h.ZaiProxyFailure && error.stage === stage
  })
  assert.deepEqual(h.calls.map(call => call.method), methods)
  assert.equal(failure.upstreamHttpStatus, status)
  for (const field of ['config', 'request', 'response', 'cause']) assert.equal(failure[field], undefined)
  assertPrivate(h, failure)
}

test('rotating auth pins one token across the actual chatCompletion operation', async t => {
  const h = harness()
  t.after(h.cleanup)
  const result = await h.adapter.chatCompletion(request('synthetic one-shot'))
  const tokenLabels = new Map([[storedToken, 'stored'], [issuedA, 'A'], [issuedB, 'B']])
  const operationTrace = h.calls.map(call => {
    const path = new URL(call.url).pathname
    const stage = call.method === 'GET' ? 'auth' : path === CREATE_PATH ? 'create' : 'complete'
    return stage + ':' + tokenLabels.get(call.config.headers.Authorization.slice('Bearer '.length))
  })
  assert.deepEqual(operationTrace, ['auth:stored', 'create:A', 'complete:A'],
    'RED control must expose both the extra auth GET and the create-B/complete-A split')
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 1,
    'an operation must authenticate once even when the next GET would rotate A to B')
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST'])
  assert.equal(h.calls[0].config.headers.Authorization, 'Bearer ' + storedToken)
  assert.equal(h.calls[0].config.maxRedirects, 0)
  assertPinnedPost(h.calls[1], issuedA)
  assertPinnedPost(h.calls[2], issuedA)
  assert.equal(h.calls[2].body.chat_id, result.chatId)
  assert.equal(h.calls[2].body.current_user_message_id,
    h.calls[1].body.chat.history.currentId)
  assertPrivate(h)
})

test('a pending create blocks its completion while another operation keeps its own token', { timeout: 5000 }, async t => {
  const entered = deferred()
  const release = deferred()
  const h = harness({ onCreate: async (_call, index) => {
    if (index === 1) { entered.resolve(); await release.promise }
    return { status: 201, data: { id: 'synthetic-chat-' + index } }
  } })
  t.after(h.cleanup)
  const first = h.adapter.chatCompletion(request('first'))
  await entered.promise
  try {
    assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST'])
    const second = await h.adapter.chatCompletion(request('second'))
    assert.equal(second.chatId, 'synthetic-chat-2')
    assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'GET', 'POST', 'POST'])
    assertPinnedPost(h.calls[1], issuedA)
    assertPinnedPost(h.calls[3], issuedB)
    assertPinnedPost(h.calls[4], issuedB)
  } finally {
    release.resolve()
  }
  const result = await first
  assert.equal(result.chatId, 'synthetic-chat-1')
  assert.equal(h.calls.length, 6)
  assertPinnedPost(h.calls[5], issuedA)
  assertPrivate(h)
})

test('public createChat and subsequent completions authenticate independently without a token cache', async t => {
  const issuedC = token('issued-C')
  const h = harness({ onGet: (_call, index) => authReply([issuedA, issuedB, issuedC][index - 1]) })
  t.after(h.cleanup)
  await h.adapter.createChat('glm-5', 'standalone')
  await h.adapter.chatCompletion(request('later first'))
  await h.adapter.chatCompletion(request('later second'))
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'GET', 'POST', 'POST', 'GET', 'POST', 'POST'])
  assertPinnedPost(h.calls[1], issuedA)
  for (const index of [3, 4]) assertPinnedPost(h.calls[index], issuedB)
  for (const index of [6, 7]) assertPinnedPost(h.calls[index], issuedC)
  for (const call of h.calls.filter(call => call.method === 'GET')) {
    assert.equal(call.config.headers.Authorization, 'Bearer ' + storedToken)
  }
  assertPrivate(h, '', [issuedC])
})

test('different accounts preserve their subjects and cannot share a module token', async t => {
  const otherSubject = 'synthetic-local19-other-subject'
  const otherStored = token('other-stored', otherSubject)
  const otherIssued = token('other-issued', otherSubject)
  const h = harness({ onGet: call => call.config.headers.Authorization === 'Bearer ' + storedToken
    ? authReply(issuedA) : authReply(otherIssued, otherSubject) })
  t.after(h.cleanup)
  const other = h.makeAccount(otherStored, 'synthetic-other-account')
  const [first, second] = await Promise.all([
    h.adapter.chatCompletion(request('own subject')),
    h.makeAdapter(other).chatCompletion(request('other subject')),
  ])
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 2)
  const posts = h.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 4)
  for (const call of posts) {
    const isOther = call.config.headers.Authorization === 'Bearer ' + otherIssued
    assertPinnedPost(call, isOther ? otherIssued : issuedA, isOther ? otherSubject : SUBJECT)
    if (new URL(call.url).pathname === COMPLETE_PATH) {
      assert.equal(call.body.chat_id, isOther ? second.chatId : first.chatId)
    }
  }
  assert.equal(other.credentials.token, otherStored)
  assertPrivate(h, '', [otherStored, otherIssued])
})

test('untrusted response endpoint fields cannot move pinned credentials to another provider', async t => {
  const h = harness({ onGet: () => ({ ...authReply(), data: { ...authReply().data,
    apiEndpoint: 'https://synthetic-other.invalid', url: 'https://synthetic-other.invalid/refresh' } }) })
  t.after(h.cleanup)
  await h.adapter.chatCompletion(request('fixed origin'))
  assert.equal(h.calls.length, 3)
  for (const call of h.calls) assert.equal(new URL(call.url).origin, ORIGIN)
  assertPrivate(h)
})

test('unverified or changed auth identity stops before either effect with fixed failures', async t => {
  const epoch = Math.floor(Date.now() / 1000)
  const cases = [
    ['root identity mismatch', () => authReply(issuedA, 'synthetic-wrong-subject')],
    ['replacement identity mismatch', () => authReply(token('wrong', 'synthetic-wrong-subject'))],
    ['expired replacement', () => authReply(token('expired', SUBJECT, { exp: epoch - 60 }))],
    ['future replacement', () => authReply(token('future', SUBJECT, { nbf: epoch + 3600 }))],
    ['guest replacement', () => authReply(token('guest', SUBJECT, { email: 'fixture@guest.com' }))],
    ['malformed replacement', () => authReply(CANARY)],
    ['HTTP 403', () => ({ ...authReply(), status: 403 }), 403],
    ['non-JSON body', () => ({ ...authReply(), headers: { 'content-type': 'text/html' }, data: CANARY })],
    ['transport loss', () => { throw privateTransportError() }],
  ]
  for (const [name, onGet, status] of cases) {
    await t.test(name, async () => {
      const h = harness({ onGet })
      await assertFailure(h, 'auth-preflight', ['GET'], status)
    })
  }
})

test('creation and completion failures preserve stage and redact raw transport errors without replay', async t => {
  for (const [name, options, stage, methods, status] of [
    ['create rejected', { onCreate: () => ({ status: 403, data: { error: { detail: CANARY } } }) },
      'chat-creation', ['GET', 'POST'], 403],
    ['create invalid', { onCreate: () => ({ status: 201, data: { detail: CANARY } }) },
      'chat-creation', ['GET', 'POST']],
    ['create outcome unknown', { onCreate: () => { throw privateTransportError() } },
      'chat-creation', ['GET', 'POST']],
    ['completion outcome unknown', { onComplete: () => { throw privateTransportError() } },
      'chat-completion', ['GET', 'POST', 'POST']],
  ]) {
    await t.test(name, async () => {
      const h = harness(options)
      await assertFailure(h, stage, methods, status)
      for (const call of h.calls.filter(call => call.method === 'POST')) assertPinnedPost(call, issuedA)
    })
  }
})

test('a rejected completion destroys its unread error stream and never reauthenticates or retries', async () => {
  const body = new PassThrough()
  body.write(CANARY)
  const h = harness({ onComplete: () => ({ status: 403, data: body }) })
  const result = await h.adapter.chatCompletion(request('rejected completion'))
  assert.equal(result.response.status, 403, 'the existing forwarder contract retains the upstream status')
  assert.equal(body.destroyed, true)
  assert.equal(body.listenerCount('data'), 0)
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST'])
  assertPrivate(h)
})

test('SSE error detail stays out of assistant content and cannot be repaired by a later DONE', async t => {
  for (const location of ['root', 'data', 'event']) {
    await t.test(location, async t => {
      const h = harness()
      t.after(h.cleanup)
      const { response } = await h.adapter.chatCompletion(request('stream error'))
      const output = await new h.ZaiStreamHandler('glm-5').handleStream(response.data)
      const collected = (async () => {
        const chunks = []
        for await (const chunk of output) chunks.push(chunk.toString())
        return chunks.join('')
      })()
      const detail = { detail: CANARY, headers: { Authorization: 'Bearer ' + issuedA },
        url: ORIGIN + COMPLETE_PATH + '?token=' + issuedA }
      const envelope = { type: 'chat:completion', data: { phase: 'answer', delta_content: CANARY } }
      if (location === 'root') envelope.error = detail
      if (location === 'data') envelope.data.error = detail
      response.data.end(
        'data: ' + JSON.stringify({ type: 'chat:completion', data: { phase: 'answer', delta_content: CANARY } }) + '\n\n' +
        (location === 'event' ? 'event: error\n' : '') + 'data: ' + JSON.stringify(envelope) + '\n\n' +
        'data: ' + JSON.stringify({ type: 'chat:completion', data: { phase: 'done', done: true } }) + '\n\n' +
        'data: [DONE]\n\n')
      const text = await collected
      const frames = text.trim().split('\n\n').map(frame => JSON.parse(frame.slice('data: '.length)))
      assert.deepEqual(frames, [{ error: { message: 'Z.ai upstream returned a model error', type: 'api_error' } }])
      assert.equal(text.includes('[DONE]'), false)
      assert.equal(text.includes('"choices"'), false)
      assert.equal(text.includes('"finish_reason"'), false)
      assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST'])
      assertPrivate(h, text)
    })
  }
})
