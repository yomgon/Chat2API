import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const inAppFile = 'src/main/oauth/inAppLogin.ts'
const zaiSessionFile = 'src/main/oauth/zaiSession.ts'
const checkerFile = 'src/main/providers/checker.ts'
const adapterDir = 'src/main/oauth/adapters/'
const sourceFiles = [
  inAppFile,
  zaiSessionFile,
  checkerFile,
  ...readdirSync(path.join(root, adapterDir))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => adapterDir + name),
]
const allowedMessages = new Set()
const compiled = new Map()
const accessToken = 'access_canary_' + 'a'.repeat(64)
const refreshToken = 'refresh_canary_' + 'r'.repeat(64)
const cookieValue = 'cookie_canary_' + 'c'.repeat(64)
const userId = 'subject_canary_private'
const email = 'person_canary@example.invalid'
const userName = 'name_canary_private'
const sessionId = 'session_canary_private'
const callbackUrl = 'https://oauth-canary.invalid/callback?access_token=' + accessToken
const jwt = makeJwt({ sub: userId, email, name: userName, access_token: accessToken })
const sensitiveData = {
  access_token: accessToken,
  refresh_token: refreshToken,
  cookie: cookieValue,
  'Set-Cookie': 'session=' + cookieValue,
  url: callbackUrl,
}
const secretFragments = [
  accessToken, refreshToken, cookieValue, userId, email, userName, sessionId, callbackUrl,
  accessToken.slice(0, 12), refreshToken.slice(0, 12), cookieValue.slice(0, 12),
  ...jwt.split('.').map((part) => part.slice(0, 12)),
]
const plain = (value) => JSON.parse(JSON.stringify(value))

function makeJwt(payload) {
  return [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature_canary_private',
  ].join('.')
}

function inspectConsoleCalls(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  assert.equal(ast.parseDiagnostics.length, 0, filename + ' must parse')
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'console') {
      // Reject aliases, computed access, trace(), and formatting with runtime values.
      const member = node.parent
      assert.ok(ts.isPropertyAccessExpression(member) && member.expression === node,
        filename + ': console must be called directly')
      assert.ok(['log', 'info', 'warn', 'error', 'debug'].includes(member.name.text),
        filename + ': console method must not emit implicit stacks or objects')
      const call = member.parent
      assert.ok(ts.isCallExpression(call) && call.expression === member,
        filename + ': console aliases are not allowed')
      assert.equal(call.arguments.length, 1, filename + ': only a fixed message may be logged')
      const message = call.arguments[0]
      assert.ok(ts.isStringLiteralLike(message), filename + ': log message must be static')
      assert.doesNotMatch(message.text, /https?:\/\//i, filename + ': do not log URLs')
      allowedMessages.add(message.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}

class FakeAxiosError extends Error {}

function sensitiveError(ErrorType = Error) {
  const error = new ErrorType('OAuth failed: ' + callbackUrl + ' ' + refreshToken)
  error.config = { url: callbackUrl, headers: { Authorization: 'Bearer ' + accessToken, Cookie: cookieValue } }
  error.response = { data: sensitiveData, headers: { 'set-cookie': ['session=' + cookieValue] } }
  return error
}

function response(data, status = 200) {
  return { status, data, headers: { 'set-cookie': ['session=' + cookieValue] } }
}

function harness(options = {}) {
  const logs = []
  const requests = []
  const blocked = []
  const queue = [...(options.responses || [])]
  const cache = new Map()
  const fakeConsole = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((level) => [
      level, (...args) => logs.push({ level, args }),
    ]),
  )
  const forbid = (operation) => {
    blocked.push(operation)
    throw new Error('Unexpected offline operation: ' + operation)
  }
  const dispatch = async (config) => {
    requests.push(config)
    if (queue.length === 0) return forbid('unmocked HTTP request')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  }
  const axios = Object.assign(dispatch, {
    get: (url, config) => dispatch({ ...config, method: 'GET', url }),
    post: (url, data, config) => dispatch({ ...config, method: 'POST', url, data }),
    request: dispatch,
  })
  const dependencies = {
    axios: { __esModule: true, default: axios, AxiosError: FakeAxiosError },
    crypto,
    events: { EventEmitter },
    http: { createServer: () => forbid('HTTP server') },
    electron: options.electron || {
      BrowserWindow: class { constructor() { forbid('real login window') } },
      session: { fromPartition: () => forbid('real Electron session') },
      shell: { openExternal: () => forbid('external browser') },
    },
    './tokenExtractionConfig': { getTokenExtractionConfig: () => options.config || null },
    './builtin': {
      getBuiltinProvider: (id) => options.builtin || { id, modelsApiEndpoint: callbackUrl },
    },
  }
  function load(relativePath) {
    assert.ok(sourceFiles.includes(relativePath), 'Only audited modules may be evaluated')
    if (cache.has(relativePath)) return cache.get(relativePath).exports
    if (!compiled.has(relativePath)) {
      const source = readFileSync(path.join(root, relativePath), 'utf8')
      inspectConsoleCalls(source, relativePath)
      const result = ts.transpileModule(source, {
        fileName: relativePath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
        reportDiagnostics: true,
      })
      assert.equal((result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0)
      compiled.set(relativePath, result.outputText)
    }
    const module = { exports: {} }
    cache.set(relativePath, module)
    vm.runInNewContext(compiled.get(relativePath), {
      module,
      exports: module.exports,
      require: (name) => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name]
        if (name === './base') return load(adapterDir + 'base.ts')
        if (name === './zaiSession' || name === '../zaiSession') return load(zaiSessionFile)
        return forbid('module ' + name)
      },
      console: fakeConsole,
      Buffer, URL, URLSearchParams, Error,
      setTimeout: (callback) => ({ callback }),
      clearTimeout: () => {},
    }, { filename: relativePath, timeout: 1000 })
    return module.exports
  }
  return {
    load, logs, requests, console: fakeConsole,
    inspectScript: (script) => {
      try {
        inspectConsoleCalls(script, 'injected-login-script.js')
      } catch (error) {
        blocked.push('unsafe injected console call')
        throw error
      }
    },
    assertPrivate() {
      assert.deepEqual(blocked, [], 'No real Electron, browser, server, or unmocked request is allowed')
      assert.equal(queue.length, 0, 'All expected mock requests must be consumed')
      for (const { args } of logs) {
        assert.equal(args.length, 1, 'Never pass objects or extra values to the console')
        assert.equal(typeof args[0], 'string')
        assert.ok(allowedMessages.has(args[0]), 'Runtime output must match a static source message')
      }
      const output = logs.flatMap(({ args }) => args).join('\n')
      for (const secret of secretFragments) assert.ok(!output.includes(secret), 'Console leaked a synthetic credential fragment')
    },
  }
}

function loginFixture({ sources, storage = {}, cookies = [], getCookies, storageError } = {}) {
  const config = { loginUrl: callbackUrl, tokenSources: sources || [], targetDomains: ['oauth-canary.invalid'] }
  const h = harness({ config })
  const { InAppLoginManager } = h.load(inAppFile)
  const manager = new InAppLoginManager()
  const hooks = {}
  const cookieEvents = new EventEmitter()
  cookieEvents.get = getCookies || (async () => [...cookies])
  const loginSession = {
    cookies: cookieEvents,
    webRequest: {
      onHeadersReceived: (callback) => { hooks.headers = callback },
      onBeforeSendHeaders: (callback) => { hooks.before = callback },
    },
  }
  const scripts = []
  manager.config = config
  manager.loginSession = loginSession
  manager.loginStartTime = Date.now() - 10000
  manager.loginWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      on: () => {},
      executeJavaScript: async (script) => {
        scripts.push(script)
        h.inspectScript(script)
        return vm.runInNewContext(script, {
          console: h.console,
          localStorage: {
            getItem: (key) => {
              if (storageError) throw storageError
              return storage[key] ?? null
            },
          },
        }, { timeout: 1000 })
      },
    },
  }
  const found = []
  manager.on('tokenFound', (event) => found.push(plain(event)))
  manager.setupTokenInterception()
  return { h, manager, hooks, found, cookieEvents, scripts, loginSession }
}

test('all OAuth adapters, login code, and checker log only fixed messages', () => {
  for (const file of sourceFiles) inspectConsoleCalls(readFileSync(path.join(root, file), 'utf8'), file)
})

test('localStorage, JWT, user details, and cookies are extracted without logging values', async () => {
  const f = loginFixture({
    sources: [
      { type: 'localStorage', key: '_token' },
      { type: 'localStorage', key: 'user_detail_agent' },
      { type: 'cookie', key: 'session_token' },
    ],
    storage: { _token: JSON.stringify({ value: jwt, ...sensitiveData }), user_detail_agent: JSON.stringify({ realUserID: userId, ...sensitiveData }) },
    cookies: [{ name: 'session_token', value: cookieValue }, { name: 'extra', value: refreshToken }],
  })
  await f.manager.checkForTokens()
  assert.deepEqual(f.found.map(({ key, value }) => ({ key, value })), [
    { key: 'token', value: jwt }, { key: 'realUserID', value: userId }, { key: 'session_token', value: cookieValue },
  ])
  assert.equal(f.found[2].allCookies.extra, refreshToken)
  assert.equal(f.scripts.length, 2, 'Execute the actual generated page scripts')
  f.h.assertPrivate()
})

test('Set-Cookie, Authorization, and cookie change events retain credential values privately', async () => {
  const f = loginFixture({ sources: [
    { type: 'cookie', key: 'session_token' },
    { type: 'networkHeader', key: 'Authorization' },
  ] })
  let callbackResult
  f.hooks.headers({ responseHeaders: { 'Set-Cookie': ['session_token="' + cookieValue + '"; HttpOnly; Secure'] } },
    (result) => { callbackResult = result })
  assert.deepEqual(plain(callbackResult), {})
  const headers = { Authorization: 'Bearer ' + accessToken, Cookie: cookieValue }
  f.hooks.before({ requestHeaders: headers }, (result) => { callbackResult = result })
  assert.equal(callbackResult.requestHeaders, headers)
  await f.cookieEvents.listeners('changed')[0]({}, { name: 'session_token', value: refreshToken }, 'explicit', false)
  assert.deepEqual(f.found.map(({ value }) => value), [cookieValue, accessToken, refreshToken])
  f.h.assertPrivate()
})

test('token rejection and JSON parsing errors do not log JWT payloads or parser excerpts', async () => {
  const f = loginFixture({
    sources: [{ type: 'localStorage', key: 'user_detail_agent' }, { type: 'localStorage', key: '_token' }],
    storage: {
      user_detail_agent: '{"realUserID":"' + userId + '",}',
      _token: '{"value":"' + accessToken + '",}',
    },
  })
  assert.equal(f.manager.isValidToken(makeJwt({ sub: userId, email: 'someone@guest.com' })), false)
  assert.equal(f.manager.isValidToken('eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"secret":"' + accessToken + '",}').toString('base64url') + '.sig'), false)
  assert.equal(f.manager.isValidToken('bad token ' + cookieValue), false)
  await f.manager.checkForTokens()
  assert.ok(f.h.logs.some(({ level }) => level === 'error'))
  f.h.assertPrivate()
})

test('page storage, cookie query, and cleanup failures keep error objects out of logs', async () => {
  const storage = loginFixture({
    sources: [{ type: 'localStorage', key: '_token' }],
    storageError: sensitiveError(),
  })
  await storage.manager.checkForTokens()
  assert.equal(storage.found.length, 0)
  storage.h.assertPrivate()

  for (const failAll of [false, true]) {
    const f = loginFixture({
      sources: [{ type: 'cookie', key: 'session_token' }],
      getCookies: async (filter) => {
        if (failAll || filter.domain) throw sensitiveError()
        return [{ name: 'session_token', value: cookieValue }]
      },
    })
    await f.manager.checkForTokens()
    assert.equal(f.found.length, failAll ? 0 : 1)
    f.loginSession.webRequest.onBeforeSendHeaders = () => { throw sensitiveError() }
    f.manager.cleanup()
    assert.equal(f.manager.loginSession, null)
    f.h.assertPrivate()
  }
})

test('mocked login windows keep ephemeral UUID partitions and fail closed on proxy setup errors', async () => {
  const partitions = []
  const windows = []
  const urls = []
  const makeSession = () => ({
    setProxy: async () => { throw sensitiveError() },
    webRequest: {
      onHeadersReceived: () => {},
      onBeforeSendHeaders: () => {},
    },
    cookies: new EventEmitter(),
  })
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      windows.push(options)
      this.webContents = new EventEmitter()
      this.webContents.isDestroyed = () => false
    }
    isDestroyed() { return false }
    loadURL(url) { urls.push(url); return Promise.resolve() }
  }
  const h = harness({ electron: {
    BrowserWindow: FakeWindow,
    session: { fromPartition: (partition) => { partitions.push(partition); return makeSession() } },
  } })
  const { InAppLoginManager } = h.load(inAppFile)
  for (let i = 0; i < 2; i++) {
    const manager = new InAppLoginManager()
    manager.config = { loginUrl: callbackUrl }
    manager.options = { proxyMode: 'none' }
    manager.createLoginWindow()
  }
  await new Promise(resolve => setImmediate(resolve))
  for (const [i, partition] of partitions.entries()) {
    assert.match(partition, /^oauth-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(windows[i].webPreferences.partition, partition)
  }
  assert.notEqual(partitions[0], partitions[1])
  assert.deepEqual(urls, [], 'Failed proxy setup must not launch an unconfigured login connection')
  h.assertPrivate()
})

const adapterCases = [
  {
    name: 'DeepSeek', file: 'deepseek.ts', className: 'DeepSeekAdapter', credentials: { token: accessToken },
    responses: [response({ ...sensitiveData, code: 0, data: { biz_data: { id: userId, email, name: userName } } })],
  },
  {
    name: 'GLM', file: 'glm.ts', className: 'GLMAdapter', credentials: { refresh_token: refreshToken },
    responses: [
      response({ result: { ...sensitiveData, user_id: userId } }),
      response({ result: { ...sensitiveData, email, nickname: userName, is_guest: false } }),
    ],
  },
  {
    name: 'MiniMax', file: 'minimax.ts', className: 'MiniMaxAdapter', credentials: { token: userId + '+' + jwt },
    responses: [response({ ...sensitiveData, statusInfo: { code: 0 }, data: { userInfo: { id: userId, email, name: userName } } })],
  },
  {
    name: 'Qwen AI', file: 'qwen-ai.ts', className: 'QwenAiAdapter', credentials: { token: jwt },
    responses: [response({ success: true, data: { ...sensitiveData, email, name: userName } })],
  },
]

for (const fixture of adapterCases) {
  test(fixture.name + ' adapter preserves successful validation without response or token logs', async () => {
    const h = harness({ responses: fixture.responses })
    const Adapter = h.load(adapterDir + fixture.file)[fixture.className]
    const result = await new Adapter({}).validateToken(fixture.credentials)
    assert.equal(result.valid, true)
    assert.equal(result.accountInfo.email, email)
    assert.equal(result.accountInfo.name, userName)
    assert.equal(h.requests.length, fixture.responses.length)
    h.assertPrivate()
  })

  if (fixture.name !== 'Qwen AI') {
    for (const failure of ['response', 'exception']) {
      test(fixture.name + ' adapter ' + failure + ' logs no provider data or errors', async () => {
        const error = sensitiveError()
        const h = harness({ responses: [failure === 'exception' ? error : response({
          ...sensitiveData, statusInfo: { code: 1001, message: error.message },
        }, 401)] })
        const Adapter = h.load(adapterDir + fixture.file)[fixture.className]
        const result = await new Adapter({}).validateToken(fixture.credentials)
        assert.equal(result.valid, false)
        if (failure === 'exception') {
          if (fixture.name === 'GLM') {
            assert.equal(result.error, 'GLM token validation request failed')
            assert.equal(result.error.includes(accessToken), false)
            assert.equal(result.error.includes(refreshToken), false)
          } else {
            assert.equal(result.error, error.message)
          }
        }
        assert.equal(h.requests.length, 1)
        h.assertPrivate()
      })
    }
  }
}

test('Qwen AI rejects a user-info exception without a JWT-only success fallback', async () => {
  const h = harness()
  const { QwenAiAdapter } = h.load(adapterDir + 'qwen-ai.ts')
  const adapter = new QwenAiAdapter({})
  adapter.getUserInfo = async () => { throw sensitiveError() }
  const result = await adapter.validateToken({ token: jwt })
  assert.equal(result.valid, false)
  assert.equal(result.accountInfo, undefined)
  assert.equal(result.error, 'Qwen AI session verification failed')
  h.assertPrivate()
})

test('Kimi browser failure cannot expose a sensitive shell exception in result or progress', async () => {
  const h = harness({ electron: { shell: { openExternal: async () => { throw sensitiveError() } } } })
  const { KimiAdapter } = h.load(adapterDir + 'kimi.ts')
  const adapter = new KimiAdapter({})
  const events = []
  adapter.setProgressCallback(event => events.push(event))
  const result = await adapter.startLogin({ providerId: 'kimi' })
  assert.equal(result.success, false)
  assert.equal(result.error, 'Failed to open Kimi login page')
  assert.equal(JSON.stringify(events).includes(callbackUrl), false)
  h.assertPrivate()
})

test('Kimi token login and validate errors are fixed and never echo Axios secrets', async () => {
  const h = harness({ responses: [sensitiveError(), sensitiveError()] })
  const { KimiAdapter } = h.load(adapterDir + 'kimi.ts')
  const adapter = new KimiAdapter({})
  const events = []
  adapter.setProgressCallback(event => events.push(event))
  const login = await adapter.loginWithToken('kimi', accessToken)
  const checked = await adapter.validateToken({ accessToken })
  assert.equal(login.success, false)
  assert.equal(login.error, 'Kimi token validation failed')
  assert.equal(checked.valid, false)
  assert.equal(checked.error, 'Kimi token validation failed')
  assert.equal(JSON.stringify(events).includes(callbackUrl), false)
  assert.equal(h.requests.length, 2)
  for (const request of h.requests) {
    assert.equal(request.maxRedirects, 0)
    assert.equal(request.headers.Authorization, 'Bearer ' + accessToken)
  }
  h.assertPrivate()
})

test('Kimi OAuth rejects malformed subscription envelopes instead of inventing login success', async () => {
  for (const payload of [
    { subscription: 'unexpected' },
    { subscription: ['unexpected'] },
    { subscription: { userName: userName }, error: { detail: callbackUrl } },
  ]) {
    const h = harness({ responses: [response(payload), response(payload)] })
    const { KimiAdapter } = h.load(adapterDir + 'kimi.ts')
    const adapter = new KimiAdapter({})
    assert.equal((await adapter.loginWithToken('kimi', accessToken)).success, false)
    assert.equal((await adapter.validateToken({ accessToken })).valid, false)
    assert.equal(h.requests.length, 2)
    h.assertPrivate()
  }
})

test('Kimi OAuth validation uses the selected proxy credential, accepts legacy fields and never falls back on invalid candidates', async () => {
  for (const [credentials, chosen] of [
    [{ token: accessToken, accessToken: refreshToken }, accessToken],
    [{ token: '', refreshToken, accessToken }, refreshToken],
    [{ refreshToken: '', accessToken }, accessToken],
    [{ api_key: accessToken }, accessToken],
  ]) {
    const h = harness({ responses: [response({ subscription: {} })] })
    const { KimiAdapter } = h.load(adapterDir + 'kimi.ts')
    const outcome = await new KimiAdapter({}).validateToken(credentials)
    assert.equal(outcome.valid, true)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].headers.Authorization, 'Bearer ' + chosen)
    h.assertPrivate()
  }
  for (const credentials of [null, undefined, { token: false, accessToken },
    { token: {}, accessToken }, { token: ' invalid', accessToken }, { accessToken: '\ninvalid' }]) {
    const h = harness()
    const { KimiAdapter } = h.load(adapterDir + 'kimi.ts')
    const result = await new KimiAdapter({}).validateToken(credentials)
    assert.equal(result.valid, false)
    assert.equal(h.requests.length, 0)
    h.assertPrivate()
  }
})

test('DeepSeek browser failure preserves the error result without logging its URL', async () => {
  const error = sensitiveError()
  const h = harness({ electron: { shell: { openExternal: async () => { throw error } } } })
  const { DeepSeekAdapter } = h.load(adapterDir + 'deepseek.ts')
  const result = await new DeepSeekAdapter({}).startLogin({ providerId: 'deepseek' })
  assert.equal(result.success, false)
  assert.equal(result.error, error.message)
  h.assertPrivate()
})

for (const [label, mockResponse, expected] of [
  ['success', response({ success: true, ...sensitiveData }), true],
  ['HTTP failure', response(sensitiveData, 503), false],
  ['rejected response', response({ success: false, errorMsg: callbackUrl, ...sensitiveData }), false],
  ['exception', sensitiveError(), false],
]) {
  test('Qwen session deletion ' + label + ' keeps IDs, cookies, and errors private', async () => {
    const h = harness({ responses: [mockResponse] })
    const { QwenAdapter } = h.load(adapterDir + 'qwen.ts')
    assert.equal(await new QwenAdapter({}).deleteSession(sessionId, cookieValue), expected)
    assert.equal(h.requests[0].data.session_id, sessionId)
    assert.equal(h.requests[0].headers.Cookie, 'tongyi_sso_ticket=' + cookieValue)
    h.assertPrivate()
  })
}

const checkerCases = [
  ['deepseek', { code: 0, data: { biz_data: { id_profile: { name: userName }, email } } }],
  ['glm', { result: { ...sensitiveData, user: { name: userName } } }],
  ['kimi', { subscription: { userName } }],
  ['minimax', { data: { deviceIDStr: 'device_canary', userInfo: { name: userName, email } } }],
]
for (const [providerId, successData] of checkerCases) {
  for (const outcome of ['success', 'rejection', 'exception']) {
    test(providerId + ' checker ' + outcome + ' preserves results without logging credentials or raw responses', async () => {
      const error = sensitiveError(FakeAxiosError)
      const mockResponse = outcome === 'exception' ? error
        : outcome === 'success' ? response({ ...sensitiveData, ...successData })
          : response({ ...sensitiveData, statusInfo: { code: 1001 } }, 401)
      const h = harness({ responses: [mockResponse] })
      const { ProviderChecker } = h.load(checkerFile)
      const result = await ProviderChecker.checkAccountToken(
        { id: providerId, type: 'builtin' },
        { credentials: { token: jwt, refresh_token: refreshToken } },
      )
      assert.equal(result.valid, outcome === 'success')
      if (outcome === 'success') assert.equal(result.userInfo.name, userName)
      if (outcome === 'exception') assert.equal(result.error,
        providerId === 'kimi' ? 'Kimi token validation failed' : error.message)
      assert.equal(h.requests.length, 1)
      const headers = h.requests[0].headers
      if (providerId === 'minimax') assert.equal(headers.token, jwt)
      else assert.equal(headers.Authorization, 'Bearer ' + (providerId === 'glm' ? refreshToken : jwt))
      h.assertPrivate()
    })
  }
}

test('MiniMax checker hides malformed JWT parser errors without sending requests', async () => {
  const h = harness()
  const { ProviderChecker } = h.load(checkerFile)
  const result = await ProviderChecker.checkAccountToken(
    { id: 'minimax', type: 'builtin' },
    { credentials: { token: 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"secret":"' + accessToken + '",}').toString('base64url') + '.sig' } },
  )
  assert.equal(result.valid, false)
  assert.equal(h.requests.length, 0)
  h.assertPrivate()
})

test('model fetch failure rethrows the same error without logging provider IDs, URLs, or headers', async () => {
  const error = sensitiveError(FakeAxiosError)
  const h = harness({ responses: [error] })
  const { ProviderChecker } = h.load(checkerFile)
  await assert.rejects(ProviderChecker.fetchProviderModels(userId), (caught) => caught === error)
  assert.equal(h.requests[0].url, callbackUrl)
  h.assertPrivate()
})
