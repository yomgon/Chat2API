import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Production parsers and forwarder, with every dependency/transport explicitly
// stubbed. No Electron profile, socket, provider request, or real credential.
const root = new URL('../../', import.meta.url)
const PRIVATE = 'SYNTHETIC_KIMI_FRAME_VALUE_NOT_FOR_ERRORS'
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const compile = relative => ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
  fileName: relative,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const adapterCode = compile('src/main/proxy/adapters/kimi.ts')
const protocolCode = compile('src/main/proxy/adapters/providerModelOptions.ts')
const forwarderCode = compile('src/main/proxy/forwarder.ts')

function load(code, dependencies, logs) {
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, Date, Error,
    setTimeout, clearTimeout,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected offline fixture dependency')
    },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
  }, { timeout: 1500 })
  return module.exports
}

function harness(upstream) {
  const logs = []
  const calls = []
  const axios = { create: () => ({}), post: async (url, body, config) => {
    calls.push({ url, body, config })
    if (url.endsWith('/Chat')) return { status: 200,
      headers: { 'content-type': 'application/connect+json' }, data: upstream }
    if (url.endsWith('/DeleteChat')) return { status: 200, data: {} }
    throw new Error('Unexpected offline fixture operation')
  } }
  const exports = load(adapterCode, {
    axios: { __esModule: true, default: axios }, stream: { PassThrough },
    './providerModelOptions': load(protocolCode, {}, logs),
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) =>
      ({ id, model, created, object: 'chat.completion.chunk' }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }, logs)
  return { ...exports, axios, calls, logs }
}

function frame(flag, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
const answer = (content = 'fixture answer') => ({
  op: 'append', mask: 'block.text.content', block: { text: { content, flags: 'answer' } },
})
const prefix = () => Buffer.concat([
  frame(0, { chat: { id: 'synthetic-chat' } }), frame(0, answer()),
])

function watchOutput(output) {
  const state = { chunks: [], ended: false }
  output.on('data', chunk => state.chunks.push(chunk.toString('utf8')))
  output.once('end', () => { state.ended = true })
  output.on('error', () => {})
  return state
}

async function runHandler(t, mode) {
  const upstream = new PassThrough({ autoDestroy: false })
  const h = harness(upstream)
  const handler = new h.KimiStreamHandler('k2d6-chat', '')
  const state = { escaped: false, result: undefined }
  let output
  let observed
  if (mode === 'stream') {
    output = await handler.handleStream(upstream)
    observed = watchOutput(output)
  } else {
    handler.handleNonStream(upstream).then(value => {
      state.result = { value }
    }, error => { state.result = { error } })
  }
  t.after(() => { upstream.destroy(); output?.destroy() })
  const write = bytes => {
    try { upstream.write(bytes) } catch { state.escaped = true; upstream.destroy() }
  }
  const end = () => {
    try { upstream.end() } catch { state.escaped = true; upstream.destroy() }
  }
  return { ...h, handler, upstream, state, observed, write, end }
}

function assertFailed(run, mode) {
  assert.equal(run.state.escaped, false, 'malformed provider bytes must not throw outside the data callback')
  assert.equal(run.handler.hasSessionError(), true)
  assert.equal(run.handler.hasSuccessfulTerminal(), false, 'cleanup must not receive a success gate')
  if (mode === 'stream') {
    const text = run.observed.chunks.join('')
    assert.equal(run.observed.ended, true)
    assert.equal(text.includes('"error"'), true)
    assert.equal(text.includes('data: [DONE]'), false)
    assert.equal(text.includes('"finish_reason":"stop"'), false)
    assert.equal(text.includes(PRIVATE), false)
  } else {
    assert.equal(run.state.result?.error instanceof run.KimiProxyFailure, true)
    assert.equal(run.state.result.error.stage, 'response-decoding')
    assert.equal(run.state.result.error.message, 'Kimi response decoding failed')
    assert.equal(run.state.result.error.cause, undefined)
  }
  assert.equal(JSON.stringify(run.logs).includes(PRIVATE), false)
  assert.equal(run.calls.length, 0)
}

test('malformed masks and text objects become fixed failures in both data callbacks', async t => {
  const invalid = [
    { ...answer(), mask: 7 }, { ...answer(), mask: {} }, { ...answer(), mask: [] },
    { ...answer(), mask: null },
    { ...answer(), block: { text: { content: { private: PRIVATE } } } },
    { ...answer(), block: { text: { content: [PRIVATE] } } },
    { ...answer(), mask: 'block.think.content', block: { think: { content: { private: PRIVATE } } } },
  ]
  for (const mode of ['stream', 'nonstream']) for (const message of invalid) {
    const run = await runHandler(t, mode)
    run.write(frame(0, message))
    run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('a present but malformed terminal error never becomes a successful answer', async t => {
  for (const mode of ['stream', 'nonstream']) for (const error of [null, false, 0, '', [], {}, { code: 7 }]) {
    const run = await runHandler(t, mode)
    run.write(prefix())
    run.write(frame(2, { error }))
    run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('terminal envelopes reject nonobjects, message payloads, and malformed metadata', async t => {
  const invalid = [null, [], false, 7, 'terminal', answer(PRIVATE),
    { metadata: null }, { metadata: [] }, { metadata: { fixture: PRIVATE } },
    { metadata: { fixture: [7] } }]
  for (const mode of ['stream', 'nonstream']) for (const terminal of invalid) {
    const run = await runHandler(t, mode)
    run.write(prefix())
    run.write(frame(2, terminal))
    run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('coalesced data or duplicate/error frames after a terminal are rejected', async t => {
  const suffixes = [Buffer.from([0]), frame(0, answer(PRIVATE)), frame(2, {}),
    frame(2, { error: { code: 'permission_denied', message: PRIVATE } })]
  for (const mode of ['stream', 'nonstream']) for (const suffix of suffixes) {
    const run = await runHandler(t, mode)
    run.write(Buffer.concat([prefix(), frame(2, {}), suffix]))
    run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('terminal success remains pending until EOF and later chunks cannot be ignored', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode)
    run.write(Buffer.concat([prefix(), frame(2, {})]))
    await nextTurn()
    assert.equal(run.handler.hasSuccessfulTerminal(), false)
    assert.equal(run.state.result, undefined)
    if (mode === 'stream') assert.equal(run.observed.chunks.join('').includes('[DONE]'), false)
    run.write(frame(0, answer(PRIVATE)))
    run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('missing or out-of-order terminals and abort before clean EOF never succeed', async t => {
  for (const mode of ['stream', 'nonstream']) for (const kind of ['missing', 'before-answer', 'aborted', 'close']) {
    const run = await runHandler(t, mode)
    if (kind !== 'before-answer') run.write(prefix())
    if (kind !== 'missing') run.write(frame(2, {}))
    if (kind === 'aborted') run.upstream.emit('aborted')
    else if (kind === 'close') run.upstream.destroy()
    else run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('ordinary answer, application done, valid metadata, and clean EOF preserve success', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode)
    run.write(prefix())
    run.write(frame(0, { done: true }))
    run.write(frame(2, { metadata: { 'x-fixture': ['ok'] } }))
    run.end()
    await nextTurn()
    assert.equal(run.state.escaped, false)
    assert.equal(run.handler.hasSessionError(), false)
    if (mode === 'stream') {
      assert.equal(run.handler.hasSuccessfulTerminal(), true)
      assert.equal(run.observed.ended, true)
      assert.equal(run.observed.chunks.join('').match(/data: \[DONE\]/g)?.length, 1)
    } else {
      assert.equal(run.state.result?.value?.choices[0].message.content, 'fixture answer')
    }
  }
})

function forwarder(h) {
  class Inert {}
  for (const name of ['DeepSeek', 'GLM', 'Mimo', 'Qwen', 'QwenAi', 'Zai', 'MiniMax', 'Perplexity']) {
    Inert['is' + name + 'Provider'] = () => false
  }
  const { RequestForwarder } = load(forwarderCode, {
    axios: { __esModule: true, default: h.axios }, http2: { __esModule: true, default: {} },
    stream: { PassThrough },
    '../store/store': { storeManager: { getConfig: () => ({ retryCount: 5,
      contextManagement: { enabled: true }, toolCallingConfig: {} }) } },
    './status': { proxyStatusManager: {} },
    './adapters/deepseek': { DeepSeekAdapter: Inert },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: Inert },
    './adapters/glm': { GLMAdapter: Inert, GLMStreamHandler: Inert },
    './adapters/kimi': h,
    './adapters/mimo': { MimoAdapter: Inert, MimoStreamHandler: Inert },
    './adapters/qwen': { QwenAdapter: Inert, QwenStreamHandler: Inert },
    './adapters/qwen-ai': { QwenAiAdapter: Inert, QwenAiStreamHandler: Inert, QwenAiProxyFailure: Inert },
    './adapters/zai': { ZaiAdapter: Inert, ZaiProxyFailure: Inert, ZaiStreamHandler: Inert },
    './adapters/minimax': { MiniMaxAdapter: Inert, MiniMaxStreamHandler: Inert },
    './adapters/perplexity': { PerplexityAdapter: Inert },
    './adapters/perplexity-stream': { PerplexityStreamHandler: Inert },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class {
      transformRequest({ request }) { return { messages: request.messages, plan: { shouldParseResponse: false } } }
      applyNonStreamResponse() {}
    } },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => true } },
    './streamTerminalGate': { hasCompletedNonStreamAnswer: value =>
      value?.choices?.[0]?.message?.role === 'assistant' &&
      typeof value.choices[0].message.content === 'string' &&
      !!value.choices[0].message.content.trim() },
    './services/contextManagementService': { createContextManagementService() {
      throw new Error('Consumer web call must not add an implicit summary')
    } },
  }, h.logs)
  return new RequestForwarder()
}

test('real forwarder preserves decoding failure and sends no cleanup for invalid terminal order', async t => {
  for (const stream of [false, true]) for (const valid of [false, true]) {
    const upstream = new PassThrough({ autoDestroy: false })
    const h = harness(upstream)
    const request = { model: 'Instant', messages: [{ role: 'user', content: 'synthetic request' }], stream }
    let result
    let output
    const pending = forwarder(h).forwardChatCompletion(request,
      { id: 'synthetic-account', providerId: 'kimi', credentials: { token: 'SYNTHETIC_TOKEN' } },
      { id: 'kimi', apiEndpoint: 'https://www.kimi.com' }, 'k2d6-chat',
      { requestId: 'synthetic-request', model: 'Instant', startTime: Date.now(), isStream: stream })
      .then(value => { result = value; return value })
    await nextTurn()
    if (stream) output = watchOutput((await pending).stream)
    t.after(() => { upstream.destroy(); result?.stream?.destroy() })
    upstream.write(Buffer.concat([prefix(), frame(2, {})]))
    await nextTurn()
    assert.equal(h.calls.filter(call => call.url.endsWith('/DeleteChat')).length, 0,
      'terminal bytes alone must not authorize cleanup before EOF')
    if (!valid) upstream.write(frame(0, answer(PRIVATE)))
    upstream.end()
    await nextTurn()
    assert.equal(h.calls.filter(call => call.url.endsWith('/Chat')).length, 1)
    assert.equal(h.calls.filter(call => call.url.endsWith('/DeleteChat')).length, valid ? 1 : 0)
    if (stream) {
      assert.equal(output.chunks.join('').includes('[DONE]'), valid)
      assert.equal(output.chunks.join('').includes(PRIVATE), false)
    } else if (!valid) {
      assert.equal(result?.success, false)
      assert.equal(result.status, 502)
      assert.equal(result.failureStage, 'response-decoding')
      assert.equal(result.failureCode, 'kimi_upstream_operation_failed')
    } else assert.equal(result?.success, true)
    assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  }
})
