import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { isLocalBindHost } from '../../src/main/proxy/localSecurity.ts'

function createRoutes() {
  const realRequire = createRequire(import.meta.url)
  const sourceFile = fileURLToPath(new URL('../../src/main/proxy/routes/management/proxy.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const callbacks = new Map()
  const calls = { stop: 0, restart: 0, logs: [] }
  class FakeRouter {
    use() {}
    post(path, callback) { callbacks.set('POST ' + path, callback) }
    get(path, callback) { callbacks.set('GET ' + path, callback) }
  }
  const proxy = {
    isRunning: () => true,
    stop: async () => { calls.stop++; return true },
    restart: async () => { calls.restart++; return true },
    start: async () => true,
  }
  const mocks = {
    '@koa/router': FakeRouter,
    '../../middleware/managementAuth': { managementAuthMiddleware: async (_ctx, next) => next() },
    '../../server': { proxyServer: proxy },
    '../../localSecurity': { isLocalBindHost },
    '../../status': { proxyStatusManager: {
      getRunningStatus: () => ({ isRunning: true, uptime: 1 }),
      getStatistics: () => ({ activeConnections: 1 }),
      getPort: () => 8080,
      getHost: () => '127.0.0.1',
    } },
    '../../../store/store': { storeManager: { addLog: (_level, msg) => calls.logs.push(msg) } },
  }
  const module = { exports: {} }
  runInNewContext(compiled, {
    exports: module.exports, module,
    require: (name) => name in mocks ? mocks[name] : realRequire(name),
    console,
  }, { filename: sourceFile })
  function context(body) {
    return {
      request: { body },
      res: new EventEmitter(),
      headers: {},
      set(name, value) { this.headers[name] = value },
    }
  }
  return { callbacks, calls, context }
}

test('stop acknowledges before stopping its own listening HTTP server', async () => {
  const r = createRoutes()
  const ctx = r.context({})
  await r.callbacks.get('POST /stop')(ctx)
  assert.equal(ctx.status, 202)
  assert.equal(r.calls.stop, 0)
  assert.equal(ctx.body.data.state, 'stopping')
  assert.equal(ctx.headers.Connection, 'close')
  ctx.res.emit('finish')
  ctx.res.emit('close')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.calls.stop, 1)
})

test('restart is rejected before stopping when it targets a non-loopback address', async () => {
  const r = createRoutes()
  const ctx = r.context({ port: 8080, host: '0.0.0.0' })
  await r.callbacks.get('POST /restart')(ctx)
  assert.equal(ctx.status, 400)
  assert.equal(ctx.body.error.code, 'invalid_target')
  assert.equal(r.calls.restart, 0)
})

test('restart uses a single transition after response finish', async () => {
  const r = createRoutes()
  const ctx = r.context({ port: 8081, host: '127.0.0.1' })
  await r.callbacks.get('POST /restart')(ctx)
  assert.equal(ctx.status, 202)
  assert.equal(r.calls.restart, 0)
  assert.equal(ctx.body.data.state, 'restarting')
  ctx.res.emit('finish')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.calls.restart, 1)
})
