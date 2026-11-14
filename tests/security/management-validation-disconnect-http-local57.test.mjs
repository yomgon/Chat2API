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
  const effects = { providerValidations: 0, writes: 0, deletes: 0, logs: 0,
    httpDisconnects: 0, validateRoutesSettled: 0 }
  const waiters = []
  const signalWaiters = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const waitUntil = (predicate, message) => new Promise((resolve, reject) => {
    if (predicate()) { resolve(); return }
    const timeout = setTimeout(() => reject(Error(message)), 1500)
    const waiter = () => {
      if (!predicate()) return
      clearTimeout(timeout)
      waiters.splice(waiters.indexOf(waiter), 1)
      resolve()
    }
    waiters.push(waiter)
  })
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
  // Passive lifetime witness, not a product-route substitute. The real
  // management auth and actual AccountManager remain responsible for effects.
  app.use(async (ctx, next) => {
    if (ctx.path.endsWith('/validate')) {
      ctx.res.once('close', () => {
        if (!ctx.res.writableEnded) {
          effects.httpDisconnects++
          signalWaiters()
        }
      })
    }
    try { await next() } finally {
      if (ctx.path.endsWith('/validate')) {
        effects.validateRoutesSettled++
        signalWaiters()
      }
    }
  })
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
  const abortableValidation = () => {
    const req = httpRequest({ hostname: '127.0.0.1', port,
      path: '/v0/management/accounts/immutable-account/validate', method: 'POST',
      headers: { Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + SECRET },
    }, res => { res.resume() })
    req.on('error', () => {}) // expected local client cancellation
    // Node's events.once() rejects on the expected ECONNRESET 'error' event;
    // cancellation instead needs to observe socket close without treating
    // its local transport error as a provider or server failure.
    const closed = new Promise(resolve => req.once('close', resolve))
    req.end()
    return { abort: () => req.destroy(), closed }
  }
  return {
    http, initial, effects, started, release: () => releaseValidation(),
    abortableValidation, waitUntil,
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

test('local57 authenticated management validation canceled by HTTP disconnect never commits a late provider success', async () => {
  const f = await fixture()
  const abandoned = f.abortableValidation()
  try {
    await f.started
    assert.equal(f.effects.providerValidations, 1)
    assert.deepEqual(f.state(), f.initial)
    abandoned.abort()
    await abandoned.closed
    await f.waitUntil(() => f.effects.httpDisconnects === 1, 'HTTP disconnect not observed by Koa')
    const second = await validate(f)
    assert.equal(second.status, 409, second.raw)
    assert.equal(second.json.error.code, 'account_validation_in_progress')
    assert.equal(f.effects.providerValidations, 1, 'No second provider validation effect')
    f.release()
    await f.waitUntil(() => f.effects.validateRoutesSettled >= 2, 'Canceled validation did not settle')
    assert.equal(f.effects.writes, 0, 'A disconnected client cannot authorize a late account status/email write')
    assert.deepEqual(f.state(), f.initial, 'Preserve the original error/status and credential snapshot')
    const later = await validate(f)
    assert.equal(later.status, 200, later.raw)
    assert.equal(f.effects.providerValidations, 2, 'Only a new explicit request may revalidate')
    assert.equal(f.effects.writes, 1)
    assert.equal(f.state()[0].status, 'active')
    assert.equal(f.state()[0].email, 'verified-old@example.invalid')
    assert.equal(later.raw.includes(OLD) || later.raw.includes(ERROR_CANARY), false)
  } finally {
    f.release()
    await f.close()
  }
})

test('local57 still commits exactly one status/email write for healthy authenticated management validation', async () => {
  const f = await fixture()
  const requested = validate(f)
  try {
    await f.started
    assert.equal(f.effects.httpDisconnects, 0)
    f.release()
    const response = await requested
    assert.equal(response.status, 200, response.raw)
    assert.equal(f.effects.writes, 1)
    assert.equal(f.effects.providerValidations, 1)
    assert.equal(f.state()[0].status, 'active')
    assert.equal(f.state()[0].email, 'verified-old@example.invalid')
  } finally {
    f.release()
    await Promise.allSettled([requested])
    await f.close()
  }
})
