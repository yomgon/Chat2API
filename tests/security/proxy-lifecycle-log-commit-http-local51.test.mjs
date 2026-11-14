import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Independent child process isolates a native Node listener's asynchronous
// 'uncaughtException' when post-effect logging throws. It avoids masking a
// real crash in the test runner. Every socket is 127.0.0.1, selected via
// port 0; all credentials/stores are synthetic, provider transports absent.
const sourcePath = fileURLToPath(import.meta.url)
const nodeRequire = createRequire(import.meta.url)
const AUTH = 'SYNTHETIC_LOCAL51_LIFECYCLE_MANAGEMENT_ONLY'

function product(relative, deps) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'),
    {
      fileName: relative,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      },
    },
  ).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error, TextDecoder,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id]
      if (id.startsWith('.')) throw Error('Unexpected local dependency: ' + relative + ':' + id)
      return nodeRequire(id)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function reservePort() {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function httpGet(port, pathname, { authorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port }
    if (authorized) headers.Authorization = 'Bearer ' + AUTH
    const req = httpRequest({
      hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, json: JSON.parse(raw) })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(1500, () => req.destroy(Error('Synthetic localhost HTTP timeout')))
    req.end()
  })
}

function httpPost(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + AUTH,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(1500, () => req.destroy(Error('Synthetic management POST timeout')))
    req.end(payload)
  })
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function childScenario(mode) {
  let failures = 0
  let failLogType = mode === 'start' ? 'started' : mode === 'bind-error' ? 'error' : ''
  let schedulerActive = 0
  let currentProxy
  process.on('uncaughtException', () => { failures++ })
  process.on('unhandledRejection', () => { failures++ })
  const storeManager = {
    getConfig: () => ({
      managementApi: { enableManagementApi: true, managementApiSecret: AUTH },
      enableApiKey: true, apiKeys: [],
    }),
    addLog(level, message) {
      if ((failLogType === 'started' && level === 'info' && message.includes('Proxy server started')) ||
          (failLogType === 'stopped' && level === 'info' && message.includes('Proxy server stopped')) ||
          (failLogType === 'transition-error' && level === 'error' && message.includes('Management proxy restart')) ||
          (failLogType === 'error' && level === 'error')) {
        throw Error('Synthetic lifecycle diagnostics unavailable')
      }
    },
  }
  const sessionManager = {
    initialize() { schedulerActive++ },
    destroy() { schedulerActive = Math.max(0, schedulerActive - 1) },
  }
  const status = new (product('proxy/status.ts', {}).ProxyStatusManager)()
  const localSecurity = product('proxy/localSecurity.ts', {})
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const management = product('proxy/routes/management/proxy.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../server': { proxyServer: {
      isRunning: () => currentProxy?.isRunning() ?? false,
      start: (...args) => currentProxy.start(...args),
      stop: (...args) => currentProxy.stop(...args),
      restart: (...args) => currentProxy.restart(...args),
    } },
    '../../localSecurity': localSecurity,
    '../../status': { proxyStatusManager: status },
    '../../../store/store': { storeManager },
  }).default
  currentProxy = product('proxy/server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'local51-fixture' } },
    '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [], './routes/management': [management],
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager }, './sessionManager': { sessionManager },
    './localSecurity': localSecurity,
  }).proxyServer

  const reserved = await reservePort()
  const port = reserved.address().port
  if (mode !== 'bind-error') await new Promise(resolve => reserved.close(resolve))
  let start = await Promise.race([
    currentProxy.start(port, '127.0.0.1').then(v => v ? 'true' : 'false'),
    delay(200).then(() => 'pending'),
  ])
  let statusHttp = null
  let unauthorizedStatus = null
  let stop = null
  let restartResponse = null
  if (mode !== 'bind-error') {
    const response = await httpGet(port, '/v0/management/proxy/status')
    const denied = await httpGet(port, '/v0/management/proxy/status', { authorized: false })
    statusHttp = { http: response.status, running: response.json.data.isRunning }
    unauthorizedStatus = denied.status
    if (mode === 'restart-fail') {
      const replacement = await reservePort()
      const replacementPort = replacement.address().port
      failLogType = 'transition-error'
      restartResponse = await httpPost(port, '/v0/management/proxy/restart', {
        host: '127.0.0.1', port: replacementPort,
      })
      await delay(250)
      await new Promise(resolve => replacement.close(resolve))
    } else {
      failLogType = mode === 'stop' ? 'stopped' : ''
      stop = await Promise.race([
        currentProxy.stop().then(v => v ? 'true' : 'false'),
        delay(200).then(() => 'pending'),
      ])
    }
  }
  const outcome = {
    mode, start, statusHttp, unauthorizedStatus, stop,
    restartHttp: restartResponse?.status,
    uncaughtExceptions: failures, schedulerActive, statusRunning: status.getRunningStatus().isRunning,
  }
  // Child-only: unbind the synthetic listener if an optional diagnostic left
  // an operation pending. Never touch an operating desktop app/process.
  failLogType = ''
  if (currentProxy.server?.listening) {
    await new Promise(resolve => currentProxy.server.close(resolve))
  }
  if (mode === 'bind-error') await new Promise(resolve => reserved.close(resolve))
  console.log('RESULT=' + JSON.stringify(outcome))
  return outcome
}

async function runChild(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sourcePath, '--local51-child', mode], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      const marker = stdout.split(/\r?\n/).find(line => line.startsWith('RESULT='))
      if (code !== 0 || !marker) {
        reject(Error('Local synthetic child failed, exit=' + code +
          ', hasResult=' + Boolean(marker) + ', stderrPresent=' + Boolean(stderr)))
        return
      }
      resolve(JSON.parse(marker.slice('RESULT='.length)))
    })
  })
}

if (process.argv[2] === '--local51-child') {
  childScenario(process.argv[3]).then(() => process.exit(0)).catch(() => process.exit(3))
} else {
  test('actual Koa authenticated listener start commits even when its optional success log throws', async () => {
    const r = await runChild('start')
    assert.equal(r.statusHttp.http, 200)
    assert.equal(r.statusHttp.running, true)
    assert.equal(r.unauthorizedStatus, 401)
    assert.equal(r.start, 'true')
    assert.equal(r.stop, 'true')
    assert.equal(r.uncaughtExceptions, 0)
    assert.equal(r.schedulerActive, 0)
  })

  test('actual Koa successful stop resolves even if its optional after-close log throws', async () => {
    const r = await runChild('stop')
    assert.equal(r.statusHttp.http, 200)
    assert.equal(r.start, 'true')
    assert.equal(r.stop, 'true')
    assert.equal(r.uncaughtExceptions, 0)
    assert.equal(r.statusRunning, false)
    assert.equal(r.schedulerActive, 0)
  })

  test('actual occupied loopback port refusal resolves false even if error diagnostic log fails', async () => {
    const r = await runChild('bind-error')
    assert.equal(r.start, 'false')
    assert.equal(r.uncaughtExceptions, 0)
    assert.equal(r.schedulerActive, 0)
    assert.equal(r.statusRunning, false)
  })

  test('accepted authenticated HTTP restart remains exception-free when refused replacement and diagnostics both fail', async () => {
    const r = await runChild('restart-fail')
    assert.equal(r.start, 'true')
    assert.equal(r.statusHttp.http, 200)
    assert.equal(r.unauthorizedStatus, 401)
    assert.equal(r.restartHttp, 202)
    assert.equal(r.statusRunning, false)
    assert.equal(r.schedulerActive, 0)
    assert.equal(r.uncaughtExceptions, 0)
  })
}
