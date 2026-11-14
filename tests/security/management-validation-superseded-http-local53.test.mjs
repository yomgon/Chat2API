import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual AccountManager + managementAuthMiddleware + management account CRUD
// HTTP endpoints (Koa/koa-bodyparser on 127.0.0.1:0). An in-memory account and
// a controllable synthetic validation Promise are the only credential source.
// This tests in-flight *stale* validation, NOT a real provider authentication.
const nodeRequire = createRequire(import.meta.url)
const SECRET = 'SYNTHETIC_LOCAL53_MANAGEMENT_AUTH_ONLY'
const OLD = 'SYNTHETIC_LOCAL53_OLD_CREDENTIAL_NEVER_RETURN'
const NEW = 'SYNTHETIC_LOCAL53_NEW_CREDENTIAL_NEVER_RETURN'
const ERROR_CANARY = 'SYNTHETIC_LOCAL53_PRIVATE_UPSTREAM_FAILURE'
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))

function product(relative, deps, dateClass = Date) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } },
  ).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Date: dateClass, Math, JSON, Error, Buffer,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected application import: ' + relative + ':' + id)
      return nodeRequire(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({
  writeRefusal = false, providerRefusal = false, errorLocation = '',
} = {}) {
  // A fixed millisecond deliberately makes updatedAt an insufficient fence by
  // itself; credential/name changes must also reject stale validation results.
  class SameMsDate extends Date { static now() { return 2000 } }
  const provider = { id: 'qwen', enabled: true, type: 'builtin', name: 'Synthetic provider' }
  const initial = [{
    id: 'immutable-account', providerId: 'qwen', name: 'Original account',
    email: 'old@example.invalid', credentials: { token: OLD },
    status: 'error', errorMessage: 'Previously unverified',
    createdAt: 1, updatedAt: 2000, requestCount: 3,
    todayUsed: 1, dailyLimit: 5,
  }]
  let accounts = clone(initial)
  const effects = { providerValidations: 0, writes: 0, deletes: 0, logs: 0 }
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  let releaseValidation
  const waitValidation = new Promise(resolve => { releaseValidation = resolve })
  const storeManager = {
    getConfig: () => ({
      managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    }),
    getAccounts: () => {
      if (errorLocation === 'list') throw Error(ERROR_CANARY)
      return clone(accounts)
    },
    getAccountById: id => {
      if (errorLocation === 'detail') throw Error(ERROR_CANARY)
      return clone(accounts.find(a => a.id === id))
    },
    getAccountsByProviderId: id => {
      if (errorLocation === 'provider-list') throw Error(ERROR_CANARY)
      return clone(accounts.filter(a => a.providerId === id))
    },
    getProviderById: id => id === provider.id ? clone(provider) : undefined,
    ensureProviderExists(id) {
      if (errorLocation === 'create') throw Error('Provider not found: ' + ERROR_CANARY)
      if (id !== provider.id) throw Error('Provider not found')
    },
    generateId: () => 'created-synthetic-id',
    addAccount(a) {
      effects.writes++
      if (errorLocation === 'create-write') throw Error(ERROR_CANARY)
      accounts = [...accounts, clone(a)]
    },
    updateAccount(id, updates) {
      effects.writes++
      if (errorLocation === 'update') throw Error(ERROR_CANARY)
      if (writeRefusal) throw Error('Synthetic durable account storage refusal')
      const row = accounts.find(a => a.id === id)
      if (!row) return null
      // The saved timestamp is identical across concurrent operations.
      const changed = { ...row, ...clone(updates), updatedAt: 2000 }
      accounts = accounts.map(a => a.id === id ? changed : a)
      return clone(changed)
    },
    deleteAccount(id) {
      effects.deletes++
      if (errorLocation === 'delete') throw Error(ERROR_CANARY)
      const prev = accounts.length
      accounts = accounts.filter(a => a.id !== id)
      return prev !== accounts.length
    },
    addLog() { effects.logs++ },
  }
  const validateCredentials = async (_provider, credentials) => {
    effects.providerValidations++
    assert.ok(credentials.token === OLD, 'Validation must use only the original synthetic credential')
    signalStarted()
    await waitValidation
    if (providerRefusal) throw Error(ERROR_CANARY)
    return {
      valid: true, validatedAt: 2000,
      accountInfo: { email: 'verified-old@example.invalid' },
    }
  }
  const AccountManager = product('store/accounts.ts', {
    './store': { storeManager }, './validator': { validateCredentials },
  }, SameMsDate).AccountManager
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }, SameMsDate).managementAuthMiddleware
  const router = product('proxy/routes/management/accounts.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }, SameMsDate).default
  const app = new (nodeRequire('koa'))()
  app.use(nodeRequire('koa-bodyparser')())
  app.use(router.routes())
  app.use(router.allowedMethods())
  const listener = createServer(app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  const http = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + SECRET
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic management HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    http, initial, effects, started, release: () => releaseValidation(),
    state: () => clone(accounts),
    close: async () => {
      releaseValidation()
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    },
  }
}

const base = '/v0/management/accounts/immutable-account'
const validate = f => f.http(base + '/validate', { method: 'POST' })

test('real Koa: stale successful validation cannot activate an account whose credentials were replaced in flight', async t => {
  const f = await fixture()
  t.after(f.close)
  const pending = validate(f)
  await f.started
  const updated = await f.http(base, {
    method: 'PUT', body: { credentials: { token: NEW } },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.raw.includes(OLD) || updated.raw.includes(NEW), false)
  assert.equal(f.effects.providerValidations, 1)
  assert.equal(f.effects.writes, 1)
  f.release()
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(result.json.error.code, 'account_validation_superseded')
  assert.equal(result.raw.includes(OLD) || result.raw.includes(NEW), false)
  // A new unverified credential is deliberately inactive after the edit;
  // the prior validation must not restore active or overwrite this status.
  assert.equal(f.state()[0].status, 'inactive')
  assert.equal(f.state()[0].email, 'old@example.invalid')
  assert.ok(f.state()[0].credentials.token === NEW)
  assert.equal(f.effects.writes, 1, 'Superseded provider result cannot mutate newly saved account')
})

test('real Koa: concurrent metadata rename at the same timestamp cannot be overwritten by old provider result', async t => {
  const f = await fixture()
  t.after(f.close)
  const pending = validate(f)
  await f.started
  assert.equal((await f.http(base, {
    method: 'PUT', body: { name: 'User renamed account' },
  })).status, 200)
  f.release()
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(f.state()[0].name, 'User renamed account')
  assert.equal(f.state()[0].status, 'error')
  assert.equal(f.state()[0].email, 'old@example.invalid')
  assert.equal(f.effects.writes, 1)
})

test('real Koa: deleting account while provider validation is pending never resurrects or writes the deleted identity', async t => {
  const f = await fixture()
  t.after(f.close)
  const pending = validate(f)
  await f.started
  assert.equal((await f.http(base, { method: 'DELETE' })).status, 200)
  assert.equal(f.state().length, 0)
  f.release()
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(f.state().length, 0)
  assert.equal(f.effects.deletes, 1)
  assert.equal(f.effects.writes, 0)
})

test('real Koa: nonconcurrent validation still commits status+email in exactly one durable write', async t => {
  const f = await fixture()
  t.after(f.close)
  const pending = validate(f)
  await f.started
  f.release()
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal(result.json.data.valid, true)
  assert.equal(f.state()[0].status, 'active')
  assert.equal(f.state()[0].email, 'verified-old@example.invalid')
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.providerValidations, 1)
  assert.equal(result.raw.includes(OLD), false)
})

test('real Koa: actual account storage refusal remains HTTP 500 with unchanged account snapshot', async t => {
  const f = await fixture({ writeRefusal: true })
  t.after(f.close)
  const pending = validate(f)
  await f.started
  f.release()
  const result = await pending
  assert.equal(result.status, 500)
  assert.deepEqual(f.state(), f.initial)
  assert.equal(f.effects.writes, 1)
  assert.equal(result.raw.includes(OLD), false)
})

test('real Koa: unauthorized validation cannot start an upstream effect', async t => {
  const f = await fixture()
  t.after(f.close)
  const denied = await f.http(base + '/validate', { method: 'POST', authorized: false })
  assert.equal(denied.status, 401)
  assert.equal(f.effects.providerValidations, 0)
  assert.equal(f.effects.writes, 0)
  assert.deepEqual(f.state(), f.initial)
})

test('real Koa: protected provider failure never returns synthetic credential or provider exception', async t => {
  const f = await fixture({ providerRefusal: true })
  t.after(f.close)
  const pending = validate(f)
  await f.started
  f.release()
  const result = await pending
  assert.equal(result.status, 500)
  assert.equal(result.raw.includes(OLD) || result.raw.includes(ERROR_CANARY), false)
  assert.deepEqual(f.state(), f.initial)
})

test('real Koa: account list, detail and provider-scoped read failures never return internal storage exception text', async t => {
  for (const [location, path] of [
    ['list', '/v0/management/accounts'],
    ['detail', base],
    ['provider-list', '/v0/management/providers/qwen/accounts'],
  ]) {
    const f = await fixture({ errorLocation: location })
    t.after(f.close)
    const response = await f.http(path)
    assert.equal(response.status, 500)
    assert.equal(response.json.error.code, 'internal_error')
    assert.equal(response.raw.includes(ERROR_CANARY) || response.raw.includes(OLD), false)
    assert.deepEqual(f.state(), f.initial)
  }
})

test('real Koa: account update/delete persistence failures never echo sensitive exception text or mutate account', async t => {
  for (const [location, operation] of [
    ['update', { method: 'PUT', body: { name: 'Change' } }],
    ['delete', { method: 'DELETE' }],
  ]) {
    const f = await fixture({ errorLocation: location })
    t.after(f.close)
    const response = await f.http(base, operation)
    assert.equal(response.status, 500)
    assert.equal(response.json.error.code, 'internal_error')
    assert.equal(response.raw.includes(ERROR_CANARY) || response.raw.includes(OLD), false)
    assert.deepEqual(f.state(), f.initial)
  }
})

test('real Koa: provider-not-found response is a safe 404 without exposing account or low-level details', async t => {
  const f = await fixture({ errorLocation: 'create' })
  t.after(f.close)
  const response = await f.http('/v0/management/accounts', {
    method: 'POST', body: {
      name: 'New synthetic account', providerId: 'not-present',
      credentials: { token: NEW },
    },
  })
  assert.equal(response.status, 404)
  assert.equal(response.json.error.code, 'provider_not_found')
  assert.equal(response.raw.includes(ERROR_CANARY) || response.raw.includes(NEW), false)
  assert.deepEqual(f.state(), f.initial)
})
