import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import {
  evaluateProxyKey,
  hasUntrustedBrowserOrigin,
  isLocalBindHost,
  isTrustedHostHeader,
} from '../../src/main/proxy/localSecurity.ts'

const realRequire = createRequire(import.meta.url)

function createOfflineServer(config) {
  const counts = { bodyParsed: 0, sockets: 0, logs: [], writes: 0, initializedSessions: 0 }
  class FakeApp {
    constructor() { this.middleware = [] }
    use(callback) { this.middleware.push(callback) }
    on() {}
    listen() { counts.sockets++; throw new Error('Listener must not open in offline tests') }
  }
  class FakeRouter {
    use() {}
    get() {}
    routes() { return async (_ctx, next) => next() }
    allowedMethods() { return async (_ctx, next) => next() }
  }
  function fakeBodyParser() {
    return async (_ctx, next) => {
      counts.bodyParsed++
      await next()
    }
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: () => { counts.writes++ },
    addLog: (_level, msg) => counts.logs.push(msg),
  }
  const proxyStatusManager = {
    getPort: () => 8080,
    getHost: () => '127.0.0.1',
    getStatistics: () => ({ activeConnections: 0 }),
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
  }
  const sourceFile = fileURLToPath(new URL('../../src/main/proxy/server.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const dependencies = {
    koa: FakeApp,
    '@koa/router': FakeRouter,
    'koa-bodyparser': fakeBodyParser,
    './routes': [],
    './routes/management': [],
    './status': { proxyStatusManager },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize: () => { counts.initializedSessions++ } } },
    './localSecurity': { evaluateProxyKey, hasUntrustedBrowserOrigin, isLocalBindHost, isTrustedHostHeader },
  }
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => dependencies[name] ?? realRequire(name),
    console, Date,
  }, { filename: sourceFile })
  const server = new module.exports.ProxyServer()
  async function request({ path = '/v1/chat/completions', origin = '', authorization = '', apiKey = '', host = '127.0.0.1:8080' } = {}) {
    const ctx = {
      path,
      status: 200,
      method: 'POST',
      ip: '127.0.0.1',
      get: name => ({
        Host: host,
        Origin: origin,
        Authorization: authorization,
        'X-API-Key': apiKey,
      })[name] ?? '',
      set() {},
    }
    const middlewares = server.app.middleware.slice(0, 3)
    let index = 0
    async function next() {
      if (index >= middlewares.length) return
      await middlewares[index++](ctx, next)
    }
    await next()
    return ctx
  }
  return { counts, server, request }
}

test('server middleware blocks empty enabled key list before parsing request bodies', async () => {
  const fixture = createOfflineServer({ enableApiKey: true, apiKeys: [] })
  const response = await fixture.request()
  assert.equal(response.status, 503)
  assert.equal(response.body.error.code, 'api_key_not_configured')
  assert.equal(fixture.counts.bodyParsed, 0)
  assert.equal(fixture.counts.writes, 0)
})

test('server requires active API key in request headers and rejects query-only key', async () => {
  const config = { enableApiKey: true, apiKeys: [{
    id: 'key-1', key: 'sk-synthetic-demo-key', enabled: true, lastUsedAt: 0, usageCount: 0,
  }] }
  const fixture = createOfflineServer(config)
  assert.equal((await fixture.request()).status, 401)
  assert.equal((await fixture.request({ authorization: 'Bearer wrong' })).status, 401)
  assert.equal(fixture.counts.bodyParsed, 0)

  const accepted = await fixture.request({ authorization: 'Bearer sk-synthetic-demo-key' })
  assert.equal(accepted.status, 200)
  assert.equal(fixture.counts.bodyParsed, 1)
  assert.equal(fixture.counts.writes, 1)
})

test('server rejects every browser Origin before either auth or body parsing', async () => {
  const fixture = createOfflineServer({ enableApiKey: false, apiKeys: [] })
  const response = await fixture.request({ origin: 'http://127.0.0.1:5173' })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'browser_origin_forbidden')
  assert.equal(fixture.counts.bodyParsed, 0)
})

test('untrusted HTTP Host is rejected before public paths, management and body parsing', async () => {
  const fixture = createOfflineServer({ enableApiKey: false, apiKeys: [] })
  for (const host of ['evil.example:8080', 'localhost:8080', '127.0.0.1:8081', '', '[::1]:80']) {
    const result = await fixture.request({ path: '/health', host })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'host_forbidden')
  }
  assert.equal(fixture.counts.bodyParsed, 0)
})

test('server never binds a non-loopback address', async () => {
  const fixture = createOfflineServer({ enableApiKey: true, apiKeys: [] })
  const result = await fixture.server.start(12345, '0.0.0.0')
  assert.equal(result, false)
  assert.equal(fixture.counts.sockets, 0)
  assert.equal(fixture.counts.initializedSessions, 0)
})
