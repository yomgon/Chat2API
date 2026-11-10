import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Only these repository source files are read. All transport, credentials,
// account IDs and provider responses below are synthetic and held in memory.
// The VM rejects every import that is not explicitly supplied by this harness.
const root = new URL('../../', import.meta.url)
const ORIGIN = 'https://www.kimi.com'
const CHAT_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat'
const SECRET = 'SYNTHETIC_KIMI_TOKEN_NEVER_PRINT'
const OTHER_SECRET = 'SYNTHETIC_SECOND_ACCOUNT_NEVER_PRINT'
const PRIVATE_BODY = 'SYNTHETIC_PROVIDER_BODY_NEVER_PRINT'
const PRIVATE_MESSAGE = 'SYNTHETIC_USER_CONTENT_NEVER_PRINT'

function compile(relative) {
  const result = ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
    fileName: relative,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  })
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return { code: result.outputText, filename: fileURLToPath(new URL(relative, root)) }
}

const compiledAdapter = compile('src/main/proxy/adapters/kimi.ts')
const compiledProtocol = compile('src/main/proxy/adapters/providerModelOptions.ts')

function load(compiled, dependencies, logs) {
  const module = { exports: {} }
  vm.runInNewContext(compiled.code, {
    module, exports: module.exports,
    require: id => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      throw new Error('Unexpected synthetic dependency')
    },
    Buffer, URL, Date, Error,
    console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
  }, { filename: compiled.filename, timeout: 1500 })
  return module.exports
}

function harness(respond = () => ({ status: 200, data: {} })) {
  const calls = []
  const logs = []
  const protocol = load(compiledProtocol, {}, logs)
  const axios = { post: async (url, body, config) => {
    const call = { url, body, config }
    calls.push(call)
    return respond(call, calls.length - 1)
  } }
  const exports = load(compiledAdapter, {
    axios: { __esModule: true, default: axios },
    stream: { PassThrough },
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: () => ({}) },
    './providerModelOptions': protocol,
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }, logs)
  return { ...exports, calls, logs }
}

const provider = (overrides = {}) => ({
  id: 'kimi', type: 'builtin', authType: 'jwt', apiEndpoint: ORIGIN, headers: {}, ...overrides,
})
const account = (credentials = { token: SECRET }, overrides = {}) => ({
  id: 'synthetic-account-a', providerId: 'kimi', credentials, ...overrides,
})
const request = (model = 'k2d6-chat') => ({
  model, messages: [{ role: 'user', content: PRIVATE_MESSAGE }], stream: false,
})

function assertRedacted(value, logs, forbidden = []) {
  const rendered = inspect({ value, logs }, { showHidden: true, depth: 8 })
  for (const marker of [SECRET, OTHER_SECRET, PRIVATE_BODY, PRIVATE_MESSAGE, ...forbidden]) {
    assert.equal(rendered.includes(marker), false, 'private fixture must not appear in an error or log')
  }
}

function assertFailure(h, failure, stage, status) {
  assert.equal(failure instanceof h.KimiProxyFailure, true)
  assert.equal(failure.name, 'KimiProxyFailure')
  assert.equal(failure.stage, stage)
  assert.equal(failure.upstreamStatus, status)
  assert.equal(failure.message, {
    'auth-preflight': 'Kimi authentication preflight failed',
    'chat-completion': 'Kimi completion was rejected',
    'response-decoding': 'Kimi response decoding failed',
  }[stage])
  assert.equal(failure.cause, undefined)
  assert.equal(Object.getOwnPropertyNames(failure).every(key =>
    ['name', 'message', 'stack', 'stage', 'upstreamStatus'].includes(key)), true)
  assertRedacted(failure, h.logs)
}

function assertPinned(call, expectedToken, expectedPath = CHAT_PATH) {
  const url = new URL(call.url)
  assert.equal(url.origin, ORIGIN)
  assert.equal(url.pathname, expectedPath)
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(call.config.maxRedirects, 0)
  assert.equal(call.config.validateStatus(302), true)
  assert.equal(call.config.headers.Origin, ORIGIN)
  // Boolean comparisons keep synthetic credential values out of diagnostics.
  assert.equal(call.config.headers.Authorization === `Bearer ${expectedToken}`, true)
  assert.equal(Object.keys(call.config.headers).filter(key => key.toLowerCase() === 'authorization').length, 1)
  assert.equal(Object.keys(call.config.headers).some(key => key.toLowerCase() === 'cookie'), false)
}

function syntheticJwt(claims) {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
}

test('token detection remains local classification and never chooses an origin or verifies a session', async () => {
  const h = harness()
  for (const [token, expected] of [
    [syntheticJwt({ app_id: 'kimi', typ: 'access', sub: 'synthetic-subject', iss: 'https://www.kimi.ai' }), 'jwt'],
    [syntheticJwt({ app_id: 'other', typ: 'access' }), 'refresh'],
    [syntheticJwt({ app_id: 'kimi', typ: 'refresh' }), 'refresh'],
    ['eyJ.not-json.synthetic', 'refresh'],
    [SECRET, 'refresh'],
  ]) {
    assert.equal(h.detectTokenType(token), expected)
    const adapter = new h.KimiAdapter(provider(), account({ token }))
    await adapter.chatCompletion(request())
    assertPinned(h.calls.at(-1), token)
    assertRedacted(undefined, h.logs, [token])
  }
  assert.equal(h.calls.length, 5, 'classification must not add refresh or identity requests')
})

test('the stored OAuth accessToken is accepted with original token and refreshToken precedence', async () => {
  for (const [credentials, chosen] of [
    [{ accessToken: SECRET }, SECRET],
    [{ token: SECRET }, SECRET],
    [{ refreshToken: SECRET }, SECRET],
    [{ token: SECRET, refreshToken: OTHER_SECRET, accessToken: OTHER_SECRET }, SECRET],
    [{ token: '', refreshToken: SECRET, accessToken: OTHER_SECRET }, SECRET],
    [{ token: '', refreshToken: '', accessToken: SECRET }, SECRET],
  ]) {
    const h = harness()
    const adapter = new h.KimiAdapter(Object.freeze(provider()), Object.freeze(account(Object.freeze(credentials))))
    await adapter.chatCompletion(request())
    assert.equal(h.calls.length, 1)
    assertPinned(h.calls[0], chosen)
    assert.equal(h.calls[0].config.headers['Content-Type'], 'application/connect+json')
    assertRedacted(undefined, h.logs)
  }
})

test('missing or malformed selected credentials fail locally without guessing another field', () => {
  for (const credentials of [
    {}, undefined, null, { token: '' }, { token: ' ' }, { token: `${SECRET}\r\nInjected: yes` },
    { token: false, accessToken: SECRET }, { token: 0, accessToken: SECRET },
    { token: null, accessToken: SECRET }, { token: {}, accessToken: SECRET },
    { token: SECRET + '\u0000' }, { token: SECRET + '\u007f' },
    { access_token: SECRET }, { apiKey: SECRET },
  ]) {
    const h = harness()
    assert.throws(() => new h.KimiAdapter(provider(), { ...account(), credentials }), error => {
      assertFailure(h, error, 'auth-preflight', undefined)
      return true
    })
    assert.equal(h.calls.length, 0)
  }
})

test('provider and account binding is checked before credentials are accessed', () => {
  for (const [providerOverride, accountOverride] of [
    [{}, { id: undefined }], [{}, { id: '' }], [{}, { id: '  ' }],
    [{}, { providerId: undefined }], [{}, { providerId: 'KIMI' }], [{}, { providerId: 'other' }],
    [{ id: '' }, { providerId: '' }], [{ id: 1 }, { providerId: 1 }],
  ]) {
    const h = harness()
    let credentialReads = 0
    const selected = account({}, accountOverride)
    Object.defineProperty(selected, 'credentials', { get() {
      credentialReads++
      throw new Error(PRIVATE_BODY)
    } })
    assert.throws(() => new h.KimiAdapter(provider(providerOverride), selected), error => {
      assertFailure(h, error, 'auth-preflight', undefined)
      return true
    })
    assert.equal(credentialReads, 0)
    assert.equal(h.calls.length, 0)
  }
})

test('only the existing exact configured www.kimi.com origin is permitted', async () => {
  for (const endpoint of [ORIGIN, `${ORIGIN}/`]) {
    const h = harness()
    await new h.KimiAdapter(provider({ apiEndpoint: endpoint }), account()).chatCompletion(request())
    assert.equal(h.calls.length, 1)
    assertPinned(h.calls[0], SECRET)
  }
  for (const endpoint of [
    undefined, '', 'https://www.kimi.ai', 'https://kimi.ai', 'https://kimi.com',
    'http://www.kimi.com', 'https://WWW.KIMI.COM', `${ORIGIN}:443`, `${ORIGIN}:8443`,
    `${ORIGIN}/chat`, `${ORIGIN}//`, `${ORIGIN}?realm=ai`, `${ORIGIN}#realm`,
    'https://www.kimi.com.evil.invalid', 'https://evil.invalid/www.kimi.com',
    'https://www.kimi.com@evil.invalid', 'https://user@www.kimi.com',
    'https://www.kimi.com./', ` ${ORIGIN}`, `${ORIGIN}\n`,
  ]) {
    const h = harness()
    let credentialReads = 0
    const selected = account()
    Object.defineProperty(selected, 'credentials', { get() {
      credentialReads++
      throw new Error(PRIVATE_BODY)
    } })
    assert.throws(() => new h.KimiAdapter(provider({ apiEndpoint: endpoint }), selected), error => {
      assertFailure(h, error, 'auth-preflight', undefined)
      return true
    })
    assert.equal(credentialReads, 0)
    assert.equal(h.calls.length, 0)
  }
})

test('Kimi matching rejects substring hosts while retaining known-ID preflight routing', () => {
  const h = harness()
  assert.equal(h.KimiAdapter.isKimiProvider(provider({ apiEndpoint: 'https://evil.invalid' })), true)
  assert.equal(h.KimiAdapter.isKimiProvider(provider({ id: 'synthetic-alias' })), true)
  for (const endpoint of ['https://www.kimi.com.evil.invalid', 'https://evil.invalid/kimi.com',
    'https://user@www.kimi.com', 'https://www.kimi.ai']) {
    assert.equal(h.KimiAdapter.isKimiProvider(provider({ id: 'unrelated', apiEndpoint: endpoint })), false)
  }
})

test('each instance keeps its account token and origin despite caller mutation or header overrides', async () => {
  const h = harness()
  const config = provider({
    chatPath: 'https://evil.invalid/chat',
    headers: { Authorization: OTHER_SECRET, authorization: OTHER_SECRET, Cookie: OTHER_SECRET, Origin: 'https://evil.invalid' },
  })
  const selected = account()
  const first = new h.KimiAdapter(config, selected)
  const second = new h.KimiAdapter(provider(), account({ token: OTHER_SECRET }, { id: 'synthetic-account-b' }))
  config.apiEndpoint = 'https://www.kimi.ai'
  config.id = 'other'
  selected.id = 'other'
  selected.providerId = 'other'
  selected.credentials.token = OTHER_SECRET
  await first.chatCompletion(request())
  await second.chatCompletion(request())
  await first.chatCompletion(request())
  assert.equal(h.calls.length, 3)
  for (const [index, token] of [[0, SECRET], [1, OTHER_SECRET], [2, SECRET]]) assertPinned(h.calls[index], token)
  assertRedacted(undefined, h.logs)
})

test('explicit agent models remain blocked before any transport or message access', async () => {
  for (const model of ['k3-agent', 'k28-agent-preview', ' K3-AGENT ']) {
    const h = harness()
    let messageReads = 0
    const input = { model, get messages() { messageReads++; throw new Error(PRIVATE_MESSAGE) } }
    const failure = await new h.KimiAdapter(provider(), account()).chatCompletion(input).catch(error => error)
    assert.equal(failure.message, 'Kimi agent models are not supported by the chat adapter.')
    assert.equal(failure.upstreamStatus, undefined)
    assertRedacted(failure, h.logs)
    assert.equal(messageReads, 0)
    assert.equal(h.calls.length, 0)
  }
})

test('HTTP rejections retain only fixed stage and numeric status with no token or host failover', async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503, 599]) {
    let destroyed = 0
    const h = harness(() => ({ status, statusText: PRIVATE_BODY,
      data: { secret: PRIVATE_BODY, destroy() { destroyed++ } } }))
    const adapter = new h.KimiAdapter(provider(), account({ token: SECRET, accessToken: OTHER_SECRET }))
    const failure = await adapter.chatCompletion(request()).catch(error => error)
    assertFailure(h, failure, 'chat-completion', status)
    assert.equal(h.calls.length, 1, 'failure must not refresh, change credential, or replay')
    assertPinned(h.calls[0], SECRET)
    assert.equal(destroyed, 1)
  }
})

test('redirects never follow Location, read it as an origin, or manufacture an authentication status', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let locationReads = 0
    const headers = { get location() { locationReads++; throw new Error(PRIVATE_BODY) } }
    const h = harness(() => ({ status, headers, data: { destroy() {} } }))
    const failure = await new h.KimiAdapter(provider(), account()).chatCompletion(request()).catch(error => error)
    // The public error contract carries HTTP4xx/5xx only; 3xx becomes a fixed
    // completion failure, with no invented 401 and no redirect destination.
    assertFailure(h, failure, 'chat-completion', undefined)
    assert.equal(locationReads, 0)
    assert.equal(h.calls.length, 1)
    assertPinned(h.calls[0], SECRET)
  }
})

test('transport rejection drops Axios request, response, cause, and unconfirmed status', async () => {
  const upstream = Object.assign(new Error(PRIVATE_BODY), {
    config: { headers: { Authorization: SECRET, Cookie: OTHER_SECRET } },
    request: { body: PRIVATE_MESSAGE }, response: { status: 401, data: PRIVATE_BODY },
    cause: new Error(OTHER_SECRET), upstreamStatus: 403,
  })
  const h = harness(() => { throw upstream })
  const failure = await new h.KimiAdapter(provider(), account()).chatCompletion(request()).catch(error => error)
  assertFailure(h, failure, 'chat-completion', undefined)
  assert.equal(failure === upstream, false)
  assert.equal(h.calls.length, 1)
})

test('status values are not coerced and response cleanup cannot replace a safe rejection', async () => {
  for (const status of ['401', 0, 399, 600, 401.5, NaN, Infinity, undefined]) {
    const h = harness(() => ({ status, data: { destroy() { throw new Error(PRIVATE_BODY) } } }))
    const failure = await new h.KimiAdapter(provider(), account()).chatCompletion(request()).catch(error => error)
    assertFailure(h, failure, 'chat-completion', undefined)
    assert.equal(h.calls.length, 1)
  }
  const h = harness(() => ({ status: 401, data: { destroy() { throw new Error(PRIVATE_BODY) } } }))
  const failure = await new h.KimiAdapter(provider(), account()).chatCompletion(request()).catch(error => error)
  assertFailure(h, failure, 'chat-completion', 401)
})

test('delete, list, and batch cleanup pin the same authorization and forbid redirects', async () => {
  const h = harness(call => ({ status: 200, data: call.url.endsWith('/ListChats')
    ? { chats: [{ id: 'synthetic-chat' }] } : {} }))
  const adapter = new h.KimiAdapter(provider(), account({ accessToken: SECRET }))
  assert.equal(await adapter.deleteConversation('synthetic-chat'), true)
  assert.equal(await adapter.deleteAllChats(), true)
  assert.equal(h.calls.length, 3)
  for (const [index, rpc] of [[0, 'DeleteChat'], [1, 'ListChats'], [2, 'BatchDeleteChats']]) {
    assertPinned(h.calls[index], SECRET, `/apiv2/kimi.chat.v1.ChatService/${rpc}`)
  }
  assertRedacted(undefined, h.logs)
})

test('cleanup redirects and provider errors retain boolean failure without replay or leakage', async () => {
  for (const operation of ['DeleteChat', 'ListChats', 'BatchDeleteChats']) {
    const h = harness(call => {
      if (call.url.endsWith(`/${operation}`)) return { status: 307, data: { message: PRIVATE_BODY } }
      return { status: 200, data: { chats: [{ id: 'synthetic-chat' }] } }
    })
    const adapter = new h.KimiAdapter(provider(), account())
    assert.equal(await (operation === 'DeleteChat' ? adapter.deleteConversation('synthetic-chat') : adapter.deleteAllChats()), false)
    assert.equal(h.calls.length, operation === 'BatchDeleteChats' ? 2 : 1)
    assert.equal(h.calls.every(call => call.config.maxRedirects === 0), true)
    assertRedacted(undefined, h.logs)
  }
  const h = harness(() => ({ status: 200, data: { error_type: 'synthetic.error', message: PRIVATE_BODY } }))
  assert.equal(await new h.KimiAdapter(provider(), account()).deleteAllChats(), false)
  assert.equal(h.calls.length, 1)
  assertRedacted(undefined, h.logs)
})

function frame(flag, payload) {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
  const framed = Buffer.alloc(5 + bytes.length)
  framed.writeUInt8(flag, 0)
  framed.writeUInt32BE(bytes.length, 1)
  bytes.copy(framed, 5)
  return framed
}

test('malformed Connect data and transport close carry response-decoding provenance', async () => {
  for (const kind of ['invalid-json', 'unsupported-flag', 'transport-error', 'close']) {
    const h = harness()
    const stream = new PassThrough()
    const pending = new h.KimiStreamHandler('k2d6-chat', '').handleNonStream(stream).catch(error => error)
    if (kind === 'invalid-json') stream.end(frame(0, PRIVATE_BODY))
    else if (kind === 'unsupported-flag') stream.end(frame(1, {}))
    else if (kind === 'transport-error') stream.destroy(new Error(PRIVATE_BODY))
    else stream.end()
    assertFailure(h, await pending, 'response-decoding', undefined)
    assert.equal(h.calls.length, 0)
  }
})

test('Connect terminal failures keep the existing bounded status map and redact server fields', async () => {
  for (const [code, status] of [['unauthenticated', 401], ['permission_denied', 403], ['resource_exhausted', 429], ['unknown', 502]]) {
    const h = harness()
    const stream = new PassThrough()
    const pending = new h.KimiStreamHandler('k2d6-chat', '').handleNonStream(stream).catch(error => error)
    stream.end(frame(2, { error: { code, message: PRIVATE_BODY, details: { token: SECRET } } }))
    assertFailure(h, await pending, 'response-decoding', status)
    assert.equal(h.calls.length, 0)
  }
})
