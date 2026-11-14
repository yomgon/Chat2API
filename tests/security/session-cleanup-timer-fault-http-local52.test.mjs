import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Child-only accelerated real timer + real SessionManager and authenticated
// Koa management sessions HTTP. Store writes and session records are memory
// fixtures. No operating profile, provider network, browser or actual data.
// Child isolation observes uncaught timer errors without killing test runner.
const nodeRequire = createRequire(import.meta.url)
const thisFile = fileURLToPath(import.meta.url)
const AUTH = 'SYNTHETIC_LOCAL52_SESSION_MANAGEMENT_ONLY'
const ERROR_MARKER = 'SYNTHETIC_LOCAL52_STORAGE_FAILURE_NOT_FOR_HTTP'

function product(relative, deps, moreGlobals = {}) {
  const mod = { exports: {} }
  const js = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'),
    { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    } },
  ).outputText
  runInNewContext(js, {
    module: mod, exports: mod.exports, Buffer, Date, Math, JSON, Error,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected module: ' + relative + ':' + id)
      return nodeRequire(id)
    },
    ...moreGlobals,
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function childRun(mode) {
  let uncaught = 0
  let unhandled = 0
  let attempts = 0
  let removed = 0
  let warnings = 0
  let sessions = [{
    id: 'local52-session', providerId: 'synthetic-provider',
    accountId: 'synthetic-account', sessionType: 'chat',
    messages: [{ role: 'user', content: 'synthetic conversation only' }],
    createdAt: 1, lastActiveAt: 2, status: 'active', model: 'synthetic-model',
  }]
  process.on('uncaughtException', () => { uncaught++ })
  process.on('unhandledRejection', () => { unhandled++ })

  const intervals = new Map()
  let nextInterval = 1
  const env = {
    setInterval(callback) {
      const id = nextInterval++
      intervals.set(id, globalThis.setInterval(callback, 6))
      return id
    },
    clearInterval(id) {
      const timer = intervals.get(id)
      if (timer) globalThis.clearInterval(timer)
      intervals.delete(id)
    },
    console: {
      log() {}, warn() {},
      error() { warnings++ },
    },
  }
  const storeManager = {
    getConfig: () => ({
      managementApi: { enableManagementApi: true, managementApiSecret: AUTH },
    }),
    getSessionConfig: () => ({
      sessionTimeout: 30, deleteAfterTimeout: false,
      maxMessagesPerSession: 50,
    }),
    getActiveSessions: () => sessions.slice(),
    cleanExpiredSessions() {
      attempts++
      if (mode === 'always-refuse' || (mode === 'refuse-once' && attempts === 1)) {
        throw Error(ERROR_MARKER)
      }
      const count = sessions.length
      sessions = []
      removed += count
      return count
    },
  }
  const sessionManager = product('proxy/sessionManager.ts', {
    '../store/store': { storeManager },
  }, env).sessionManager
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const sessionsRouter = product('proxy/routes/management/sessions.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../sessionManager': { __esModule: true, default: sessionManager },
  }).default
  const app = new (nodeRequire('koa'))()
  app.use(nodeRequire('koa-bodyparser')())
  app.use(sessionsRouter.routes())
  app.use(sessionsRouter.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  sessionManager.initialize()
  await new Promise(resolve => setTimeout(resolve, 65))
  const get = authorized => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + AUTH
    const req = httpRequest({ hostname: '127.0.0.1', port,
      path: '/v0/management/sessions', method: 'GET', headers,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, raw, json: JSON.parse(raw) })
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(Error('Synthetic session Koa timeout')))
    req.end()
  })
  const authorized = await get(true)
  const unauthorized = await get(false)
  sessionManager.destroy()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  const result = {
    mode, attempts, removed, remaining: sessions.length,
    uncaught, unhandled, warnings, activeTimers: intervals.size,
    authorizedStatus: authorized.status,
    authorizedSessionCount: authorized.json.data?.length,
    unauthorizedStatus: unauthorized.status,
    publicCanaryLeaked: (authorized.raw + unauthorized.raw).includes(ERROR_MARKER),
  }
  console.log('CHILD_RESULT=' + JSON.stringify(result))
}

function run(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [thisFile, '--local52-child', mode], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      const marker = stdout.split(/\r?\n/).find(line => line.startsWith('CHILD_RESULT='))
      if (code !== 0 || !marker) {
        reject(Error('Local52 isolated timer child failed: exit=' + code +
          ', result=' + Boolean(marker) + ', stderrPresent=' + Boolean(stderr)))
      } else resolve(JSON.parse(marker.slice('CHILD_RESULT='.length)))
    })
  })
}

if (process.argv[2] === '--local52-child') {
  childRun(process.argv[3]).then(() => process.exit(0)).catch(() => process.exit(2))
} else {
  test('scheduled session cleanup storage refusal cannot raise uncaught error or break authenticated Koa HTTP', async () => {
    const r = await run('always-refuse')
    assert.equal(r.authorizedStatus, 200)
    assert.equal(r.authorizedSessionCount, 1)
    assert.equal(r.unauthorizedStatus, 401)
    assert.ok(r.attempts >= 2)
    assert.equal(r.removed, 0)
    assert.equal(r.remaining, 1)
    assert.equal(r.uncaught, 0)
    assert.equal(r.unhandled, 0)
    assert.equal(r.publicCanaryLeaked, false)
    assert.equal(r.activeTimers, 0)
  })

  test('one refused cleanup tick preserves original session and allows next scheduled tick to succeed', async () => {
    const r = await run('refuse-once')
    assert.ok(r.attempts >= 2)
    assert.equal(r.removed, 1)
    assert.equal(r.remaining, 0)
    assert.equal(r.authorizedStatus, 200)
    assert.equal(r.authorizedSessionCount, 0)
    assert.equal(r.unauthorizedStatus, 401)
    assert.equal(r.uncaught, 0)
    assert.equal(r.unhandled, 0)
    assert.equal(r.activeTimers, 0)
  })

  test('normal scheduled cleanup retains HTTP/auth and ends interval at destroy', async () => {
    const r = await run('normal')
    assert.ok(r.attempts >= 1)
    assert.equal(r.removed, 1)
    assert.equal(r.uncaught, 0)
    assert.equal(r.unhandled, 0)
    assert.equal(r.activeTimers, 0)
    assert.equal(r.authorizedStatus, 200)
    assert.equal(r.unauthorizedStatus, 401)
  })
}
