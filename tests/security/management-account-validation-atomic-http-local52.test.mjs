import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real AccountManager, management-auth middleware, accounts router, Koa,
// koa-bodyparser, and 127.0.0.1:0. Only external credential validation and
// persistence are closed synthetic fixtures. No operating profile, tokens,
// provider network, login, session effects, or approval/marker usage.
const nodeRequire = createRequire(import.meta.url)
const SECRET = 'SYNTHETIC_LOCAL52_MANAGEMENT_SECRET'
const CREDENTIAL = 'SYNTHETIC_LOCAL52_CREDENTIAL_NEVER_EXPOSE'
const VERIFIED_EMAIL = 'verified-local52@example.invalid'
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))

function product(relative, deps) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } },
  ).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Date, Math, JSON, Error, Buffer,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected local product import: ' + relative + ' ' + id)
      return nodeRequire(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({
  validation = 'success-with-email',
  failWriteAt = 0,
  denyManagement = false,
  noAccount = false,
} = {}) {
  const provider = { id: 'synthetic-provider', name: 'Synthetic', enabled: true, type: 'custom' }
  const initial = [{
    id: 'stable-account', providerId: provider.id, name: 'Original', email: 'old@example.invalid',
    credentials: { token: CREDENTIAL }, status: 'error', errorMessage: 'old failure',
    requestCount: 3, todayUsed: 1, dailyLimit: 5, createdAt: 100, updatedAt: 101,
  }]
  let accounts = noAccount ? [] : clone(initial)
  const calls = { validation: 0, writes: 0, infoLog: 0 }
  const storeManager = {
    getConfig: () => ({
      managementApi: { enableManagementApi: !denyManagement, managementApiSecret: SECRET },
    }),
    getAccounts: () => clone(accounts),
    getAccountById: id => clone(accounts.find(a => a.id === id)),
    getProviderById: id => id === provider.id ? clone(provider) : undefined,
    updateAccount(id, changes) {
      calls.writes++
      if (failWriteAt === calls.writes) throw Error('SYNTHETIC_LOCAL52_DURABLE_STORAGE_REFUSAL')
      const existing = accounts.find(a => a.id === id)
      if (!existing) return null
      const next = { ...existing, ...clone(changes), updatedAt: 102 }
      // A refused update must not modify the prior in-memory snapshot.
      accounts = accounts.map(a => a.id === id ? next : a)
      return clone(next)
    },
    addLog(level) { if (level === 'info') calls.infoLog++ },
  }
  const validateCredentials = async (_provider, credentials) => {
    calls.validation++
    assert.equal(credentials.token, CREDENTIAL)
    if (validation === 'invalid') {
      return { valid: false, error: 'Synthetic rejected credentials', validatedAt: 104 }
    }
    if (validation === 'success-no-email') {
      return { valid: true, validatedAt: 104 }
    }
    return {
      valid: true, validatedAt: 104,
      accountInfo: { email: VERIFIED_EMAIL, name: 'Synthetic verified name' },
    }
  }
  const AccountManager = product('store/accounts.ts', {
    './store': { storeManager }, './validator': { validateCredentials },
  }).AccountManager
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const router = product('proxy/routes/management/accounts.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  const app = new (nodeRequire('koa'))()
  app.use(nodeRequire('koa-bodyparser')())
  app.use(router.routes())
  app.use(router.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', authenticated = true, body } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authenticated) headers.Authorization = 'Bearer ' + SECRET
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
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
    req.setTimeout(3000, () => req.destroy(Error('local52 synthetic HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    request, calls, state: () => clone(accounts), initial: clone(initial),
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

const validatePath = '/v0/management/accounts/stable-account/validate'

test('real authenticated Koa successful validation commits status and verified email once', async t => {
  const f = await fixture({ failWriteAt: 2 })
  t.after(f.close)
  const response = await f.request(validatePath, { method: 'POST' })
  assert.equal(f.calls.validation, 1)
  assert.equal(f.calls.writes, 1, 'status and verified email are ONE durable account update')
  assert.equal(response.status, 200, 'validated but already changed account is not a false HTTP 500')
  assert.equal(response.json.success, true)
  assert.equal(response.json.data.valid, true)
  assert.equal(f.state()[0].status, 'active')
  assert.equal(f.state()[0].email, VERIFIED_EMAIL)
  assert.equal(f.state()[0].id, 'stable-account')
  assert.equal(f.state()[0].providerId, 'synthetic-provider')
  assert.equal(f.state()[0].requestCount, 3)
  assert.equal(f.state()[0].credentials.token, CREDENTIAL)
  assert.equal(response.raw.includes(CREDENTIAL) || response.raw.includes(SECRET), false)
})

test('actual validation true storage refusal leaves original status, email and credentials unchanged', async t => {
  const f = await fixture({ failWriteAt: 1 })
  t.after(f.close)
  const response = await f.request(validatePath, { method: 'POST' })
  assert.equal(response.status, 500)
  assert.equal(f.calls.validation, 1)
  assert.equal(f.calls.writes, 1)
  assert.deepEqual(f.state(), f.initial)
  assert.equal(response.raw.includes(CREDENTIAL), false)
})

test('rejected credentials mark error status in one write without overwriting preexisting email', async t => {
  const f = await fixture({ validation: 'invalid' })
  t.after(f.close)
  const response = await f.request(validatePath, { method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal(response.json.data.valid, false)
  assert.equal(f.state()[0].status, 'error')
  assert.equal(f.state()[0].email, f.initial[0].email)
  assert.equal(f.calls.validation, 1)
  assert.equal(f.calls.writes, 1)
})

test('successful validation without account email still performs only one durable status write', async t => {
  const f = await fixture({ validation: 'success-no-email' })
  t.after(f.close)
  const response = await f.request(validatePath, { method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal(f.calls.validation, 1)
  assert.equal(f.calls.writes, 1)
  assert.equal(f.state()[0].email, f.initial[0].email)
  assert.equal(f.state()[0].status, 'active')
})

test('unauthorized and disabled validation send no provider effect or storage write', async t => {
  for (const disabled of [false, true]) {
    const f = await fixture({ denyManagement: disabled })
    t.after(f.close)
    const response = await f.request(validatePath, { method: 'POST', authenticated: false })
    assert.equal(response.status, disabled ? 404 : 401)
    assert.equal(f.calls.validation, 0)
    assert.equal(f.calls.writes, 0)
    assert.deepEqual(f.state(), f.initial)
  }
})

test('missing account never validates upstream and preserves stable 404', async t => {
  const f = await fixture({ noAccount: true })
  t.after(f.close)
  const response = await f.request(validatePath, { method: 'POST' })
  assert.equal(response.status, 404)
  assert.equal(response.json.error.code, 'account_not_found')
  assert.equal(f.calls.validation, 0)
  assert.equal(f.calls.writes, 0)
})

test('after authorized validation, normal management account read stays credential-masked', async t => {
  const f = await fixture()
  t.after(f.close)
  assert.equal((await f.request(validatePath, { method: 'POST' })).status, 200)
  const response = await f.request('/v0/management/accounts/stable-account')
  assert.equal(response.status, 200)
  assert.equal(response.json.data.email, VERIFIED_EMAIL)
  assert.equal(response.json.data.credentials.token, '***')
  assert.equal(response.raw.includes(CREDENTIAL), false)
})
