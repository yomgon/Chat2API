import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual AccountManager + management-auth/account CRUD router, Koa and
// koa-bodyparser over 127.0.0.1:0. Entirely synthetic account state; no
// operating profile, credentials, provider checker or external requests.
const requireNode = createRequire(import.meta.url)
const SECRET = 'LOCAL49_SYNTHETIC_MANAGEMENT_AUTH'
const PRIVATE = 'LOCAL49_SYNTHETIC_ACCOUNT_SECRET_NO_PUBLIC_OUTPUT'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function load(relative, dependencies) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'), {
      fileName: relative,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      },
    },
  ).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Date, Math, JSON, Error, Buffer,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('.')) throw Error('Unexpected account dependency ' + relative + ':' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({ refuseInfoLog = false, refuseWrite = false } = {}) {
  const provider = {
    id: 'p1', name: 'Synthetic provider', type: 'custom',
    apiEndpoint: 'https://synthetic.example.com', enabled: true,
  }
  let accounts = [{
    id: 'a1', providerId: provider.id, name: 'Existing', status: 'active',
    credentials: { token: PRIVATE }, dailyLimit: 3, todayUsed: 0,
    requestCount: 0, createdAt: 1, updatedAt: 1,
  }]
  let nextId = 1
  const effects = { writes: 0, infoLogAttempts: 0, validationChecks: 0 }
  const storeManager = {
    getConfig: () => ({ managementApi: { enableManagementApi: true, managementApiSecret: SECRET } }),
    ensureProviderExists(providerId) {
      if (providerId !== provider.id) throw Error('Provider not found')
    },
    getProviderById: id => id === provider.id ? clone(provider) : undefined,
    generateId: () => 'created-' + nextId++,
    getAccounts: () => clone(accounts),
    getAccountById: id => clone(accounts.find(a => a.id === id)),
    getAccountsByProviderId: id => clone(accounts.filter(a => a.providerId === id)),
    addAccount(account) {
      effects.writes++
      if (refuseWrite) throw Error('Synthetic durable create refusal')
      accounts = [...accounts, clone(account)]
    },
    updateAccount(id, update) {
      effects.writes++
      if (refuseWrite) throw Error('Synthetic durable update refusal')
      const index = accounts.findIndex(a => a.id === id)
      if (index === -1) return null
      accounts = accounts.map((a, i) => i === index ? { ...a, ...clone(update), updatedAt: Date.now() } : a)
      return clone(accounts[index])
    },
    deleteAccount(id) {
      effects.writes++
      if (refuseWrite) throw Error('Synthetic durable delete refusal')
      const count = accounts.length
      accounts = accounts.filter(a => a.id !== id)
      return count !== accounts.length
    },
    addLog(level) {
      if (level === 'info') {
        effects.infoLogAttempts++
        if (refuseInfoLog) throw Error('Synthetic postcommit diagnostics unavailable')
      }
    },
  }
  const AccountManager = load('store/accounts.ts', {
    './store': { storeManager },
    './validator': {
      validateCredentials: async () => {
        effects.validationChecks++
        throw Error('No external credential verification in this fixture')
      },
    },
  }).AccountManager
  const managementAuthMiddleware = load('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const router = load('proxy/routes/management/accounts.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  const Koa = requireNode('koa')
  const app = new Koa()
  app.use(requireNode('koa-bodyparser')())
  app.use(router.routes())
  app.use(router.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + SECRET
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({
      hostname: '127.0.0.1', port, method, path, headers,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic local account CRUD timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    request, effects,
    state: () => clone(accounts),
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('account create after committed write stays 201 with masked credentials if app log fails', async t => {
  const f = await fixture({ refuseInfoLog: true }); t.after(f.close)
  const response = await f.request('/v0/management/accounts', {
    method: 'POST',
    body: { providerId: 'p1', name: 'Synthetic second', credentials: { token: PRIVATE }, dailyLimit: 4 },
  })
  assert.equal(f.state().length, 2)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.infoLogAttempts, 1)
  assert.equal(response.raw.includes(PRIVATE), false)
  assert.equal(response.status, 201)
  assert.equal(response.json.data.id, 'created-1')
  assert.equal(response.json.data.credentials.token, '***')
  assert.equal(f.effects.validationChecks, 0)
})

test('account metadata update after committed write stays 200 and preserves immutable ID and secret', async t => {
  const f = await fixture({ refuseInfoLog: true }); t.after(f.close)
  const response = await f.request('/v0/management/accounts/a1', {
    method: 'PUT', body: { name: 'Renamed', dailyLimit: 6 },
  })
  assert.equal(f.state()[0].id, 'a1')
  assert.equal(f.state()[0].providerId, 'p1')
  assert.equal(f.state()[0].credentials.token, PRIVATE)
  assert.equal(f.state()[0].dailyLimit, 6)
  assert.equal(response.status, 200)
  assert.equal(response.json.data.name, 'Renamed')
  assert.equal(response.json.data.credentials.token, '***')
  assert.equal(response.raw.includes(PRIVATE), false)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.infoLogAttempts, 1)
})

test('account delete committed once remains HTTP 200 with absent account even if diagnostics fail', async t => {
  const f = await fixture({ refuseInfoLog: true }); t.after(f.close)
  const response = await f.request('/v0/management/accounts/a1', { method: 'DELETE' })
  assert.equal(f.state().length, 0)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.infoLogAttempts, 1)
  assert.equal(response.status, 200)
  assert.equal(response.json.data.deleted, true)
  assert.equal(response.raw.includes(PRIVATE), false)
})

test('account CRUD true persistence refusal never claims success or changes preserved account state', async t => {
  const f = await fixture({ refuseWrite: true }); t.after(f.close)
  const before = f.state()
  const responses = [
    await f.request('/v0/management/accounts', {
      method: 'POST', body: { providerId: 'p1', name: 'New', credentials: { token: PRIVATE } },
    }),
    await f.request('/v0/management/accounts/a1', { method: 'PUT', body: { name: 'Change' } }),
    await f.request('/v0/management/accounts/a1', { method: 'DELETE' }),
  ]
  assert.deepEqual(responses.map(r => r.status), [500, 500, 500])
  assert.equal(responses.some(r => r.raw.includes(PRIVATE)), false)
  assert.deepEqual(f.state(), before)
  assert.equal(f.effects.writes, 3)
  assert.equal(f.effects.infoLogAttempts, 0)
})

test('unauthorized account mutation has zero durable writes, and list remains masked', async t => {
  const f = await fixture(); t.after(f.close)
  const before = f.state()
  const forbidden = await f.request('/v0/management/accounts/a1', {
    method: 'PUT', body: { name: 'Unauthorized' }, authorized: false,
  })
  assert.equal(forbidden.status, 401)
  assert.equal(f.effects.writes, 0)
  assert.deepEqual(f.state(), before)
  const list = await f.request('/v0/management/accounts')
  assert.equal(list.status, 200)
  assert.equal(list.raw.includes(PRIVATE), false)
  assert.equal(list.json.data[0].credentials.token, '***')
  assert.equal(f.effects.validationChecks, 0)
})
