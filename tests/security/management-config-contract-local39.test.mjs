import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual Store ConfigManager + management config route + auth + Koa server.
// Backing store is entirely synthetic. No operating Electron profile/keys,
// upstream effects, real config files, or public listener.
const requireNode = createRequire(import.meta.url)
function compile(path) {
  const original = readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
  return ts.transpileModule(original, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  }).outputText
}
function load(path, dependencies) {
  const mod = { exports: {} }
  runInNewContext(compile(path), {
    module: mod, exports: mod.exports, Buffer, TextDecoder, Date, JSON, Math, Error,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('.')) throw Error('Unexpected import ' + path + ': ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function fixture() {
  const effects = { updates: [], authErrors: 0 }
  let config = {
    managementApi: { enableManagementApi: true, managementApiSecret: 'synthetic-secret' },
    enableApiKey: true, apiKeys: [],
    proxyPort: 8080, logRetentionDays: 30, requestTimeout: 30000,
    retryCount: 0, loadBalanceStrategy: 'round-robin',
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: changes => {
      effects.updates.push(changes)
      config = { ...config, ...changes }
      return config
    },
    addLog() {},
  }
  const ConfigManager = load('src/main/store/config.ts', {
    './store': { storeManager },
    './configSecrets': { redactExportConfigSecrets: x => x },
    './types': { DEFAULT_CONFIG: config },
    '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).default
  const middleware = load('src/main/proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const configRouter = load('src/main/proxy/routes/management/config.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: middleware },
    '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const localSecurity = load('src/main/proxy/localSecurity.ts', {})
  const status = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const server = load('src/main/proxy/server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'synthetic' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [], './routes/management': [configRouter],
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager }, './localSecurity': localSecurity,
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port
  async function request(path, { method = 'GET', body, rawBody, authorized = true } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Host: '127.0.0.1:' + port }
      if (authorized) headers.Authorization = 'Bearer synthetic-secret'
      if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json'
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, json, raw })
        })
      })
      req.on('error', reject)
      req.setTimeout(2500, () => req.destroy(Error('Local fixture timeout')))
      req.end(rawBody ?? (body === undefined ? undefined : JSON.stringify(body)))
    })
  }
  return {
    request, effects,
    state: () => ({ ...config }),
    close: async () => {
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(err => err ? reject(err) : resolve()))
    },
  }
}

test('real management HTTP rejects invalid numeric configuration before any durable update', async t => {
  const f = await fixture(); t.after(f.close)
  const badUpdates = [
    { proxyPort: '8080' },
    { proxyPort: 70000 },
    { proxyPort: 7.5 },
    { retryCount: 'zero' },
    { retryCount: -1 },
    { requestTimeout: 'many' },
    { logRetentionDays: 'month' },
  ]
  for (const body of badUpdates) {
    const res = await f.request('/v0/management/config', { method: 'PUT', body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(res.json?.error?.code, 'validation_error')
  }
  assert.equal(f.effects.updates.length, 0)
  assert.equal(f.state().proxyPort, 8080)
})

test('real management HTTP rejects config arrays, unknown inherited keys, null keyed bodies', async t => {
  const f = await fixture(); t.after(f.close)
  const array = await f.request('/v0/management/config', { method: 'PUT', body: [{ retryCount: 3 }] })
  assert.equal(array.status, 400)
  assert.equal(array.json?.error?.code, 'invalid_request')
  const inherited = await f.request('/v0/management/config/constructor', {
    method: 'PUT', body: { value: 'constructor-injection' },
  })
  assert.equal(inherited.status, 404)
  assert.equal(inherited.json?.error?.code, 'config_key_not_found')
  const nullBody = await f.request('/v0/management/config/proxyPort', {
    method: 'PUT', rawBody: 'null',
  })
  // koa-bodyparser may reject JSON null at its own boundary before the
  // route. Both paths must be 400 with no persistent write; never force an
  // application error envelope when parsing already refused the input.
  assert.equal(nullBody.status, 400)
  if (nullBody.json?.error) assert.equal(nullBody.json.error.code, 'invalid_request')
  assert.equal(f.effects.updates.length, 0)
})

test('real management HTTP permits valid numeric config update while preserving auth and masking', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.request('/v0/management/config', { authorized: false })).status, 401)
  const good = await f.request('/v0/management/config/retryCount', {
    method: 'PUT', body: { value: 0 },
  })
  assert.equal(good.status, 200)
  assert.equal(good.json?.data, 0)
  assert.equal(f.effects.updates.length, 1)
  assert.equal(f.state().retryCount, 0)
  const read = await f.request('/v0/management/config')
  assert.equal(read.status, 200)
  assert.equal(read.json?.data?.managementApi?.managementApiSecret, '***')
})
