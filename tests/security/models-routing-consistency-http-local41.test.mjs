import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual models route + ModelMapper + LoadBalancer + chat route + API-key gate.
// Provider/account/catalog/forwarder are in-memory only; no upstream effect.
const requireNode = createRequire(import.meta.url)
const read = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
function load(path, mocks) {
  const module = { exports: {} }
  const code = ts.transpileModule(read(path), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  runInNewContext(code, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw Error('Unexpected local dependency ' + path + ': ' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000 })
  return module.exports
}

async function fixture({ exhausted = true } = {}) {
  const effects = { forwards: 0, settlements: 0 }
  const provider = { id: 'qwen', name: 'Synthetic Qwen', enabled: true, createdAt: 1000 }
  const account = {
    id: 'pinned-account', providerId: 'qwen', name: 'Pinned', status: 'active',
    dailyLimit: 5, todayUsed: exhausted ? 5 : 4,
  }
  const config = {
    enableApiKey: true,
    apiKeys: [{ id: 'fixture-key', key: 'fixture-local41-key', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false },
    loadBalanceStrategy: 'round-robin',
    modelMappings: {
      'public-alias': {
        requestModel: 'public-alias', actualModel: 'wire-qwen',
        preferredProviderId: 'qwen', preferredAccountId: 'pinned-account',
      },
    },
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: updates => { Object.assign(config, updates); return config },
    getProviders: () => [provider],
    getAccountsByProviderId: id => id === provider.id ? [account] : [],
    getEffectiveModels: id => id === provider.id
      ? [{ actualModelId: 'wire-qwen', displayName: 'Qwen Synthetic Model' }] : [],
    addRequestLog: () => ({ id: 'fixture-log' }), updateRequestLog() {}, addLog() {},
    recordRequestInStats() {}, recordAccountSuccess: () => { effects.settlements++; return true },
  }
  const storeMock = { '../store/store': { storeManager } }
  const modelMapper = load('modelMapper.ts', storeMock).modelMapper
  const loadBalancer = load('loadbalancer.ts', { ...storeMock, './modelMapper': { modelMapper } }).loadBalancer
  const forwarder = {
    forwardChatCompletion: async (_request, _account, _provider, actualModel) => {
      effects.forwards++
      return { success: true, status: 200, body: {
        id: 'synthetic', object: 'chat.completion', created: 1, model: actualModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' }],
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
    '@koa/router': requireNode('@koa/router'), '../modelMapper': { modelMapper },
    '../loadbalancer': { loadBalancer }, '../forwarder': { requestForwarder: forwarder },
    '../status': { proxyStatusManager: status }, '../streamTerminalGate': gate,
    '../../store/store': { storeManager },
    '../stream': { streamHandler: { createTransformStream: () => { throw Error('stream forbidden') } } },
  }
  const models = load('routes/models.ts', shared).default
  const chat = load('routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw Error('not used') },
      transformChunkToAnthropic: () => { throw Error('not used') },
    },
  }).default
  const localSecurity = load('localSecurity.ts', {})
  const proxyServer = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'synthetic' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models, chat], './routes/management': [], '../store/store': { storeManager },
    './status': { proxyStatusManager: status }, './localSecurity': localSecurity,
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const listener = createServer(proxyServer.app.callback())
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; proxyServer.port = port
  const request = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, Authorization: 'Bearer fixture-local41-key' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let json
        try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
        resolve({ status: res.statusCode, raw, json })
      })
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  return { request, effects, close: async () => {
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve))
  } }
}

test('daily-limit exhausted account is not advertised when chat deterministically has no selectable account', async t => {
  const f = await fixture({ exhausted: true }); t.after(f.close)
  const list = await f.request('/v1/models')
  assert.equal(list.status, 200)
  assert.equal(list.json.data.some(model => model.id === 'Qwen Synthetic Model'), false)
  assert.equal(list.json.data.some(model => model.id === 'public-alias'), false)
  const baseDetail = await f.request('/v1/models/Qwen%20Synthetic%20Model')
  assert.equal(baseDetail.status, 404)
  const aliasDetail = await f.request('/v1/models/public-alias')
  assert.equal(aliasDetail.status, 404)
  const chat = await f.request('/v1/chat/completions', { method: 'POST', body: {
    model: 'public-alias', messages: [{ role: 'user', content: 'synthetic only' }], stream: false,
  } })
  assert.equal(chat.status, 503)
  assert.equal(chat.json.error.code, 'no_available_account')
  assert.equal(f.effects.forwards, 0); assert.equal(f.effects.settlements, 0)
})

test('below-limit selectable account remains listed and routed through the same pinned account contract', async t => {
  const f = await fixture({ exhausted: false }); t.after(f.close)
  const list = await f.request('/v1/models')
  assert.equal(list.status, 200)
  assert.equal(list.json.data.some(model => model.id === 'Qwen Synthetic Model'), true)
  assert.equal(list.json.data.some(model => model.id === 'public-alias'), true)
  assert.equal((await f.request('/v1/models/public-alias')).status, 200)
  const chat = await f.request('/v1/chat/completions', { method: 'POST', body: {
    model: 'public-alias', messages: [{ role: 'user', content: 'synthetic only' }], stream: false,
  } })
  assert.equal(chat.status, 200)
  assert.equal(f.effects.forwards, 1); assert.equal(f.effects.settlements, 1)
})
