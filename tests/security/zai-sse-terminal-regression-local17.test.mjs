import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Execute only the real parser with synthetic SSE. All adapter transports,
// authentication, storage and imports outside the explicit allow-list fail.
const sourcePath = fileURLToPath(new URL('../../src/main/proxy/adapters/zai.ts', import.meta.url))
const requireNode = createRequire(import.meta.url)
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
  reportDiagnostics: true,
})
assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
const PRIVATE = 'SYNTHETIC_PRIVATE_SSE_CANARY_LOCAL17'
const MODEL = 'synthetic-zai-parser-model'

function harness(t) {
  const logs = []
  const timers = []
  let forbiddenCalls = 0
  const forbidden = () => {
    forbiddenCalls++
    throw new Error('Offline parser test forbids external effects')
  }
  const dependencies = {
    axios: { __esModule: true, default: { get: forbidden, post: forbidden, delete: forbidden, request: forbidden } },
    crypto: {},
    stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': { readZaiSessionClaims: forbidden, readZaiTokenIdentity: forbidden },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: forbidden,
      flushToolCallBuffer: forbidden,
      createBaseChunk: forbidden,
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      return forbidden()
    },
    Buffer, TextDecoder, URL, URLSearchParams, Date, Error,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) { timer.cleared = true },
  }, { filename: sourcePath, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  const handler = new module.exports.ZaiStreamHandler(MODEL)
  handler.setChatId('synthetic-chat')
  t.after(() => {
    for (const timer of timers) if (!timer.cleared) timer.callback()
    assert.equal(forbiddenCalls, 0, 'parser must not request, authenticate, delete or retry')
    assert.equal(JSON.stringify(logs).includes(PRIVATE), false, 'raw upstream text must never reach console')
  })
  return { handler, logs, timers }
}

const record = data => ({ type: 'chat:completion', data })
const answer = text => record({ phase: 'answer', role: 'assistant', delta_content: text })
const thinking = text => record({ phase: 'thinking', delta_content: text })
const done = record({ phase: 'done', done: true })
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n'
const sentinel = 'data: [DONE]\n\n'

function pendingResult(h, input) {
  return h.handler.handleNonStream(input).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error }),
  )
}

async function collect(t, chunks, terminal = 'end') {
  const h = harness(t)
  const input = new EventEmitter()
  const pending = pendingResult(h, input)
  for (const chunk of chunks) input.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  input.emit(terminal)
  // A fake clock bounds old implementations that ignore end or [DONE].
  for (const timer of h.timers) if (!timer.cleared) timer.callback()
  return { ...(await pending), h, input }
}

function assertSuccess(outcome, expected) {
  assert.equal(outcome.ok, true, outcome.error?.message)
  assert.equal(outcome.value.object, 'chat.completion')
  assert.equal(outcome.value.model, MODEL)
  assert.equal(outcome.value.choices[0].message.role, 'assistant')
  assert.equal(outcome.value.choices[0].message.content, expected)
  assert.equal(outcome.h?.timers.every(timer => timer.cleared) ?? true, true)
}

function assertFailure(outcome, pattern = /^Z\.ai /) {
  assert.equal(outcome.ok, false, 'incomplete or invalid input must never fabricate success')
  assert.match(outcome.error.message, pattern)
  assert.equal(outcome.error.message.includes(PRIVATE), false)
  assert.equal(outcome.error.cause, undefined)
}

test('answer followed by [DONE] remains provisional until clean transport end', async t => {
  const h = harness(t)
  const input = new EventEmitter()
  const pending = pendingResult(h, input)
  input.emit('data', Buffer.from(frame(answer('A confirmed synthetic answer.')) + sentinel))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.timers[0].cleared, false, 'logical marker cannot settle before clean EOF')
  input.emit('end')
  assert.equal(h.timers[0].cleared, true, 'clean transport should settle')
  assertSuccess(await pending, 'A confirmed synthetic answer.')
})

test('UTF-8 answer survives every byte boundary and split CRLF with [DONE]', async t => {
  const text = '한글 😀 café �'
  for (const newline of ['\n', '\r\n']) {
    const wire = Buffer.from((frame(answer(text)) + sentinel).replaceAll('\n', newline))
    for (let split = 1; split < wire.length; split++) {
      const out = await collect(t, [wire.subarray(0, split), wire.subarray(split)])
      assertSuccess(out, text)
    }
  }
})

test('native done also preserves one-byte UTF-8 chunks', async t => {
  const text = '정확한 답변 😀'
  const wire = Buffer.from(frame(answer(text)) + frame(done))
  assertSuccess(await collect(t, Array.from(wire, byte => Buffer.from([byte]))), text)
})

test('snapshot, delta and UTF-16 edits retain their semantics before [DONE]', async t => {
  const out = await collect(t, [
    frame(thinking('짧은 생각')),
    frame(answer('Hello danger!')),
    frame(record({ phase: 'answer', edit_index: 6, edit_content: 'world 😀' })),
    frame(record({ phase: 'answer', content: '최종 답변【turn1search2】' })),
    sentinel,
  ])
  assertSuccess(out, '최종 답변')
  assert.equal(out.value.choices[0].message.reasoning_content, '짧은 생각')
})

test('OpenAI assistant deltas accept [DONE] and existing finish_reason completion', async t => {
  const first = { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] }
  const second = { choices: [{ index: 0, delta: { content: 'there' }, finish_reason: null }] }
  for (const end of [
    sentinel,
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]) {
    assertSuccess(await collect(t, [frame(first), frame(second), end]), 'Hello there')
  }
})

test('[DONE] cannot supply an answer or rescue empty, thinking-only or citation-only content', async t => {
  for (const prefix of ['', frame(thinking('private reasoning')), frame(answer(' \n\t')), frame(answer('【turn1search2】'))]) {
    assertFailure(await collect(t, [prefix + sentinel]))
  }
})

test('a premature [DONE] cannot be repaired by a later answer', async t => {
  assertFailure(await collect(t, [sentinel + frame(answer('Too late')) + frame(done)]))
})

test('error events remain failures even when answer and completion follow', async t => {
  for (const failure of [
    { error: { message: PRIVATE } },
    { type: 'chat:completion', error: { message: PRIVATE }, data: { phase: 'answer', content: 'forged' } },
    record({ error: { message: PRIVATE } }),
  ]) {
    assertFailure(await collect(t, [
      frame(answer('Partial')),
      frame(failure),
      frame(answer('Not a recovery')),
      frame(done),
      sentinel,
    ]), /model error/)
  }
})

test('SSE error event names cannot disguise a successful completion envelope', async t => {
  assertFailure(await collect(t, [
    frame(answer('Partial')),
    'event: error\n' + frame(record({ phase: 'done', done: true, detail: PRIVATE })),
  ]))
})

test('malformed JSON remains a fixed error and cannot recover with later completion', async t => {
  assertFailure(await collect(t, [
    frame(answer('Partial')),
    'data: {"private":"' + PRIVATE + '"\n\n',
    frame(done),
  ]), /not valid completion data/)
})

test('malformed event envelopes and non-assistant content never become answers', async t => {
  const malformed = [
    null, 4, 'text', [], {},
    { type: 'chat:completion', data: [] },
    { type: 'chat:completion', data: 'not an object' },
    record({ phase: 'answer', role: 'user', content: 'Not assistant output' }),
    record({ phase: 'answer', delta_content: { value: PRIVATE } }),
    { choices: [null] },
    { choices: [{ delta: { role: 'user', content: 'Not assistant output' } }] },
    { choices: [{ delta: { content: ['Not text'] } }] },
    { choices: [{ delta: { content: 'Partial' }, finish_reason: 'unexpected' }] },
    { type: 'unrelated', choices: [{ delta: { content: 'Not a supported event' } }] },
  ]
  for (const bad of malformed) {
    assertFailure(await collect(t, [frame(bad), frame(answer('Later')), frame(done)]))
  }
})

test('non-boolean native done is not a valid upstream terminal', async t => {
  for (const value of ['true', 1, {}, []]) {
    assertFailure(await collect(t, [frame(answer('Partial')), frame(record({ phase: 'done', done: value }))]))
  }
})

test('malformed SSE framing does not silently skip an unknown input line', async t => {
  assertFailure(await collect(t, ['invalid-field: ' + PRIVATE + '\n\n', frame(answer('Later')), frame(done)]))
})

test('answer followed by end, close or transport error without a terminal always fails', async t => {
  for (const signal of ['end', 'close', 'error']) {
    const h = harness(t)
    const input = new EventEmitter()
    const pending = pendingResult(h, input)
    input.emit('data', Buffer.from(frame(answer('Partial'))))
    input.emit(signal, signal === 'error' ? new Error(PRIVATE) : undefined)
    assert.equal(h.timers[0].cleared, true, signal + ' must fail immediately without waiting for timeout')
    assertFailure(await pending)
  }
})

test('incomplete JSON, SSE dispatch boundary and UTF-8 at EOF remain incomplete', async t => {
  for (const suffix of [
    Buffer.from('data: {"type":"chat:completion"'),
    Buffer.from('data: [DONE]\n'),
    Buffer.from('data: [DONE]'),
    Buffer.from([0xf0, 0x9f]),
  ]) {
    assertFailure(await collect(t, [frame(answer('Partial')), suffix], 'end'))
  }
})

test('invalid UTF-8 is rejected instead of returning replacement characters as model output', async t => {
  const malformed = Buffer.concat([
    Buffer.from('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}}\n\n' + frame(done)),
  ])
  assertFailure(await collect(t, [malformed]))
})

test('native stream EOF with a partial byte sequence cannot complete the last SSE event', async t => {
  const input = new PassThrough()
  const h = harness(t)
  const pending = pendingResult(h, input)
  input.end(Buffer.concat([Buffer.from(frame(answer('Partial'))), Buffer.from([0xe3, 0x81])]))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.timers[0].cleared, true)
  assertFailure(await pending)
})

test('whole-string SSE shares terminal, edit, multiline-data and fail-closed rules', async t => {
  for (const text of [
    frame(answer('String answer')) + sentinel,
    'data: {"type":"chat:completion",\ndata: "data":{"phase":"answer","content":"String answer"}}\n\n' + sentinel,
  ]) {
    const h = harness(t)
    assertSuccess(await pendingResult(h, text), 'String answer')
  }
  for (const text of [
    frame(answer('Partial')) + 'data: {"private":"' + PRIVATE + '"\n\n' + frame(done),
    frame(answer('Partial')) + frame(record({ error: { detail: PRIVATE } })) + frame(done),
    frame(answer('Partial')),
    sentinel,
  ]) {
    const h = harness(t)
    assertFailure(await pendingResult(h, text))
  }
})

test('deadline remains a fixed failure even after partial answer', async t => {
  const h = harness(t)
  const input = new EventEmitter()
  const pending = pendingResult(h, input)
  input.emit('data', Buffer.from(frame(answer('Partial'))))
  h.timers[0].callback()
  assertFailure(await pending, /timed out; outcome unconfirmed/)
  input.emit('data', Buffer.from(sentinel))
  input.emit('close')
})

test('valid native done retains supplied usage and does not require a trailing [DONE]', async t => {
  const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  const out = await collect(t, [frame(answer('Actual fixture text')), frame(record({ phase: 'done', done: true, usage }))])
  assertSuccess(out, 'Actual fixture text')
  assert.equal(JSON.stringify(out.value.usage), JSON.stringify(usage))
})
