import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import * as streams from 'node:stream'
import * as zlib from 'node:zlib'
import vm from 'node:vm'
import ts from 'typescript'
import { createParser } from 'eventsource-parser'

// Production adapter and terminal gate with explicit offline dependencies.
// No application/profile/account import, credential, socket or provider call.
const root = new URL('../../', import.meta.url)
const compile = relative => ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
  fileName: relative,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const adapterCode = compile('src/main/proxy/adapters/qwen.ts')
const gateCode = compile('src/main/proxy/streamTerminalGate.ts')
const PRIVATE = 'SYNTHETIC_QWEN_PRIVATE_ERROR_NEVER_OUTPUT'
const MODEL = 'tongyi-qwen37-max-model'
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const sse = (value, event) => Buffer.from((event ? 'event: ' + event + '\n' : '') +
  'data: ' + JSON.stringify(value) + '\n\n', 'utf8')
const message = (content = 'safe answer', status = 'streaming', extra = {}) => ({
  communication: { sessionid: 'synthetic-session', reqid: 'synthetic-response' },
  data: { messages: [{ mime_type: 'multi_load/iframe', status, content, ...extra }] },
})
const finish = content => sse(message(content, 'complete'))
const errorEvent = () => sse({ error_code: 1001, error_msg: PRIVATE })
const fixedError = () => Object.assign(new Error(PRIVATE), {
  config: { headers: { Authorization: PRIVATE } }, response: { data: { secret: PRIVATE } },
})

function load(code, dependencies, logs, timers = {}) {
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, Date, Error, Uint8Array, TextDecoder, TextEncoder,
    setTimeout: timers.setTimeout ?? setTimeout, clearTimeout: timers.clearTimeout ?? clearTimeout,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected offline fixture import')
    },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
  }, { timeout: 1500 })
  return module.exports
}
const gate = load(gateCode, { stream: streams }, [])

function harness(options = {}) {
  const logs = [], calls = [], toolInputs = []
  const state = { zstdCallback: undefined, flushes: 0 }
  const blocked = () => { calls.push('blocked transport'); throw new Error('No transport is allowed') }
  const codec = { run(callback) {
    if (options.zstdRunThrows) throw fixedError()
    const ready = () => callback({ Simple: class {
      decompress() {
        if (options.zstdThrows) throw fixedError()
        return options.zstdResult
      }
    } })
    if (options.deferZstd) state.zstdCallback = ready
    else ready()
  } }
  const exports = load(adapterCode, {
    axios: { __esModule: true, default: { create: () => ({ post: blocked }), post: blocked, get: blocked } },
    stream: streams,
    zlib: options.zlib ?? zlib,
    // This is the installed module's real export shape, not a permissive run stub.
    'zstd-codec': { ZstdCodec: codec },
    'eventsource-parser': { createParser },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
    '../utils/tools': { hasToolPromptInjected: () => false, shouldInjectToolPrompt: () => false,
      toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) =>
      ({ id, model, created, object: 'chat.completion.chunk' }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {
      push(content, base, first) {
        toolInputs.push(content)
        return [{ ...base, choices: [{ index: 0,
          delta: { ...(first ? { role: 'assistant' } : {}), content }, finish_reason: null }] }]
      }
      flush() {
        state.flushes++
        options.onFlush?.()
        if (options.flushThrows) throw fixedError()
        return []
      }
      hasEmittedToolCall() { return false }
    } },
  }, logs, options.timers)
  return { ...exports, logs, calls, toolInputs, codecState: state }
}

async function runHandler(t, mode, options = {}) {
  const h = harness(options)
  const upstream = options.source ?? new streams.PassThrough({ autoDestroy: false })
  const cleanup = []
  const handler = new h.QwenStreamHandler(MODEL, () => {
    cleanup.push('success')
    if (options.cleanupThrows) throw fixedError()
    if (options.cleanupRejects) return Promise.reject(fixedError())
  }, options.withTools ? { shouldParseResponse: true } : undefined)
  const state = { chunks: [], ended: false, escaped: false, result: undefined }
  const terminal = []
  let complete
  const completed = new Promise(resolve => { complete = resolve })
  let output
  const invoke = action => { try { action() } catch { state.escaped = true } }
  if (mode === 'stream') {
    invoke(() => {
      const normalized = handler.handleStream(upstream, { headers:
        options.encoding ? { 'content-encoding': options.encoding } : {} })
      output = options.useGate
        ? gate.createOpenAIStreamTerminalGate(normalized, value => terminal.push(value)) : normalized
      output.on('data', bytes => state.chunks.push(bytes.toString('utf8')))
      if (options.errorOnFinalWrite) output.on('data', bytes => {
        if (bytes.toString('utf8').includes('"finish_reason":"stop"')) {
          invoke(() => upstream.emit('error', fixedError()))
        }
      })
      output.once('end', () => { state.ended = true; complete() })
      output.on('error', () => {})
    })
  } else {
    handler.handleNonStream(upstream, { headers:
      options.encoding ? { 'content-encoding': options.encoding } : {} })
      .then(value => { state.result = { value }; complete() },
        error => { state.result = { error }; complete() })
  }
  t.after(() => { upstream.destroy?.(); output?.destroy() })
  return { ...h, handler, upstream, cleanup, state, terminal, invoke,
    write: bytes => invoke(() => upstream.emit('data', bytes)),
    end: () => invoke(() => upstream.emit('end')),
    signal: name => invoke(() => upstream.emit(name, fixedError())),
    async settled() {
      let timer
      try { await Promise.race([completed, new Promise(resolve => { timer = setTimeout(resolve, 350) })]) }
      finally { clearTimeout(timer) }
      await nextTurn()
    },
  }
}
function events(run) {
  return run.state.chunks.join('').split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
}
const text = (run, key = 'content') => events(run).map(event => event.choices?.[0]?.delta?.[key] ?? '').join('')
function assertPending(run, mode) {
  assert.equal(run.state.escaped, false)
  assert.equal(run.cleanup.length, 0)
  if (mode === 'stream') {
    assert.equal(run.state.ended, false)
    assert.equal(run.state.chunks.join('').includes('data: [DONE]'), false)
    assert.equal(events(run).some(event => event.choices?.[0]?.finish_reason), false)
  } else assert.equal(run.state.result, undefined)
}
function assertSuccess(run, mode, expected = 'safe answer', cleanup = 1) {
  assert.equal(run.state.escaped, false)
  assert.equal(run.handler.hasSessionError(), false)
  assert.equal(run.calls.length, 0)
  assert.equal(run.cleanup.length, cleanup)
  if (mode === 'stream') {
    assert.equal(run.state.ended, true)
    assert.equal(events(run).some(event => event.error), false)
    assert.equal(text(run), expected)
    assert.equal(events(run).filter(event => event.choices?.[0]?.finish_reason === 'stop').length, 1)
    assert.equal(run.state.chunks.join('').split('data: [DONE]').length - 1, 1)
    assert.equal(events(run).every(event => event.model === MODEL), true)
  } else {
    assert.equal(run.state.result?.error, undefined)
    assert.equal(run.state.result?.value?.choices?.[0]?.message?.content, expected.trim())
    assert.equal(run.state.result.value.choices[0].finish_reason, 'stop')
    assert.equal(run.state.result.value.model, MODEL)
  }
  assert.equal(JSON.stringify(run.logs).includes(PRIVATE), false)
}
function assertFailure(run, mode) {
  assert.equal(run.state.escaped, false, 'async callbacks must contain parser/codec failures')
  assert.equal(run.handler.hasSessionError(), true)
  assert.equal(run.calls.length, 0, 'no provider request, retry or failover')
  assert.equal(run.cleanup.length, 0, 'unverified completion must not authorize deletion')
  if (mode === 'stream') {
    assert.equal(run.state.ended, true)
    assert.equal(events(run).filter(event => event.error).length, 1)
    assert.equal(events(run).some(event => event.choices?.[0]?.finish_reason), false)
    assert.equal(run.state.chunks.join('').includes('data: [DONE]'), false)
    assert.equal(run.state.chunks.join('').includes(PRIVATE), false)
  } else {
    assert.equal(run.state.result?.error instanceof Error, true)
    assert.equal(run.state.result.error.message, 'Qwen response decoding failed')
    assert.equal(run.state.result.error.cause, undefined)
  }
  assert.equal(JSON.stringify(run.logs).includes(PRIVATE), false)
}

test('native answer and provider finish stay provisional until clean EOF in both modes', async t => {
  for (const mode of ['stream', 'nonstream']) for (const status of ['complete', 'finished']) {
    const run = await runHandler(t, mode, { withTools: mode === 'stream' })
    run.write(sse(message('safe')))
    run.write(sse(message('safe answer', status)))
    await nextTurn()
    assertPending(run, mode)
    assert.equal(run.codecState.flushes, 0)
    run.end()
    await run.settled()
    assertSuccess(run, mode)
    if (mode === 'stream') assert.deepEqual(run.toolInputs, ['safe', ' answer'])
  }
})

test('event-only complete preserves the text/plain protocol and waits for EOF', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode)
    run.write(sse(message('safe answer', 'streaming', { mime_type: 'text/plain' })))
    run.write(Buffer.from('event: complete\n\n'))
    await nextTurn()
    assertPending(run, mode)
    run.end()
    await run.settled()
    assertSuccess(run, mode, 'safe answer', 0) // Preserve the existing callback selection.
  }
})

test('thinking, cumulative content and final content survive the terminal change', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode)
    run.write(sse(message('[(deep_think)]', 'streaming', { meta_data: { multi_load: [
      { type: 'deep_think', content: { think_content: 'reasoning 한😀' } },
    ] } })))
    run.write(sse(message('safe')))
    run.write(finish('safe answer'))
    run.end()
    await run.settled()
    assertSuccess(run, mode)
    assert.equal(mode === 'stream' ? text(run, 'reasoning_content')
      : run.state.result.value.choices[0].message.reasoning_content, 'reasoning 한😀')
  }
})

test('valid metadata, comments and optional DONE after provider finish do not replace EOF', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode)
    run.write(finish('safe answer'))
    run.write(sse({ communication: { sessionid: 'synthetic-session' }, data: { metadata: true } }))
    run.write(Buffer.from(': keepalive\n\ndata: [DONE]\n\n'))
    assertPending(run, mode)
    run.end()
    await run.settled()
    assertSuccess(run, mode)
  }
})

test('provider errors take priority over same-event answer and finish without reflecting raw messages', async t => {
  for (const mode of ['stream', 'nonstream']) for (const code of [1001, 'provider-error', null, false, '0']) {
    const run = await runHandler(t, mode)
    run.write(sse({ ...message(PRIVATE, 'complete'), error_code: code, error_msg: PRIVATE }))
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('late provider errors and error events invalidate provisional completion in both modes', async t => {
  for (const mode of ['stream', 'nonstream']) for (const error of [
    errorEvent(), sse({ error: { detail: PRIVATE } }), sse({ detail: PRIVATE }, 'error'),
  ]) {
    const run = await runHandler(t, mode)
    run.write(finish('safe answer'))
    run.write(error)
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('missing finish, empty finish and thinking-only finish never fabricate an answer', async t => {
  const invalid = [
    [sse(message())], [Buffer.from('event: complete\n\n')], [finish('')], [finish('  \n\t')],
    [finish('[(deep_think)]')], [sse(message('[(deep_think)]', 'complete', {
      meta_data: { multi_load: [{ type: 'deep_think', content: { think_content: 'reasoning only' } }] },
    }))],
  ]
  for (const mode of ['stream', 'nonstream']) for (const pieces of invalid) {
    const run = await runHandler(t, mode)
    for (const piece of pieces) run.write(piece)
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('transport errors, close, abort and timeout never become normal DONE before EOF', async t => {
  for (const mode of ['stream', 'nonstream']) for (const signal of ['error', 'close', 'aborted', 'timeout']) {
    for (const finished of [false, true]) {
      const run = await runHandler(t, mode)
      run.write(finished ? finish('safe answer') : sse(message()))
      run.signal(signal)
      run.end()
      await run.settled()
      assertFailure(run, mode)
    }
  }
})

test('malformed JSON and consumed envelope fields cannot be ignored before a valid finish', async t => {
  const badMessages = [null, [], false, 'message', { content: 7, mime_type: 'text/plain' },
    { content: {}, mime_type: 'multi_load/iframe' },
    { content: 'unsafe', mime_type: 'multi_load/iframe', status: 7 },
    { content: 'unsafe', mime_type: 'multi_load/iframe', role: 'user' },
    { mime_type: 'multi_load/iframe', meta_data: [] },
    { meta_data: { multi_load: {} } },
    { meta_data: { multi_load: [{ type: 'deep_think', content: { think_content: {} } }] } }]
  const invalid = [Buffer.from('data: {"broken":\n\n'), ...[null, [], false, 'envelope',
    { data: [] }, { communication: [] }, { data: { messages: {} } },
    ...badMessages.map(value => ({ data: { messages: [value] } }))].map(value => sse(value))]
  for (const mode of ['stream', 'nonstream']) for (const bytes of invalid) {
    const run = await runHandler(t, mode)
    run.write(bytes)
    run.write(finish('safe answer'))
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('EOF cannot complete an unfinished SSE event or discard a late partial frame', async t => {
  for (const mode of ['stream', 'nonstream']) for (const tail of [
    Buffer.from('data: {"error_code":1001'), Buffer.from('data: {}\n'), Buffer.from('event: error\n'),
  ]) {
    const run = await runHandler(t, mode)
    run.write(finish('safe answer'))
    run.write(tail)
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('UTF8 and LF, CRLF or CR framing survive one-byte delivery and multiline data', async t => {
  const expected = 'safe 한😀\ufffd answer'
  for (const mode of ['stream', 'nonstream']) for (const ending of ['\n', '\r\n', '\r']) {
    const run = await runHandler(t, mode)
    const jsonLines = JSON.stringify(message(expected, 'complete'), null, 2).split('\n')
    const payload = Buffer.from([': comment', 'id: synthetic', 'retry: 1000',
      ...jsonLines.map(line => 'data: ' + line), '', ''].join(ending), 'utf8')
    for (const byte of payload) run.write(Buffer.from([byte]))
    run.end()
    await run.settled()
    assertSuccess(run, mode, expected)
  }
})

test('invalid UTF8 bytes in JSON and truncated multibyte tails fail instead of being replaced', async t => {
  const before = Buffer.from('data: {"data":{"messages":[{"mime_type":"multi_load/iframe","status":"complete","content":"')
  const after = Buffer.from('"}]}}\n\n')
  for (const mode of ['stream', 'nonstream']) {
    for (const invalid of [[0x80], [0xc0, 0xaf], [0xc2], [0xe2, 0x28, 0xa1],
      [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]]) {
      const run = await runHandler(t, mode)
      const bytes = Buffer.concat([before, Buffer.from(PRIVATE), Buffer.from(invalid), after])
      for (const byte of bytes) run.write(Buffer.from([byte]))
      run.end()
      await run.settled()
      assertFailure(run, mode)
    }
    const run = await runHandler(t, mode)
    run.write(finish('safe answer'))
    run.write(Buffer.from([0xe2, 0x82]))
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('DONE alone and content changes after provider finish never count as verified completion', async t => {
  for (const mode of ['stream', 'nonstream']) for (const pieces of [
    [sse(message()), Buffer.from('data: [DONE]\n\n')],
    [finish('safe answer'), sse(message('changed answer'))],
  ]) {
    const run = await runHandler(t, mode)
    for (const piece of pieces) run.write(piece)
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('ignored DONE markers preserve native finish ordering while later errors are still checked', async t => {
  for (const mode of ['stream', 'nonstream']) for (const lateError of [false, true]) {
    const run = await runHandler(t, mode)
    run.write(sse(message('safe')))
    run.write(Buffer.from('data: [DONE]\n\n'))
    assertPending(run, mode)
    run.write(finish('safe answer'))
    run.write(Buffer.from('data: [DONE]\n\n'))
    run.write(sse({ data: { metadata: true } }))
    if (lateError) run.write(errorEvent())
    run.end()
    await run.settled()
    if (lateError) assertFailure(run, mode)
    else assertSuccess(run, mode)
  }
})

test('gzip, deflate and brotli preserve valid completed answers in both modes', async t => {
  for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync]]) for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode, { encoding })
    run.upstream.write(compress(finish('safe answer')))
    run.upstream.end()
    await run.settled()
    assertSuccess(run, mode)
  }
})

test('compressed corruption and truncation fail without cleanup or raw codec details', async t => {
  for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync]]) for (const mode of ['stream', 'nonstream']) {
    for (const bytes of [Buffer.from(PRIVATE), compress(finish('safe answer')).subarray(0, -2)]) {
      const run = await runHandler(t, mode, { encoding })
      run.upstream.write(bytes)
      run.upstream.end()
      await run.settled()
      assertFailure(run, mode)
    }
  }
})

test('a decompressor EOF does not hide a later original-source error', async t => {
  for (const mode of ['stream', 'nonstream']) for (const lateError of [false, true]) {
    const decoded = new EventEmitter()
    const source = new EventEmitter()
    source.pipe = destination => destination
    const run = await runHandler(t, mode, { source, encoding: 'gzip',
      zlib: { createGunzip: () => decoded } })
    run.invoke(() => decoded.emit('data', finish('safe answer')))
    run.invoke(() => decoded.emit('end'))
    await nextTurn()
    assertPending(run, mode)
    if (lateError) run.signal('error')
    run.end()
    await run.settled()
    if (lateError) assertFailure(run, mode)
    else assertSuccess(run, mode)
  }
})

test('zstd uses the installed export shape and validates decoded bytes only after raw EOF', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode, { encoding: 'zstd', zstdResult: new Uint8Array(finish('safe answer')) })
    run.write(Buffer.from('synthetic compressed input'))
    assertPending(run, mode)
    run.end()
    await run.settled()
    assertSuccess(run, mode)
  }
})

test('zstd runner failures, callback exceptions, null and invalid decoded bytes fail safely', async t => {
  for (const mode of ['stream', 'nonstream']) for (const options of [
    { zstdRunThrows: true }, { zstdThrows: true }, { zstdResult: null }, { zstdResult: 'not bytes' },
    { zstdResult: new Uint8Array(Buffer.concat([finish('safe answer'), Buffer.from([0xff])])) },
  ]) {
    const run = await runHandler(t, mode, { ...options, encoding: 'zstd' })
    run.write(Buffer.from('synthetic compressed input'))
    run.end()
    await run.settled()
    assertFailure(run, mode)
  }
})

test('deferred zstd work catches callback errors and cannot recover after source failure', async t => {
  for (const mode of ['stream', 'nonstream']) for (const lateError of [false, true]) {
    const run = await runHandler(t, mode, { encoding: 'zstd', deferZstd: true,
      zstdThrows: !lateError, zstdResult: new Uint8Array(finish('safe answer')) })
    run.write(Buffer.from('synthetic compressed input'))
    run.end()
    await nextTurn()
    assert.equal(typeof run.codecState.zstdCallback, 'function')
    assertPending(run, mode)
    if (lateError) run.signal('error')
    run.invoke(() => run.codecState.zstdCallback())
    await run.settled()
    assertFailure(run, mode)
  }
})

test('tool flush exceptions cannot escape the EOF callback or publish normal DONE', async t => {
  const run = await runHandler(t, 'stream', { withTools: true, flushThrows: true })
  run.write(finish('safe answer'))
  run.end()
  await run.settled()
  assertFailure(run, 'stream')
})

test('a source error during tool finalization vetoes prepared success and cleanup', async t => {
  const source = new EventEmitter()
  const run = await runHandler(t, 'stream', { source, withTools: true,
    onFlush: () => source.emit('error', fixedError()) })
  run.write(finish('safe answer'))
  run.end()
  await run.settled()
  assertFailure(run, 'stream')
})

test('a synchronous output listener cannot reopen settled success after both clean EOFs', async t => {
  const run = await runHandler(t, 'stream', { errorOnFinalWrite: true })
  run.write(finish('safe answer'))
  run.end()
  await run.settled()
  assertSuccess(run, 'stream')
})

test('a missing zstd callback expires locally and a late callback cannot recover', async t => {
  for (const mode of ['stream', 'nonstream']) {
    const timers = new Map()
    const timerApi = {
      setTimeout(callback, delay) { const handle = { callback, delay }; timers.set(handle, handle); return handle },
      clearTimeout(handle) { timers.delete(handle) },
    }
    const run = await runHandler(t, mode, { encoding: 'zstd', deferZstd: true,
      zstdResult: new Uint8Array(finish('safe answer')), timers: timerApi })
    run.write(Buffer.from('synthetic compressed input'))
    run.end()
    assertPending(run, mode)
    assert.equal(timers.size, 1)
    const timeout = [...timers.values()][0]
    assert.equal(timeout.delay, 120_000)
    run.invoke(() => timeout.callback())
    run.invoke(() => run.codecState.zstdCallback())
    await run.settled()
    assertFailure(run, mode)
    assert.equal(timers.size, 0)
  }
})

test('cleanup callback errors remain private after one verified successful completion', async t => {
  for (const options of [{ cleanupThrows: true }, { cleanupRejects: true }]) {
    const run = await runHandler(t, 'stream', options)
    run.write(finish('safe answer'))
    run.end()
    await run.settled()
    assertSuccess(run, 'stream')
  }
})

test('the actual global gate receives success only for verified provider completion plus EOF', async t => {
  for (const lateError of [false, true]) {
    const run = await runHandler(t, 'stream', { useGate: true })
    run.write(finish('safe answer'))
    await nextTurn()
    assert.deepEqual(run.terminal, [])
    assertPending(run, 'stream')
    if (lateError) run.write(errorEvent())
    run.end()
    await run.settled()
    assert.deepEqual(run.terminal, [!lateError])
    if (lateError) assertFailure(run, 'stream')
    else assertSuccess(run, 'stream')
  }
})
