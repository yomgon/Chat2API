import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real Koa + koa-bodyparser + managementAuthMiddleware + production key router.
// Only the store is synthetic and the socket is temporary 127.0.0.1:0.
// In particular, no operating userData, credentials or remote provider exist.
const nodeRequire = createRequire(import.meta.url)
const read = name => readFileSync(new URL('../../src/main/proxy/' + name, import.meta.url), 'utf8')
function load(name, mocks) {
  const module = { exports: {} }
  const code = ts.transpileModule(read(name), {
    fileName: name, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    crypto: globalThis.crypto, console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
    require(specifier) {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier]
      if (specifier.startsWith('.')) throw Error('Undeclared local module ' + name + ':' + specifier)
      return nodeRequire(specifier)
    },
  }, { filename: name, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const SECRET = 'SYNTHETIC_LOCAL46_MANAGEMENT_SECRET'
const ORIGINAL = Object.freeze({
  id: 'pinned-key', name: 'Initial key', key: 'sk-mgmt-synthetic-original-only',
  enabled: true, createdAt: 1, usageCount: 12, description: 'before',
})
const ERROR_CANARY = 'LOCAL46_SYNTHETIC_LOG_STORAGE_THROW_SECRET_CANARY'
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture({ rejectWrite = false } = {}) {
  let persisted = {
    managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    apiKeys: [clone(ORIGINAL)],
  }
  const effects = { writes: 0, logAttempts: 0 }
  const storeManager = {
    getConfig: () => clone(persisted),
    updateConfig: updates => {
      effects.writes++
      if (rejectWrite) throw Error('LOCAL46_SYNTHETIC_PERSISTENCE_REFUSAL')
      persisted = { ...persisted, ...clone(updates) }
      return clone(persisted)
    },
    addLog: () => { effects.logAttempts++; throw Error(ERROR_CANARY) },
  }
  const auth = load('middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const router = load('routes/management/apiKeys.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/store': { storeManager },
  }).default
  const Koa = nodeRequire('koa')
  const app = new Koa()
  app.use(nodeRequire('koa-bodyparser')())
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
    req.setTimeout(3000, () => req.destroy(Error('Synthetic Koa request timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return { effects, request, persisted: () => clone(persisted),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

for (const [label, method, path, body] of [
  ['empty API key create body', 'POST', '/v0/management/api-keys', undefined],
  ['array API key create body', 'POST', '/v0/management/api-keys', []],
  ['empty API key metadata update body', 'PUT', '/v0/management/api-keys/pinned-key', undefined],
  ['empty API key metadata object', 'PUT', '/v0/management/api-keys/pinned-key', {}],
  ['array API key metadata update body', 'PUT', '/v0/management/api-keys/pinned-key', []],
  ['array with unauthorized metadata fields', 'PUT', '/v0/management/api-keys/pinned-key',
    [{ name: 'Misleading field', enabled: false }]],
  ['API key metadata object containing only unknown fields', 'PUT',
    '/v0/management/api-keys/pinned-key', { unexpected: 'inert' }],
]) {
  test('local56 real management HTTP rejects ' + label + ' as 400 without durable key mutation', async t => {
    const f = await fixture()
    t.after(f.close)
    const before = f.persisted()
    const result = await f.request(path, { method, body })
    assert.equal(result.status, 400, JSON.stringify(result.json))
    assert.equal(result.json.success, false)
    assert.equal(result.json.error.code, 'invalid_request')
    assert.equal(f.effects.writes, 0, 'Invalid request must not commit a configuration write')
    assert.deepEqual(f.persisted(), before, 'Previous API key value and metadata must be preserved')
  })
}

test('local56 valid authenticated metadata update still writes once and returns only masked key', async t => {
  const f = await fixture()
  t.after(f.close)
  const result = await f.request('/v0/management/api-keys/pinned-key', {
    method: 'PUT', body: { name: 'Valid renamed key', enabled: false },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(result.json.success, true)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.persisted().apiKeys[0].name, 'Valid renamed key')
  assert.equal(f.persisted().apiKeys[0].enabled, false)
  assert.notEqual(result.json.data.key, ORIGINAL.key)
  assert.equal(JSON.stringify(result.json).includes(ORIGINAL.key), false)
})

test('local56 unauthorized malformed API-key update is 401 before any write', async t => {
  const f = await fixture()
  t.after(f.close)
  const prior = f.persisted()
  const denied = await f.request('/v0/management/api-keys/pinned-key', {
    method: 'PUT', body: [], authorized: false,
  })
  assert.equal(denied.status, 401)
  assert.equal(f.effects.writes, 0)
  assert.deepEqual(f.persisted(), prior)
})

test('local56 durable storage refusal on valid metadata update remains failure with unchanged API key', async t => {
  const f = await fixture({ rejectWrite: true })
  t.after(f.close)
  const prior = f.persisted()
  const rejected = await f.request('/v0/management/api-keys/pinned-key', {
    method: 'PUT', body: { description: 'New metadata' },
  })
  assert.equal(rejected.status, 500)
  assert.equal(f.effects.writes, 1)
  assert.deepEqual(f.persisted(), prior)
})
