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

// Actual ProxyServer->Koa->koa-bodyparser error-handler path over a fresh
// 127.0.0.1:0 listener, synthetic authenticated API key, memory config and
// optional diagnostic refusal. The child process traps an uncaught exception
// or unhandled rejection without touching any operating Electron profile,
// provider session or remote API. Never print auth or error canaries.
const sourcePath = fileURLToPath(import.meta.url)
const requireNode = createRequire(import.meta.url)
const API_KEY = 'SYNTHETIC_LOCAL55_PROXY_API_KEY_NO_HTTP'
const ERROR_CANARY = 'SYNTHETIC_LOCAL55_OPTIONAL_SERVER_ERROR_LOG_REFUSAL'
const AUTH_STORE_CANARY = 'SYNTHETIC_LOCAL55_AUTH_STORAGE_INTERNAL_REFUSAL'

function product(relative, deps) {
  const module = { exports: {} }
  const source = readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    fileName: relative,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  runInNewContext(compiled, {
    module, exports: module.exports,
    Date, Buffer, TextDecoder, JSON, Math, Error, process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (name.startsWith('.')) throw Error('Unexpected local dependency: ' + relative + ':' + name)
      return requireNode(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function childScenario(refuseLog, authStoreRefusal = false) {
  const events = {
    errorLogs: 0, warningLogs: 0, configWrites: 0,
    upstreamCalls: 0, uncaughtExceptions: 0, unhandledRejections: 0,
  }
  const uncaught = () => { events.uncaughtExceptions++ }
  const unhandled = () => { events.unhandledRejections++ }
  process.on('uncaughtException', uncaught)
  process.on('unhandledRejection', unhandled)

  let config = {
    managementApi: { enableManagementApi: false },
    enableApiKey: true,
    apiKeys: [{ id: 'synthetic-key', key: API_KEY, enabled: true,
      usageCount: 0, lastUsedAt: 0 }],
  }
  const storeManager = {
    getConfig: () => {
      if (authStoreRefusal) throw Error(AUTH_STORE_CANARY)
      return structuredClone(config)
    },
    updateConfig: patch => {
      events.configWrites++
      config = { ...config, ...structuredClone(patch) }
    },
    addLog(level) {
      if (level === 'error') {
        events.errorLogs++
        if (refuseLog) throw Error(ERROR_CANARY)
      }
      if (level === 'warn') events.warningLogs++
    },
  }
  const status = {
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0,
      failedRequests: 0, activeConnections: 0 }),
    getHost: () => '127.0.0.1',
    getPort: () => 8080,
  }
  const proxy = product('proxy/server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'local55-closed-fixture' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [],
    './routes/management': [],
    './status': { proxyStatusManager: status },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: {
      initialize() { throw Error('No persistent proxy startup in local55 fixture') },
      destroy() {},
    } },
    './localSecurity': product('proxy/localSecurity.ts', {}),
  }).proxyServer
  const listener = createServer(proxy.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxy.port = port
  const malformedPayload = '{"messages":'
  const sendMalformed = () => new Promise(resolve => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = httpRequest({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions',
      method: 'POST', headers: {
        Host: '127.0.0.1:' + port,
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
      },
    }, res => {
      const chunks = []
      res.on('data', part => chunks.push(part))
      res.on('error', () => finish({ status: res.statusCode, error: true }))
      res.on('end', () =>
        finish({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', () => finish({ status: null, error: true }))
    req.setTimeout(600, () => {
      req.destroy()
      finish({ status: null, timedOut: true })
    })
    req.end(malformedPayload)
  })

  let response
  try {
    response = await sendMalformed()
    await new Promise(resolve => setTimeout(resolve, 35))
  } finally {
    listener.closeAllConnections()
    await new Promise(resolve => listener.close(resolve))
    process.off('uncaughtException', uncaught)
    process.off('unhandledRejection', unhandled)
  }
  const { raw = '', ...result } = response
  const outcome = {
    ...events,
    ...result,
    rawLeaks: raw.includes(API_KEY) || raw.includes(ERROR_CANARY) ||
      raw.includes(AUTH_STORE_CANARY),
    proxyResponseBodyLength: raw.length,
  }
  console.log('LOCAL55_CHILD_RESULT=' + JSON.stringify(outcome))
}

function runChild(refuseLog, authStoreRefusal = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      sourcePath, '--local55-child',
      refuseLog ? 'refuse' : 'normal',
      authStoreRefusal ? 'auth-store-refusal' : 'no-auth-store-refusal',
    ], {
      cwd: process.cwd(), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('LOCAL55_CHILD_RESULT='))
      if (!line) {
        reject(Error('Local55 synthetic child did not report safe outcome, exit=' + code +
          ', stderrPresent=' + Boolean(stderr)))
        return
      }
      const result = JSON.parse(line.slice('LOCAL55_CHILD_RESULT='.length))
      resolve({ code, ...result })
    })
  })
}

if (process.argv.includes('--local55-child')) {
  await childScenario(process.argv.includes('refuse'),
    process.argv.includes('auth-store-refusal'))
} else {
  test('local55 actual authenticated malformed JSON returns HTTP 400 with normal Koa error diagnostic', async () => {
    const r = await runChild(false)
    assert.equal(r.code, 0)
    assert.equal(r.status, 400)
    assert.equal(r.configWrites, 1)
    assert.equal(r.errorLogs, 1)
    assert.equal(r.uncaughtExceptions, 0)
    assert.equal(r.unhandledRejections, 0)
    assert.equal(r.upstreamCalls, 0)
    assert.equal(r.rawLeaks, false)
  })

  test('local55 optional Koa app error diagnostic refusal cannot change HTTP 400 or trigger an unhandled async exception', async () => {
    const r = await runChild(true)
    assert.equal(r.code, 0)
    assert.equal(r.status, 400, 'The client should not hang when the Koa error logger is unavailable')
    assert.equal(r.configWrites, 1)
    assert.equal(r.errorLogs, 1)
    assert.equal(r.uncaughtExceptions, 0)
    assert.equal(r.unhandledRejections, 0)
    assert.equal(r.upstreamCalls, 0)
    assert.equal(r.rawLeaks, false)
  })

  test('local55 true credential configuration storage refusal stays HTTP 500 despite separate Koa error diagnostic refusal', async () => {
    const r = await runChild(true, true)
    assert.equal(r.code, 0)
    assert.equal(r.status, 500)
    assert.equal(r.configWrites, 0, 'Auth storage rejection cannot mutate any API key')
    assert.equal(r.errorLogs, 1)
    assert.equal(r.uncaughtExceptions, 0)
    assert.equal(r.unhandledRejections, 0)
    assert.equal(r.upstreamCalls, 0)
    assert.equal(r.rawLeaks, false)
  })
}
