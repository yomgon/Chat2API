import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual HTTP API-key middleware + bodyparser + production chat route +
// selected first-party forwarder methods + both provider stream handlers +
// real managed XML ToolCallingEngine. NO REAL NETWORK OR OPERATING PROFILE.
// Fake adapters return a closed synthetic upstream Readable instead of POST.
const requireNode = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const proxyRoot = path.join(root, 'main/proxy')
const PRIVATE = 'LOCAL71_PRIVATE_SECRET_NEVER_EXPOSE'
const BUILTIN = new Set(['stream', 'node:stream', 'crypto', 'node:crypto', 'eventsource-parser', 'form-data'])
const cache = new Map()
const quiet = { log() {}, error() {}, warn() {}, info() {} }
const toPlain = obj => JSON.parse(JSON.stringify(obj))

function runSource(source, filename, overrides = {}) {
  const filenameOnDisk = path.join(proxyRoot, filename)
  const js = ts.transpileModule(source, { fileName: filenameOnDisk,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true } }).outputText
  const mod = { exports: {} }
  runInNewContext(js, {
    module: mod, exports: mod.exports, Buffer, TextDecoder, TextEncoder,
    URL, URLSearchParams, Date, Math, JSON, Error, Promise, Object,
    Map, Set, RegExp, setTimeout, clearTimeout, console: quiet,
    process: { env: {} },
    require(specifier) {
      if (Object.hasOwn(overrides, specifier)) return overrides[specifier]
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filenameOnDisk), specifier)
        const local = resolved.endsWith('.ts') ? resolved : resolved + '.ts'
        if (!local.startsWith(root + path.sep)) throw Error('Out-of-root import forbidden')
        return loadAbsolute(local)
      }
      if (BUILTIN.has(specifier)) return requireNode(specifier)
      throw Error('Forbidden product dependency: ' + specifier)
    },
  }, { filename, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}
function loadAbsolute(abs, overrides) {
  if (!overrides && cache.has(abs)) return cache.get(abs)
  const source = readFileSync(abs, 'utf8')
  const relative = path.relative(proxyRoot, abs)
  const result = runSource(source, relative, overrides)
  if (!overrides) cache.set(abs, result)
  return result
}
const product = (relative, overrides) =>
  loadAbsolute(path.join(proxyRoot, relative), overrides)
const { ToolCallingEngine } = product('toolCalling/ToolCallingEngine.ts')
const terminal = product('streamTerminalGate.ts')
const qwenHandler = product('adapters/qwen-ai.ts', {
  axios: { __esModule: true, default: { create: () => { throw Error('No network axios') } } },
})
const zaiHandler = product('adapters/zai.ts', {
  axios: { __esModule: true, default: { create: () => { throw Error('No network axios') } } },
  '../../oauth/zaiSession': {
    readZaiSessionClaims: () => { throw Error('No real Zai auth') },
    readZaiTokenIdentity: () => { throw Error('No real Zai auth') },
  },
})
const forwardAst = ts.createSourceFile('forwarder.ts',
  readFileSync(path.join(proxyRoot, 'forwarder.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const methodSources = []
function selectMethods(node) {
  if (ts.isMethodDeclaration(node) &&
      ['forwardQwenAi', 'forwardZai'].includes(node.name.getText(forwardAst))) {
    methodSources.push(node.getText(forwardAst))
  }
  ts.forEachChild(node, selectMethods)
}
selectMethods(forwardAst)
assert.equal(methodSources.length, 2, 'Must run both actual product forwarder methods')
const baseConfig = { enabled: true, mode: 'auto', clientAdapterId: 'standard-openai-tools',
  diagnosticsEnabled: false, advanced: { promptPreviewEnabled: false } }
const xml = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="local_lookup"><|CHAT2API|parameter name="city"><![CDATA[Seoul]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
const invalidXml = xml.replace('name="local_lookup"', 'name="unlisted_function"')
const tool = { type: 'function', function: { name: 'local_lookup',
  description: 'Closed synthetic weather lookup', parameters: {
    type: 'object', properties: { city: { type: 'string' } },
  } } }
const streamWire = (providerId, content, complete = true) => providerId === 'qwen-ai'
  ? [
    'data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [{
      index: 0, delta: { role: 'assistant', phase: 'answer', status: 'streaming', content },
      finish_reason: null,
    }] }) + '\n\n',
    ...(complete ? ['data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [{
      index: 0, delta: { role: 'assistant', phase: 'answer', status: 'finished', content: '' },
      finish_reason: 'stop',
    }] }) + '\n\n'] : []),
  ].join('')
  : [
    'data: ' + JSON.stringify({ type: 'chat:completion', data: { phase: 'answer', content } }) + '\n\n',
    ...(complete ? ['data: ' + JSON.stringify({ type: 'chat:completion', data: {
      phase: 'done', done: true,
    } }) + '\n\n'] : []),
  ].join('')

async function fixture(providerId, { body = xml, complete = true,
  accountRefused = false, loggingRefused = false } = {}) {
  const effects = { selected: 0, sent: 0, remoteCreate: 0, account: 0,
    success: 0, failure: 0, stats: [], received: [], closed: 0 }
  const account = { id: 'local71-' + providerId, providerId,
    status: 'active', name: 'Offline', credentials: { token: PRIVATE } }
  const provider = { id: providerId, name: 'Synthetic ' + providerId,
    enabled: true, createdAt: 1 }
  const fakeAdapter = class {
    constructor(ownProvider, ownAccount) {
      assert.equal(ownProvider.id, providerId)
      assert.equal(ownAccount.id, account.id)
    }
    async chatCompletion(request) {
      effects.remoteCreate++
      effects.received.push({ model: request.model, original: request.originalModel,
        resolved: request.resolvedModelId, messages: toPlain(request.messages) })
      const stream = new PassThrough({ autoDestroy: false })
      stream.once('close', () => { effects.closed++ })
      const content = streamWire(providerId, body, complete)
      setImmediate(() => {
        const bytes = Buffer.from(content, 'utf8')
        for (let i = 0; i < bytes.length; i += 13) {
          if (!stream.destroyed) stream.write(bytes.subarray(i, i + 13))
        }
        if (!stream.destroyed) stream.end()
      })
      return { response: { status: 200, data: stream, headers: {} },
        chatId: 'synthetic-chat', requestId: 'synthetic-request', parentId: null }
    }
    async deleteChat() { throw Error('Unapproved remote delete forbidden') }
  }
  const FakeZaiFailure = class extends Error {}
  const fakeForwarder = runSource('class SelectedForwarder { ' + methodSources.join('\n') +
    ' }\nexports.SelectedForwarder=SelectedForwarder', 'selected-forwarder.ts', {
    './adapters/qwen-ai': {
      QwenAiAdapter: fakeAdapter, QwenAiProxyFailure: class extends Error {},
      QwenAiStreamHandler: qwenHandler.QwenAiStreamHandler,
    },
    './adapters/zai': {
      ZaiAdapter: fakeAdapter, ZaiProxyFailure: FakeZaiFailure,
      ZaiStreamHandler: zaiHandler.ZaiStreamHandler,
    },
  })
  // The extracted production methods access their imports as free lexical
  // symbols in their original module. Inject exactly the original dependency
  // identities into the isolated module globals through a second loader.
  const source = 'const QwenAiAdapter = deps.QwenAiAdapter;\n' +
    'const QwenAiProxyFailure = deps.QwenAiProxyFailure;\n' +
    'const QwenAiStreamHandler = deps.QwenAiStreamHandler;\n' +
    'const ZaiAdapter = deps.ZaiAdapter;\n' +
    'const ZaiProxyFailure = deps.ZaiProxyFailure;\n' +
    'const ZaiStreamHandler = deps.ZaiStreamHandler;\n' +
    'const shouldDeleteSession = () => false;\n' +
    'const hasCompletedNonStreamAnswer = deps.hasCompletedNonStreamAnswer;\n' +
    'const unconfirmedProviderCompletion = latency => ({success:false,status:502,latency});\n' +
    'const safeWebErrorStatus = () => undefined;\n' +
    'class SelectedForwarder { ' + methodSources.join('\n') +
    ' }\nexports.SelectedForwarder = SelectedForwarder'
  const compiled = ts.transpileModule(source, { fileName: 'selected-forwarder.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const selected = { exports: {} }
  const deps = {
    QwenAiAdapter: fakeAdapter, QwenAiProxyFailure: class extends Error {},
    QwenAiStreamHandler: qwenHandler.QwenAiStreamHandler, ZaiAdapter: fakeAdapter,
    ZaiProxyFailure: FakeZaiFailure, ZaiStreamHandler: zaiHandler.ZaiStreamHandler,
    hasCompletedNonStreamAnswer: terminal.hasCompletedNonStreamAnswer,
  }
  runInNewContext(compiled, {
    module: selected, exports: selected.exports, deps, Date, Math, Error,
  }, { timeout: 2000, filename: 'selected-forwarder.ts',
    codeGeneration: { strings: false, wasm: false } })
  const forwarder = new selected.exports.SelectedForwarder()
  forwarder.transformRequestForPromptToolUse = (request, selectedProvider) =>
    new ToolCallingEngine(baseConfig).transformRequest({
      request, provider: selectedProvider, actualModel: request.model,
    })
  forwarder.applyToolCallsToResponse = (answer, transformed) =>
    new ToolCallingEngine(baseConfig).applyNonStreamResponse(answer, transformed.plan)
  forwarder.extractHeaders = () => ({})

  const storeManager = {
    getConfig: () => ({
      enableApiKey: true, apiKeys: [{ id: 'local71-key', key: 'local71-bearer',
        enabled: true, usageCount: 0 }], managementApi: { enableManagementApi: false },
      loadBalanceStrategy: 'round-robin', toolCallingConfig: baseConfig,
    }),
    updateConfig() {},
    recordAccountSuccess(id, providerIdOfRecord) {
      assert.equal(id, account.id)
      assert.equal(providerIdOfRecord, providerId)
      if (accountRefused) return false
      effects.account++
      return true
    },
    recordRequestInStats(ok) { effects.stats.push(ok) },
    addRequestLog() {
      if (loggingRefused) throw Error('PRIVATE_POSTCOMMIT_DIAGNOSTIC_ERROR')
      return { id: 'local71-log' }
    },
    updateRequestLog() {}, addLog() {},
  }
  const status = {
    recordRequestStart() {},
    recordRequestSuccess() { effects.success++ },
    recordRequestFailure() { effects.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0,
      activeConnections: 0 }),
    getHost: () => '127.0.0.1', getPort: () => 8080,
  }
  const chat = product('routes/chat.ts', {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => {
        effects.selected++
        return { account, provider, actualModel: 'exact-wire-model-fast' }
      }, clearAccountFailure() {}, markAccountFailed() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => providerId,
      getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: (request, ownAccount, ownProvider, wire) => {
        assert.equal(ownAccount.id, account.id)
        assert.equal(ownProvider.id, provider.id)
        assert.equal(wire, 'exact-wire-model-fast')
        effects.sent++
        return providerId === 'qwen-ai'
          ? forwarder.forwardQwenAi(request, ownAccount, ownProvider, wire, Date.now())
          : forwarder.forwardZai(request, ownAccount, ownProvider, wire, Date.now())
      },
    } },
    '../status': { proxyStatusManager: status },
    '../../store/store': { storeManager },
    '../streamTerminalGate': terminal,
    '../stream': { streamHandler: { createTransformStream() { throw Error('unexpected') } } },
    '../utils/toolFormatConverter': product('utils/toolFormatConverter.ts'),
  }).default
  const serverModule = product('server.ts', {
    koa: requireNode('koa'), electron: { app: { getVersion: () => 'offline-local71' } },
    '@koa/router': requireNode('@koa/router'), 'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chat], './routes/management': [],
    './status': { proxyStatusManager: status }, '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': product('localSecurity.ts'),
  })
  const proxy = serverModule.proxyServer
  const server = createServer(proxy.app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  proxy.port = port
  const send = (patch = {}, token = 'local71-bearer') => new Promise((resolve, reject) => {
    const parts = []
    const req = httpRequest({ hostname: '127.0.0.1', port,
      path: '/v1/chat/completions', method: 'POST', headers: {
        Host: '127.0.0.1:' + port, Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      } }, response => {
      response.on('data', part => parts.push(part))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch { json = null }
        resolve({ status: response.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(3500, () => req.destroy(Error('Closed local HTTP timeout')))
    req.end(JSON.stringify({
      model: 'display-alias', stream: false,
      messages: [{ role: 'user', content: 'Synthetic private request' }],
      tools: [tool], tool_choice: 'required', ...patch,
    }))
  })
  return { effects, send, async close() {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  } }
}

for (const provider of ['qwen-ai', 'zai']) {
  for (const stream of [false, true]) {
    for (const choice of ['required', { type: 'function', function: { name: 'local_lookup' } }]) {
      test('local71 ' + provider + ' stream=' + stream + ': managed XML authorized tool calls match nonstream', async () => {
        const f = await fixture(provider)
        try {
          const r = await f.send({ stream, tool_choice: choice })
          assert.equal(r.status, 200, r.raw)
          const events = stream
            ? r.raw.split('\n\n').filter(x => x.startsWith('data: ') && !x.includes('[DONE]'))
              .map(x => { try { return JSON.parse(x.slice(6)) } catch { return {} } })
            : []
          const calls = stream
            ? events.flatMap(x => x.choices?.[0]?.delta?.tool_calls ?? [])
            : r.json?.choices?.[0]?.message?.tool_calls
          assert.equal(calls?.length, 1, r.raw)
          assert.equal(calls[0].function.name, 'local_lookup')
          assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: 'Seoul' })
          if (stream) {
            assert.equal((r.raw.match(/data: \[DONE\]/g) || []).length, 1)
            assert.equal(r.raw.includes('<|CHAT2API|tool_calls>'), false)
          } else {
            assert.equal(r.json?.choices?.[0]?.finish_reason, 'tool_calls')
          }
          assert.equal(f.effects.selected, 1)
          assert.equal(f.effects.sent, 1)
          assert.equal(f.effects.remoteCreate, 1)
          assert.equal(f.effects.received[0].model, 'exact-wire-model-fast')
          assert.equal(f.effects.account, 1)
          assert.equal(f.effects.success, 1)
          assert.deepEqual(f.effects.stats, [true])
          assert.equal(r.raw.includes(PRIVATE), false)
        } finally { await f.close() }
      })
    }
    test('local71 ' + provider + ' stream=' + stream + ': unknown managed function never settles success', async () => {
      const f = await fixture(provider, { body: invalidXml })
      try {
        const r = await f.send({ stream })
        if (stream) assert.equal(r.raw.includes('data: [DONE]'), false)
        else assert.equal(r.status, 502, r.raw)
        assert.equal(f.effects.account, 0)
        assert.equal(f.effects.success, 0)
        assert.deepEqual(f.effects.stats, [false])
        assert.equal(f.effects.remoteCreate, 1)
      } finally { await f.close() }
    })
    test('local71 ' + provider + ' stream=' + stream + ': upstream partial EOF refuses completion', async () => {
      const f = await fixture(provider, { complete: false })
      try {
        const r = await f.send({ stream })
        if (stream) assert.equal(r.raw.includes('data: [DONE]'), false)
        else assert.notEqual(r.status, 200)
        assert.equal(f.effects.account, 0)
        assert.equal(f.effects.success, 0)
        assert.deepEqual(f.effects.stats, [false])
      } finally { await f.close() }
    })
  }
}
test('local71 invalid HTTP auth never dispatches web adapter', async () => {
  const f = await fixture('qwen-ai')
  try {
    const r = await f.send({}, 'invalid-bearer')
    assert.equal(r.status, 401)
    assert.equal(f.effects.selected, 0)
    assert.equal(f.effects.remoteCreate, 0)
  } finally { await f.close() }
})
test('local71 post-commit logger refusal preserves valid managed tool result', async () => {
  const f = await fixture('qwen-ai', { loggingRefused: true })
  try {
    const r = await f.send({ stream: false })
    assert.equal(r.status, 200, r.raw)
    assert.equal(f.effects.account, 1)
    assert.equal(r.raw.includes('PRIVATE_POSTCOMMIT_DIAGNOSTIC_ERROR'), false)
  } finally { await f.close() }
})
test('local71 refused mandatory account settlement never emits stream DONE', async () => {
  const f = await fixture('zai', { accountRefused: true })
  try {
    const r = await f.send({ stream: true })
    assert.equal(r.raw.includes('data: [DONE]'), false)
    assert.equal(f.effects.account, 0)
  } finally { await f.close() }
})
