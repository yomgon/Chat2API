import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'
import { ZAI_SESSION_MODULE } from './helpers/zaiSessionModule.mjs'

// Actual product checker with synthetic HTTPS responses only. The selected
// OAuth credential must be the one the web completion adapter would consume.
const source = readFileSync(new URL('../../src/main/providers/checker.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { fileName: 'checker.ts', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const CANARY = 'SYNTHETIC_PRIVATE_AUTH_URL_ERROR_LOCAL21'
const A = 'synthetic-a-access-token'
const B = 'synthetic-b-access-token'
const C = 'synthetic-c-access-token'

function harness({ status = 200, body = { subscription: { userName: 'Synthetic user' } }, reject = false } = {}) {
  const requests = []
  const AxiosError = class extends Error {}
  const fakeAxios = {
    post(url, data, config) {
      requests.push({ url, data, config })
      if (reject) {
        const error = new AxiosError('Upstream failed ' + CANARY)
        error.config = { headers: { Authorization: CANARY }, url: 'https://private.invalid/?secret=' + CANARY }
        return Promise.reject(error)
      }
      return Promise.resolve({ status, data: body })
    },
  }
  const log = []
  const deps = {
    axios: { __esModule: true, default: fakeAxios, AxiosError },
    './builtin': { getBuiltinProvider: id => id === 'kimi' ? { id } : null },
    './qwenTicket': QWEN_TICKET_MODULE,
    './qwenAiToken': QWEN_AI_TOKEN_MODULE,
    '../oauth/zaiSession': ZAI_SESSION_MODULE,
  }
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Error, Buffer, URL,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      throw new Error('Forbidden checker import ' + name)
    },
    console: { log: (...args) => log.push(args), error: (...args) => log.push(args), warn: (...args) => log.push(args) },
  }, { filename: 'checker.ts', timeout: 2000 })
  const check = credentials => mod.exports.ProviderChecker.checkAccountToken(
    { id: 'kimi', type: 'builtin', apiEndpoint: 'https://www.kimi.com' },
    { id: 'synthetic', providerId: 'kimi', credentials },
  )
  return { check, requests, log }
}

test('manual Kimi OAuth accessToken is consumed without Bearer undefined', async () => {
  const h = harness()
  const result = await h.check({ accessToken: A })
  assert.equal(result.valid, true)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].config.headers.Authorization, 'Bearer ' + A)
  assert.equal(h.requests[0].config.maxRedirects, 0)
})

test('legacy credential precedence matches web completion account pin', async () => {
  for (const [credentials, expected] of [
    [{ token: A, refreshToken: B, accessToken: C }, A],
    [{ token: '', refreshToken: B, accessToken: C }, B],
    [{ token: '', refreshToken: '', accessToken: C }, C],
    [{ token: A }, A],
  ]) {
    const h = harness()
    assert.equal((await h.check(credentials)).valid, true)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].config.headers.Authorization, 'Bearer ' + expected)
  }
})

test('malformed selected credential cannot be silently swapped for another one', async () => {
  for (const credentials of [
    {}, null, undefined, { token: undefined }, { token: 0, accessToken: A },
    { token: null, accessToken: A }, { token: false, accessToken: A },
    { token: {}, accessToken: A }, { token: '\nInjected:' + A, accessToken: A },
    { token: ' ' }, { token: '\t' }, { token: '\u0085' + A, accessToken: A },
    { token: '\u009f' + A, accessToken: A }, { refreshToken: {}, accessToken: A },
  ]) {
    const h = harness()
    const result = await h.check(credentials)
    assert.equal(result.valid, false)
    assert.equal(h.requests.length, 0, 'No malformed or guessed credentials may reach network')
    assert.equal(JSON.stringify(result).includes(CANARY), false)
  }
})

test('HTTP errors and redirect are never a valid Kimi account', async () => {
  for (const status of [301, 302, 307, 401, 403, 429, 500]) {
    const h = harness({ status })
    assert.equal((await h.check({ accessToken: A })).valid, false)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].config.maxRedirects, 0)
  }
})

test('provider transport errors never echo Axios headers, token URLs or raw error', async () => {
  const h = harness({ reject: true })
  const result = await h.check({ accessToken: A })
  assert.equal(result.valid, false)
  assert.equal(JSON.stringify(result).includes(CANARY), false)
  assert.equal(JSON.stringify(h.log).includes(CANARY), false)
  assert.equal(h.requests.length, 1)
})
