import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const read = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
function load(relative, deps) {
  const module = { exports: {} }
  const code = ts.transpileModule(read(relative), { fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  runInNewContext(code, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    require(name) { if (Object.hasOwn(deps, name)) return deps[name]; return requireNode(name) },
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
  }, { filename: relative, timeout: 2000 })
  return module.exports
}

const SECRET = 'SYNTHETIC_MANAGEMENT_LOCAL40_ACCOUNTS'
const PRIVATE = 'SYNTHETIC_ACCOUNT_PRIVATE_LOCAL40'
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture({ failAccountUpdate = false, failProviderUpdate = false } = {}) {
  let providers = [{ id: 'p1', name: 'Provider', type: 'custom', authType: 'none',
    apiEndpoint: 'https://fixture.invalid', enabled: true, createdAt: 1, headers: {} }]
  let accounts = [{ id: 'a1', providerId: 'p1', name: 'Account', credentials: { token: PRIVATE },
    status: 'active', createdAt: 1, requestCount: 0 }]
  const calls = { accountCreate: 0, accountUpdate: 0, providerCreate: 0, providerUpdate: 0, validate: 0 }
  const storeManager = { getConfig: () => ({ managementApi: { enableManagementApi: true, managementApiSecret: SECRET } }) }
  const AccountManager = {
    getAll: () => clone(accounts), getByProviderId: id => clone(accounts.filter(a => a.providerId === id)),
    getById: id => clone(accounts.find(a => a.id === id)),
    create: data => { calls.accountCreate++; const out = { ...clone(data), id: 'created-a', status: 'active', createdAt: 2 }; accounts.push(out); return clone(out) },
    update: (id, patch) => { calls.accountUpdate++; if (failAccountUpdate) throw Error('synthetic account persistence refusal'); const i = accounts.findIndex(a => a.id === id); if (i < 0) return null; accounts[i] = { ...accounts[i], ...clone(patch) }; return clone(accounts[i]) },
    delete: id => { const n = accounts.length; accounts = accounts.filter(a => a.id !== id); return n !== accounts.length },
    validate: async () => { calls.validate++; throw Error('remote validation forbidden') },
  }
  AccountManager.updateEditable = AccountManager.update
  const ProviderManager = {
    getAll: () => clone(providers), getById: id => clone(providers.find(p => p.id === id)),
    create: data => { calls.providerCreate++; const out = { ...clone(data), id: 'created-p', enabled: true, createdAt: 2 }; providers.push(out); return clone(out) },
    update: (id, patch) => { calls.providerUpdate++; if (failProviderUpdate) throw Error('synthetic provider persistence refusal'); const i = providers.findIndex(p => p.id === id); if (i < 0) return null; providers[i] = { ...providers[i], ...clone(patch) }; return clone(providers[i]) },
    delete: id => { const n = providers.length; providers = providers.filter(p => p.id !== id); return n !== providers.length },
  }
  class ProviderEndpointTrustError extends Error { constructor(code, message) { super(message); this.code = code } }
  const auth = load('middleware/managementAuth.ts', { '../../store/store': { storeManager } }).managementAuthMiddleware
  const accountsRouter = load('routes/management/accounts.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  const providersRouter = load('routes/management/providers.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/providers': { __esModule: true, default: ProviderManager },
    '../../../providers/endpointTrust': { ProviderEndpointTrustError },
  }).default
  const Koa = requireNode('koa'); const app = new Koa(); app.use(requireNode('koa-bodyparser')())
  app.use(accountsRouter.routes()); app.use(accountsRouter.allowedMethods())
  app.use(providersRouter.routes()); app.use(providersRouter.allowedMethods())
  const server = createServer(app.callback()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` }; if (authorized) headers.Authorization = `Bearer ${SECRET}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let json
        try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
        resolve({ status: res.statusCode, raw, json })
      })
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  return { request, calls, state: () => ({ providers: clone(providers), accounts: clone(accounts) }),
    close: () => new Promise(resolve => server.close(resolve)) }
}

test('account/provider GET responses stay authenticated and account credentials are masked', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.request('/v0/management/accounts', { authorized: false })).status, 401)
  const account = await f.request('/v0/management/accounts/a1')
  assert.equal(account.status, 200); assert.equal(account.raw.includes(PRIVATE), false); assert.equal(account.json.data.credentials.token, '***')
  assert.equal((await f.request('/v0/management/providers/p1')).status, 200)
  assert.equal(f.calls.validate, 0)
})

for (const [label, path, method, body, counter, routeJson] of [
  ['account create null body', '/v0/management/accounts', 'POST', null, 'accountCreate', false],
  ['account create array credentials', '/v0/management/accounts', 'POST', { providerId: 'p1', name: 'Bad', credentials: [] }, 'accountCreate'],
  ['account create numeric identity fields', '/v0/management/accounts', 'POST', { providerId: 7, name: 9, credentials: { token: 'x' } }, 'accountCreate'],
  ['account update null body', '/v0/management/accounts/a1', 'PUT', null, 'accountUpdate', false],
  ['account update array credentials', '/v0/management/accounts/a1', 'PUT', { credentials: [] }, 'accountUpdate'],
  ['provider status null body', '/v0/management/providers/p1/status', 'PATCH', null, 'providerUpdate', false],
  ['provider update nonboolean enabled', '/v0/management/providers/p1', 'PUT', { enabled: 'false' }, 'providerUpdate'],
]) {
  test(label + ' is invalid_request before persistence', async t => {
    const f = await fixture(); t.after(f.close); const before = f.state()
    const response = await f.request(path, { method, body })
    assert.equal(response.status, 400)
    if (routeJson !== false) assert.equal(response.json.error.code, 'invalid_request')
    assert.equal(f.calls[counter], 0); assert.deepEqual(f.state(), before)
  })
}

test('persistence refusal returns failure without exposing account credentials or changing synthetic durable state', async t => {
  const f = await fixture({ failAccountUpdate: true }); t.after(f.close); const before = f.state()
  const response = await f.request('/v0/management/accounts/a1', { method: 'PUT', body: { name: 'Changed' } })
  assert.equal(response.status, 500); assert.equal(response.raw.includes(PRIVATE), false)
  assert.deepEqual(f.state(), before); assert.equal(f.calls.accountUpdate, 1)
})
