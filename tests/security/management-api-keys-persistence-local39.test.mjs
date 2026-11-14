import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real managementAuth + real API-key router over a local Koa callback.
// Persistence is synthetic and getConfig returns a fresh key snapshot, matching
// StoreManager.decodeConfigSecrets() copy semantics. No Electron/profile/network.
const requireNode = createRequire(import.meta.url)
const source = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
function load(relative, dependencies) {
  const module = { exports: {} }
  const code = ts.transpileModule(source(relative), {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      return requireNode(name)
    },
    Buffer, Date, Math, JSON, Error, crypto: globalThis.crypto,
    console: { log() {}, warn() {}, error() {} },
  }, { filename: relative, timeout: 2000 })
  return module.exports
}

const MANAGEMENT_SECRET = 'SYNTHETIC_MANAGEMENT_SECRET_LOCAL39'
const ORIGINAL_KEY = Object.freeze({
  id: 'existing-key', name: 'Existing', key: 'sk-mgmt-0123456789abcdef0123456789abcdef',
  enabled: true, createdAt: 1, usageCount: 7, description: 'before',
})
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture({ failWrites = false } = {}) {
  let persisted = {
    managementApi: { enableManagementApi: true, managementApiSecret: MANAGEMENT_SECRET },
    apiKeys: [clone(ORIGINAL_KEY)],
  }
  const writes = []
  const logs = []
  const storeManager = {
    // Mirrors the real StoreManager: each read returns copied API-key data.
    getConfig: () => clone(persisted),
    updateConfig: patch => {
      writes.push(clone(patch))
      if (failWrites) throw new Error('SYNTHETIC_PERSISTENCE_FAILURE_LOCAL39')
      persisted = { ...persisted, ...clone(patch) }
      return clone(persisted)
    },
    addLog: (...args) => logs.push(args),
  }
  const auth = load('middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const router = load('routes/management/apiKeys.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/store': { storeManager },
  }).default
  const Koa = requireNode('koa')
  const bodyParser = requireNode('koa-bodyparser')
  const app = new Koa()
  app.use(bodyParser())
  app.use(router.routes())
  app.use(router.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` }
    if (authorized) headers.Authorization = `Bearer ${MANAGEMENT_SECRET}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode, json: raw ? JSON.parse(raw) : undefined })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
  return {
    request, writes, logs,
    persisted: () => clone(persisted),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('real management auth guards API-key mutation routes before validation or persistence', async t => {
  const h = await fixture()
  t.after(h.close)
  const result = await h.request('/v0/management/api-keys', {
    method: 'POST', authorized: false, body: { name: 'Denied', description: 42 },
  })
  assert.equal(result.status, 401)
  assert.equal(result.json.error.code, 'missing_authentication')
  assert.equal(h.writes.length, 0)
  assert.deepEqual(h.persisted().apiKeys, [clone(ORIGINAL_KEY)])
})

for (const [label, method, path, body] of [
  ['create', 'POST', '/v0/management/api-keys', { name: 'New key', description: 42 }],
  ['update', 'PUT', '/v0/management/api-keys/existing-key', { name: 'Renamed', description: { bad: true }, enabled: false }],
]) {
  test(label + ' rejects a non-string description as invalid_request without a persistence write', async t => {
    const h = await fixture()
    t.after(h.close)
    const result = await h.request(path, { method, body })
    assert.equal(result.status, 400)
    assert.equal(result.json.success, false)
    assert.equal(result.json.error.code, 'invalid_request')
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.persisted().apiKeys, [clone(ORIGINAL_KEY)])
  })
}

test('failed persistence cannot change durable API-key state under the real StoreManager snapshot contract', async t => {
  const h = await fixture({ failWrites: true })
  t.after(h.close)
  const before = h.persisted()
  const result = await h.request('/v0/management/api-keys/existing-key', {
    method: 'PUT', body: { name: 'Would be new', description: 'valid', enabled: false },
  })
  assert.equal(result.status, 500)
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.persisted(), before,
    'getConfig copies mean a failed updateConfig does not mutate durable state')
  assert.equal(h.logs.length, 0, 'no success log after rejected persistence')
})

test('authorized list keeps stored API-key values masked', async t => {
  const h = await fixture()
  t.after(h.close)
  const result = await h.request('/v0/management/api-keys')
  assert.equal(result.status, 200)
  assert.equal(result.json.data.length, 1)
  assert.notEqual(result.json.data[0].key, ORIGINAL_KEY.key)
  assert.equal(result.json.data[0].key.endsWith(ORIGINAL_KEY.key.slice(-8)), true)
})
