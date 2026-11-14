import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual ProxyServer, management route handlers, Koa, bodyparser, authentication
// and final response sanitizer on temporary 127.0.0.1:0. All storage, accounts,
// config and services are closed synthetic stubs; no production profile/effects.
const requireNode = createRequire(import.meta.url)
const root = new URL('../../src/main/', import.meta.url)
const MANAGEMENT_SECRET = 'SYNTHETIC_LOCAL61_MANAGEMENT_SECRET'
const PRIVATE = 'SYNTHETIC_LOCAL61_PRIVATE_TOKEN_COOKIE_IN_ERROR_NEVER_HTTP'
const original = {
  id: 'api-key-one', name: 'Before update', key: 'sk-mgmt-synthetic-private',
  enabled: true, usageCount: 0, createdAt: 1,
}
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function product(name, dependencies) {
  const file = name.startsWith('proxy/') ? name : 'proxy/' + name
  const code = ts.transpileModule(readFileSync(new URL(file + '', root.href), 'utf8'), {
    fileName: file, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, Date, Math, JSON, Error,
    crypto: requireNode('node:crypto').webcrypto,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      if (id.startsWith('.')) throw new Error('Unexpected product module: ' + file + ':' + id)
      return requireNode(id)
    },
  }, { filename: file, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({ fault = null } = {}) {
  const state = {
    writes: 0, remoteEffects: 0, optionalLogs: 0, configReads: 0,
    deleted: 0, updated: 0, record: {
      apiKeys: [clone(original)],
      managementApi: { enableManagementApi: true, managementApiSecret: MANAGEMENT_SECRET },
      modelMappings: {
        pinned: { requestModel: 'pinned', actualModel: 'synthetic-wire',
          preferredProviderId: 'qwen', preferredAccountId: 'qwen-account' },
      },
    },
    provider: { id: 'qwen', name: 'Synthetic Qwen', enabled: true, type: 'builtin' },
    session: { id: 'synthetic-session', providerId: 'qwen', accountId: 'qwen-account',
      status: 'active', sessionType: 'chat', messages: [], createdAt: 1, lastActiveAt: 1 },
  }
  const refused = () => { throw new Error(PRIVATE) }
  const storeManager = {
    getConfig() {
      state.configReads++
      if (fault === 'config-read' && state.configReads > 1) refused()
      return clone(state.record)
    },
    updateConfig(updates) {
      state.writes++
      if ((fault === 'key-write' && Object.hasOwn(updates, 'apiKeys')) ||
          (fault === 'mapping-write' && Object.hasOwn(updates, 'modelMappings')) ||
          fault === 'config-write') refused()
      Object.assign(state.record, clone(updates))
      return clone(state.record)
    },
    addLog() { state.optionalLogs++ },
    getStatistics: fault === 'statistics-read' ? refused : () => ({
      totalRequests: 0, successRequests: 0, failedRequests: 0, totalLatency: 0,
      modelUsage: {}, providerUsage: {}, accountUsage: {},
    }),
    getTodayStatistics: () => ({ date: '2026-11-13', totalRequests: 0,
      successRequests: 0, failedRequests: 0 }),
    getRequestLogs: fault === 'request-logs-read' ? refused : () => [],
    getLogs: fault === 'system-logs-read' ? refused : () => [],
  }
  const ProviderManager = {
    getAll: () => [clone(state.provider)],
    getById: id => id === 'qwen' ? clone(state.provider) : undefined,
    update: (id, update) => {
      state.writes++
      if (fault === 'provider-write') refused()
      Object.assign(state.provider, clone(update)); return clone(state.provider)
    },
    delete: () => {
      state.writes++
      if (fault === 'provider-delete') refused()
      state.deleted++; return true
    },
  }
  const sessionManager = {
    getAllActiveSessions: fault === 'session-read' ? refused : () => [clone(state.session)],
    getSession: id => id === state.session.id ? clone(state.session) : null,
    deleteSession: id => {
      state.writes++
      if (fault === 'session-delete') refused()
      state.deleted++; return true
    },
    clearAllSessions() {
      state.writes++
      if (fault === 'session-clear') refused()
      state.deleted++
    },
  }
  const ConfigManager = {
    get: () => clone(state.record),
    update: changes => storeManager.updateConfig(changes),
    validate: () => ({ valid: true, errors: [] }),
    getModelMappings: () => clone(state.record.modelMappings),
    setModelMapping: mapping => storeManager.updateConfig({
      modelMappings: { ...state.record.modelMappings, [mapping.requestModel]: mapping },
    }),
    removeModelMapping: model => {
      const entries = { ...state.record.modelMappings }
      if (!Object.hasOwn(entries, model)) return false
      delete entries[model]
      storeManager.updateConfig({ modelMappings: entries })
      return true
    },
  }
  const status = {
    getStatistics: () => ({ requestsPerMinute: 0, activeConnections: 0 }),
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getConfig: () => ({ port: 8080, host: '127.0.0.1' }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const auth = product('middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const imports = {
    '@koa/router': requireNode('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager },
    '../../../store/store': { storeManager },
    '../../../store/providers': { __esModule: true, default: ProviderManager },
    '../../../providers/endpointTrust': { ProviderEndpointTrustError: class ProviderEndpointTrustError extends Error {} },
    '../../sessionManager': { __esModule: true, default: sessionManager },
    '../../status': { proxyStatusManager: status },
  }
  const names = ['apiKeys', 'modelMappings', 'providers', 'config', 'sessions', 'statistics']
  const routers = names.map(name => product('routes/management/' + name + '.ts', imports).default)
  const localSecurity = product('localSecurity.ts', {})
  const actualProxyServer = product('server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'local61-offline-fixture' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [],
    './routes/management': routers,
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': localSecurity,
  }).proxyServer
  const listener = createServer(actualProxyServer.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  actualProxyServer.port = port
  function request(path, { method = 'GET', body, authorized = true } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Host: '127.0.0.1:' + port }
      if (authorized) headers.Authorization = 'Bearer ' + MANAGEMENT_SECRET
      // An HTTP DELETE request does not get Node's default chunked framing.
      // Explicitly frame *every* body instead of letting a test-client artifact
      // masquerade as a rejected Koa management DELETE operation.
      const payload = body === undefined ? undefined : JSON.stringify(body)
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(payload)
      }
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
        const bytes = []
        res.on('data', chunk => bytes.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const raw = Buffer.concat(bytes).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, raw, json })
        })
      })
      req.on('error', reject)
      req.setTimeout(2500, () => req.destroy(new Error('Local auth Koa test timeout')))
      req.end(payload)
    })
  }
  const close = async () => {
    listener.closeAllConnections()
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  }
  return { request, state, close }
}

const injectedFailures = [
  ['key-write', '/v0/management/api-keys/api-key-one', 'PUT', { name: 'Renamed' }],
  ['key-write', '/v0/management/api-keys/api-key-one', 'DELETE', undefined],
  ['key-write', '/v0/management/api-keys/api-key-one/regenerate', 'POST', undefined],
  ['mapping-write', '/v0/management/model-mappings/pinned', 'PUT', { actualModel: 'other' }],
  ['mapping-write', '/v0/management/model-mappings/pinned', 'DELETE', undefined],
  ['provider-write', '/v0/management/providers/qwen', 'PUT', { name: 'New synthetic name' }],
  ['provider-write', '/v0/management/providers/qwen/status', 'PATCH', { enabled: false }],
  ['provider-delete', '/v0/management/providers/qwen', 'DELETE', undefined],
  ['config-write', '/v0/management/config', 'PUT', { requestTimeout: 3000 }],
  ['session-delete', '/v0/management/sessions/synthetic-session', 'DELETE', undefined],
  ['session-clear', '/v0/management/sessions', 'DELETE', { confirm: true }],
  ['statistics-read', '/v0/management/statistics', 'GET', undefined],
  ['request-logs-read', '/v0/management/logs', 'GET', undefined],
  ['system-logs-read', '/v0/management/logs?type=system', 'GET', undefined],
  ['session-read', '/v0/management/sessions', 'GET', undefined],
]

for (const [fault, path, method, body] of injectedFailures) {
  test('local61 real auth management HTTP 500 never exposes storage/secret exception: ' + method + ' ' + path, async () => {
    const f = await fixture({ fault })
    try {
      const before = clone(f.state.record)
      const response = await f.request(path, { method, body })
      assert.equal(response.status, 500, response.raw)
      assert.equal(response.json?.success, false, response.raw)
      assert.equal(response.json?.error?.code, 'internal_error', response.raw)
      assert.equal(response.raw.includes(PRIVATE), false, response.raw)
      assert.equal(response.raw.includes(MANAGEMENT_SECRET), false)
      assert.equal(response.raw.includes(original.key), false)
      assert.deepEqual(f.state.record, before, 'Refused durable mutation cannot persist a partial config')
      assert.equal(f.state.deleted, 0)
      assert.equal(f.state.remoteEffects, 0)
    } finally { await f.close() }
  })
}

test('local61 management rejects unauthorized mutation before storage or exception content', async () => {
  const f = await fixture({ fault: 'key-write' })
  try {
    const response = await f.request('/v0/management/api-keys/api-key-one', {
      method: 'PUT', authorized: false, body: { name: 'untrusted' },
    })
    assert.equal(response.status, 401, response.raw)
    assert.equal(f.state.writes, 0)
    assert.equal(response.raw.includes(PRIVATE), false)
  } finally { await f.close() }
})

test('local61 management healthy read and key mutation still work with masking', async () => {
  const f = await fixture()
  try {
    const list = await f.request('/v0/management/api-keys')
    assert.equal(list.status, 200, list.raw)
    assert.equal(list.json.success, true)
    assert.equal(list.raw.includes(original.key), false)
    const change = await f.request('/v0/management/api-keys/api-key-one', {
      method: 'PUT', body: { name: 'Updated' },
    })
    assert.equal(change.status, 200, change.raw)
    assert.equal(f.state.record.apiKeys[0].name, 'Updated')
    assert.equal(change.raw.includes(original.key), false)
    assert.equal(f.state.writes, 1)
  } finally { await f.close() }
})

test('local61 actual ProxyServer must honor confirmed DELETE sessions JSON and clear exactly once', async () => {
  const f = await fixture()
  try {
    const before = await f.request('/v0/management/sessions/synthetic-session')
    assert.equal(before.status, 200, before.raw)
    const response = await f.request('/v0/management/sessions', {
      method: 'DELETE', body: { confirm: true },
    })
    assert.equal(response.status, 200, response.raw)
    assert.equal(response.json?.success, true, response.raw)
    assert.equal(response.json?.data?.cleared, true)
    assert.equal(f.state.writes, 1)
    assert.equal(f.state.deleted, 1)
    assert.equal(f.state.remoteEffects, 0)
  } finally { await f.close() }
})

test('local61 management clear without confirmation or authentication must not mutate sessions', async () => {
  const f = await fixture()
  try {
    for (const body of [undefined, {}, { confirm: false }]) {
      const refusal = await f.request('/v0/management/sessions', { method: 'DELETE', body })
      assert.equal(refusal.status, 400, refusal.raw)
      assert.equal(refusal.json?.error?.code, 'confirmation_required', refusal.raw)
    }
    const unauthorized = await f.request('/v0/management/sessions', {
      method: 'DELETE', body: { confirm: true }, authorized: false,
    })
    assert.equal(unauthorized.status, 401, unauthorized.raw)
    assert.equal(f.state.writes, 0)
    assert.equal(f.state.deleted, 0)
    assert.equal(f.state.remoteEffects, 0)
  } finally { await f.close() }
})
