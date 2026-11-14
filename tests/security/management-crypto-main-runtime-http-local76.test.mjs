import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Independent RED for the actual local.75 packaged Electron main failure:
// authorized POST /v0/management/api-keys returned HTTP 500 despite the GUI
// having successfully enabled management auth. Previous synthetic harnesses
// injected a global WebCrypto object that Electron main must not rely on.
// Here the real route must run with NO ambient global crypto at all, as a
// legitimate Node/Electron CommonJS main execution context permits.
// Loopback-only Koa/ProxyServer/bodyParser/management auth/API-key auth,
// in-memory store, zero app/profile/provider access.
const requireNode = createRequire(import.meta.url)
const read = relative => readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8')
function product(relative, mocks = {}) {
  const module = { exports: {} }
  const source = ts.transpileModule(read(relative), {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true },
  }).outputText
  runInNewContext(source, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    // Intentionally NO global crypto / WebCrypto in this VM.
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('.')) throw Error('Unexpected runtime dependency ' + relative + ':' + id)
      return requireNode(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}
const clone = value => JSON.parse(JSON.stringify(value))
const SECRET = 'SYNTHETIC_LOCAL76_MANAGEMENT_OWNER'
const PRIVATE = 'SYNTHETIC_LOCAL76_LOGGER_PRIVATE_ERROR'

async function fixture({ failWrites = false, failLogs = false } = {}) {
  let config = {
    managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    enableApiKey: true, apiKeys: [], modelMappings: {},
    loadBalanceStrategy: 'round-robin',
  }
  const effects = { writes: 0, logs: 0 }
  const storeManager = {
    getConfig: () => clone(config),
    updateConfig(patch) {
      effects.writes++
      if (failWrites) throw Error(PRIVATE)
      config = { ...config, ...clone(patch) }
      return clone(config)
    },
    getProviders: () => [],
    addLog() {
      effects.logs++
      if (failLogs) throw Error(PRIVATE)
    },
  }
  const storeDep = { storeManager }
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': storeDep,
  }).managementAuthMiddleware
  const keyRoutes = product('proxy/routes/management/apiKeys.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/store': storeDep,
  }).default
  const models = product('proxy/routes/models.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../store/store': storeDep,
    '../modelMapper': { modelMapper: { getMatchingMapping: () => undefined } },
    '../loadbalancer': { loadBalancer: { hasSelectableAccount: () => false } },
  }).default
  const status = {
    getRunningStatus: () => ({ isRunning: true, uptime: 1 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const proxy = product('proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'isolated-local76' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models], './routes/management': [keyRoutes],
    './status': { proxyStatusManager: status },
    '../store/store': storeDep, './localSecurity': product('proxy/localSecurity.ts'),
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const request = (method, path, { body, bearer = SECRET } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (bearer) headers.Authorization = 'Bearer ' + bearer
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', part => chunks.push(part))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(4000, () => req.destroy(Error('Loopback HTTP timeout')))
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

test('actual authenticated Koa key creation cannot depend on ambient global crypto in Electron main', async t => {
  const f = await fixture()
  t.after(f.close)
  const unauthorized = await f.request('POST', '/v0/management/api-keys', {
    bearer: '', body: { name: 'Denied' },
  })
  assert.equal(unauthorized.status, 401)
  assert.equal(f.effects.writes, 0)
  const created = await f.request('POST', '/v0/management/api-keys', {
    body: { name: 'Local76 key' },
  })
  assert.equal(created.status, 201, 'real Electron main returned HTTP500 for valid create')
  assert.match(created.json?.data?.key, /^sk-mgmt-[a-f0-9]{32}$/)
  assert.equal(f.state().apiKeys.length, 1)
  assert.equal(f.effects.writes, 1)
  assert.equal((await f.request('GET', '/v1/models', {
    bearer: created.json.data.key,
  })).status, 200)
})

test('actual main generation and regeneration preserve exact once-only credential rotation and auth', async t => {
  const f = await fixture()
  t.after(f.close)
  const added = await f.request('POST', '/v0/management/api-keys', { body: { name: 'Initial' } })
  assert.equal(added.status, 201)
  const first = added.json.data.key
  const id = added.json.data.id
  const renewed = await f.request('POST', '/v0/management/api-keys/' + id + '/regenerate', { body: {} })
  assert.equal(renewed.status, 200, 'regeneration must never report false 500')
  const second = renewed.json.data.key
  assert.match(second, /^sk-mgmt-[a-f0-9]{32}$/)
  assert.notEqual(first, second)
  assert.equal(f.state().apiKeys.length, 1)
  assert.equal(f.state().apiKeys[0].key, second)
  assert.equal((await f.request('GET', '/v1/models', { bearer: first })).status, 401)
  assert.equal((await f.request('GET', '/v1/models', { bearer: second })).status, 200)
  const listed = await f.request('GET', '/v0/management/api-keys')
  assert.equal(listed.status, 200)
  assert.equal(listed.raw.includes(second), false)
})

test('independent logger failure postcommit does not defeat main crypto generation or disclose secret', async t => {
  const f = await fixture({ failLogs: true })
  t.after(f.close)
  const created = await f.request('POST', '/v0/management/api-keys', {
    body: { name: 'Safe even without diagnostics' },
  })
  assert.equal(created.status, 201)
  assert.equal(f.state().apiKeys.length, 1)
  assert.equal(created.json.data.key, f.state().apiKeys[0].key)
  assert.equal(created.raw.includes(PRIVATE), false)
})

test('durable refusal remains a sanitized HTTP failure without storing a generated key', async t => {
  const f = await fixture({ failWrites: true })
  t.after(f.close)
  const created = await f.request('POST', '/v0/management/api-keys', {
    body: { name: 'Cannot commit' },
  })
  assert.equal(created.status, 500)
  assert.equal(f.state().apiKeys.length, 0)
  assert.equal(created.raw.includes(PRIVATE), false)
  assert.equal(created.raw.includes('sk-mgmt-'), false)
})
