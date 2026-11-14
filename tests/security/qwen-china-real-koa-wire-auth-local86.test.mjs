import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import * as crypto from 'node:crypto'
import * as stream from 'node:stream'
import * as zlib from 'node:zlib'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'

// Actual authenticated Koa Chat route -> real Qwen forwarder method -> real
// Qwen China adapter. Captured Axios has no vendor network; no operating
// account, refresh, session, cookie or retry is used.
const nodeRequire = createRequire(import.meta.url)
const PRIVATE = 'OFFLINE_QWEN_LOCAL65_PRIVATE_TOKEN'
const forwarderSource = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
const forwarderAst = ts.createSourceFile('forwarder.ts', forwarderSource, ts.ScriptTarget.Latest, true)
let forwardQwenMethod
function visitForward(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(forwarderAst) === 'forwardQwen')
    forwardQwenMethod = node.getText(forwarderAst)
  ts.forEachChild(node, visitForward)
}
visitForward(forwarderAst)
assert.ok(forwardQwenMethod, 'Production Qwen forwarder method required')
function product(relative, mocked = {}, extraGlobals = {}) {
  const source = readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    URL, URLSearchParams, setTimeout, clearTimeout,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocked, name)) return mocked[name]
      if (name.startsWith('.')) throw new Error('Unmocked product import: ' + name)
      return nodeRequire(name)
    },
    ...extraGlobals,
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}
const freezeDeep = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
const text = value => ({ type: 'text', text: value })

async function fixture({ credentials = { ticket: PRIVATE }, wire = 'Qwen3.6' } = {}) {
  const events = { dispatches: [], captured: [], accountSuccess: 0, stats: [], failures: 0 }
  const account = freezeDeep({
    id: 'qwen-local86-account', name: 'private-fixture', providerId: 'qwen',
    status: 'active', credentials,
  })
  const provider = freezeDeep({
    id: 'qwen', name: 'Qwen China Synthetic', enabled: true, modelMappings: {},
  })
  const qwenDeps = {
    '../../providers/qwenTicket': QWEN_TICKET_MODULE,
    axios: { __esModule: true, default: {
      create: () => ({
        post: async (url, body, config) => {
          events.captured.push({ url, body: JSON.parse(JSON.stringify(body)), config })
          assert.ok(url.startsWith('https://chat2.qianwen.com/api/v2/chat?'))
          assert.equal(config.maxRedirects, 0)
          assert.equal(config.responseType, 'stream')
          assert.equal(config.headers.Cookie, 'tongyi_sso_ticket=' + PRIVATE)
          return { status: 503, headers: {}, data: {} }
        },
      }),
      post: () => { throw new Error('Unintended global Axios request') },
      get: () => { throw new Error('Unintended global Axios GET') },
    } },
    stream, zlib, crypto,
    'zstd-codec': { ZstdCodec: { run: () => { throw new Error('No real codec') } } },
    'eventsource-parser': { createParser: () => { throw new Error('No actual response parsing') } },
    '../utils/tools': {
      toolsToSystemPrompt: () => 'SYNTHETIC_TOOLS_HINT', TOOL_WRAP_HINT: '\n[synthetic tools]',
      hasToolPromptInjected: () => false, shouldInjectToolPrompt: () => false,
    },
    '../utils/toolParser': { parseToolCallsFromText: () => ({ content: '', toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: () => ({}) },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({
      formatAssistantToolCalls: () => 'ASSISTANT_TOOL',
      formatToolResult: () => 'TOOL_RESULT',
    }) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
    '../../store/store': { storeManager: {} },
  }
  const QwenAdapter = product('adapters/qwen.ts', qwenDeps).QwenAdapter
  const forwarderModule = { exports: {} }
  const forwarderCode = ts.transpileModule(
    'class Local86Forwarder {' + forwardQwenMethod +
      '} exports.Local86Forwarder=Local86Forwarder', {
      fileName: 'forwardQwen-method.ts', compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      },
    }).outputText
  runInNewContext(forwarderCode, {
    module: forwarderModule, exports: forwarderModule.exports,
    QwenAdapter, QwenStreamHandler: class { constructor() { throw Error('No completed model response') } },
    shouldDeleteSession: () => { throw Error('Unexpected model success') },
    hasCompletedNonStreamAnswer: () => { throw Error('Unexpected success') },
    unconfirmedProviderCompletion: () => { throw Error('Unexpected success') },
    Date, Math, Error, Buffer, console: { log() {}, warn() {}, error() {} },
  }, { filename: 'forwardQwen-method.ts', timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  const productionForwarder = new forwarderModule.exports.Local86Forwarder()
  productionForwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages, tools: undefined,
    plan: { mode: 'disabled', shouldParseResponse: false },
  })
  const storeManager = {
    getConfig: () => ({
      loadBalanceStrategy: 'round-robin', enableApiKey: true,
      apiKeys: [{ id: 'offline-key', key: 'offline-only-api-key', enabled: true, usageCount: 0 }],
      managementApi: { enableManagementApi: false },
    }),
    updateConfig() {},
    recordAccountSuccess() { events.accountSuccess++; return true },
    recordRequestInStats(value) { events.stats.push(value) },
    addRequestLog() { return { id: 'offline-log' } },
    updateRequestLog() {}, addLog() {},
  }
  const proxyStatusManager = {
    recordRequestStart() {},
    recordRequestSuccess() { throw new Error('Unexpected synthetic account success') },
    recordRequestFailure() { events.failures++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const deps = {
    '@koa/router': nodeRequire('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => ({ account, provider, actualModel: wire }),
      markAccountFailed() {}, clearAccountFailure() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => 'qwen',
      getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: {
      async forwardChatCompletion(request, selectedAccount, selectedProvider, wireModel) {
        assert.equal(selectedAccount, account)
        assert.equal(selectedProvider, provider)
        assert.equal(wireModel, wire)
        events.dispatches.push(JSON.parse(JSON.stringify(request)))
        return productionForwarder.forwardQwen(
          request, selectedAccount, selectedProvider, wireModel, Date.now())
      },
    } },
    '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': product('streamTerminalGate.ts', { stream }),
    '../stream': { streamHandler: { createTransformStream() {
      throw new Error('Unexpected response transform')
    } } },
  }
  const chat = product('routes/chat.ts', {
    ...deps, '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }).default
  const proxyServer = product('server.ts', {
    koa: nodeRequire('koa'),
    electron: { app: { getVersion: () => 'offline-local65' } },
    '@koa/router': nodeRequire('@koa/router'), 'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [chat], './routes/management': [],
    './status': { proxyStatusManager },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('localSecurity.ts'),
  }).proxyServer
  const server = createServer(proxyServer.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxyServer.port = port
  function post(messages, auth = 'offline-only-api-key', patch = {}) {
    return new Promise((resolve, reject) => {
      const chunks = []
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { Host: '127.0.0.1:' + port,
          Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      }, res => {
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, raw, json })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(3000, () => req.destroy(new Error('Isolated HTTP timeout')))
      req.end(JSON.stringify({
        model: 'offline-display-model', messages, stream: false, ...patch,
      }))
    })
  }
  return { events, account, provider, post, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

for (const [name, display, wire, options, expectedDeepSearch] of [
  ['catalog wire is a historical alias', 'Qwen3.6', 'Qwen3.6', {}, '0'],
  ['thinking alias must not substitute catalog wire',
    'Qwen3-Max-thinking', 'Qwen3-Max', { reasoning_effort: 'high' }, '1'],
  ['independent exact catalog wire', 'Display Name', 'tongyi-exact-model', {}, '0'],
]) {
  test('local86 authenticated Koa+forwarder+Qwen adapter: ' + name, async t => {
    const f = await fixture({ wire })
    t.after(f.close)
    const reply = await f.post([{ role: 'user', content: 'LOCAL86_EXACT_WIRE' }],
      'offline-only-api-key', { model: display, ...options })
    assert.equal(reply.status, 503, reply.raw)
    assert.equal(f.events.dispatches.length, 1)
    assert.equal(f.events.captured.length, 1, 'Only one captured provider POST')
    const sent = f.events.captured[0]
    assert.equal(sent.body.model, wire, 'Preserve exact effective catalog wire')
    assert.equal(sent.body.deep_search, expectedDeepSearch)
    assert.equal(sent.config.maxRedirects, 0)
    assert.equal(sent.config.headers.Cookie, 'tongyi_sso_ticket=' + PRIVATE)
    assert.equal(f.events.accountSuccess, 0)
    assert.deepEqual(f.events.stats, [false])
    assert.equal(reply.raw.includes(PRIVATE), false)
  })
}

for (const [name, creds] of [
  ['conflicting aliases', { ticket: PRIVATE, tongyi_sso_ticket: 'DIFFERENT' }],
  ['injected Cookie CRLF', { ticket: PRIVATE + '\r\nHeader: injected' }],
  ['non-string ticket', { ticket: { token: PRIVATE } }],
]) {
  test('local86 authenticated Koa denies ' + name + ' before Qwen POST', async t => {
    const f = await fixture({ credentials: creds })
    t.after(f.close)
    const reply = await f.post([{ role: 'user', content: 'LOCAL86_INVALID_COOKIE' }])
    assert.notEqual(reply.status, 200)
    assert.equal(f.events.captured.length, 0)
    assert.equal(f.events.accountSuccess, 0)
    assert.equal(reply.raw.includes(PRIVATE), false)
  })
}

test('local86 Koa rejects unauthenticated request before model dispatch', async t => {
  const f = await fixture()
  t.after(f.close)
  const reply = await f.post([{ role: 'user', content: 'NO_AUTH' }], 'invalid-key')
  assert.equal(reply.status, 401)
  assert.equal(f.events.dispatches.length, 0)
  assert.equal(f.events.captured.length, 0)
})
