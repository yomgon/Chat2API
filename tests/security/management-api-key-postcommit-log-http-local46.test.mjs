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

test('authorized create remains HTTP 201 with its only visible new key after postcommit app-log failure', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.request('/v0/management/api-keys', {
    method: 'POST', body: { name: 'Synthetic second key' },
  })
  assert.equal(response.status, 201)
  assert.equal(response.json.success, true)
  assert.match(response.json.data.key, /^sk-mgmt-[0-9a-f]{32}$/)
  assert.equal(f.persisted().apiKeys.length, 2)
  assert.equal(f.persisted().apiKeys[1].key, response.json.data.key)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.logAttempts, 1)
  const list = await f.request('/v0/management/api-keys')
  assert.equal(list.status, 200)
  assert.equal(list.raw.includes(response.json.data.key), false)
  assert.equal(response.raw.includes(ERROR_CANARY), false)
})

test('regenerate after successful write but failed app-log returns exactly the persisted new key', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.request('/v0/management/api-keys/pinned-key/regenerate', {
    method: 'POST', body: {},
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.success, true)
  assert.match(response.json.data.key, /^sk-mgmt-[0-9a-f]{32}$/)
  assert.notEqual(response.json.data.key, ORIGINAL.key)
  assert.equal(f.persisted().apiKeys[0].key, response.json.data.key)
  assert.equal(f.persisted().apiKeys[0].usageCount, 0)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.logAttempts, 1)
  assert.equal(response.raw.includes(ERROR_CANARY), false)
})

test('metadata update and deletion return committed result when only app-log fails', async t => {
  const f = await fixture(); t.after(f.close)
  const update = await f.request('/v0/management/api-keys/pinned-key', {
    method: 'PUT', body: { name: 'Synthetic renamed key', enabled: false },
  })
  assert.equal(update.status, 200)
  assert.equal(update.json.success, true)
  assert.equal(update.json.data.name, 'Synthetic renamed key')
  assert.equal(update.json.data.enabled, false)
  assert.notEqual(update.json.data.key, ORIGINAL.key)
  assert.equal(f.persisted().apiKeys[0].name, 'Synthetic renamed key')
  const deletion = await f.request('/v0/management/api-keys/pinned-key', { method: 'DELETE' })
  assert.equal(deletion.status, 200)
  assert.equal(deletion.json.success, true)
  assert.deepEqual(deletion.json.data, { id: 'pinned-key', deleted: true })
  assert.equal(f.persisted().apiKeys.length, 0)
  assert.equal(f.effects.writes, 2)
  assert.equal(f.effects.logAttempts, 2)
  assert.equal((update.raw + deletion.raw).includes(ERROR_CANARY), false)
})

test('actual auth denies unapproved mutation even if the synthetic log backend is broken', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.request('/v0/management/api-keys', {
    method: 'POST', body: { name: 'Must not exist' }, authorized: false,
  })
  assert.equal(response.status, 401)
  assert.equal(f.effects.writes, 0)
  assert.equal(f.effects.logAttempts, 0)
  assert.deepEqual(f.persisted().apiKeys, [clone(ORIGINAL)])
})

test('real persistence refusal remains HTTP 500 with prior key untouched, unlike postcommit logging failure', async t => {
  const f = await fixture({ rejectWrite: true }); t.after(f.close)
  const response = await f.request('/v0/management/api-keys/pinned-key/regenerate', {
    method: 'POST', body: {},
  })
  assert.equal(response.status, 500)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.logAttempts, 0)
  assert.deepEqual(f.persisted().apiKeys, [clone(ORIGINAL)])
})
