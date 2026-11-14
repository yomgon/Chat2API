import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const read = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
function load(path, mocks) {
  const module = { exports: {} }
  const js = ts.transpileModule(read(path), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  runInNewContext(js, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw Error('Unexpected local dependency ' + path + ': ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({ exhausted = false } = {}) {
  const effects = { sends: [], settlements: 0 }
  const providers = [
    { id: 'pinned', name: 'Pinned Provider', enabled: true, createdAt: 1000 },
    { id: 'fallback', name: 'Fallback Provider', enabled: true, createdAt: 1000 },
  ]
  const accounts = [
    { id: 'pinned-a', providerId: 'pinned', name: 'Pinned Account', status: 'active', dailyLimit: 10, todayUsed: exhausted ? 10 : 1 },
    { id: 'fallback-a', providerId: 'fallback', name: 'Fallback Account', status: 'active', dailyLimit: 10, todayUsed: 1 },
  ]
  const catalogs = {
    pinned: [
      { actualModelId: 'wire-exact', displayName: 'same-alias' },
      { actualModelId: 'wire-wild', displayName: 'wild-public-*' },
    ],
    fallback: [
      // Deliberately overlapping public names. Explicit mapping pins must still
      // prevent fallback to this provider when the pinned account is unhealthy.
      { actualModelId: 'wire-fallback-exact', displayName: 'same-alias' },
      { actualModelId: 'wire-fallback-wild', displayName: 'wild-public-*' },
    ],
  }
  const config = {
    enableApiKey: true,
    apiKeys: [{ id: 'local46-key', key: 'fixture-local46-key', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false },
    loadBalanceStrategy: 'failover',
    modelMappings: {
      'same-alias': {
        requestModel: 'same-alias', actualModel: 'wire-exact',
        preferredProviderId: 'pinned', preferredAccountId: 'pinned-a',
      },
      'wild-public-*': {
        requestModel: 'wild-public-*', actualModel: 'wire-wild',
        preferredProviderId: 'pinned', preferredAccountId: 'pinned-a',
      },
    },
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: updates => { Object.assign(config, updates); return config },
    getProviders: () => providers,
    getAccountsByProviderId: providerId => accounts.filter(a => a.providerId === providerId),
    getEffectiveModels: providerId => catalogs[providerId] || [],
    addRequestLog: () => ({ id: 'synthetic-log' }), updateRequestLog() {}, addLog() {}, recordRequestInStats() {},
    recordAccountSuccess: () => { effects.settlements++; return true },
  }
  const sm = { '../store/store': { storeManager } }
  const modelMapper = load('modelMapper.ts', sm).modelMapper
  const loadBalancer = load('loadbalancer.ts', { ...sm, './modelMapper': { modelMapper } }).loadBalancer
  const forwarder = {
    forwardChatCompletion: async (request, account, provider, actualModel) => {
      effects.sends.push({ model: request.model, accountId: account.id, providerId: provider.id, actualModel })
      return { success: true, status: 200, body: {
        id: 'synthetic', object: 'chat.completion', created: 1, model: actualModel,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'synthetic only' } }],
      } }
    },
  }
  const status = {
    recordRequestStart() {}, recordRequestSuccess() {}, recordRequestFailure() {},
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const gate = load('streamTerminalGate.ts', {})
  const shared = {
    '@koa/router': requireNode('@koa/router'), '../modelMapper': { modelMapper }, '../loadbalancer': { loadBalancer },
    '../forwarder': { requestForwarder: forwarder }, '../status': { proxyStatusManager: status },
    '../streamTerminalGate': gate, '../../store/store': { storeManager },
    '../stream': { streamHandler: { createTransformStream: () => { throw Error('No streaming in local46') } } },
  }
  const models = load('routes/models.ts', shared).default
  const chat = load('routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw Error('unused') },
      transformChunkToAnthropic: () => { throw Error('unused') },
    },
  }).default
  const localSecurity = load('localSecurity.ts', {})
  const proxyServer = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'local46' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models, chat], './routes/management': [], '../store/store': { storeManager },
    './status': { proxyStatusManager: status }, './localSecurity': localSecurity,
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const listener = createServer(proxyServer.app.callback())
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; proxyServer.port = port
  const request = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, Authorization: 'Bearer fixture-local46-key' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let json
        try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
        resolve({ status: res.statusCode, raw, json })
      })
    })
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  const failPinned = () => {
    loadBalancer.markAccountFailed('pinned-a')
    loadBalancer.markAccountFailed('pinned-a')
    loadBalancer.markAccountFailed('pinned-a')
  }
  return { request, effects, failPinned, close: async () => {
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve))
  } }
}

async function postChat(f, model) {
  return f.request('/v1/chat/completions', { method: 'POST', body: {
    model, messages: [{ role: 'user', content: 'synthetic only' }], stream: false,
  } })
}

test('failover health: failed exact-pinned account is still advertised although POST is deterministic 503/no fallback', async t => {
  const f = await fixture(); t.after(f.close)
  f.failPinned()
  const list = await f.request('/v1/models')
  const detail = await f.request('/v1/models/same-alias')
  const chat = await postChat(f, 'same-alias')
  assert.equal(list.status, 200)
  assert.equal(chat.status, 503)
  assert.equal(chat.json.error.code, 'no_available_account')
  assert.equal(f.effects.sends.length, 0, 'explicit account pin must not fall back to overlapping provider')
  assert.equal(list.json.data.some(m => m.id === 'same-alias'), false)
  assert.equal(detail.status, 404)
})

test('failover health: failed wildcard-pinned account is not advertised or silently substituted', async t => {
  const f = await fixture(); t.after(f.close)
  f.failPinned()
  const detail = await f.request('/v1/models/wild-public-42')
  const chat = await postChat(f, 'wild-public-42')
  assert.equal(chat.status, 503)
  assert.equal(chat.json.error.code, 'no_available_account')
  assert.equal(f.effects.sends.length, 0)
  assert.equal(detail.status, 404)
})

test('daily-limit exhausted pinned account remains hidden under failover strategy', async t => {
  const f = await fixture({ exhausted: true }); t.after(f.close)
  const list = await f.request('/v1/models')
  assert.equal(list.status, 200)
  assert.equal(list.json.data.some(m => m.id === 'same-alias'), false)
  assert.equal((await f.request('/v1/models/same-alias')).status, 404)
  const chat = await postChat(f, 'same-alias')
  assert.equal(chat.status, 503)
  assert.equal(f.effects.sends.length, 0)
})

test('healthy failover control advertises and routes exact and wildcard pins only to the pinned account', async t => {
  const f = await fixture(); t.after(f.close)
  const list = await f.request('/v1/models')
  assert.equal(list.status, 200)
  assert.equal(list.json.data.some(m => m.id === 'same-alias'), true)
  assert.equal((await f.request('/v1/models/same-alias')).status, 200)
  assert.equal((await f.request('/v1/models/wild-public-42')).status, 200)
  assert.equal((await postChat(f, 'same-alias')).status, 200)
  assert.equal((await postChat(f, 'wild-public-42')).status, 200)
  assert.deepEqual(f.effects.sends.map(x => [x.model, x.providerId, x.accountId]), [
    ['same-alias', 'pinned', 'pinned-a'],
    ['wild-public-42', 'pinned', 'pinned-a'],
  ])
})
