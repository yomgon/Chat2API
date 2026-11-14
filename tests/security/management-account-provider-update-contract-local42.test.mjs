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
  runInNewContext(code, { module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    require(name) { if (Object.hasOwn(deps, name)) return deps[name]; return requireNode(name) },
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
  }, { filename: relative, timeout: 2000 })
  return module.exports
}

const SECRET = 'SYNTHETIC_LOCAL42_MANAGEMENT'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

async function fixture() {
  let account = { id: 'a1', providerId: 'p1', name: 'Account', email: 'a@example.invalid',
    credentials: { token: 'PRIVATE_LOCAL42' }, status: 'active', createdAt: 1, requestCount: 0, dailyLimit: 10 }
  let provider = { id: 'p1', name: 'Provider', type: 'custom', authType: 'none',
    apiEndpoint: 'https://fixture.invalid', enabled: true, createdAt: 1,
    headers: { 'X-Fixture': 'ok' }, modelMappings: { Display: 'wire' }, supportedModels: ['wire'] }
  const calls = { accountUpdate: 0, providerUpdate: 0 }
  const storeManager = { getConfig: () => ({ managementApi: { enableManagementApi: true, managementApiSecret: SECRET } }) }
  const AccountManager = {
    getAll: () => [clone(account)], getByProviderId: () => [clone(account)], getById: id => id === 'a1' ? clone(account) : undefined,
    update: (_id, patch) => { calls.accountUpdate++; account = { ...account, ...clone(patch) }; return clone(account) },
    create() { throw Error('not used') }, delete() { return false }, validate() { throw Error('remote validation forbidden') },
  }
  AccountManager.updateEditable = AccountManager.update
  const ProviderManager = {
    getAll: () => [clone(provider)], getById: id => id === 'p1' ? clone(provider) : undefined,
    update: (_id, patch) => { calls.providerUpdate++; provider = { ...provider, ...clone(patch) }; return clone(provider) },
    create() { throw Error('not used') }, delete() { return false },
  }
  class ProviderEndpointTrustError extends Error { constructor(code, message) { super(message); this.code = code } }
  const auth = load('middleware/managementAuth.ts', { '../../store/store': { storeManager } }).managementAuthMiddleware
  const accounts = load('routes/management/accounts.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  const providers = load('routes/management/providers.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/providers': { __esModule: true, default: ProviderManager },
    '../../../providers/endpointTrust': { ProviderEndpointTrustError },
  }).default
  const Koa = requireNode('koa'); const app = new Koa(); app.use(requireNode('koa-bodyparser')())
  app.use(accounts.routes()); app.use(accounts.allowedMethods()); app.use(providers.routes()); app.use(providers.allowedMethods())
  const server = createServer(app.callback()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const request = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'PUT', path,
      headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : undefined })
      })
    }); req.on('error', reject); req.end(payload)
  })
  return { request, calls, state: () => ({ account: clone(account), provider: clone(provider) }),
    close: () => new Promise(resolve => server.close(resolve)) }
}

for (const [label, body] of [
  ['blank name', { name: '   ' }],
  ['numeric name', { name: 42 }],
  ['object email', { email: { value: 'x' } }],
  ['negative dailyLimit', { dailyLimit: -1 }],
  ['fractional dailyLimit', { dailyLimit: 1.5 }],
  ['string dailyLimit', { dailyLimit: '10' }],
]) test('account PUT rejects ' + label + ' before manager mutation', async t => {
  const f = await fixture(); t.after(f.close); const before = f.state()
  const res = await f.request('/v0/management/accounts/a1', body)
  assert.equal(res.status, 400); assert.equal(res.json.error.code, 'invalid_request')
  assert.equal(f.calls.accountUpdate, 0); assert.deepEqual(f.state(), before)
})

for (const [label, body] of [
  ['array headers', { headers: [] }],
  ['non-string header value', { headers: { Authorization: { token: 'x' } } }],
  ['array modelMappings', { modelMappings: [] }],
  ['non-string model mapping value', { modelMappings: { Display: 42 } }],
  ['array supportedModels', { supportedModels: ['wire', 42] }],
  ['numeric apiEndpoint', { apiEndpoint: 42 }],
  ['blank name', { name: '   ' }],
]) test('provider PUT rejects ' + label + ' before manager mutation', async t => {
  const f = await fixture(); t.after(f.close); const before = f.state()
  const res = await f.request('/v0/management/providers/p1', body)
  assert.equal(res.status, 400); assert.equal(res.json.error.code, 'invalid_request')
  assert.equal(f.calls.providerUpdate, 0); assert.deepEqual(f.state(), before)
})

test('valid account/provider updates still persist and return 200', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.request('/v0/management/accounts/a1', { name: 'Renamed', email: 'b@example.invalid', dailyLimit: 20 })).status, 200)
  assert.equal((await f.request('/v0/management/providers/p1', { headers: { 'X-New': 'yes' }, modelMappings: { Alias: 'wire2' }, supportedModels: ['wire2'] })).status, 200)
  assert.equal(f.calls.accountUpdate, 1); assert.equal(f.calls.providerUpdate, 1)
})
