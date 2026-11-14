import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'
import { ZAI_SESSION_MODULE } from './helpers/zaiSessionModule.mjs'

// Production Qwen China browser/manual OAuth, account validity checker and
// their common credentials, under a closed Axios transport. Never send GET,
// POST or login traffic to the actual first-party host.
const source = p => readFileSync(new URL('../../src/main/' + p, import.meta.url), 'utf8')
const compile = (p, code = source(p)) => ts.transpileModule(code, {
  fileName: p, compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const compiled = Object.fromEntries([
  'oauth/adapters/base.ts', 'oauth/adapters/qwen.ts', 'providers/checker.ts',
].map(p => [p, compile(p)]))
const ticketModule = new URL('../../src/main/providers/qwenTicket.ts', import.meta.url)
if (existsSync(ticketModule)) compiled['providers/qwenTicket.ts'] = compile('providers/qwenTicket.ts')
const PRIVATE = 'LOCAL86_SYNTHETIC_PRIVATE_QWEN_COOKIE_DO_NOT_LOG'
const FAILURE = 'Qwen China ticket validation failed'
const valid = Object.freeze({ ticket: PRIVATE })
const noOperation = () => { throw Error('Forbidden offline browser, server, retry or extra effect') }

function harness(options = {}) {
  const calls = [], progress = [], logs = []
  const scenario = options.response === undefined
    ? { status: 200, data: { success: true, data: { synthetic: true } } }
    : options.response
  class FakeAxiosError extends Error {}
  const axios = {
    post: async (url, payload, config) => {
      calls.push({ url, payload, config })
      if (options.postThrows) throw options.postThrows
      return scenario
    },
    get: noOperation, delete: noOperation, request: noOperation,
    create: noOperation,
  }
  const shell = { openExternal: options.browserError
    ? async () => { throw options.browserError } : noOperation }
  const modules = new Map()
  const load = p => {
    if (modules.has(p)) return modules.get(p).exports
    const mod = { exports: {} }
    modules.set(p, mod)
    vm.runInNewContext(compiled[p], {
      module: mod, exports: mod.exports, Buffer, URL, Date, Math, Error,
      console: Object.fromEntries(['log','warn','error','debug','info'].map(k =>
        [k, (...args) => logs.push({ level:k, args })])),
      require(specifier) {
        if (specifier === 'axios') return { __esModule: true, default: axios, AxiosError: FakeAxiosError }
        if (specifier === 'electron') return { shell, BrowserWindow: class { constructor() { noOperation() } } }
        if (specifier === 'http') return { __esModule: true, default: { createServer: noOperation } }
        if (specifier === 'crypto') return { __esModule: true, default: { randomBytes: noOperation } }
        if (specifier === './base') return load('oauth/adapters/base.ts')
        if (specifier === './builtin') return { getBuiltinProvider: id => id === 'qwen' ? { id } : null }
        if (specifier === '../../providers/qwenTicket' || specifier === './qwenTicket')
          return load('providers/qwenTicket.ts')
        if (specifier === './qwenAiToken') return QWEN_AI_TOKEN_MODULE
        if (specifier === '../oauth/zaiSession') return ZAI_SESSION_MODULE
        throw Error('Unexpected module in offline OAuth-checker: ' + specifier)
      },
    }, { filename: p, timeout: 1800 })
    return mod.exports
  }
  const { QwenAdapter } = load('oauth/adapters/qwen.ts')
  const oauth = new QwenAdapter({ providerId: 'qwen', providerType: 'qwen',
    loginUrl: 'https://www.qianwen.com', apiUrl: 'https://chat2-api.qianwen.com',
    authMethods: ['manual'] })
  oauth.setProgressCallback(event => progress.push(event))
  const checker = load('providers/checker.ts').ProviderChecker
  const check = credentials => checker.checkAccountToken({
    id: 'qwen', type: 'builtin', name: 'Qwen China', apiEndpoint: 'https://chat2.qianwen.com',
  }, { id: 'synthetic-account', credentials, providerId: 'qwen', status: 'active' })
  return { oauth, check, calls, logs, progress, FakeAxiosError,
    assertSafe(result) {
      const exposed = JSON.stringify({ result, logs, progress })
      assert.equal(exposed.includes(PRIVATE), false, 'Private account/transport data leaked')
    },
  }
}

for (const path of ['oauth', 'checker']) {
  test('Qwen China ' + path + ' accepts verified legacy alias and sends identical cookie', async () => {
    const h = harness()
    const response = path === 'oauth'
      ? await h.oauth.validateToken({ tongyi_sso_ticket: PRIVATE })
      : await h.check({ tongyi_sso_ticket: PRIVATE })
    assert.equal(response.valid, true)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].config.headers.Cookie, 'tongyi_sso_ticket=' + PRIVATE)
    assert.equal(h.calls[0].config.maxRedirects, 0)
    assert.equal(h.calls[0].url, 'https://chat2-api.qianwen.com/api/v2/session/page/list')
  })
  for (const [description, creds] of [
    ['no ticket', {}], ['wrong shape', { ticket: { secret: PRIVATE } }],
    ['conflicting aliases', { ticket: PRIVATE, tongyi_sso_ticket: 'OTHER' }],
    ['second alias is malformed', { ticket: PRIVATE, tongyi_sso_ticket: ['OTHER'] }],
    ['ticket with CRLF', { ticket: PRIVATE + '\r\nCanary: 1' }],
    ['ticket with cookie separator', { ticket: PRIVATE + '; extra=1' }],
  ]) {
    test(path + ' rejects ' + description + ' before network', async () => {
      const h = harness()
      const result = path === 'oauth'
        ? await h.oauth.validateToken(creds) : await h.check(creds)
      assert.equal(result.valid, false)
      assert.equal(h.calls.length, 0)
      h.assertSafe(result)
    })
  }
  for (const [description, body, status] of [
    ['missing success marker', { data: { synthetic: true } }, 200],
    ['string success marker', { success: 'true', data: {} }, 200],
    ['numeric success marker', { success: 1, data: {} }, 200],
    ['null body', null, 200],
    ['server-declared error', { success: false, errorMsg: PRIVATE }, 200],
    ['login redirect', { success: true }, 302],
    ['upstream error', { success: true }, 503],
  ]) {
    test(path + ' rejects ' + description + ' with one fixed failure', async () => {
      const h = harness({ response: { status, data: body } })
      const result = path === 'oauth' ? await h.oauth.validateToken(valid) : await h.check(valid)
      assert.equal(result.valid, false)
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0].config.maxRedirects, 0)
      h.assertSafe(result)
    })
  }
  test(path + ' handles opaque Axios exception without returning credential canary', async () => {
    const error = Object.assign(new Error(PRIVATE), {
      config: { headers: { Cookie: PRIVATE }, url: 'https://invalid.test/?ticket=' + PRIVATE },
      response: { data: { error: PRIVATE } },
    })
    const h = harness({ postThrows: error })
    const result = path === 'oauth' ? await h.oauth.validateToken(valid) : await h.check(valid)
    assert.equal(result.valid, false)
    assert.equal(h.calls.length, 1)
    h.assertSafe(result)
  })
}

test('verified Qwen China manual login persists only the supplied synthetic ticket', async () => {
  const h = harness()
  const result = await h.oauth.loginWithToken('qwen', PRIVATE)
  assert.equal(result.success, true)
  assert.equal(result.credentials.ticket, PRIVATE)
  assert.equal(Object.keys(result.credentials).length, 1)
  assert.equal(h.calls.length, 1)
  assert.equal(h.progress.some(p => p.status === 'success'), true)
})

test('Qwen China manual login and browser-opening failures never reveal transport credentials', async () => {
  const networkError = new Error(PRIVATE)
  const network = harness({ postThrows: networkError })
  const login = await network.oauth.loginWithToken('qwen', PRIVATE)
  assert.equal(login.success, false)
  network.assertSafe(login)
  const browser = harness({ browserError: networkError })
  const loginWindow = await browser.oauth.startLogin({ providerId: 'qwen' })
  assert.equal(loginWindow.success, false)
  browser.assertSafe(loginWindow)
})
