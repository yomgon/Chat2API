import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import crypto from 'node:crypto'
import ts from 'typescript'

// Reproduce a real existing GLM consumer-web refresh failure across the
// product adapter, Forwarder, Koa route, and native proxy's Host/API-key gate.
// All accounts, HTTP responses and persistence are synthetic. No Electron
// profile, protected credentials, remote sockets or operating port 8080.
const requireNode = createRequire(import.meta.url)
const text = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const transpile = (code, filename) => ts.transpileModule(code, {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText
const PRIVATE = 'SYNTHETIC_AUTHORIZATION_AND_UPSTREAM_PAYLOAD_LOCAL38'
const noEffect = name => () => { throw new Error('UNAUTHORIZED_SYNTHETIC_EFFECT_' + name) }

function moduleWith(source, filename, dependencies) {
  const module = { exports: {} }
  runInNewContext(transpile(source, filename), {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('.')) throw new Error('Unknown product import ' + filename + ' ' + name)
      return requireNode(name)
    },
    Buffer, URL, URLSearchParams, TextDecoder, TextEncoder, Date, Math,
    JSON, Error, Promise, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
  }, { filename, timeout: 2000 })
  return module.exports
}

const forwarderSource = ts.createSourceFile('forwarder.ts',
  text('src/main/proxy/forwarder.ts'), ts.ScriptTarget.Latest, true)
let forwardGLM
let safeWebErrorStatus
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(forwarderSource) === 'forwardGLM') {
    forwardGLM = node.getText(forwarderSource)
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'safeWebErrorStatus') {
    safeWebErrorStatus = node.getText(forwarderSource)
  }
  ts.forEachChild(node, visit)
}
visit(forwarderSource)
assert.ok(forwardGLM && safeWebErrorStatus, 'use exact current product Forwarder source')

async function fixture(upstreamHttpStatus) {
  const effects = {
    upstream: [], settlement: [], stats: [], requests: [], appLogs: [],
    start: 0, success: 0, failure: 0, clear: 0, mark: 0, configWrites: 0,
  }
  const token = 'SYNTHETIC_GLMPROVIDER_REFRESH_TOKEN_LOCAL38'
  const account = { id: 'synthetic-glm-account', providerId: 'glm',
    name: 'Synthetic GLM account', status: 'active', credentials: { refresh_token: token } }
  const provider = { id: 'glm', name: 'Synthetic GLM', enabled: true,
    type: 'builtin', apiEndpoint: 'https://chatglm.cn/chatglm', createdAt: 1000,
    supportedModels: ['GLM-5.3-Flash'], modelMappings: { 'GLM-5.3-Flash': 'glm-5.3-flash' } }
  let config = {
    enableApiKey: true, apiKeys: [{ id: 'fixture-key', key: 'fixture-loopback-key',
      enabled: true, usageCount: 0 }],
    modelMappings: { 'test-glm-alias': { requestModel: 'test-glm-alias',
      actualModel: 'GLM-5.3-Flash', preferredProviderId: 'glm',
      preferredAccountId: account.id } },
    loadBalanceStrategy: 'round-robin',
    managementApi: { enableManagementApi: false },
  }
  const storeManager = {
    getConfig: () => config,
    updateConfig: update => { config = { ...config, ...update }; effects.configWrites++ },
    getProviders: () => [provider],
    getAccountsByProviderId: id => id === 'glm' ? [account] : [],
    getEffectiveModels: id => id === 'glm'
      ? [{ displayName: 'GLM-5.3-Flash', actualModelId: 'glm-5.3-flash' }] : [],
    updateAccount: noEffect('credential-mutation'),
    recordAccountSuccess: (...args) => { effects.settlement.push(args); return true },
    addRequestLog: entry => { effects.requests.push(entry); return { id: 'fixture-receipt' } },
    recordRequestInStats: ok => effects.stats.push(ok),
    addLog: (level, message, meta) => effects.appLogs.push({ level, message, meta }),
  }
  const axios = { __esModule: true, default: {
    async post(url, _body, options) {
      effects.upstream.push({ endpoint: url.endsWith('/user-api/user/refresh')
        ? 'refresh' : 'unexpected', maxRedirects: options?.maxRedirects })
      assert.equal(url, 'https://chatglm.cn/chatglm/user-api/user/refresh')
      return { status: upstreamHttpStatus,
        data: { code: 1, msg: PRIVATE, headers: { Authorization: PRIVATE } } }
    },
    get: noEffect('provider-get'), delete: noEffect('provider-delete'),
  } }
  const glm = moduleWith(text('src/main/proxy/adapters/glm.ts'), 'glm.ts', {
    axios, crypto,
    '../../store/store': { storeManager },
    stream: { PassThrough },
    'eventsource-parser': { createParser: noEffect('eventsource-parser') },
    'form-data': { __esModule: true, default: class {} },
    'mime-types': { __esModule: true, default: {} },
    '../utils/tools': {
      toolsToSystemPrompt: noEffect('tool-prompt'),
      TOOL_WRAP_HINT: '', hasToolPromptInjected: () => false,
    },
    '../utils/toolParser': { parseToolCallsFromText: noEffect('tool-parser') },
    '../utils/streamToolHandler': { createBaseChunk: noEffect('tool-chunk') },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
    'node:dns/promises': { lookup: noEffect('DNS') },
    'node:https': { Agent: class {} },
  })
  // Source methods compile in their own VM. Bind these exact values through a
  // second VM context so instanceof still observes the adapter's class.
  const context = {
    module: { exports: {} }, Date, Math, Error, Promise,
    GLMAdapter: glm.GLMAdapter,
    GLMAttachmentInputFailure: glm.GLMAttachmentInputFailure,
    GLMAuthPreflightFailure: glm.GLMAuthPreflightFailure,
    GLMStreamHandler: class { constructor() { noEffect('decoder')() } },
    shouldDeleteSession: () => false,
    hasCompletedNonStreamAnswer: noEffect('completion-settlement'),
    unconfirmedProviderCompletion: noEffect('missing-terminal'),
    console: { log() {}, warn() {}, error() {} },
  }
  context.exports = context.module.exports
  runInNewContext(transpile(safeWebErrorStatus +
    '\nclass TestedForwarder { ' + forwardGLM + ' }\nexports.TestedForwarder = TestedForwarder',
    'forwarder-subset.ts'), context, { filename: 'forwarder-subset.ts', timeout: 2000 })
  const realMethod = new context.module.exports.TestedForwarder()
  realMethod.transformRequestForPromptToolUse = input => ({
    messages: input.messages, tools: [], plan: { mode: 'disabled' },
  })
  realMethod.applyToolCallsToResponse = noEffect('tool-result')
  const proxyStatusManager = {
    recordRequestStart: () => effects.start++,
    recordRequestSuccess: () => effects.success++,
    recordRequestFailure: () => effects.failure++,
    getRunningStatus: () => ({ isRunning: true, uptime: 0 }),
    getStatistics: () => ({ totalRequests: effects.start, successRequests: effects.success,
      failedRequests: effects.failure, activeConnections: 0, requestsPerMinute: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const loadBalancer = {
    selectAccount: (model, strategy, preferredProvider, preferredAccount) => {
      assert.equal(model, 'test-glm-alias')
      assert.equal(preferredProvider, 'glm')
      assert.equal(preferredAccount, account.id)
      return { provider, account, actualModel: 'glm-5.3-flash' }
    },
    markAccountFailed: () => effects.mark++,
    clearAccountFailure: () => effects.clear++,
  }
  const modelMapper = {
    getPreferredProvider: () => 'glm',
    getPreferredAccount: () => account.id,
  }
  const gate = moduleWith(text('src/main/proxy/streamTerminalGate.ts'),
    'streamTerminalGate.ts', { stream: requireNode('stream') })
  const chat = moduleWith(text('src/main/proxy/routes/chat.ts'), 'chat.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer },
    '../modelMapper': { modelMapper },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: (request, selected, target, wire) =>
        realMethod.forwardGLM(request, selected, target, wire, Date.now()),
    } },
    '../status': { proxyStatusManager },
    '../streamTerminalGate': gate,
    '../stream': { streamHandler: { createTransformStream: noEffect('stream-transform') } },
    '../../store/store': { storeManager },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: noEffect('anthropic-transform'),
      transformChunkToAnthropic: noEffect('anthropic-stream'),
    },
  }).default
  const localSecurity = moduleWith(text('src/main/proxy/localSecurity.ts'),
    'localSecurity.ts', {})
  const server = moduleWith(text('src/main/proxy/server.ts'), 'server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => '1.4.0-local.36-fixture' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat],
    './routes/management': [],
    './status': { proxyStatusManager },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': localSecurity,
  }).proxyServer
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port
  async function post(key = 'fixture-loopback-key') {
    const body = JSON.stringify({ model: 'test-glm-alias', stream: false,
      messages: [{ role: 'user', content: 'Only synthetic nonsecret data' }],
      web_search: false, reasoning_effort: false, tool_choice: 'none' })
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
        headers: { Host: `127.0.0.1:${port}`,
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json' },
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode, raw, json: JSON.parse(raw) })
        })
      })
      request.once('error', reject)
      request.setTimeout(2000, () => request.destroy(new Error('Synthetic fixture timed out')))
      request.end(body)
    })
  }
  async function close() {
    listener.closeAllConnections()
    await new Promise((resolve, reject) =>
      listener.close(error => error ? reject(error) : resolve()))
  }
  return { post, close, effects, glm }
}

for (const [upstreamStatus, localStatus] of [
  [401, 401], [403, 403], [429, 429], [503, 503], [302, 502], [200, 502],
]) {
  test(`GLM real Koa/forwarder rejected refresh HTTP ${upstreamStatus} preserves safe phase and local status, without completion POST`, async t => {
    const f = await fixture(upstreamStatus)
    t.after(f.close)
    const denied = await f.post('bad-key')
    assert.equal(denied.status, 401)
    assert.equal(f.effects.upstream.length, 0, 'auth denial must precede provider activity')
    const result = await f.post()
    assert.equal(result.status, localStatus, 'verified 4xx/5xx status is preserved; redirects and invalid success envelopes are 502')
    assert.equal(result.json.error.code, 'glm_upstream_operation_failed')
    assert.equal(f.effects.upstream.length, 1, 'only one bounded refresh POST, no completion/retry')
    assert.equal(f.effects.upstream[0].endpoint, 'refresh')
    assert.equal(f.effects.upstream[0].maxRedirects, 0)
    assert.equal(f.effects.settlement.length, 0)
    assert.equal(f.effects.start, 1)
    assert.equal(f.effects.success, 0)
    assert.equal(f.effects.failure, 1)
    assert.equal(f.effects.stats.join(','), 'false')
    assert.equal(f.effects.requests.length, 1)
    assert.equal(f.effects.requests[0].statusCode, localStatus)
    const diagnostic = f.effects.appLogs.find(x => x.message === 'Provider request failed')
    assert.equal(diagnostic?.meta?.data?.failureStage, 'auth-preflight')
    assert.equal(diagnostic?.meta?.data?.upstreamHttpStatus, null,
      'local route does not claim upstream status provenance')
    assert.doesNotMatch(JSON.stringify({ result, effects: f.effects }), new RegExp(PRIVATE))
  })
}
