import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Extract only the actual first-party methods under test into a closed VM.
// No Electron import, operating account, live URL request, or credential read.
const PRIVATE = 'SYNTHETIC_PRIVATE_DEEPSEEK_CANARY_' + 'X'.repeat(30)
const refreshToken = 'synthetic-refresh-token-local28'
const nextToken = 'synthetic-new-token-local28'
const forbidden = () => { throw new Error('Unexpected network operation') }
class SyntheticAxiosError extends Error {}

function methodHarness({ file, className, methodName, replies = [], context = {} }) {
  const source = readFileSync(new URL('../../src/main/' + file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const target = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  assert.ok(target, 'Expected real ' + className)
  const method = target.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === methodName)
  assert.ok(method, 'Expected real ' + methodName)
  const standalone = 'class ClosedHarness {' + method.getText(ast) + '} exports.ClosedHarness=ClosedHarness'
  const code = ts.transpileModule(standalone, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const calls = [], logs = [], queue = [...replies]
  const get = async (url, options) => {
    calls.push({ url, options })
    if (queue.length === 0) return forbidden()
    const reply = queue.shift()
    if (reply instanceof Error) throw reply
    return reply
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    axios: { get, post: forbidden },
    DEEPSEEK_API_BASE: 'https://chat.deepseek.com',
    FAKE_HEADERS: Object.freeze({ Accept: '*/*' }),
    CHECK_TIMEOUT: 15000,
    AxiosError: SyntheticAxiosError,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    ...context,
  }, { filename: 'closed-' + file, timeout: 2000 })
  const api = module.exports.ClosedHarness
  const instance = new api()
  instance.getTimestamp = () => 1800000000
  return { api, instance, calls, logs }
}

function oauth(replies) {
  return methodHarness({ file: 'oauth/adapters/deepseek.ts',
    className: 'DeepSeekAdapter', methodName: 'refreshToken', replies })
}
function oauthMethod(methodName, replies, context) {
  return methodHarness({ file: 'oauth/adapters/deepseek.ts',
    className: 'DeepSeekAdapter', methodName, replies, context })
}
function checker(replies) {
  return methodHarness({ file: 'providers/checker.ts',
    className: 'ProviderChecker', methodName: 'checkDeepSeekToken', replies })
}
function successBody(token, nested) {
  const bizData = { token }
  return nested ? { code: 0, data: { biz_code: 0, biz_data: bizData } }
    : { code: 0, biz_data: bizData }
}

for (const nested of [true, false]) {
  test('DeepSeek refresh preserves ' + (nested ? 'nested consumer envelope' : 'legacy flat envelope') +
    ' and does not follow redirect', async () => {
    const h = oauth([{ status: 200, data: successBody(nextToken, nested) }])
    const result = await h.instance.refreshToken({ token: refreshToken })
    assert.equal(result?.type, 'access')
    assert.equal(result?.value, nextToken)
    assert.equal(result?.expiresAt, 1800003600)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].options.headers.Authorization, 'Bearer ' + refreshToken)
    assert.equal(h.calls[0].options.maxRedirects, 0)
    assert.equal(h.calls[0].url, 'https://chat.deepseek.com/api/v0/users/current')
  })
}

test('DeepSeek refresh rejects malformed or nonzero-code envelopes without publishing token', async () => {
  const replies = [
    { status: 200, data: { code: 40003, biz_data: { token: nextToken } } },
    { status: 200, data: { code: 0, data: { biz_code: 40003, biz_data: { token: nextToken } } } },
    { status: 200, data: { code: 0, data: { biz_code: 0, biz_data: { token: { private: PRIVATE } } } } },
  ]
  const h = oauth(replies)
  for (let i = 0; i < replies.length; i++) {
    assert.equal(await h.instance.refreshToken({ token: refreshToken }), null)
  }
  assert.equal(h.calls.length, replies.length)
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
})

test('DeepSeek refresh malformed identity never emits Authorization or network request', async () => {
  const h = oauth([])
  for (const token of [null, {}, ['token'], 'synthetic\rheader']) {
    assert.equal(await h.instance.refreshToken({ token }), null)
  }
  assert.equal(h.calls.length, 0)
})

test('DeepSeek checker success keeps existing user identity and redirect gate', async () => {
  const h = checker([{ status: 200, data: {
    code: 0, data: { biz_data: { id_profile: { name: 'Synthetic User' }, email: 'user@example.invalid' } },
  } }])
  const result = await h.api.checkDeepSeekToken(refreshToken)
  assert.equal(result.valid, true)
  assert.equal(result.userInfo.name, 'Synthetic User')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].options.maxRedirects, 0)
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer ' + refreshToken)
})

test('DeepSeek checker rejected HTTP response does not publish remote secret text', async () => {
  const h = checker([{ status: 503, data: {
    code: 40001, msg: PRIVATE, message: PRIVATE, embedded: { header: PRIVATE },
  } }])
  const result = await h.api.checkDeepSeekToken(refreshToken)
  assert.equal(result.valid, false)
  assert.equal(result.error, 'DeepSeek token validation failed')
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(h.calls.length, 1)
})

test('DeepSeek checker transport error does not reflect private Axios Error text', async () => {
  const error = Object.assign(new SyntheticAxiosError(PRIVATE), { config: {
    url: 'https://invalid.example/?token=' + PRIVATE, headers: { Authorization: PRIVATE },
  } })
  const h = checker([error])
  const result = await h.api.checkDeepSeekToken(refreshToken)
  assert.equal(result.valid, false)
  assert.equal(result.error, 'DeepSeek token validation failed')
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(h.calls.length, 1)
})

test('DeepSeek checker rejects missing or malformed credential before remote work', async () => {
  const h = checker([])
  for (const token of [undefined, {}, ['token'], 'synthetic\nheader']) {
    const result = await h.api.checkDeepSeekToken(token)
    assert.equal(result.valid, false)
    assert.equal(result.error, 'DeepSeek token validation failed')
  }
  assert.equal(h.calls.length, 0)
})

test('DeepSeek OAuth validation honors nested success and no-redirect gate', async () => {
  const h = oauthMethod('validateToken', [{ status: 200, data: { code: 0, data: {
    biz_code: 0, biz_data: { id: 'synthetic-id', name: 'Synthetic User', email: 'user@example.invalid' },
  } } }])
  const result = await h.instance.validateToken({ token: refreshToken })
  assert.equal(result.valid, true)
  assert.equal(result.accountInfo.name, 'Synthetic User')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].options.maxRedirects, 0)
})

test('DeepSeek OAuth validation refuses explicit business failure even with profile-like data', async () => {
  const h = oauthMethod('validateToken', [
    { status: 200, data: { code: 40003, data: { biz_code: 0, biz_data: { id: 'fake' } } } },
    { status: 200, data: { code: 0, data: { biz_code: 40003, biz_data: { id: 'fake' } } } },
  ])
  for (let i = 0; i < 2; i++) {
    const result = await h.instance.validateToken({ token: refreshToken })
    assert.equal(result.valid, false)
    assert.equal(result.accountInfo, undefined)
  }
  assert.equal(h.calls.length, 2)
})

test('DeepSeek OAuth validation refuses malformed credentials before sending bearer', async () => {
  const h = oauthMethod('validateToken', [])
  for (const token of [null, {}, ['bad'], 'header\rbreak']) {
    const result = await h.instance.validateToken({ token })
    assert.equal(result.valid, false)
  }
  assert.equal(h.calls.length, 0)
})

test('DeepSeek OAuth validation never returns raw network exception to the UI', async () => {
  const h = oauthMethod('validateToken', [new SyntheticAxiosError(PRIVATE)])
  const result = await h.instance.validateToken({ token: refreshToken })
  assert.equal(result.valid, false)
  assert.equal(result.error, 'DeepSeek token validation failed')
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
})

test('DeepSeek token login catches validation exception with fixed result and progress', async () => {
  const h = oauthMethod('loginWithToken', [])
  h.instance.validateToken = async () => { throw new Error(PRIVATE) }
  h.instance.emitProgress = (...args) => h.logs.push(args)
  const result = await h.instance.loginWithToken('deepseek', refreshToken)
  assert.equal(result.success, false)
  assert.equal(result.error, 'DeepSeek token validation failed')
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(h.calls.length, 0)
})

test('DeepSeek browser-launch failure has fixed result and progress without raw URL', async () => {
  const h = oauthMethod('startLogin', [], { shell: { openExternal: async () => { throw new Error(PRIVATE) } } })
  h.instance.emitProgress = (...args) => h.logs.push(args)
  const result = await h.instance.startLogin({ providerId: 'deepseek' })
  assert.equal(result.success, false)
  assert.equal(result.error, 'Failed to open DeepSeek login page')
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(h.calls.length, 0)
})
