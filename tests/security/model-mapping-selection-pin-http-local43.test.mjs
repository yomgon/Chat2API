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
  const code = ts.transpileModule(read(path), { fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  runInNewContext(code, { module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; if (name.startsWith('.')) throw Error('Unexpected '+path+':'+name); return requireNode(name) },
  }, { filename: path, timeout: 2000 })
  return module.exports
}

async function fixture({ specificEnabled = true } = {}) {
  const effects = { forwards: [] }
  const providers = [
    { id: 'broad', name: 'Broad Provider', enabled: true, createdAt: 1 },
    { id: 'specific', name: 'Specific Provider', enabled: specificEnabled, createdAt: 1 },
  ]
  const accounts = [
    { id: 'broad-a', providerId: 'broad', status: 'active' },
    { id: 'specific-a', providerId: 'specific', status: 'active' },
  ]
  const effective = {
    broad: [{ actualModelId: 'wire-broad', displayName: 'wire-broad' }],
    specific: [{ actualModelId: 'wire-specific', displayName: 'wire-specific' }],
  }
  const config = {
    enableApiKey: true, apiKeys: [{ id: 'k', key: 'fixture-local43', enabled: true, usageCount: 0 }],
    loadBalanceStrategy: 'round-robin', managementApi: { enableManagementApi: false },
    modelMappings: {
      'portal-*': { requestModel: 'portal-*', actualModel: 'wire-broad', preferredProviderId: 'broad', preferredAccountId: 'broad-a' },
      'portal-special-*': { requestModel: 'portal-special-*', actualModel: 'wire-specific', preferredProviderId: 'specific', preferredAccountId: 'specific-a' },
    },
  }
  const storeManager = {
    getConfig: () => config, updateConfig: updates => { Object.assign(config, updates); return config },
    getProviders: () => providers, getAccountsByProviderId: id => accounts.filter(a => a.providerId === id),
    getEffectiveModels: id => effective[id] || [], addRequestLog: () => ({ id: 'log' }), updateRequestLog() {}, addLog() {},
    recordRequestInStats() {}, recordAccountSuccess: () => true,
  }
  const sm = { '../store/store': { storeManager } }
  const modelMapper = load('modelMapper.ts', sm).modelMapper
  const loadBalancer = load('loadbalancer.ts', { ...sm, './modelMapper': { modelMapper } }).loadBalancer
  const forwarder = { forwardChatCompletion: async (request, account, provider, actualModel) => {
    effects.forwards.push({ model: request.model, accountId: account.id, providerId: provider.id, actualModel })
    return { success: true, status: 200, body: { id: 'x', object: 'chat.completion', created: 1, model: actualModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' }] } }
  } }
  const status = { recordRequestStart() {}, recordRequestSuccess() {}, recordRequestFailure() {},
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }), getStatistics: () => ({ activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1' }
  const gate = load('streamTerminalGate.ts', {})
  const shared = { '@koa/router': requireNode('@koa/router'), '../modelMapper': { modelMapper }, '../loadbalancer': { loadBalancer },
    '../forwarder': { requestForwarder: forwarder }, '../status': { proxyStatusManager: status }, '../streamTerminalGate': gate,
    '../../store/store': { storeManager }, '../stream': { streamHandler: { createTransformStream: () => { throw Error('no stream') } } } }
  const models = load('routes/models.ts', shared).default
  const chat = load('routes/chat.ts', { ...shared, '../utils/toolFormatConverter': {
    isAnthropicToolFormat: () => false, transformResponseToAnthropic: () => { throw Error('unused') }, transformChunkToAnthropic: () => { throw Error('unused') },
  } }).default
  const localSecurity = load('localSecurity.ts', {})
  const proxyServer = load('server.ts', { koa: requireNode('koa'), electron: { app: { getVersion: () => 'synthetic' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'), './routes': [models, chat], './routes/management': [],
    '../store/store': { storeManager }, './status': { proxyStatusManager: status }, './localSecurity': localSecurity,
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } } }).proxyServer
  const server = createServer(proxyServer.app.callback()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; proxyServer.port = port
  const request = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, Authorization: 'Bearer fixture-local43' }; if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => { const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('error',reject); res.on('end',()=>{
      const raw=Buffer.concat(chunks).toString('utf8'); let json; try{json=JSON.parse(raw)}catch{} resolve({status:res.statusCode,json,raw}) }) })
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  return { request, effects, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

test('more-specific wildcard pin outranks broader wildcard regardless of insertion order', async t => {
  const f = await fixture({ specificEnabled: true }); t.after(f.close)
  const detail = await f.request('/v1/models/portal-special-42'); assert.equal(detail.status, 200)
  const chat = await f.request('/v1/chat/completions', { method: 'POST', body: { model: 'portal-special-42', messages: [{ role: 'user', content: 'synthetic' }] } })
  assert.equal(chat.status, 200); assert.equal(f.effects.forwards.length, 1)
  assert.deepEqual(f.effects.forwards[0], { model: 'portal-special-42', accountId: 'specific-a', providerId: 'specific', actualModel: 'wire-specific' })
})

test('disabled provider on the most-specific wildcard fails closed instead of falling back to broader mapping', async t => {
  const f = await fixture({ specificEnabled: false }); t.after(f.close)
  const detail = await f.request('/v1/models/portal-special-42'); assert.equal(detail.status, 404)
  const chat = await f.request('/v1/chat/completions', { method: 'POST', body: { model: 'portal-special-42', messages: [{ role: 'user', content: 'synthetic' }] } })
  assert.equal(chat.status, 503); assert.equal(chat.json.error.code, 'no_available_account'); assert.equal(f.effects.forwards.length, 0)
})
