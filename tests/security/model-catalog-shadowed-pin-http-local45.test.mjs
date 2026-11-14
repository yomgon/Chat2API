import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// The real Koa/auth/models/chat/modelMapper/loadBalancer path, with only
// synthetic accounts/config and a closed in-memory forwarder. No provider I/O.
const nodeRequire = createRequire(import.meta.url)
const read = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')

function load(relative, mocks) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(read(relative), {
    fileName: relative,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, Date, Math, JSON, Error,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) throw Error('Unexpected dependency ' + relative + ':' + name)
      return nodeRequire(name)
    },
  }, { filename: relative, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

async function fixture({ pinnedEnabled, mappingKey }) {
  const attempted = []
  const alias = 'portal-special-42'
  const providers = [
    { id: 'other', name: 'Other provider', enabled: true, createdAt: 1000 },
    { id: 'pinned', name: 'Pinned provider', enabled: pinnedEnabled, createdAt: 1000 },
  ]
  const accounts = [
    { id: 'other-account', providerId: 'other', status: 'active' },
    { id: 'pinned-account', providerId: 'pinned', status: 'active' },
  ]
  const effective = {
    other: [{ displayName: alias, actualModelId: 'wire-other' }],
    pinned: [{ displayName: 'Pinned wire', actualModelId: 'wire-pinned' }],
  }
  const config = {
    loadBalanceStrategy: 'round-robin',
    enableApiKey: true,
    apiKeys: [{ id: 'synthetic', key: 'synthetic-local45', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false },
    modelMappings: {
      [mappingKey]: {
        requestModel: mappingKey, actualModel: 'wire-pinned',
        preferredProviderId: 'pinned', preferredAccountId: 'pinned-account',
      },
    },
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: updates => Object.assign(config, updates),
    getProviders: () => providers,
    getAccountsByProviderId: id => accounts.filter(a => a.providerId === id),
    getEffectiveModels: id => effective[id] ?? [],
    addLog() {}, addRequestLog: () => ({ id: 'local' }), updateRequestLog() {},
    recordAccountSuccess: () => true, recordRequestInStats() {},
  }
  const store = { '../store/store': { storeManager } }
  const modelMapper = load('modelMapper.ts', store).modelMapper
  const loadBalancer = load('loadbalancer.ts', { ...store, './modelMapper': { modelMapper } }).loadBalancer
  const forwarder = {
    forwardChatCompletion: async (_request, account, provider, model) => {
      attempted.push({ accountId: account.id, providerId: provider.id, model })
      return {
        success: true, status: 200,
        body: {
          id: 'synthetic', object: 'chat.completion', model, created: 1000,
          choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' }],
        },
      }
    },
  }
  const status = {
    recordRequestStart() {}, recordRequestSuccess() {}, recordRequestFailure() {},
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const gate = load('streamTerminalGate.ts', {})
  const shared = {
    '@koa/router': nodeRequire('@koa/router'),
    '../modelMapper': { modelMapper }, '../loadbalancer': { loadBalancer },
    '../forwarder': { requestForwarder: forwarder },
    '../status': { proxyStatusManager: status },
    '../streamTerminalGate': gate,
    '../../store/store': { storeManager },
    '../stream': { streamHandler: { createTransformStream() { throw Error('No stream') } } },
  }
  const models = load('routes/models.ts', shared).default
  const chat = load('routes/chat.ts', {
    ...shared,
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic() { throw Error('Unused') },
      transformChunkToAnthropic() { throw Error('Unused') },
    },
  }).default
  const localSecurity = load('localSecurity.ts', {})
  const proxy = load('server.ts', {
    koa: nodeRequire('koa'), electron: { app: { getVersion: () => 'synthetic' } },
    '@koa/router': nodeRequire('@koa/router'),
    'koa-bodyparser': nodeRequire('koa-bodyparser'),
    './routes': [models, chat], './routes/management': [],
    '../store/store': { storeManager },
    './status': { proxyStatusManager: status },
    './localSecurity': localSecurity,
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
  }).proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const request = (path, body) => new Promise((resolve, reject) => {
    const headers = { Host: '127.0.0.1:' + port, Authorization: 'Bearer synthetic-local45' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({
      hostname: '127.0.0.1', port,
      method: body === undefined ? 'GET' : 'POST', path, headers,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch { json = { raw } }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(Error('Synthetic local HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    alias, attempted, request,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    },
  }
}

for (const mappingKey of ['portal-special-*', 'portal-special-42']) {
  test('GET models does not advertise a shadowed unavailable pinned alias: ' + mappingKey, async t => {
    const f = await fixture({ pinnedEnabled: false, mappingKey })
    t.after(f.close)
    const detail = await f.request('/v1/models/' + f.alias)
    const list = await f.request('/v1/models')
    const chat = await f.request('/v1/chat/completions', {
      model: f.alias, messages: [{ role: 'user', content: 'synthetic' }],
    })
    assert.equal(chat.status, 503)
    assert.equal(f.attempted.length, 0, 'No provider can be substituted for an unavailable explicit pin')
    assert.equal(detail.status, 404, 'A pinned-unavailable model must not be a 200 model detail')
    assert.equal(list.status, 200)
    assert.ok(!list.json.data.some(item => item.id === f.alias),
      'The unrelated provider display name must not advertise an unrouteable pinned model')
  })

  test('The same public model is exposed and routed when its explicit pin is available: ' + mappingKey, async t => {
    const f = await fixture({ pinnedEnabled: true, mappingKey })
    t.after(f.close)
    const detail = await f.request('/v1/models/' + f.alias)
    assert.equal(detail.status, 200)
    const list = await f.request('/v1/models')
    assert.equal(list.json.data.find(item => item.id === f.alias)?.owned_by, 'model-mapping',
      'The list must not attribute a pinned public alias to an unrelated provider')
    const chat = await f.request('/v1/chat/completions', {
      model: f.alias, messages: [{ role: 'user', content: 'synthetic' }],
    })
    assert.equal(chat.status, 200)
    assert.deepEqual(f.attempted, [{ accountId: 'pinned-account', providerId: 'pinned', model: 'wire-pinned' }])
  })
}
