import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Product ConfigManager, management auth, config/mapping routes, full Koa
// middleware and body parser. The store is an isolated in-memory snapshot;
// no operating profile, real account, credential or external provider exists.
const nodeRequire = createRequire(import.meta.url)
const MANAGEMENT_SECRET = 'SYNTHETIC_LOCAL48_MANAGEMENT_SECRET'
const ERROR_CANARY = 'SYNTHETIC_LOCAL48_POSTCOMMIT_LOG_PRIVATE'
const clone = value => JSON.parse(JSON.stringify(value))
function product(relative, deps) {
  const mod = { exports: {} }
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } },
  ).outputText
  runInNewContext(js, {
    module: mod, exports: mod.exports, Buffer, Date, Math, JSON, Error, TextDecoder,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unknown product dependency ' + relative + ':' + id)
      return nodeRequire(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function fixture({ failWrites = false } = {}) {
  let config = {
    managementApi: { enableManagementApi: true, managementApiSecret: MANAGEMENT_SECRET },
    enableApiKey: true, apiKeys: [],
    proxyPort: 8080, requestTimeout: 30000, retryCount: 0, logRetentionDays: 30,
    loadBalanceStrategy: 'round-robin',
    modelMappings: {
      stable: {
        requestModel: 'stable', actualModel: 'wire-stable',
        preferredProviderId: 'p1', preferredAccountId: 'a1',
      },
      preserve: {
        requestModel: 'preserve', actualModel: 'wire-preserve',
        preferredProviderId: 'p2', preferredAccountId: 'a2',
      },
    },
  }
  const original = clone(config)
  const effects = { writes: 0, logAttempts: 0 }
  const storeManager = {
    getConfig: () => clone(config),
    updateConfig: updates => {
      effects.writes++
      if (failWrites) throw Error('SYNTHETIC_LOCAL48_DURABLE_WRITE_REFUSAL')
      config = { ...config, ...clone(updates) }
      return clone(config)
    },
    addLog: (level) => {
      // Only the management mutation's optional success diagnostic fails.
      // Server-wide error reporting is an independent observer and must not
      // obscure the actual Koa HTTP status under test.
      if (level !== 'info') return
      effects.logAttempts++
      throw Error(ERROR_CANARY)
    },
  }
  const ConfigManager = product('store/config.ts', {
    './store': { storeManager },
    './configSecrets': { redactExportConfigSecrets: x => x },
    './types': { DEFAULT_CONFIG: original },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).default
  const managementAuthMiddleware = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const deps = {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware },
    '../../../store/config': { __esModule: true, default: ConfigManager },
  }
  const configRouter = product('proxy/routes/management/config.ts', deps).default
  const mappingsRouter = product('proxy/routes/management/modelMappings.ts', deps).default
  const proxyStatusManager = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getHost: () => '127.0.0.1', getPort: () => 8080,
  }
  const proxy = product('proxy/server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'local48-fixture' } },
    '@koa/router': nodeRequire('@koa/router'), 'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [], './routes/management': [configRouter, mappingsRouter],
    '../store/store': { storeManager }, './status': { proxyStatusManager },
    './localSecurity': product('proxy/localSecurity.ts', {}),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + MANAGEMENT_SECRET
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const pieces = []
      res.on('data', piece => pieces.push(piece))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(pieces).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic local HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    request, effects, state: () => clone(config),
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('committed management config PUT remains HTTP 200 when postcommit diagnostic log throws', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.request('/v0/management/config', {
    method: 'PUT', body: { requestTimeout: 45000 },
  })
  assert.equal(f.state().requestTimeout, 45000)
  assert.equal(f.effects.writes, 1)
  assert.equal(f.effects.logAttempts, 1)
  assert.equal(response.raw.includes(ERROR_CANARY), false)
  assert.equal(response.status, 200)
  assert.equal(response.json.success, true)
  assert.equal(response.json.data.requestTimeout, 45000)
  assert.equal(response.raw.includes(MANAGEMENT_SECRET), false)
})

test('committed individual management config key PUT reflects the actual persisted value', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.request('/v0/management/config/retryCount', {
    method: 'PUT', body: { value: 2 },
  })
  assert.equal(f.state().retryCount, 2)
  assert.equal(f.effects.writes, 1)
  assert.equal(response.status, 200)
  assert.equal(response.json.data, 2)
})

test('model mapping POST, PUT and DELETE return persisted results after nonfatal config/mapping logs', async t => {
  const f = await fixture(); t.after(f.close)
  const create = await f.request('/v0/management/model-mappings', {
    method: 'POST', body: { requestModel: 'added', actualModel: 'wire-added', preferredProviderId: 'p3', preferredAccountId: 'a3' },
  })
  assert.equal(f.state().modelMappings.added.actualModel, 'wire-added')
  assert.equal(create.status, 201)
  assert.equal(create.json.success, true)
  const update = await f.request('/v0/management/model-mappings/stable', {
    method: 'PUT', body: { actualModel: 'wire-updated' },
  })
  assert.equal(f.state().modelMappings.stable.actualModel, 'wire-updated')
  assert.equal(f.state().modelMappings.stable.preferredAccountId, 'a1')
  assert.equal(update.status, 200)
  assert.equal(update.json.data.actualModel, 'wire-updated')
  const deleted = await f.request('/v0/management/model-mappings/stable', { method: 'DELETE' })
  assert.equal(Object.hasOwn(f.state().modelMappings, 'stable'), false)
  assert.equal(f.state().modelMappings.preserve.actualModel, 'wire-preserve')
  assert.equal(f.state().modelMappings.added.preferredAccountId, 'a3')
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.data.deleted, true)
  assert.equal(f.effects.writes, 3)
  assert.ok(f.effects.logAttempts >= 3)
  assert.equal((create.raw + update.raw + deleted.raw).includes(ERROR_CANARY), false)
})

test('missing management authorization never writes or invokes optional diagnostic log', async t => {
  const f = await fixture(); t.after(f.close)
  const before = f.state()
  const rejected = await f.request('/v0/management/config', {
    method: 'PUT', body: { retryCount: 2 }, authorized: false,
  })
  assert.equal(rejected.status, 401)
  assert.equal(f.effects.writes, 0)
  assert.equal(f.effects.logAttempts, 0)
  assert.deepEqual(f.state(), before)
})

test('failed durable persistence remains fail-closed with no configuration or mapping mutation', async t => {
  const f = await fixture({ failWrites: true }); t.after(f.close)
  const before = f.state()
  const set = await f.request('/v0/management/config/retryCount', {
    method: 'PUT', body: { value: 1 },
  })
  assert.equal(set.status, 500)
  assert.deepEqual(f.state(), before)
  const mapping = await f.request('/v0/management/model-mappings', {
    method: 'POST', body: { requestModel: 'new', actualModel: 'wire-new' },
  })
  assert.equal(mapping.status, 500)
  assert.deepEqual(f.state(), before)
  assert.equal(f.effects.writes, 2)
  assert.equal(f.effects.logAttempts, 0)
  assert.equal((set.raw + mapping.raw).includes(ERROR_CANARY), false)
})
