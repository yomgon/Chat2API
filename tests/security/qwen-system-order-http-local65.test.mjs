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

// Real authenticated Koa ProxyServer + chat route + dedicated Qwen China
// adapter request projection. Every account, token, header and Axios reply is
// synthetic. Axios is a closed capture-only fixture; there are zero remote
// requests, refreshes, session deletions, fallback or retries.
const nodeRequire = createRequire(import.meta.url)
const PRIVATE = 'OFFLINE_QWEN_LOCAL65_PRIVATE_TOKEN'
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

async function fixture() {
  const events = { dispatches: [], captured: [], accountSuccess: 0, stats: [], failures: 0 }
  const account = freezeDeep({
    id: 'qwen-local65-account', name: 'private-fixture', providerId: 'qwen',
    status: 'active', credentials: { ticket: PRIVATE },
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
          return { status: 502, headers: {}, data: {} }
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
      selectAccount: () => ({ account, provider, actualModel: 'Qwen3.7-Max' }),
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
        assert.equal(wireModel, 'Qwen3.7-Max')
        events.dispatches.push(JSON.parse(JSON.stringify(request)))
        const adapter = new QwenAdapter(selectedProvider, selectedAccount)
        const { response } = await adapter.chatCompletion({
          model: wireModel, originalModel: request.model, messages: request.messages,
          enableWebSearch: request.web_search, enableThinking: request.reasoning_effort,
        })
        return {
          success: false, status: response.status,
          failureStage: 'chat-completion',
          failureCode: 'qwen_synthetic_upstream_refusal',
        }
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

const cases = [
  {
    name: 'two distinct leading system messages',
    messages: [{ role: 'system', content: 'RULE_ALPHA' },
      { role: 'system', content: 'RULE_BETA' },
      { role: 'user', content: 'QUESTION' }],
    expected: 'RULE_ALPHA\n\nRULE_BETA\n\nUser: QUESTION',
  },
  {
    name: 'two text-part systems with UTF-8 and empty segment',
    messages: [
      { role: 'system', content: [text('한글😀'), text(''), text('ALPHA')] },
      { role: 'system', content: [text('BETA'), text('尾')] },
      { role: 'user', content: [text('한글 질문')] },
    ],
    // OpenAI text-part arrays concatenate their text; only separate system
    // messages receive the established two-newline framing.
    expected: '한글😀ALPHA\n\nBETA尾\n\nUser: 한글 질문',
  },
  {
    name: 'systems plus full assistant/user history',
    messages: [
      { role: 'system', content: 'FIRST_RULE' }, { role: 'system', content: 'SECOND_RULE' },
      { role: 'user', content: 'FIRST_QUESTION' },
      { role: 'assistant', content: 'PREVIOUS_ANSWER' },
      { role: 'user', content: 'SECOND_QUESTION' },
    ],
    expected: 'FIRST_RULE\n\nSECOND_RULE\n\nUser: FIRST_QUESTION\n\nAssistant: PREVIOUS_ANSWER\n\nSECOND_QUESTION',
  },
  {
    name: 'single system remains unchanged',
    messages: [{ role: 'system', content: 'SINGLE_RULE' }, { role: 'user', content: 'QUESTION' }],
    expected: 'SINGLE_RULE\n\nUser: QUESTION',
  },
  {
    name: 'no system remains unchanged',
    messages: [{ role: 'user', content: 'QUESTION' }],
    expected: 'QUESTION',
  },
]

for (const { name, messages, expected } of cases) {
  test('local65 actual auth Koa / Qwen request preserves ' + name, async () => {
    const f = await fixture()
    try {
      const before = JSON.stringify(messages)
      const response = await f.post(messages)
      assert.equal(response.status, 502, response.raw)
      assert.equal(f.events.dispatches.length, 1, 'No remote fallback or replay')
      assert.equal(f.events.captured.length, 1, 'One closed Axios capture-only request')
      const payload = f.events.captured[0].body
      assert.equal(payload.model, 'Qwen3.7-Max', 'Actual wire ID must stay pinned')
      assert.equal(payload.messages[0].content, expected)
      assert.equal(payload.messages[0].meta_data.ori_query, expected)
      assert.equal(JSON.stringify(messages), before, 'Client messages cannot mutate')
      assert.equal(f.account.credentials.ticket, PRIVATE)
      assert.equal(f.events.accountSuccess, 0)
      assert.deepEqual(f.events.stats, [false])
      assert.equal(response.raw.includes(PRIVATE), false)
    } finally { await f.close() }
  })
}

test('local65 HTTP unauthorized request never triggers Qwen consumer dispatch', async () => {
  const f = await fixture()
  try {
    const result = await f.post([{ role: 'user', content: 'offline' }], 'wrong-key')
    assert.equal(result.status, 401, result.raw)
    assert.equal(f.events.dispatches.length, 0)
    assert.equal(f.events.captured.length, 0)
    assert.equal(f.events.accountSuccess, 0)
  } finally { await f.close() }
})

test('local65 malformed system message never starts Qwen consumer dispatch', async () => {
  const f = await fixture()
  try {
    const result = await f.post([
      { role: 'system', content: [text('valid'), { type: 'image_url', image_url: { url: 'https://example.invalid/pic' } }] },
      { role: 'user', content: 'offline' },
    ])
    assert.equal(result.status, 400, result.raw)
    assert.equal(f.events.captured.length, 0)
    assert.equal(f.events.accountSuccess, 0)
  } finally { await f.close() }
})
