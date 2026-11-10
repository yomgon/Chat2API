import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Only the production handler runs. Transports, tools and console are explicit
// in-memory stubs; no account, Electron profile, socket or provider is accessed.
const source = readFileSync(new URL('../../src/main/proxy/adapters/kimi.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  fileName: 'kimi.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const MAX_FRAME = 1024 * 1024
const PRIVATE = 'SYNTHETIC_INVALID_UTF8_NOT_FOR_OUTPUT'
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const logs = []
  const calls = []
  const toolInputs = []
  const forbiddenTransport = () => {
    calls.push('forbidden transport')
    throw new Error('Offline test forbids transport')
  }
  const dependencies = {
    axios: { __esModule: true, default: { post: forbiddenTransport, get: forbiddenTransport } },
    stream: { PassThrough },
    './providerModelOptions': {},
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) =>
      ({ id, model, created, object: 'chat.completion.chunk' }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {
      push(content) { toolInputs.push(content); return [] }
      flush() { return [] }
      hasEmittedToolCall() { return false }
      isBuffering() { return false }
    } },
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, Date, Error, setTimeout, clearTimeout,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected offline fixture dependency')
    },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
  }, { timeout: 1500 })
  return { ...module.exports, logs, calls, toolInputs }
}

function rawFrame(flag, bytes) {
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([header, bytes])
}
const frame = (flag, value) => rawFrame(flag, Buffer.from(JSON.stringify(value), 'utf8'))
function textMessage(content, op = 'append', kind = 'answer', masked = true) {
  const part = kind === 'reasoning' ? 'think' : 'text'
  return { op, ...(masked ? { mask: `block.${part}.content` } : {}),
    block: { [part]: { content, ...(part === 'text' ? { flags: 'answer' } : {}) } } }
}
const answerFrame = (content, op = 'append') => frame(0, textMessage(content, op))

async function runHandler(t, mode, withTools = false) {
  const h = harness()
  const handler = new h.KimiStreamHandler('k2d6-chat', '', false,
    withTools ? { shouldParseResponse: true } : undefined)
  const upstream = new PassThrough({ autoDestroy: false })
  const state = { escaped: false, result: undefined, chunks: [], ended: false }
  let output
  if (mode === 'stream') {
    output = await handler.handleStream(upstream)
    output.on('data', chunk => state.chunks.push(chunk.toString('utf8')))
    output.once('end', () => { state.ended = true })
    output.on('error', () => {})
  } else {
    handler.handleNonStream(upstream).then(value => {
      state.result = { value }
    }, error => { state.result = { error } })
  }
  t.after(() => { upstream.destroy(); output?.destroy() })
  const invoke = action => {
    try { action() } catch { state.escaped = true; upstream.destroy() }
  }
  return { ...h, handler, state, upstream,
    write: bytes => invoke(() => upstream.write(bytes)),
    end: () => invoke(() => upstream.end()) }
}

function events(run) {
  return run.state.chunks.join('').split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
}
function streamText(run, key = 'content') {
  return events(run).map(event => event.choices?.[0]?.delta?.[key] ?? '').join('')
}
function assertSuccess(run, mode) {
  assert.equal(run.state.escaped, false, 'upstream callbacks must contain every parser failure')
  assert.equal(run.handler.hasSessionError(), false)
  assert.equal(run.calls.length, 0, 'no provider request or retry is allowed')
  if (mode === 'stream') {
    assert.equal(run.state.ended, true)
    assert.equal(run.handler.hasSuccessfulTerminal(), true)
    assert.equal(events(run).some(event => event.error), false)
    assert.equal(events(run).filter(event => event.choices?.[0]?.finish_reason === 'stop').length, 1)
    assert.equal(run.state.chunks.join('').split('data: [DONE]').length - 1, 1)
  } else {
    assert.equal(run.state.result?.error, undefined)
    assert.equal(run.state.result?.value?.choices?.[0]?.finish_reason, 'stop')
  }
}
function assertFailed(run, mode) {
  assert.equal(run.state.escaped, false)
  assert.equal(run.handler.hasSessionError(), true)
  assert.equal(run.handler.hasSuccessfulTerminal(), false, 'failure must not authorize cleanup')
  assert.equal(run.calls.length, 0, 'failure must not start a request, retry or failover')
  if (mode === 'stream') {
    assert.equal(run.state.ended, true)
    assert.equal(events(run).filter(event => event.error).length, 1)
    assert.equal(run.state.chunks.join('').includes('data: [DONE]'), false)
    assert.equal(events(run).some(event => event.choices?.[0]?.finish_reason === 'stop'), false)
    assert.equal(run.state.chunks.join('').includes(PRIVATE), false)
  } else {
    assert.equal(run.state.result?.error instanceof run.KimiProxyFailure, true)
    assert.equal(run.state.result.error.stage, 'response-decoding')
    assert.equal(run.state.result.error.message, 'Kimi response decoding failed')
    assert.equal(run.state.result.error.cause, undefined)
  }
  assert.equal(JSON.stringify(run.logs).includes(PRIVATE), false)
}
async function complete(run) {
  run.write(frame(2, {}))
  run.end()
  await nextTurn()
}

test('streaming cumulative set snapshots emit exactly AB and wait for terminal plus EOF', async t => {
  const run = await runHandler(t, 'stream')
  run.write(answerFrame('A', 'set'))
  assert.equal(streamText(run), 'A', 'streaming must deliver the first available text')
  run.write(answerFrame('AB', 'set'))
  assert.equal(streamText(run), 'AB')
  run.write(frame(2, {}))
  await nextTurn()
  assert.equal(run.handler.hasSuccessfulTerminal(), false)
  assert.equal(run.state.ended, false)
  run.end()
  await nextTurn()
  assertSuccess(run, 'stream')
  assert.equal(streamText(run), 'AB')
})

test('set and append interleave without duplicating snapshots or tool parser input', async t => {
  for (const withTools of [false, true]) {
    const run = await runHandler(t, 'stream', withTools)
    for (const [content, op] of [['A', 'set'], ['B', 'append'], ['ABC', 'set'],
      ['ABC', 'set'], ['', 'append'], ['D', 'append']]) run.write(answerFrame(content, op))
    await complete(run)
    assertSuccess(run, 'stream')
    assert.equal(streamText(run), 'ABCD')
    if (withTools) assert.deepEqual(run.toolInputs, ['A', 'B', 'C', 'D'])
  }
})

test('streaming masked reasoning and unmasked phased text use set snapshot semantics', async t => {
  for (const kind of ['reasoning', 'unmasked reasoning', 'unmasked answer']) {
    const run = await runHandler(t, 'stream')
    for (const content of ['A', 'AB', 'AB']) {
      const message = kind === 'reasoning' ? textMessage(content, 'set', 'reasoning')
        : { op: 'set', block: { text: { content,
          flags: kind === 'unmasked reasoning' ? 'thinking' : 'answer' } } }
      run.write(frame(0, message))
    }
    if (kind !== 'unmasked answer') run.write(answerFrame('final'))
    await complete(run)
    assertSuccess(run, 'stream')
    assert.equal(streamText(run, kind === 'unmasked answer' ? 'content' : 'reasoning_content'), 'AB')
  }
})

test('nonstream empty set clears previous answer before append, including the masked path', async t => {
  for (const masked of [true, false]) {
    const run = await runHandler(t, 'nonstream')
    for (const [content, op] of [['old answer', 'set'], ['', 'set'], ['new answer', 'append']]) {
      run.write(frame(0, textMessage(content, op, 'answer', masked)))
    }
    await complete(run)
    assertSuccess(run, 'nonstream')
    assert.equal(run.state.result.value.choices[0].message.content, 'new answer')
  }
})

test('nonstream empty final set cannot return a stale answer as success', async t => {
  const run = await runHandler(t, 'nonstream')
  run.write(answerFrame('stale answer', 'set'))
  run.write(answerFrame('', 'set'))
  await complete(run)
  assertFailed(run, 'nonstream')
})

test('nonstream empty reasoning set clears reasoning without erasing the answer', async t => {
  const run = await runHandler(t, 'nonstream')
  run.write(frame(0, textMessage('old reasoning', 'set', 'reasoning')))
  run.write(frame(0, textMessage('', 'set', 'reasoning')))
  run.write(answerFrame('answer'))
  await complete(run)
  assertSuccess(run, 'nonstream')
  assert.equal(run.state.result.value.choices[0].message.reasoning_content, undefined)
  assert.equal(run.state.result.value.choices[0].message.content, 'answer')
})

test('streaming cannot fabricate success after a set retracts or replaces published text', async t => {
  for (const replacement of ['', 'A', 'XY']) for (const kind of ['answer', 'reasoning']) {
    const run = await runHandler(t, 'stream')
    run.write(frame(0, textMessage('AB', 'set', kind)))
    run.write(frame(0, textMessage(replacement, 'set', kind)))
    if (kind === 'reasoning') run.write(answerFrame('answer'))
    await complete(run)
    assertFailed(run, 'stream')
  }
  const run = await runHandler(t, 'nonstream')
  run.write(answerFrame('AB', 'set'))
  run.write(answerFrame('XY', 'set'))
  await complete(run)
  assertSuccess(run, 'nonstream')
  assert.equal(run.state.result.value.choices[0].message.content, 'XY')
})

test('coalesced valid frames exceeding 1MiB equal split delivery in both modes', async t => {
  const first = 'a'.repeat(600_000)
  const expected = first + 'b'.repeat(1000)
  const frames = [answerFrame(first, 'set'), answerFrame(expected, 'set'), frame(2, {})]
  const coalesced = Buffer.concat(frames)
  assert.equal(coalesced.length > MAX_FRAME, true)
  assert.equal(frames.every(bytes => bytes.readUInt32BE(1) < MAX_FRAME), true)
  for (const mode of ['stream', 'nonstream']) {
    const observed = []
    for (const chunks of [frames, [coalesced], [coalesced.subarray(0, 3), coalesced.subarray(3)]]) {
      const run = await runHandler(t, mode)
      for (const chunk of chunks) run.write(chunk)
      run.end()
      await nextTurn()
      assertSuccess(run, mode)
      const result = mode === 'stream' ? streamText(run) : run.state.result.value.choices[0].message.content
      assert.equal(result.length, expected.length)
      assert.equal(result === expected, true)
      observed.push(result)
    }
    assert.equal(observed.every(result => result === expected), true)
  }
})

test('the 1MiB limit belongs to each payload, and an oversized declaration fails immediately', async t => {
  const envelopeBytes = Buffer.byteLength(JSON.stringify(textMessage('', 'set')), 'utf8')
  const limitFrame = answerFrame('a'.repeat(MAX_FRAME - envelopeBytes), 'set')
  assert.equal(limitFrame.readUInt32BE(1), MAX_FRAME)
  for (const mode of ['stream', 'nonstream']) {
    const accepted = await runHandler(t, mode)
    accepted.write(Buffer.concat([limitFrame, frame(2, {})]))
    accepted.end()
    await nextTurn()
    assertSuccess(accepted, mode)
    for (const split of [false, true]) {
      const rejected = await runHandler(t, mode)
      const header = Buffer.alloc(5)
      header.writeUInt32BE(MAX_FRAME + 1, 1)
      if (split) { rejected.write(header.subarray(0, 2)); rejected.write(header.subarray(2)) }
      else rejected.write(header)
      await nextTurn()
      assertFailed(rejected, mode)
    }
  }
})

test('valid UTF8 survives every byte split, including literal replacement characters', async t => {
  const expected = 'A\u0000\u007f\u0080\u07ff\u0800\ud7ff\ue000\ufffd\uffff한😀\u{10ffff}Z'
  const bytes = answerFrame(expected, 'set')
  for (const mode of ['stream', 'nonstream']) {
    for (let split = 1; split < bytes.length; split++) {
      const run = await runHandler(t, mode)
      run.write(bytes.subarray(0, split))
      run.write(bytes.subarray(split))
      await complete(run)
      assertSuccess(run, mode)
      const result = mode === 'stream' ? streamText(run) : run.state.result.value.choices[0].message.content
      assert.equal(result, expected)
    }
  }
})

test('malformed UTF8 message bytes fail in both modes and never become replacement-character answers', async t => {
  const malformed = [[0x80], [0xc0, 0xaf], [0xc2], [0xe2, 0x82], [0xe2, 0x28, 0xa1],
    [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff]]
  const before = Buffer.from(`{"op":"set","mask":"block.text.content","block":{"text":{"content":"${PRIVATE}`)
  const after = Buffer.from('"}}}')
  for (const mode of ['stream', 'nonstream']) for (const invalid of malformed) {
    const bytes = rawFrame(0, Buffer.concat([before, Buffer.from(invalid), after]))
    for (const split of [1, 5 + before.length + 1, bytes.length - 1]) {
      const run = await runHandler(t, mode)
      run.write(bytes.subarray(0, split))
      run.write(bytes.subarray(split))
      await complete(run)
      assertFailed(run, mode)
    }
  }
})

test('terminal metadata also requires strict UTF8 after a usable answer', async t => {
  const payload = Buffer.concat([Buffer.from(`{"metadata":{"fixture":["${PRIVATE}`),
    Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"]}}')])
  const bytes = rawFrame(2, payload)
  for (const mode of ['stream', 'nonstream']) {
    const run = await runHandler(t, mode)
    run.write(answerFrame('provisional'))
    for (const byte of bytes) run.write(Buffer.from([byte]))
    run.end()
    await nextTurn()
    assertFailed(run, mode)
  }
})

test('large coalesced delivery never weakens terminal EOF or trailing-byte failure', async t => {
  const content = 'a'.repeat(550_000)
  const prefix = Buffer.concat([answerFrame(content, 'set'), answerFrame(content, 'set')])
  for (const mode of ['stream', 'nonstream']) {
    for (const kind of ['missing terminal', 'coalesced trailing byte', 'later trailing byte']) {
      const run = await runHandler(t, mode)
      if (kind === 'missing terminal') run.write(prefix)
      else if (kind === 'coalesced trailing byte') {
        run.write(Buffer.concat([prefix, frame(2, {}), Buffer.from([0])]))
      } else {
        run.write(Buffer.concat([prefix, frame(2, {})]))
        await nextTurn()
        assert.equal(run.handler.hasSuccessfulTerminal(), false)
        assert.equal(mode === 'stream' ? run.state.ended : run.state.result !== undefined, false)
        run.write(Buffer.from([0]))
      }
      run.end()
      await nextTurn()
      assertFailed(run, mode)
    }
  }
})

test('streaming large append sequences remain valid while later retractions fail closed', async t => {
  const first = 'a'.repeat(600_000)
  for (const kind of ['answer', 'reasoning']) for (const total of [MAX_FRAME, MAX_FRAME + 1]) {
    const second = 'b'.repeat(total - first.length)
    const chunks = [frame(0, textMessage(first, 'append', kind)),
      frame(0, textMessage(second, 'append', kind))]
    for (const coalesced of [false, true]) {
      const run = await runHandler(t, 'stream')
      for (const chunk of coalesced ? [Buffer.concat(chunks)] : chunks) run.write(chunk)
      run.write(frame(0, textMessage('Z', 'append', kind)))
      if (kind === 'reasoning') run.write(answerFrame('final answer', 'set'))
      await complete(run)
      assertSuccess(run, 'stream')
      const result = streamText(run, kind === 'answer' ? 'content' : 'reasoning_content')
      assert.equal(result.length, total + 1)
      assert.equal(result === first + second + 'Z', true)
    }
    for (const replacement of ['', 'short']) {
      const run = await runHandler(t, 'stream')
      run.write(Buffer.concat(chunks))
      run.write(frame(0, textMessage(replacement, 'set', kind)))
      if (kind === 'reasoning') run.write(answerFrame('final answer'))
      await complete(run)
      assertFailed(run, 'stream')
    }
  }
})

test('empty JSON payloads and incomplete headers or payloads fail safely at EOF', async t => {
  const message = answerFrame('incomplete')
  const terminal = frame(2, {})
  for (const mode of ['stream', 'nonstream']) {
    for (const suffix of [rawFrame(0, Buffer.alloc(0)), rawFrame(2, Buffer.alloc(0)),
      message.subarray(0, 1), message.subarray(0, 4), message.subarray(0, 5),
      message.subarray(0, -1), terminal.subarray(0, -1)]) {
      const run = await runHandler(t, mode)
      run.write(answerFrame('provisional'))
      run.write(suffix)
      run.end()
      await nextTurn()
      assertFailed(run, mode)
    }
  }
})
