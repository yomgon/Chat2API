import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { inspect } from 'node:util'
import ts from 'typescript'
import { createParser } from 'eventsource-parser'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Run: node --test tests/security/provider-adapter-log-privacy.test.mjs
// Only adapter source and local compiler/parser packages are read. Application,
// store, Electron, Axios and HTTP/2 imports are mocked; unknown imports fail.
// Private TypeScript methods are exercised after transpilation to test their
// existing protocol logic without starting Electron or contacting a provider.
const adapterRoot = fileURLToPath(new URL('../../src/main/proxy/adapters/', import.meta.url))
const markers = Object.freeze({
  access: 'PRIVATE_ACCESS_0123456789abcdefghijklmnopqrstuvwxyz',
  refresh: 'PRIVATE_REFRESH_0123456789abcdefghijklmnopqrstuvwxyz',
  nextRefresh: 'PRIVATE_ROTATED_0123456789abcdefghijklmnopqrstuvwxyz',
  cookie: 'PRIVATE_COOKIE_0123456789abcdefghijklmnopqrstuvwxyz',
  session: 'PRIVATE_SESSION_0123456789abcdefghijklmnopqrstuvwxyz',
  user: 'PRIVATE_USER_0123456789abcdefghijklmnopqrstuvwxyz',
  prompt: 'PRIVATE_PROMPT_0123456789abcdefghijklmnopqrstuvwxyz',
  answer: 'PRIVATE_ANSWER_0123456789abcdefghijklmnopqrstuvwxyz',
  error: 'PRIVATE_ERROR_0123456789abcdefghijklmnopqrstuvwxyz',
  key: 'PRIVATE_JSONKEY_0123456789abcdefghijklmnopqrstuvwxyz',
})
const plain = value => JSON.parse(JSON.stringify(value))
const forbidden = name => () => { throw new Error('Unexpected offline dependency: ' + name) }

function adapterFiles(directory = adapterRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? adapterFiles(file) : entry.name.endsWith('.ts') ? [file] : []
  }).sort()
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

function isConsole(node) {
  if (ts.isIdentifier(node) && node.text === 'console') {
    // The property name in globalThis.console is handled by its parent.
    return !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  }
  return memberName(node) === 'console'
    && ts.isIdentifier(node.expression)
    && ['globalThis', 'global', 'window'].includes(node.expression.text)
}

function unsafeLogging(source, file = 'fixture.ts') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const failures = ast.parseDiagnostics.map(diagnostic => (
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  ))
  let calls = 0
  const fail = (node, reason) => {
    failures.push((ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1) + ': ' + reason)
  }
  function visit(node) {
    if (isConsole(node)) {
      const member = node.parent
      const call = member?.parent
      if (!member || member.expression !== node || !memberName(member)
        || !ts.isCallExpression(call) || call.expression !== member) {
        fail(node, 'Console aliases and indirect logging are not permitted')
      } else {
        calls++
        if (call.arguments.length !== 1 || !ts.isStringLiteralLike(call.arguments[0])) {
          fail(call, 'Adapter diagnostics must contain one fixed literal message')
        }
      }
    }
    if (ts.isIdentifier(node) && /^(appLog|logger)$/.test(node.text)) {
      fail(node, 'Additional logging sinks require an explicit privacy review')
    }
    if (ts.isCallExpression(node)
      && /^(?:process\.)?(?:stdout|stderr)\.write$/.test(node.expression.getText(ast))) {
      fail(node, 'Direct diagnostic output bypasses the privacy contract')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { failures, calls }
}

function captureConsole() {
  const entries = []
  const console = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'].map(level => [
      level, (...args) => entries.push({
        level,
        args,
        // Error.message and Error.stack are non-enumerable. JSON.stringify
        // would miss them and could accept the old raw AxiosError logs.
        rendered: inspect(args, { depth: 20, maxStringLength: null, customInspect: false, getters: false }),
      }),
    ]),
  )
  return { entries, console }
}

function assertPrivate(logs, extraSecrets = []) {
  const output = logs.entries.map(entry => entry.rendered).join('\n')
  for (const secret of [...Object.values(markers), ...extraSecrets]) {
    for (const fragment of new Set([secret, secret.slice(0, 12), secret.slice(0, 20)])) {
      assert.equal(output.includes(fragment), false, 'A synthetic private value reached diagnostics')
    }
  }
  for (const entry of logs.entries) {
    assert.equal(entry.args.length, 1, 'Diagnostics must not receive hidden object/error arguments')
    assert.equal(typeof entry.args[0], 'string')
  }
}

function richError() {
  return Object.assign(new Error(markers.error), {
    isAxiosError: true,
    code: 'ERR_BAD_RESPONSE',
    config: {
      url: 'https://example.invalid/?token=' + markers.access,
      headers: { Authorization: 'Bearer ' + markers.access, Cookie: markers.cookie },
      data: { prompt: markers.prompt },
    },
    request: { session: markers.session },
    response: {
      status: 401,
      headers: { 'set-cookie': [markers.cookie] },
      data: { access_token: markers.access, refresh_token: markers.refresh, [markers.key]: markers.answer },
    },
  })
}

function axiosMock(replies = []) {
  const calls = []
  const queue = [...replies]
  const send = async (method, args) => {
    calls.push({ method, args })
    assert.ok(queue.length, 'An unexpected mocked Axios operation was attempted')
    const reply = queue.shift()
    if (reply instanceof Error) throw reply
    return reply
  }
  const axios = (...args) => send('call', args)
  for (const method of ['get', 'post', 'delete', 'request']) {
    axios[method] = (...args) => send(method, args)
  }
  axios.create = () => axios
  return { axios, calls, assertDrained: () => assert.equal(queue.length, 0) }
}

function fixtureAccount(credentials = {}) {
  return {
    id: 'offline-account',
    credentials: { token: markers.access, ...credentials },
  }
}

const fixtureProvider = Object.freeze({ id: 'offline-provider', modelMappings: {} })
const sourceCache = new Map()
const compiledCache = new Map()

// The adapter now enforces the same pure JWT metadata gate as reconnect.
// Evaluate the actual helper inside the offline VM, not a permissive stub.
function loadZaiClaimsHelper() {
  const file = fileURLToPath(new URL('../../src/main/oauth/zaiSession.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, Buffer, URL, Date,
    require(name) {
      assert.equal(name, 'crypto', 'Z.ai session helper must remain pure')
      return crypto
    },
  }, { filename: file, timeout: 2000 })
  return module.exports
}
const zaiClaimsHelper = loadZaiClaimsHelper()

function loadAdapter(name, overrides = {}) {
  const logs = captureConsole()
  const blockedHttp = Object.fromEntries(['connect', 'request', 'createServer'].map(key => [key, forbidden(key)]))
  const toolProfile = {
    formatAssistantToolCalls: calls => JSON.stringify(calls),
    formatToolResult: result => result.content,
  }
  const baseChunk = (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' })
  const imports = {
    '../../providers/qwenTicket': QWEN_TICKET_MODULE,
    '../../providers/qwenAiToken': QWEN_AI_TOKEN_MODULE,
    axios: axiosMock().axios,
    crypto,
    stream: { PassThrough, Readable },
    http2: blockedHttp,
    electron: { net: { request: forbidden('electron.net.request') } },
    'eventsource-parser': { createParser },
    'form-data': class { constructor() { forbidden('multipart upload')() } },
    'mime-types': { extension: () => 'bin', lookup: () => 'application/octet-stream' },
    path: { basename: path.basename },
    zlib: {
      createGunzip: forbidden('gzip'),
      createInflate: forbidden('deflate'),
      createBrotliDecompress: forbidden('brotli'),
    },
    'zstd-codec': { run: forbidden('zstd') },
    '../../store/store': { storeManager: { updateAccount: forbidden('store.updateAccount') } },
    '../../oauth/zaiSession': zaiClaimsHelper,
    '../../lib/challenge': { getDeepSeekHash: forbidden('proof of work') },
    '../utils/tools': {
      toolsToSystemPrompt: forbidden('tool prompt generation'),
      TOOL_WRAP_HINT: '',
      hasToolPromptInjected: () => false,
      shouldInjectToolPrompt: () => false,
    },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': {
      createBaseChunk: baseChunk,
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: (content, _state, base, first) => ({
        chunks: content ? [{
          ...base,
          choices: [{ index: 0, delta: { ...(first ? { role: 'assistant' } : {}), content }, finish_reason: null }],
        }] : [],
      }),
      flushToolCallBuffer: () => [],
    },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => toolProfile },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class { constructor() { forbidden('tool parser')() } } },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
    '../../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../../constants/signatures': {
      TOOL_PROMPT_SIGNATURES: { general: [] },
      hasGeneralToolPromptSignature: () => false,
    },
    '../../prompt/variants': {
      DEFAULT_VARIANT: { id: 'offline-default', toolPromptTemplate: '{{TOOL_DEFINITIONS}}' },
      XML_VARIANT: { id: 'offline-xml', toolPromptTemplate: '{{TOOL_DEFINITIONS}}' },
    },
    ...overrides,
  }
  const timers = new Map()
  let timerId = 0
  const context = vm.createContext({
    console: logs.console, Buffer, Error, URL, URLSearchParams, TextDecoder, TextEncoder,
    process: Object.freeze({ platform: 'win32' }),
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
  }, { codeGeneration: { strings: false, wasm: false } })
  context.global = context
  const loaded = new Map()
  function load(file) {
    assert.ok(file.startsWith(adapterRoot), 'Source loading must remain inside the adapter directory')
    if (loaded.has(file)) return loaded.get(file).exports
    if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, 'utf8'))
    if (!compiledCache.has(file)) {
      const result = ts.transpileModule(sourceCache.get(file), {
        fileName: file,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
        },
        reportDiagnostics: true,
      })
      assert.deepEqual(
        (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), [],
      )
      compiledCache.set(file, result.outputText)
    }
    const module = { exports: {} }
    loaded.set(file, module)
    const requireMock = specifier => {
      const key = specifier.replace(/\.ts$/, '')
      if (Object.hasOwn(imports, key)) return imports[key]
      // Only pure/owned adapter dependencies are eligible for local recursion.
      if (key.startsWith('.')) {
        const target = path.resolve(path.dirname(file), key + '.ts')
        if (target.startsWith(adapterRoot) && adapterFiles().includes(target)) return load(target)
      }
      throw new Error('Blocked adapter import: ' + specifier)
    }
    const wrapper = vm.runInContext(
      '(function(require, module, exports) {\n' + compiledCache.get(file) + '\n})',
      context, { filename: file, timeout: 2000 },
    )
    wrapper(requireMock, module, module.exports)
    return module.exports
  }
  return { exports: load(path.join(adapterRoot, name)), logs, timers }
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'offline-signature',
  ].join('.')
}

function sse(data, event) {
  return (event ? 'event: ' + event + '\n' : '')
    + 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n'
}

function captureStream(stream) {
  const chunks = []
  const errors = []
  const done = new Promise(resolve => {
    stream.on('data', chunk => chunks.push(chunk.toString()))
    stream.on('error', error => errors.push(error))
    stream.once('end', () => resolve(chunks.join('')))
  })
  return { chunks, errors, done }
}

test('every provider and nested prompt adapter has only fixed diagnostic messages', () => {
  const files = adapterFiles()
  for (const name of ['deepseek.ts', 'glm.ts', 'minimax.ts', 'qwen-ai.ts', 'qwen.ts', 'mimo.ts']) {
    assert.ok(files.includes(path.join(adapterRoot, name)))
  }
  assert.ok(files.includes(path.join(adapterRoot, 'prompt', 'DefaultPromptAdapter.ts')))
  let calls = 0
  for (const file of files) {
    const checked = unsafeLogging(readFileSync(file, 'utf8'), file)
    assert.deepEqual(checked.failures, [], path.relative(adapterRoot, file))
    calls += checked.calls
  }
  assert.ok(calls > 0, 'The regression must actually inspect diagnostic statements')
})

test('static guard rejects payloads, prefixes, raw errors, keys, headers and indirect sinks', () => {
  const bad = [
    "console.log('[Provider] Credentials:', account.credentials)",
    "console.log('[Provider] Token:', token.substring(0, 20))",
    "console.log('[Provider] Headers:', JSON.stringify(response.headers))",
    "console.error('[Provider] Failed:', error)",
    "console.error('[Provider] Failed:', error.message)",
    "console.log('[Provider] Keys:', Object.keys(response.data))",
    "console['warn']('[Provider] Failed:', response.data)",
    "globalThis.console.error('[Provider] Failed:', error)",
    "globalThis['console']['error']('[Provider] Failed:', error)",
    "console?.error?.('[Provider] Failed:', error)",
    "const report = console.error; report(error)",
    "const report = console.error.bind(console); report(error)",
    "logger.error('Failed', error)",
    "appLog('error', error.message)",
    "process.stderr.write(error.message)",
  ]
  for (const source of bad) assert.ok(unsafeLogging(source).failures.length > 0, source)
  assert.deepEqual(unsafeLogging("console.error('[Provider] Request failed')").failures, [])
})

test('DeepSeek token acquisition keeps credentials and token-bearing responses out of logs', async () => {
  const net = axiosMock([{ status: 200, data: { code: 0, data: { biz_code: 0, biz_data: { token: markers.access } } } }])
  const h = loadAdapter('deepseek.ts', { axios: net.axios })
  const adapter = new h.exports.DeepSeekAdapter(fixtureProvider, fixtureAccount({ token: markers.refresh }))
  assert.equal(await adapter.acquireToken(), markers.access)
  assert.equal(await adapter.acquireToken(), markers.access)
  assert.equal(net.calls.length, 1, 'Token caching must be preserved')
  assert.equal(net.calls[0].args[1].headers.Authorization, 'Bearer ' + markers.refresh)
  net.assertDrained()
  assertPrivate(h.logs)
})

test('DeepSeek missing-token response and Axios rejection retain their failure behavior', async () => {
  const net = axiosMock([
    { status: 200, data: { msg: markers.error, refresh_token: markers.refresh } },
    richError(),
  ])
  const h = loadAdapter('deepseek.ts', { axios: net.axios })
  const adapter = new h.exports.DeepSeekAdapter(fixtureProvider, fixtureAccount())
  await assert.rejects(adapter.acquireToken(), /Failed to acquire token/)
  assert.equal(await adapter.deleteSession(markers.session), false)
  assert.ok(h.logs.entries.some(entry => entry.level === 'error'))
  net.assertDrained()
  assertPrivate(h.logs)
})

test('GLM token rotation still updates the mocked store without logging either token', async () => {
  const net = axiosMock([{
    status: 200,
    data: { code: 0, result: { access_token: markers.access, refresh_token: markers.nextRefresh } },
  }])
  const updates = []
  const original = {
    id: 'offline-account', providerId: 'glm',
    credentials: { refresh_token: markers.refresh },
  }
  const h = loadAdapter('glm.ts', {
    axios: net.axios,
    '../../store/store': { storeManager: {
      getAccountById(id, includeCredentials) {
        assert.equal(id, original.id)
        assert.equal(includeCredentials, true)
        return { ...original, credentials: { ...original.credentials } }
      },
      updateAccount(id, updatesToCommit) {
        updates.push([id, updatesToCommit])
        return { ...original, ...updatesToCommit }
      },
    } },
  })
  // A GLM refresh key is an identity credential, not the generic fixture's
  // unrelated default token. The production adapter now rejects conflicts.
  const adapter = new h.exports.GLMAdapter(fixtureProvider, original)
  assert.equal(await adapter.acquireToken(), markers.access)
  assert.equal(await adapter.acquireToken(), markers.access)
  assert.deepEqual(plain(updates), [['offline-account', { credentials: { refresh_token: markers.nextRefresh } }]])
  assert.equal(net.calls.length, 1)
  assert.equal(net.calls[0].args[2].headers.Authorization, 'Bearer ' + markers.refresh)
  net.assertDrained()
  assertPrivate(h.logs)
})

test('QwenAI preserves request authentication, prompt and token-bearing response identity', async () => {
  const reply = {
    status: 200, data: new EventEmitter(), headers: { 'set-cookie': [markers.cookie] },
  }
  const net = axiosMock([
    { status: 200, data: { data: { id: markers.session }, access_token: markers.access } },
    reply,
  ])
  const h = loadAdapter('qwen-ai.ts', { axios: net.axios })
  const adapter = new h.exports.QwenAiAdapter(fixtureProvider, fixtureAccount({ cookies: 'session=' + markers.cookie }))
  const result = await adapter.chatCompletion({
    model: 'qwen', messages: [{ role: 'user', content: markers.prompt }],
  })
  assert.equal(result.response, reply)
  assert.equal(result.chatId, markers.session)
  const [, body, options] = net.calls[1].args
  assert.equal(body.messages[0].content, markers.prompt)
  assert.equal(options.headers.Authorization, 'Bearer ' + markers.access)
  assert.equal(options.headers.Cookie, 'session=' + markers.cookie)
  assert.equal(options.headers.Referer, 'https://chat.qwen.ai/c/' + markers.session)
  net.assertDrained()
  assertPrivate(h.logs)
})

test('QwenAI deletion failures and Axios exceptions retain safe fixed outcomes without diagnostic leaks', async () => {
  const failure = richError()
  const net = axiosMock([
    { status: 400, data: { success: false, access_token: markers.access, [markers.key]: markers.answer } },
    failure,
    failure,
  ])
  const h = loadAdapter('qwen-ai.ts', { axios: net.axios })
  const adapter = new h.exports.QwenAiAdapter(fixtureProvider, fixtureAccount({ cookies: 'session=' + markers.cookie }))
  assert.equal(await adapter.deleteChat(markers.session), false)
  assert.equal(await adapter.deleteAllChats(), false)
  await assert.rejects(adapter.createChat('qwen'), error =>
    error instanceof h.exports.QwenAiProxyFailure &&
    error.stage === 'chat-creation' &&
    error.upstreamStatus === undefined &&
    error !== failure &&
    !error.message.includes(markers.error))
  net.assertDrained()
  assertPrivate(h.logs)
})

test('MiniMax JWT, device registration and HTTP/2 logging preserve request headers without exposing them', async () => {
  const token = jwt({ user: { id: markers.user }, access_token: markers.access })
  const net = axiosMock([{
    status: 200,
    data: { statusInfo: { code: 0 }, data: { deviceIDStr: markers.session, realUserID: markers.user, token } },
  }])
  const session = new EventEmitter()
  const stream = new EventEmitter()
  const recorded = {}
  stream.setTimeout = value => { recorded.timeout = value }
  stream.setEncoding = value => { recorded.encoding = value }
  stream.end = value => { recorded.body = value.toString() }
  session.request = headers => { recorded.headers = headers; return stream }
  const h = loadAdapter('minimax.ts', {
    axios: net.axios,
    http2: { connect: origin => {
      recorded.origin = origin
      queueMicrotask(() => session.emit('connect'))
      return session
    } },
  })
  const adapter = new h.exports.MiniMaxAdapter(fixtureProvider, fixtureAccount({ token }))
  const device = await adapter.requestDeviceInfo()
  assert.equal(device.jwtToken, token)
  assert.equal(device.realUserID, markers.user)
  const result = await adapter.requestStream('POST', '/offline-test', { text: markers.prompt }, device)
  assert.equal(result.stream, stream)
  assert.equal(recorded.headers.token, token)
  assert.equal(JSON.parse(recorded.body).text, markers.prompt)
  assert.ok(recorded.headers[':path'].includes('token=' + token))
  assert.ok(recorded.headers['x-signature'])
  stream.emit('response', { ':status': 200, 'set-cookie': [markers.cookie] })
  stream.emit('data', Buffer.from(markers.answer))
  stream.emit('error', richError())
  net.assertDrained()
  assertPrivate(h.logs, [token])
})

test('MiniMax malformed JWT errors and token-bearing response failures stay private', async () => {
  const invalid = 'header.' + Buffer.from(markers.error).toString('base64') + '.signature'
  const h = loadAdapter('minimax.ts')
  const adapter = new h.exports.MiniMaxAdapter(fixtureProvider, fixtureAccount({ token: invalid }))
  assert.equal(adapter.realUserID, '')
  const failure = richError()
  adapter.requestDeviceInfo = async () => { throw failure }
  assert.deepEqual(plain(await adapter.getCredits()), { totalCredits: 0, usedCredits: 0, remainingCredits: 0 })
  assertPrivate(h.logs, [invalid])
})

test('Qwen response headers and failed deletion messages stay out of diagnostics', async () => {
  const reply = { status: 200, data: new EventEmitter(), headers: { 'set-cookie': [markers.cookie] } }
  const net = axiosMock([
    reply,
    { status: 200, data: { success: false, msg: markers.error, access_token: markers.access } },
    richError(),
  ])
  const h = loadAdapter('qwen.ts', { axios: net.axios })
  const adapter = new h.exports.QwenAdapter(fixtureProvider, fixtureAccount({ ticket: markers.cookie }))
  const result = await adapter.chatCompletion({
    model: 'Qwen3.6', messages: [{ role: 'user', content: markers.prompt }],
  })
  assert.equal(result.response, reply)
  assert.equal(net.calls[0].args[1].messages[0].content, markers.prompt)
  assert.equal(net.calls[0].args[2].headers.Cookie, 'tongyi_sso_ticket=' + markers.cookie)
  assert.equal(await adapter.deleteSession(markers.session), false)
  assert.equal(await adapter.deleteSession(markers.session), false)
  net.assertDrained()
  assertPrivate(h.logs)
})

test('Mimo token-bearing conversation lists and errors keep the existing deletion contract', async () => {
  const net = axiosMock([
    { status: 200, data: { code: 0, data: { dataList: [{ conversationId: markers.session, token: markers.access }] } } },
    { status: 200, data: { code: 0, service_token: markers.access } },
    { status: 400, data: { code: 1, ph_token: markers.refresh } },
    richError(),
  ])
  const h = loadAdapter('mimo.ts', { axios: net.axios })
  const adapter = new h.exports.MimoAdapter(fixtureProvider, fixtureAccount({
    service_token: markers.access, user_id: markers.user, ph_token: markers.refresh,
  }))
  assert.equal(await adapter.deleteAllChats(), true)
  assert.deepEqual(plain(net.calls[1].args[1]), [markers.session])
  assert.ok(net.calls[0].args[2].headers.Cookie.includes(markers.access))
  assert.equal(await adapter.generateConversationTitle(markers.session, markers.prompt, markers.answer), false)
  assert.equal(await adapter.generateConversationTitle(markers.session, markers.prompt, markers.answer), false)
  net.assertDrained()
  assertPrivate(h.logs)
})

test('Kimi JWT user IDs and rejected Axios requests stay private', async () => {
  const token = jwt({ app_id: 'kimi', typ: 'access', sub: markers.user })
  const net = axiosMock([richError()])
  const h = loadAdapter('kimi.ts', { axios: net.axios })
  const adapter = new h.exports.KimiAdapter(
    { ...fixtureProvider, id: 'kimi', apiEndpoint: 'https://www.kimi.com' },
    { ...fixtureAccount({ token }), providerId: 'kimi' })
  assert.deepEqual(plain(await adapter.acquireToken()), { accessToken: token, userId: markers.user })
  assert.equal(await adapter.deleteConversation(markers.session), false)
  assert.equal(net.calls[0].args[2].headers.Authorization, 'Bearer ' + token)
  net.assertDrained()
  assertPrivate(h.logs, [token])
})

test('Z.ai response bodies and Axios errors stay private while success/failure results remain intact', async () => {
  const net = axiosMock([
    { status: 400, data: { token: markers.access, message: markers.error } },
    { status: 200, data: true },
    richError(),
  ])
  const h = loadAdapter('zai.ts', { axios: net.axios })
  const adapter = new h.exports.ZaiAdapter(fixtureProvider, fixtureAccount({
    token: jwt({ id: 'synthetic-zai-user', exp: Math.floor(Date.now() / 1000) + 3600 }),
  }))
  await assert.rejects(adapter.createChat(markers.prompt), /Failed to create chat/)
  assert.equal(await adapter.deleteAllChats(), true)
  assert.equal(await adapter.deleteChat(markers.session), false)
  net.assertDrained()
  assertPrivate(h.logs)
})

test('Perplexity Electron request errors are handled using only a local mock', async () => {
  const request = new EventEmitter()
  const headers = {}
  const body = []
  request.setHeader = (name, value) => { headers[name] = value }
  request.write = value => body.push(value)
  request.end = () => queueMicrotask(() => request.emit('error', richError()))
  const h = loadAdapter('perplexity.ts', {
    electron: { net: { request: () => request } },
  })
  const adapter = new h.exports.PerplexityAdapter(fixtureProvider, fixtureAccount({ sessionToken: markers.cookie }))
  assert.equal(await adapter.deleteAllChats(), false)
  assert.ok(headers.Cookie.includes(markers.cookie))
  assert.deepEqual(JSON.parse(body.join('')), { delete_all: true })
  assertPrivate(h.logs)
})

test('QwenAI valid streams preserve answer/reasoning and suppress JSON keys and payload prefixes', async () => {
  const h = loadAdapter('qwen-ai.ts')
  const source = new EventEmitter()
  const handler = new h.exports.QwenAiStreamHandler('qwen')
  handler.setChatId(markers.session)
  const output = captureStream(await handler.handleStream(source))
  source.emit('data', Buffer.from(sse({
    [markers.key]: markers.access,
    'response.created': { response_id: markers.session },
    choices: [{ delta: { phase: 'think', status: 'streaming', content: markers.prompt } }],
  })))
  source.emit('data', Buffer.from(sse({
    choices: [{ delta: { phase: 'answer', status: 'finished', content: markers.answer } }],
  })))
  // A provider's finished status is not a clean upstream EOF. The downstream
  // OpenAI terminal must be withheld until this transport also ends.
  source.emit('end')
  const text = await output.done
  assert.ok(text.includes(markers.answer))
  assert.ok(text.includes(markers.prompt))
  assert.ok(text.includes('data: [DONE]'))
  assertPrivate(h.logs)
})

test('QwenAI malformed event fails closed instead of claiming completed model output', async () => {
  const h = loadAdapter('qwen-ai.ts')
  const source = new EventEmitter()
  const handler = new h.exports.QwenAiStreamHandler('qwen')
  const output = captureStream(await handler.handleStream(source))
  source.emit('data', Buffer.from(sse(markers.error)))
  const text = await output.done
  assert.match(text, /Qwen AI upstream stream did not complete/)
  assert.doesNotMatch(text, /data: \[DONE\]/)
  assert.equal(text.includes(markers.error), false)
  assert.ok(h.logs.entries.some(entry => entry.level === 'error'))
  assertPrivate(h.logs)
})

test('Qwen streams preserve verified assistant content after clean upstream completion', async () => {
  const h = loadAdapter('qwen.ts')
  const source = new EventEmitter()
  const handler = new h.exports.QwenStreamHandler('Qwen3.6')
  const output = captureStream(handler.handleStream(source, { headers: { 'content-encoding': 'identity' } }))
  source.emit('data', Buffer.from(sse({
    [markers.key]: markers.access,
    communication: { sessionid: markers.session },
    data: { messages: [{ mime_type: 'multi_load/iframe', status: 'complete', content: markers.answer }] },
  })))
  source.emit('end')
  const text = await output.done
  assert.ok(text.includes(markers.answer))
  assert.ok(text.includes('data: [DONE]'))
  assertPrivate(h.logs)
})

test('Qwen malformed event followed by a plausible answer remains a failure without private diagnostics', async () => {
  const h = loadAdapter('qwen.ts')
  const source = new EventEmitter()
  const handler = new h.exports.QwenStreamHandler('Qwen3.6')
  const output = captureStream(handler.handleStream(source, { headers: { 'content-encoding': 'identity' } }))
  source.emit('data', Buffer.from(sse(markers.error)))
  source.emit('data', Buffer.from(sse({
    [markers.key]: markers.access,
    communication: { sessionid: markers.session },
    data: { messages: [{ mime_type: 'multi_load/iframe', status: 'complete', content: markers.answer }] },
  })))
  source.emit('end')
  const text = await output.done
  assert.doesNotMatch(text, /data: \[DONE\]/)
  assert.equal(text.includes(markers.error), false)
  assert.ok(h.logs.entries.some(entry => entry.level === 'error'))
  assertPrivate(h.logs)
})

for (const [file, exportName, args] of [
  ['glm.ts', 'GLMStreamHandler', ['glm']],
  ['qwen-ai.ts', 'QwenAiStreamHandler', ['qwen']],
  ['qwen.ts', 'QwenStreamHandler', ['qwen']],
  ['zai.ts', 'ZaiStreamHandler', ['glm']],
  ['kimi.ts', 'KimiStreamHandler', ['kimi', markers.session]],
  ['minimax.ts', 'MiniMaxStreamHandler', ['minimax']],
  ['perplexity-stream.ts', 'PerplexityStreamHandler', ['sonar', markers.session]],
]) {
  test(file + ' stream errors never print Error.message or nested credentials', async () => {
    const h = loadAdapter(file)
    const source = new EventEmitter()
    const handler = new h.exports[exportName](...args)
    const stream = await handler.handleStream(source)
    stream.on('error', () => {})
    source.emit('error', richError())
    // Some adapters validate upstream completion asynchronously before
    // publishing the fixed error. Observe the settled result, not only
    // synchronous EventEmitter callbacks.
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(h.logs.entries.some(entry => entry.level === 'error'))
    assertPrivate(h.logs)
    stream.destroy()
  })
}

test('GLM and MiniMax malformed SSE errors never echo token-bearing JSON input', async () => {
  for (const [file, exportName] of [['glm.ts', 'GLMStreamHandler'], ['minimax.ts', 'MiniMaxStreamHandler']]) {
    const h = loadAdapter(file)
    const source = new EventEmitter()
    const handler = new h.exports[exportName]('offline-model')
    const stream = await handler.handleStream(source)
    stream.on('error', () => {})
    source.emit('data', Buffer.from(sse(markers.error, 'message_result')))
    assert.ok(h.logs.entries.some(entry => entry.level === 'error'))
    assertPrivate(h.logs)
    stream.destroy()
  }
})

for (const [file, exportName] of [
  ['prompt/DefaultPromptAdapter.ts', 'DefaultPromptAdapter'],
  ['prompt/CherryStudioPromptAdapter.ts', 'CherryStudioPromptAdapter'],
]) {
  test(file + ' XML argument failures hide private input while valid arguments are preserved', () => {
    const h = loadAdapter(file)
    const adapter = new h.exports[exportName]()
    const malformed = '<tool_use><name>offline_tool</name><arguments>' + markers.error + '</arguments></tool_use>'
    assert.equal(adapter.parseToolCalls(malformed).toolCalls.length, 0)
    const valid = '<tool_use><name>offline_tool</name><arguments>'
      + JSON.stringify({ value: markers.prompt }) + '</arguments></tool_use>'
    const result = adapter.parseToolCalls(valid)
    assert.equal(result.toolCalls.length, 1)
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).value, markers.prompt)
    assertPrivate(h.logs)
  })
}
