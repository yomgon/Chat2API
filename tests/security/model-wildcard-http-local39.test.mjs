import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual modelMapper+loadBalancer, GET /v1/models/:model, chat and legacy
// routes, Koa authentication and body parser. Synthetic accounts and
// in-memory forwarder only: no operating profile, Electron or upstream.
const requireNode = createRequire(import.meta.url)
const readSource = path => readFileSync(new URL('../../src/main/proxy/' + path, import.meta.url), 'utf8')
function load(path, mocks) {
  const mod = { exports: {} }
  runInNewContext(ts.transpileModule(readSource(path), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module: mod, exports: mod.exports,
    Buffer, TextDecoder, Date, Math, JSON, Error, process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw Error('Unexpected dependency: ' + path + ':' + name)
      return requireNode(name)
    },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

async function fixture() {
  const effects = { requests: [], success: 0, fail: 0, accounts: [], stats: [] }
  const providers = [
    { id: 'qwen', name: 'Synthetic Qwen', enabled: true, createdAt: 1_000 },
    { id: 'glm', name: 'Synthetic GLM', enabled: true, createdAt: 1_000 },
  ]
  const accounts = [
    { id: 'chosen-account', name: 'Pinned', providerId: 'qwen', status: 'active' },
    { id: 'unrelated-account', name: 'Unrelated', providerId: 'glm', status: 'active' },
  ]
  const effective = {
    qwen: [{ actualModelId: 'wire-qwen', displayName: 'Qwen Synthetic Model' }],
    glm: [{ actualModelId: 'wire-glm', displayName: 'GLM Synthetic Model' }],
  }
  const config = {
    enableApiKey: true, apiKeys: [{ id: 'fixture-key', key: 'fixture-local-auth', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false },
    loadBalanceStrategy: 'round-robin',
    modelMappings: {
      'portal-*': {
        requestModel: 'portal-*', actualModel: 'wire-qwen',
        preferredProviderId: 'qwen', preferredAccountId: 'chosen-account',
      },
      'portal-exact': {
        requestModel: 'portal-exact', actualModel: 'wire-glm',
        preferredProviderId: 'glm', preferredAccountId: 'unrelated-account',
      },
    },
  }
  const storeManager = {
    getConfig: () => config, updateConfig() {},
    getProviders: () => providers,
    getAccountsByProviderId: providerId => accounts.filter(a => a.providerId === providerId),
    getEffectiveModels: providerId => effective[providerId] || [],
    addRequestLog: () => ({ id: 'synthetic-log' }), updateRequestLog() {},
    addLog() {},
    recordAccountSuccess: (accountId, providerId) => {
      effects.accounts.push({ accountId, providerId }); return true
    },
    recordRequestInStats: outcome => effects.stats.push(outcome),
  }
  const m = { '../store/store': { storeManager } }
  const modelMapper = load('modelMapper.ts', m).modelMapper
  const loadBalancer = load('loadbalancer.ts', { ...m, './modelMapper': { modelMapper } }).loadBalancer
  const forwarder = {
    forwardChatCompletion: async (request, account, provider, actualModel) => {
      effects.requests.push({
        publicModel: request.model, providerId: provider.id, accountId: account.id, actualModel,
        content: request.messages?.[0]?.content,
      })
      return { success: true, status: 200, body: {
        id: 'synthetic-answer', object: 'chat.completion', created: 1, model: actualModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic verified' }, finish_reason: 'stop' }],
      } }
    },
  }
  const status = {
    recordRequestStart() {}, recordRequestSuccess() { effects.success++ },
    recordRequestFailure() { effects.fail++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const gate = load('streamTerminalGate.ts', {})
  const legacy = load('legacyCompletion.ts', {})
  const shared = {
    '@koa/router': requireNode('@koa/router'),
    '../modelMapper': { modelMapper }, '../loadbalancer': { loadBalancer },
    '../forwarder': { requestForwarder: forwarder },
    '../status': { proxyStatusManager: status }, '../streamTerminalGate': gate,
    '../legacyCompletion': legacy,
    '../../store/store': { storeManager },
    '../stream': { streamHandler: { createTransformStream: () => { throw Error('No streaming effect') } } },
  }
  const models = load('routes/models.ts', shared).default
  const chat = load('routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw Error('Not used') },
      transformChunkToAnthropic: () => { throw Error('Not used') },
    },
  }).default
  const completions = load('routes/completions.ts', shared).default
  const localSecurity = load('localSecurity.ts', {})
  const proxyServer = load('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'synthetic' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [models, chat, completions], './routes/management': [],
    '../store/store': { storeManager },
    './status': { proxyStatusManager: status }, './localSecurity': localSecurity,
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const listener = createServer(proxyServer.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  proxyServer.port = port
  async function fetchLocal(path, { method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Host: `127.0.0.1:${port}`, Authorization: 'Bearer fixture-local-auth' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(raw) } catch { json = null }
          resolve({ status: res.statusCode, json, raw })
        })
      })
      req.on('error', reject)
      req.setTimeout(2500, () => req.destroy(new Error('Synthetic loopback timeout')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  return {
    effects, fetchLocal,
    disablePin: () => { accounts[0].status = 'error' },
    close: async () => {
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(err => err ? reject(err) : resolve()))
    },
  }
}

test('real Koa public chat: wildcard alias uses exact pinned provider/account and catalog wire ID', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.fetchLocal('/v1/chat/completions', {
    method: 'POST', body: {
      model: 'portal-new', messages: [{ role: 'user', content: 'local synthetic' }], stream: false,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(f.effects.requests.length, 1, 'One local synthetic send, never fallback')
  assert.equal(f.effects.requests[0].accountId, 'chosen-account')
  assert.equal(f.effects.requests[0].providerId, 'qwen')
  assert.equal(f.effects.requests[0].actualModel, 'wire-qwen')
  assert.equal(f.effects.accounts.length, 1)
})

test('real Koa legacy completion and GET model resolve wildcard alias consistently', async t => {
  const f = await fixture(); t.after(f.close)
  const item = await f.fetchLocal('/v1/models/portal-new')
  assert.equal(item.status, 200)
  assert.equal(item.json.id, 'portal-new')
  const list = await f.fetchLocal('/v1/models')
  assert.equal(list.status, 200)
  assert.ok(list.json.data.some(m => m.id === 'portal-*'), 'wildcard public mapping advertised')
  const completion = await f.fetchLocal('/v1/completions', {
    method: 'POST', body: { model: 'portal-new', prompt: 'local synthetic', stream: false },
  })
  assert.equal(completion.status, 200)
  assert.equal(completion.json.object, 'text_completion')
  assert.equal(f.effects.requests.length, 1)
  assert.equal(f.effects.requests[0].accountId, 'chosen-account')
  assert.equal(f.effects.requests[0].actualModel, 'wire-qwen')
})

test('real Koa exact alias outranks wildcard and preserves its distinct pinned account', async t => {
  const f = await fixture(); t.after(f.close)
  const response = await f.fetchLocal('/v1/chat/completions', {
    method: 'POST', body: {
      model: 'portal-exact', messages: [{ role: 'user', content: 'synthetic' }],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(f.effects.requests.length, 1)
  assert.equal(f.effects.requests[0].providerId, 'glm')
  assert.equal(f.effects.requests[0].accountId, 'unrelated-account')
  assert.equal(f.effects.requests[0].actualModel, 'wire-glm')
})

test('real Koa wildcard pinned account unavailable is fail-closed: no provider fallback', async t => {
  const f = await fixture(); t.after(f.close)
  f.disablePin()
  const item = await f.fetchLocal('/v1/models/portal-new')
  assert.equal(item.status, 404)
  const response = await f.fetchLocal('/v1/chat/completions', {
    method: 'POST', body: {
      model: 'portal-new', messages: [{ role: 'user', content: 'synthetic' }],
    },
  })
  assert.equal(response.status, 503)
  assert.equal(f.effects.requests.length, 0)
  assert.equal(f.effects.accounts.length, 0)
})
