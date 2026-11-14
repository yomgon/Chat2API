import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Closed, synthetic transport only. Exercise the actual adapter parser without
// authentication, HTTP, operating stores, cleanup effects or real credentials.
const source = readFileSync(new URL('../../src/main/proxy/adapters/zai.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: 'zai.ts', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const requireNode = createRequire(import.meta.url)
const PRIVATE = 'SYNTHETIC_ZAI_TRAILING_PRIVATE_LOCAL28'
const TEXT = 'Confirmed synthetic answer 한글 😀'
const frame = data => 'data: ' + JSON.stringify({ type: 'chat:completion', data }) + '\n\n'
const answer = frame({ phase: 'answer', role: 'assistant', delta_content: TEXT })
const done = frame({ phase: 'done', done: true })
const sentinel = 'data: [DONE]\n\n'

function harness() {
  const logs = []
  const timers = []
  const state = { forbiddenCalls: 0, cleanup: 0 }
  const forbidden = () => {
    state.forbiddenCalls++
    throw new Error('Forbidden external effect or import')
  }
  const dependencies = {
    axios: { __esModule: true, default: { get: forbidden, post: forbidden, delete: forbidden } },
    crypto: {}, stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': { readZaiSessionClaims: forbidden, readZaiTokenIdentity: forbidden },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: forbidden, flushToolCallBuffer: forbidden, createBaseChunk: forbidden,
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Buffer, TextDecoder, URL, URLSearchParams, Date, Error,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      return forbidden()
    },
    console: Object.fromEntries(['error', 'warn', 'log', 'info'].map(name =>
      [name, (...args) => logs.push(args)])),
    setTimeout(callback) {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) { timer.cleared = true },
  }, { filename: 'zai.ts', timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  const handler = new module.exports.ZaiStreamHandler('synthetic-model', () => { state.cleanup++ })
  handler.setChatId('synthetic-chat')
  return { handler, logs, timers, state }
}

async function run(mode, chunks, signal = 'end', checkPending = false) {
  const h = harness()
  const input = new EventEmitter()
  input.destroyed = false
  input.destroy = () => { input.destroyed = true }
  let settled = false
  let wire = ''
  let pending
  if (mode === 'nonstream') {
    pending = h.handler.handleNonStream(input).then(
      value => ({ ok: true, value }), error => ({ ok: false, error }),
    )
  } else {
    const output = await h.handler.handleStream(input)
    output.on('data', bytes => { wire += bytes.toString('utf8') })
    pending = new Promise(resolve => output.once('end', () =>
      resolve({ ok: !wire.includes('"error"'), wire })))
  }
  pending = pending.then(value => { settled = true; return value })
  for (const chunk of chunks) input.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  if (checkPending) {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'a logical terminal plus empty lines is not clean transport EOF')
    assert.equal(h.state.cleanup, 0)
    assert.doesNotMatch(wire, /data: \[DONE\]|"finish_reason":"stop"/)
  }
  input.emit(signal, signal === 'error' ? new Error(PRIVATE) : undefined)
  const result = await pending
  assert.equal(h.state.forbiddenCalls, 0)
  assert.equal(h.timers.every(timer => timer.cleared), true)
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  return { ...result, cleanup: h.state.cleanup, destroyed: input.destroyed }
}

function successful(result, mode) {
  assert.equal(result.ok, true, result.error?.message || result.wire)
  if (mode === 'nonstream') {
    assert.equal(result.value.choices[0].message.role, 'assistant')
    assert.equal(result.value.choices[0].message.content, TEXT)
    assert.equal(result.value.choices[0].finish_reason, 'stop')
    assert.equal(result.cleanup, 0)
  } else {
    const messages = result.wire.split('\n\n').filter(value =>
      value.startsWith('data: ') && value !== 'data: [DONE]').map(value => JSON.parse(value.slice(6)))
    assert.equal(messages.map(value => value.choices[0].delta.content || '').join(''), TEXT)
    assert.equal((result.wire.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal((result.wire.match(/"finish_reason":"stop"/g) || []).length, 1)
    assert.equal(result.cleanup, 1)
  }
}

function rejected(result, mode) {
  assert.equal(result.ok, false, 'invalid or incomplete framing must not become a completion')
  assert.equal(result.cleanup, 0)
  assert.equal(result.destroyed, true)
  if (mode === 'nonstream') {
    assert.match(result.error.message, /^Z\.ai /)
    assert.equal(result.error.message.includes(PRIVATE), false)
  } else {
    assert.match(result.wire, /"error"/)
    assert.doesNotMatch(result.wire, /data: \[DONE\]|"finish_reason":"stop"/)
    assert.equal(result.wire.includes(PRIVATE), false)
  }
}

for (const mode of ['nonstream', 'stream']) {
  test(mode + ': native and sentinel terminals accept fully terminated empty LF/CRLF tail lines', async () => {
    for (const terminal of [done, sentinel, done + sentinel]) {
      for (const tail of ['\n', '\r\n', '\n\r\n\n', '\n\n']) {
        successful(await run(mode, [answer, terminal, tail], 'end', true), mode)
      }
    }
  })

  test(mode + ': empty CRLF tail remains valid across single-byte UTF-8 and line-ending splits', async () => {
    const bytes = Buffer.from((answer + done + sentinel).replaceAll('\n', '\r\n') + '\r\n')
    successful(await run(mode, Array.from(bytes, byte => Buffer.from([byte])), 'end', true), mode)
  })

  test(mode + ': complete framing without an extra tail remains valid', async () => {
    successful(await run(mode, [answer + done + sentinel], 'end', true), mode)
  })

  test(mode + ': empty lines cannot rescue missing terminal, blank answer or transport abort', async () => {
    rejected(await run(mode, [answer, '\n']), mode)
    rejected(await run(mode, [done, '\n']), mode)
    for (const signal of ['error', 'close']) {
      rejected(await run(mode, [answer + done, '\n'], signal, true), mode)
    }
  })

  test(mode + ': empty tail cannot hide partial data, a late error, malformed framing or bad UTF-8', async () => {
    const invalid = [
      'data: {"private":"' + PRIVATE + '"',
      'data: [DONE]\n',
      'data: [DONE]',
      'data: {broken ' + PRIVATE + '}\n\n',
      'data: ' + JSON.stringify({ error: { message: PRIVATE } }) + '\n\n',
      'event: error\n' + done,
      frame({ phase: 'answer', delta_content: 'late content' }),
      done,
      sentinel + sentinel,
      'unknown-field: ' + PRIVATE + '\n\n',
      ' \n',
      '\t\n',
      '\r',
      Buffer.from([0xc3, 0x28]),
      Buffer.from([0xe2, 0x82]),
    ]
    for (const tail of invalid) {
      rejected(await run(mode, [answer + done, '\n', tail]), mode)
    }
  })
}
