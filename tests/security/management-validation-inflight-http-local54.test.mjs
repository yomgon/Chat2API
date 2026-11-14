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
  anotherAccount = false,
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
  if (anotherAccount) initial.push({
    ...clone(initial[0]), id: 'other-immutable-account', name: 'Independent account',
    email: 'independent@example.invalid',
  })
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

// These are two authenticated HTTP requests for the *same* immutable account
// before a first provider validation can finish. A duplicate effect can
// consume a provider's session/challenge/rate quota even if the late result
// is subsequently rejected as a superseded local account write.
test('local54 concurrent management validate for same account rejects duplicate before any second provider effect', async () => {
  const f = await fixture()
  let first
  let second
  try {
    first = validate(f)
    await f.started
    second = validate(f)
    const beforeRelease = await Promise.race([
      second,
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 150)),
    ])
    const effectsBeforeRelease = f.effects.providerValidations
    f.release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.status, 200, a.raw)
    assert.equal(beforeRelease.status, 409,
      `Concurrent validation was not rejected before another provider effect; calls=${effectsBeforeRelease}`)
    assert.equal(beforeRelease.json.error.code, 'account_validation_in_progress')
    assert.equal(b.status, 409, b.raw)
    assert.equal(effectsBeforeRelease, 1, 'Second validation must not be dispatched')
    assert.equal(f.effects.writes, 1, 'Original validation alone owns the status/email write')
    assert.equal(f.state()[0].status, 'active')
    assert.equal(a.raw.includes(OLD) || b.raw.includes(OLD), false)
  } finally {
    f.release()
    await Promise.allSettled([first, second].filter(Boolean))
    await f.close()
  }
})

for (const [label, options] of [
  ['provider validation exception', { providerRefusal: true }],
  ['durable store refusal', { writeRefusal: true }],
]) {
  test(`local54 ${label} releases duplicate-validation guard without leaking private errors or inventing success`, async () => {
    const f = await fixture(options)
    let first
    let second
    try {
      first = validate(f)
      await f.started
      second = await validate(f)
      assert.equal(second.status, 409, second.raw)
      assert.equal(second.json.error.code, 'account_validation_in_progress')
      assert.equal(f.effects.providerValidations, 1)
      assert.equal(f.effects.writes, 0)
      f.release()
      const failed = await first
      assert.equal(failed.status, 500)
      assert.equal(failed.raw.includes(OLD) || failed.raw.includes(ERROR_CANARY), false)
      assert.deepEqual(f.state(), f.initial)
      const fresh = await validate(f)
      assert.equal(fresh.status, 500, fresh.raw)
      assert.equal(f.effects.providerValidations, 2, 'A new explicitly authorized validation can start')
      assert.equal(f.state()[0].status, 'error')
    } finally {
      f.release()
      if (first) await Promise.allSettled([first])
      await f.close()
    }
  })
}

test('local54 validation concurrency guard is per immutable account and does not block independent authorized account', async () => {
  const f = await fixture({ anotherAccount: true })
  let first
  let second
  try {
    first = validate(f)
    await f.started
    second = f.http('/v0/management/accounts/other-immutable-account/validate', {
      method: 'POST',
    })
    for (let i = 0; i < 100 && f.effects.providerValidations < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(f.effects.providerValidations, 2,
      'Different immutable account is not serialized behind the first one')
    f.release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.status, 200, a.raw)
    assert.equal(b.status, 200, b.raw)
    assert.equal(f.effects.writes, 2)
    assert.equal(f.state().length, 2)
    assert.equal(f.state().every(account => account.status === 'active'), true)
  } finally {
    f.release()
    await Promise.allSettled([first, second].filter(Boolean))
    await f.close()
  }
})
