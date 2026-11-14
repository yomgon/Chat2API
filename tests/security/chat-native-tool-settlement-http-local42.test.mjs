import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual authenticated Koa chat route, terminal validator AND unmocked
// production toolFormatConverter. No real Electron user, credentials,
// supplier, browser, fixed port or remote operation is reachable.
const requireNode = createRequire(import.meta.url)
const source = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
function product(path, dependencies = {}) {
  const code = ts.transpileModule(source(path), {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      if (specifier.startsWith('.')) throw Error('Unexpected product dependency: ' + specifier)
      return requireNode(specifier)
    },
    Buffer, TextDecoder, Date, Math, JSON, Error,
    console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const account = { id: 'synthetic-account-id', providerId: 'qwen', name: 'synthetic', status: 'active' }
const provider = { id: 'qwen', name: 'In-memory provider only', enabled: true }
const toolReply = argumentsString => ({
  id: 'synthetic-provider-reply',
  object: 'chat.completion',
  created: 1000,
  model: 'synthetic-wire-id',
  choices: [{
    index: 0,
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'synthetic-tool', type: 'function',
        function: { name: 'local_lookup', arguments: argumentsString } }],
    },
  }],
})
const textReply = {
  id: 'synthetic-text-reply', object: 'chat.completion', created: 1000, model: 'synthetic-wire-id',
  choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: 'offline text response' } }],
}

async function fixture() {
  const events = {
    send: 0, accountSuccess: 0, successes: 0, failures: 0, requestStats: [],
    errorLogs: [], responseLogs: [],
  }
  let upstreamReply = toolReply('{UNPARSEABLE_PROVIDER_TOOL_ARGUMENTS')
  const storeManager = {
    getConfig: () => ({
      enableApiKey: true,
      apiKeys: [{ id: 'fixture-id', key: 'synthetic-local-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false },
      loadBalanceStrategy: 'round-robin',
    }),
    updateConfig() {},
    recordAccountSuccess(accountId, providerId) {
      assert.equal(accountId, account.id)
      assert.equal(providerId, provider.id)
      events.accountSuccess++
      return true
    },
    recordRequestInStats(success) { events.requestStats.push(success) },
    addRequestLog(entry) { events.responseLogs.push(entry.status); return { id: 'fixture-log-id' } },
    updateRequestLog() {},
    addLog(level, name) { if (level === 'error') events.errorLogs.push(name) },
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { events.successes++ },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080,
    getHost: () => '127.0.0.1',
  }
  const requestForwarder = {
    async forwardChatCompletion() {
      events.send++
      return { success: true, status: 200, body: upstreamReply }
    },
  }
  const gate = product('streamTerminalGate.ts')
  const converter = product('utils/toolFormatConverter.ts')
  const chat = product('routes/chat.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: 'synthetic-wire-id' }),
      clearAccountFailure() {},
      markAccountFailed() {},
    } },
    '../forwarder': { requestForwarder },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id,
      getPreferredAccount: () => account.id,
    } },
    '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': gate,
    '../stream': { streamHandler: {
      createTransformStream() { throw Error('Streaming not part of fixture') },
    } },
    '../utils/toolFormatConverter': converter,
  }).default
  const localSecurity = product('localSecurity.ts')
  const proxyServer = product('server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'local42-offline-fixture' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat],
    './routes/management': [],
    './status': { proxyStatusManager },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': localSecurity,
  }).proxyServer
  const listener = createServer(proxyServer.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxyServer.port = port
  const post = ({ tool_format = 'native', key = 'synthetic-local-key' } = {}) => new Promise((resolve, reject) => {
    const chunks = []
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: {
        Host: '127.0.0.1:' + port,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
    }, res => {
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch { json = null }
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(2500, () => req.destroy(new Error('Private loopback timeout')))
    req.end(JSON.stringify({
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'offline synthetic tool request' }],
      stream: false, tool_format,
    }))
  })
  return {
    events, post, reply: body => { upstreamReply = body },
    async close() {
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(e => e ? reject(e) : resolve()))
    },
  }
}

test('actual Koa native tool format rejects unparseable provider arguments before any account success or success receipt', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.post()
  assert.equal(response.status, 502)
  assert.equal(response.json?.choices, undefined, 'A conversion failure is not a completed native tool answer')
  assert.doesNotMatch(response.raw, /UNPARSEABLE_PROVIDER_TOOL_ARGUMENTS/)
  assert.equal(f.events.send, 1, 'A consumed provider effect cannot be retried')
  assert.equal(f.events.accountSuccess, 0, 'Do not settle an answer the requested wire converter cannot represent')
  assert.equal(f.events.successes, 0)
  assert.equal(f.events.failures, 1)
  assert.deepEqual(f.events.requestStats, [false])
  assert.deepEqual(f.events.responseLogs, ['error'])
})

test('actual Koa native tool format with valid provider arguments produces Anthropic content and exactly one settlement', async t => {
  const f = await fixture(); t.after(f.close)
  f.reply(toolReply('{"request":"synthetic"}'))
  const response = await f.post()
  assert.equal(response.status, 200)
  assert.equal(response.json?.choices?.[0]?.message?.content?.[0]?.type, 'tool_use')
  assert.equal(response.json?.choices?.[0]?.message?.content?.[0]?.input?.request, 'synthetic')
  assert.equal(f.events.send, 1)
  assert.equal(f.events.accountSuccess, 1)
  assert.equal(f.events.successes, 1)
  assert.equal(f.events.failures, 0)
  assert.deepEqual(f.events.requestStats, [true])
})

test('actual Koa native format leaves ordinary text response unchanged and does not parse nonexistent tool args', async t => {
  const f = await fixture(); t.after(f.close)
  f.reply(textReply)
  const response = await f.post()
  assert.equal(response.status, 200)
  assert.equal(response.json?.choices?.[0]?.message?.content, 'offline text response')
  assert.equal(f.events.send, 1)
  assert.equal(f.events.accountSuccess, 1)
  assert.deepEqual(f.events.requestStats, [true])
})

test('actual Koa auth rejects unauthorized native request before any synthetic provider action', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.post({ key: 'not-the-synthetic-key' })
  assert.equal(response.status, 401)
  assert.equal(f.events.send, 0)
  assert.equal(f.events.accountSuccess, 0)
  assert.equal(f.events.requestStats.length, 0)
})
