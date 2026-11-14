import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual production Koa Chat router (including input, model/pin and failure
// boundaries), with exact in-memory selections and inert forwarders. The only
// listener is loopback 127.0.0.1:0; no vendor, profile or credential is read.
const requireNode = createRequire(import.meta.url)
const source = readFileSync(new URL('../../src/main/proxy/routes/chat.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  fileName: 'chat.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText
const API_KEY = 'SYNTHETIC_LOCAL92_LOOPBACK_KEY'
const SECRET = 'SYNTHETIC_LOCAL92_SECRET_NEVER_ECHO'
const complete = { id: 'offline92', object: 'chat.completion', model: 'wire92',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Offline only' }, finish_reason: 'stop' }] }

async function fixture(providerId, { alias = false } = {}) {
  const events = { selects: 0, reserves: 0, forward: 0, accountSuccess: 0, stats: [], logs: 0 }
  const provider = { id: alias ? 'configured-origin-alias' : providerId,
    name: 'Synthetic ' + providerId, enabled: true, type: 'builtin' }
  const account = { id: 'pinned-' + providerId, providerId: provider.id,
    name: 'Synthetic account', credentials: { token: SECRET }, status: 'active' }
  const selection = { provider, account, actualModel: 'exact-wire-' + providerId }
  const balancer = {
    selectAccount() { events.selects++; return selection },
    reserveSelectedAccount(s) { assert.equal(s, selection); events.reserves++; return () => {} },
    markAccountFailed() { throw Error('No input validation may mark the account failed') },
    clearAccountFailure() {},
  }
  const forwarder = {
    getConsumerWebProviderId: () => providerId,
    requiresAdditionalSummary: async () => false,
    async forwardChatCompletion(req, a, p, model) {
      events.forward++
      assert.equal(a, account)
      assert.equal(p, provider)
      assert.equal(model, selection.actualModel)
      return { success: true, status: 200, body: complete }
    },
  }
  const status = { recordRequestStart() {}, recordRequestFailure() {}, recordRequestSuccess() {} }
  const store = {
    getConfig: () => ({ loadBalanceStrategy: 'round-robin' }),
    recordAccountSuccess: () => { events.accountSuccess++; return true },
    recordRequestInStats: ok => { events.stats.push(ok) },
    addLog() { events.logs++ }, addRequestLog() { return { id: 'offline-log' } },
  }
  const deps = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: balancer },
    '../forwarder': { requestForwarder: forwarder },
    '../stream': { streamHandler: {} },
    '../streamTerminalGate': {
      hasCompletedNonStreamAnswer: body => body === complete,
      getStopSequences: () => [], applyStopSequencesNonStream: x => x,
      createStopSequenceSseStream() { throw Error('No streaming dispatch permitted') },
      createOpenAIStreamTerminalGate() { throw Error('No stream handshake permitted') },
    },
    '../status': { proxyStatusManager: status },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id,
    } },
    '../../store/store': { storeManager: store },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic() { throw Error('Not requested') },
      transformChunkToAnthropic() { throw Error('Not requested') },
    },
  }
  const mod = { exports: {} }
  runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, TextDecoder, Error, Date, Math,
    URL, JSON, Set, Map, Object, Number, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      throw Error('Unexpected production dependency ' + name)
    },
  }, { filename: 'actual-chat-route-local92.ts', timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  const Koa = requireNode('koa')
  const app = new Koa()
  app.use(async (ctx, next) => {
    if (ctx.headers.authorization !== 'Bearer ' + API_KEY) {
      ctx.status = 401; return
    }
    return next()
  })
  app.use(requireNode('koa-bodyparser')())
  app.use(mod.exports.default.routes())
  app.use(mod.exports.default.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const post = (messages, stream = false) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'public-model-alias', messages, stream })
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port,
      path: '/v1/chat/completions', method: 'POST',
      headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body)
  })
  return { post, events, provider, account, close: () => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())) }
}

for (const stream of [false, true]) {
  test('Qwen Intl refuses multi-turn HTTP before account reservation and effects, stream=' + stream, async () => {
    const h = await fixture('qwen-ai')
    try {
      const response = await h.post([
        { role: 'user', content: 'Question one' },
        { role: 'assistant', content: 'Prior response' },
        { role: 'user', content: 'Next question' },
      ], stream)
      assert.equal(response.status, 400)
      assert.equal(response.body.error.param, 'messages')
      assert.equal(response.body.error.code, 'unsupported_message_history')
      assert.deepEqual([h.events.selects, h.events.reserves, h.events.forward,
        h.events.accountSuccess], [1, 0, 0, 0])
      assert.deepEqual(h.events.stats, [])
      assert.equal(response.text.includes(SECRET), false)
    } finally { await h.close() }
  })

  test('Z.ai refuses tool history before account reservation and effects, stream=' + stream, async () => {
    const h = await fixture('zai', { alias: true })
    try {
      const response = await h.post([
        { role: 'user', content: 'Find one fact' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call92', type: 'function',
          function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call92', content: 'Synthetic tool output' },
        { role: 'user', content: 'Continue' },
      ], stream)
      assert.equal(response.status, 400)
      assert.equal(response.body.error.param, 'messages')
      assert.equal(response.body.error.code, 'unsupported_message_history')
      assert.deepEqual([h.events.selects, h.events.reserves, h.events.forward,
        h.events.accountSuccess], [1, 0, 0, 0])
      assert.deepEqual(h.events.stats, [])
      assert.equal(response.text.includes(SECRET), false)
    } finally { await h.close() }
  })

  test('Text part metadata cannot be silently dropped by Kimi or another consumer, stream=' + stream, async () => {
    const h = await fixture('kimi')
    try {
      const response = await h.post([{ role: 'user', content: [
        { type: 'text', text: 'plain content', unrecognized_payload: 'SHOULD_NOT_DROP' },
      ] }], stream)
      assert.equal(response.status, 400)
      assert.equal(response.body.error.param, 'messages')
      assert.equal(h.events.selects, 0)
      assert.equal(h.events.forward, 0)
      assert.equal(h.events.reserves, 0)
      assert.equal(response.text.includes(SECRET), false)
    } finally { await h.close() }
  })
}

for (const providerId of ['qwen-ai', 'zai', 'kimi']) {
  test(providerId + ' retains supported text-only exact model/account dispatch', async () => {
    const h = await fixture(providerId)
    try {
      const messages = providerId === 'zai'
        ? [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' },
          { role: 'user', content: [{ type: 'text', text: 'Again' }] }]
        : [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]
      const response = await h.post(messages)
      assert.equal(response.status, 200)
      assert.equal(response.body.choices[0].message.content, 'Offline only')
      assert.deepEqual([h.events.selects, h.events.reserves, h.events.forward,
        h.events.accountSuccess], [1, 1, 1, 1])
      assert.deepEqual(h.events.stats, [true])
      assert.equal(response.text.includes(SECRET), false)
    } finally { await h.close() }
  })
}
