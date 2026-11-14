import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real Koa auth/body parser + product chat/legacy routes + terminal gate.
// All account, storage and provider effects are synthetic. No Electron profile,
// operating credentials, provider service or fixed operating port is accessed.
const requireNode = createRequire(import.meta.url)
const source = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const compiled = path => ts.transpileModule(source(path), {
  fileName: path,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

function product(path, mocks) {
  const module = { exports: {} }
  runInNewContext(compiled(path), {
    module, exports: module.exports,
    require(specifier) {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier]
      if (specifier.startsWith('.')) throw new Error('Unapproved product dependency: ' + specifier)
      return requireNode(specifier)
    },
    Buffer, TextDecoder, Date, JSON, Math, Error,
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: path, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}

const validUsage = Object.freeze({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 })
const invalidUsages = [
  { prompt_tokens: '4', completion_tokens: 6, total_tokens: 10 },
  { prompt_tokens: -1, completion_tokens: 6, total_tokens: 5 },
  { prompt_tokens: 4, completion_tokens: 6.5, total_tokens: 10.5 },
  { prompt_tokens: 4, completion_tokens: 6 },
]
const reply = usage => ({
  id: 'synthetic-reply', object: 'chat.completion', created: 1, model: 'synthetic-wire',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'synthetic answer' } }],
  ...(usage === undefined ? {} : { usage }),
})
const frame = json => 'data: ' + JSON.stringify(json) + '\n\n'
const answer = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: { role: 'assistant', content: 'synthetic answer' }, finish_reason: null },
] })
const finish = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: {}, finish_reason: 'stop' },
] })

async function fixture() {
  const effects = { send: 0, settle: 0, success: 0, failure: 0, stats: [], logs: [] }
  const account = { id: 'synthetic-account', providerId: 'qwen', name: 'local only', status: 'active' }
  const provider = { id: 'qwen', name: 'Synthetic', enabled: true, createdAt: 1000 }
  let forwarded = { success: true, status: 200, body: reply() }
  const config = {
    enableApiKey: true, apiKeys: [{ id: 'key-only', key: 'fixture-key', enabled: true, usageCount: 0 }],
    managementApi: { enableManagementApi: false, managementApiSecret: 'synthetic-secret' },
    modelMappings: { 'public-model': { actualModel: 'synthetic-wire', preferredProviderId: 'qwen',
      preferredAccountId: account.id } },
    loadBalanceStrategy: 'round-robin',
  }
  const storeManager = {
    getConfig: () => config, updateConfig: () => {},
    getProviders: () => [provider],
    getAccountsByProviderId: () => [account],
    getEffectiveModels: () => [{ actualModelId: 'synthetic-wire', displayName: 'synthetic-display' }],
    recordAccountSuccess: (accountId, providerId) => {
      assert.equal(accountId, account.id); assert.equal(providerId, provider.id)
      effects.settle++; return true
    },
    recordRequestInStats: succeeded => effects.stats.push(succeeded),
    addRequestLog: () => ({ id: 'fixture-log' }), updateRequestLog: () => true,
    addLog: (_level, name) => effects.logs.push(name),
  }
  const proxyStatusManager = {
    recordRequestStart() {}, recordRequestSuccess() { effects.success++ },
    recordRequestFailure() { effects.failure++ },
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, activeConnections: 0 }),
    getPort: () => 8080, getHost: () => '127.0.0.1',
  }
  const loadBalancer = {
    selectAccount: () => ({ account, provider, actualModel: 'synthetic-wire' }),
    clearAccountFailure() {}, markAccountFailed() {},
  }
  const modelMapper = {
    getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id,
  }
  const requestForwarder = {
    forwardChatCompletion: async () => { effects.send++; return forwarded },
  }
  const gate = product('src/main/proxy/streamTerminalGate.ts', {})
  const legacy = product('src/main/proxy/legacyCompletion.ts', {})
  const dependencies = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer }, '../modelMapper': { modelMapper },
    '../forwarder': { requestForwarder }, '../status': { proxyStatusManager },
    '../../store/store': { storeManager },
    '../streamTerminalGate': gate, '../legacyCompletion': legacy,
    '../stream': { streamHandler: { createTransformStream: () => { throw Error('No raw provider transform') } } },
  }
  const chatRouter = product('src/main/proxy/routes/chat.ts', {
    ...dependencies, '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw Error('No anthropic fixture') },
      transformChunkToAnthropic: () => { throw Error('No anthropic fixture') },
    },
  }).default
  const legacyRouter = product('src/main/proxy/routes/completions.ts', dependencies).default
  const security = product('src/main/proxy/localSecurity.ts', {})
  const server = product('src/main/proxy/server.ts', {
    koa: requireNode('koa'),
    electron: { app: { getVersion: () => 'local38-synthetic' } },
    '@koa/router': requireNode('@koa/router'),
    'koa-bodyparser': requireNode('koa-bodyparser'),
    './routes': [chatRouter, legacyRouter],
    './routes/management': [],
    './status': { proxyStatusManager },
    '../store/store': { storeManager },
    './sessionManager': { sessionManager: { initialize() {}, destroy() {} } },
    './localSecurity': security,
  }).proxyServer
  const listener = createServer(server.app.callback())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  server.port = port
  const fetchLocal = (path, body) => new Promise((resolve, reject) => {
    const chunks = []
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: {
        Host: '127.0.0.1:' + port,
        Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json',
      },
    }, response => {
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch { json = null }
        resolve({ status: response.statusCode, raw, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(2500, () => req.destroy(Error('Synthetic loopback timeout')))
    req.end(JSON.stringify(body))
  })
  return {
    effects, fetchLocal, setResult: next => { forwarded = next },
    close: async () => {
      listener.closeAllConnections()
      await new Promise((resolve, reject) => listener.close(err => err ? reject(err) : resolve()))
    },
  }
}

function requestBody(legacy, streaming) {
  return legacy ? { model: 'public-model', prompt: 'local synthetic', stream: streaming }
    : { model: 'public-model', messages: [{ role: 'user', content: 'local synthetic' }], stream: streaming }
}
function pathFor(legacy) {
  return legacy ? '/v1/completions' : '/v1/chat/completions'
}

for (const legacy of [false, true]) {
  const route = legacy ? 'legacy' : 'chat'
  test(`real Koa ${route} input: unsupported core parameter values must fail before any provider effect`, async t => {
    const f = await fixture(); t.after(f.close)
    const invalidOptions = [
      { max_tokens: -1 },
      { max_tokens: '12' },
      { temperature: 'warm' },
      { top_p: 1.2 },
      { stop: { unintended: 'object' } },
      { stop: ['valid', 12] },
      { n: 2 },
    ]
    for (const options of invalidOptions) {
      const result = await f.fetchLocal(pathFor(legacy),
        { ...requestBody(legacy, false), ...options })
      assert.equal(result.status, 400, JSON.stringify(options))
      assert.equal(result.json?.error?.type, 'invalid_request_error')
    }
    assert.equal(f.effects.send, 0, 'Validation must precede account reservation or remote effect')
    assert.equal(f.effects.settle, 0)
    assert.equal(f.effects.stats.length, 0)
  })
  test(`real Koa ${route} nonstream: invalid provider usage must not count a successful answer`, async t => {
    const f = await fixture(); t.after(f.close)
    for (const usage of invalidUsages) {
      f.setResult({ success: true, status: 200, body: reply(usage) })
      const result = await f.fetchLocal(pathFor(legacy), requestBody(legacy, false))
      assert.equal(result.status, 502, JSON.stringify(usage))
      assert.equal(result.json?.choices, undefined)
    }
    assert.equal(f.effects.settle, 0)
    assert.equal(f.effects.success, 0)
    assert.deepEqual(f.effects.stats, Array(invalidUsages.length).fill(false))
    assert.equal(f.effects.send, invalidUsages.length, 'No retry for any remote effect')
  })
  test(`real Koa ${route} stream: invalid usage-only frame must suppress terminal DONE and settlement`, async t => {
    const f = await fixture(); t.after(f.close)
    const upstream = new PassThrough()
    f.setResult({ success: true, status: 200, stream: upstream, skipTransform: true })
    const pending = f.fetchLocal(pathFor(legacy), requestBody(legacy, true))
    await new Promise(resolve => setTimeout(resolve, 25))
    upstream.end(answer + finish + frame({
      object: 'chat.completion.chunk', choices: [], usage: invalidUsages[0],
    }) + 'data: [DONE]\n\n')
    const res = await pending
    assert.doesNotMatch(res.raw, /data: \[DONE\]/)
    assert.match(res.raw, /provider_stream_incomplete/)
    assert.equal(f.effects.settle, 0)
    assert.equal(f.effects.success, 0)
    assert.deepEqual(f.effects.stats, [false])
    assert.equal(f.effects.send, 1)
  })
  test(`real Koa ${route}: valid usage and missing usage retain normal answer behavior`, async t => {
    const f = await fixture(); t.after(f.close)
    f.setResult({ success: true, status: 200, body: reply(validUsage) })
    const good = await f.fetchLocal(pathFor(legacy), requestBody(legacy, false))
    assert.equal(good.status, 200)
    assert.deepEqual(good.json.usage, validUsage)
    f.setResult({ success: true, status: 200, body: reply(undefined) })
    const omitted = await f.fetchLocal(pathFor(legacy), requestBody(legacy, false))
    assert.equal(omitted.status, 200)
    assert.equal(omitted.json.usage, undefined)
    assert.equal(f.effects.settle, 2)
  })
}

test('real Koa chat messages: malformed parts and tool turns fail before account/provider dispatch', async t => {
  const f = await fixture(); t.after(f.close)
  const badMessages = [
    [{ role: 'user', content: [null] }],
    [{ role: 'user', content: [] }],
    [{ role: 'user', content: [{ type: 'text' }] }],
    [{ role: 'user', content: [{ type: 'text', text: 7 }] }],
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 10 } }] }],
    [{ role: 'user', content: [{ type: 'file', file: { file_data: 'private' } }] }],
    [{ role: 'system', content: null }],
    [{ role: 'user', content: null }],
    [{ role: 'tool', content: 'tool output' }],
    [{ role: 'tool', tool_call_id: 9, content: 'tool output' }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: '', type: 'function',
      function: { name: 'lookup', arguments: '{}' } }] }],
    [{ role: 'assistant', content: 'text', tool_calls: [{ id: 'call1', type: 'function',
      function: { name: 'lookup', arguments: { city: 'synthetic' } } }] }],
    [{ role: 'user', content: 'text', tool_calls: [{ id: 'call1', type: 'function',
      function: { name: 'lookup', arguments: '{}' } }] }],
    [{ role: 'user', content: [{ type: 'text', text: 'safe', image_url: { url: 'file://ignored' } }] }],
    [{ role: 'user', content: 'text', attachments: ['undocumented'] }],
  ]
  for (const messages of badMessages) {
    const result = await f.fetchLocal('/v1/chat/completions',
      { model: 'public-model', messages, stream: false })
    assert.equal(result.status, 400, JSON.stringify(messages))
    assert.equal(result.json?.error?.type, 'invalid_request_error')
  }
  assert.equal(f.effects.send, 0, 'Malformed messages never reach upstream or consume a provider operation')
  assert.equal(f.effects.settle, 0)
  assert.equal(f.effects.stats.length, 0)
})

test('real Koa Qwen chat messages: valid text-part and tool replay remain available; image is rejected', async t => {
  const f = await fixture(); t.after(f.close)
  const validMessages = [
    [{ role: 'user', content: [{ type: 'text', text: 'synthetic text' }] }],
    [{ role: 'assistant', content: null, tool_calls: [
      { id: 'call_one', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ] }, { role: 'tool', tool_call_id: 'call_one', content: 'synthetic result' },
    { role: 'user', content: 'summarize result' }],
  ]
  for (const messages of validMessages) {
    const result = await f.fetchLocal('/v1/chat/completions',
      { model: 'public-model', messages, stream: false })
    assert.equal(result.status, 200, JSON.stringify(messages))
  }
  // This fixture pins Qwen China. The actual Qwen text projector discarded
  // image_url even when the route previously accepted the request as a
  // successful model reply. The local60 auth-Koa RED now requires fail-closed
  // before this provider receives an unsupported multimodal prompt; a GLM
  // positive with image_url is covered separately by the local60 fixture.
  const unsupportedImage = await f.fetchLocal('/v1/chat/completions', {
    model: 'public-model', stream: false, messages: [
      { role: 'user', content: [{ type: 'text', text: 'question' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } }] },
    ],
  })
  assert.equal(unsupportedImage.status, 400)
  assert.equal(unsupportedImage.json?.error?.code, 'unsupported_message_content')
  assert.equal(f.effects.send, validMessages.length)
  assert.equal(f.effects.settle, validMessages.length)
})
