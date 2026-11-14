import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const compile = path => ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
  fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
function load(path, deps) {
  const module = { exports: {} }
  runInNewContext(compile(path), { module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    crypto: globalThis.crypto, console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(name) { if (Object.hasOwn(deps, name)) return deps[name]; return requireNode(name) },
  }, { filename: path, timeout: 2000 })
  return module.exports
}

const SECRET = 'mgmt_11111111-1111-4111-8111-111111111111'
const OLD_KEY = 'sk-mgmt-11111111111111111111111111111111'
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture({ failWrites = false } = {}) {
  let config = {
    managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    enableApiKey: true,
    apiKeys: [{ id: 'k1', name: 'Primary', key: OLD_KEY, enabled: true, createdAt: 1, usageCount: 9 }],
    proxyPort: 8080, logRetentionDays: 30, requestTimeout: 30000, retryCount: 0,
    loadBalanceStrategy: 'round-robin', toolCallingConfig: { clientAdapterId: 'standard-openai-tools' },
    accountDataSentinel: 'PRESERVE_SYNTHETIC_ACCOUNT_DATA',
  }
  const writes = [], logs = []
  const storeManager = {
    getConfig: () => clone(config),
    updateConfig: updates => {
      writes.push(clone(updates))
      if (failWrites) throw Error('synthetic write refusal')
      config = { ...config, ...clone(updates) }
      return clone(config)
    },
    addLog: (...args) => logs.push(args),
  }
  const DEFAULT_CONFIG = clone(config)
  const ConfigManager = load('src/main/store/config.ts', {
    './store': { storeManager }, './configSecrets': { redactExportConfigSecrets: x => x },
    './types': { DEFAULT_CONFIG }, '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).default
  const auth = load('src/main/proxy/middleware/managementAuth.ts', { '../../store/store': { storeManager } }).managementAuthMiddleware
  const shared = { '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth } }
  const keyRouter = load('src/main/proxy/routes/management/apiKeys.ts', {
    ...shared, '../../../store/store': { storeManager },
  }).default
  const configRouter = load('src/main/proxy/routes/management/config.ts', {
    ...shared, '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const Koa = requireNode('koa'); const app = new Koa(); app.use(requireNode('koa-bodyparser')())
  app.use(keyRouter.routes()); app.use(keyRouter.allowedMethods()); app.use(configRouter.routes()); app.use(configRouter.allowedMethods())
  const server = createServer(app.callback()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${SECRET}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  return { request, writes, logs, state: () => clone(config), close: () => new Promise(resolve => server.close(resolve)) }
}

test('failed key regenerate write does not reveal a replacement or mutate persisted key', async t => {
  const f = await fixture({ failWrites: true }); t.after(f.close); const before = f.state()
  const res = await f.request('/v0/management/api-keys/k1/regenerate', { method: 'POST', body: {} })
  assert.equal(res.status, 500); assert.deepEqual(f.state(), before); assert.equal(f.logs.length, 0)
  assert.equal(res.raw.includes('sk-mgmt-'), false)
})

test('stale general config write cannot roll back a freshly regenerated API key', async t => {
  const f = await fixture(); t.after(f.close)
  const stale = f.state()
  const regenerated = await f.request('/v0/management/api-keys/k1/regenerate', { method: 'POST', body: {} })
  assert.equal(regenerated.status, 200)
  const freshKey = regenerated.json.data.key
  assert.notEqual(freshKey, OLD_KEY)
  const staleUpdate = { ...stale, retryCount: 1 }
  const res = await f.request('/v0/management/config', { method: 'PUT', body: staleUpdate })
  assert.equal(res.status, 400)
  assert.equal(f.state().apiKeys[0].key, freshKey)
  assert.equal(f.state().retryCount, 0)
  assert.equal(f.state().accountDataSentinel, 'PRESERVE_SYNTHETIC_ACCOUNT_DATA')
})

test('general config routes reject direct API-key and management-secret replacement', async t => {
  const f = await fixture(); t.after(f.close); const before = f.state()
  for (const [path, body] of [
    ['/v0/management/config', { apiKeys: [{ ...before.apiKeys[0], key: 'sk-mgmt-22222222222222222222222222222222' }] }],
    ['/v0/management/config/apiKeys', { value: [] }],
    ['/v0/management/config', { managementApi: { ...before.managementApi, managementApiSecret: 'mgmt_22222222-2222-4222-8222-222222222222' } }],
  ]) {
    const res = await f.request(path, { method: 'PUT', body })
    assert.equal(res.status, 400, path)
  }
  assert.deepEqual(f.state(), before)
})

test('authorized create still reveals full key once while list/config reads remain masked', async t => {
  const f = await fixture(); t.after(f.close)
  const created = await f.request('/v0/management/api-keys', { method: 'POST', body: { name: 'Second' } })
  assert.equal(created.status, 201); assert.match(created.json.data.key, /^sk-mgmt-[0-9a-f]{32}$/)
  const list = await f.request('/v0/management/api-keys'); assert.equal(list.status, 200)
  assert.equal(list.raw.includes(created.json.data.key), false)
  const config = await f.request('/v0/management/config'); assert.equal(config.status, 200)
  assert.equal(config.raw.includes(created.json.data.key), false); assert.equal(config.raw.includes(SECRET), false)
})
