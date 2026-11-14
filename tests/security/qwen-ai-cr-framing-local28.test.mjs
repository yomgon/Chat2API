import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Actual product handler with synthetic in-memory bytes only. No app import,
// credentials, stores, real transport, provider effects or cleanup requests.
const source = readFileSync(new URL('../../src/main/proxy/adapters/qwen-ai.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: 'qwen-ai.ts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true } })
assert.equal(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
const PRIVATE = 'SYNTHETIC_QWEN_CR_PRIVATE_LOCAL28'
const TEXT = 'Confirmed answer 한글 😀 �'
const logs = []
let forbiddenCalls = 0
const forbidden = () => { forbiddenCalls++; throw new Error('Forbidden external effect or import') }
const dependencies = {
  '../../providers/qwenAiToken': QWEN_AI_TOKEN_MODULE,
  axios: { __esModule: true, default: { create: forbidden, get: forbidden, post: forbidden, delete: forbidden } },
  stream: { PassThrough },
  '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
}
const module = { exports: {} }
vm.runInNewContext(compiled.outputText, {
  module, exports: module.exports, Buffer, URL, Date, Error,
  require(name) {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    return forbidden()
  },
  console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(name =>
    [name, (...args) => logs.push(args)])),
}, { filename: 'qwen-ai.ts', timeout: 2000, codeGeneration: { strings: false, wasm: false } })
const Handler = module.exports.QwenAiStreamHandler
const answer = (content = TEXT, status = 'finished', extra = {}) => ({
  choices: [{ delta: { role: 'assistant', phase: 'answer', status, content, ...extra } }],
})
const frame = (body, newline = '\n') => 'data: ' + JSON.stringify(body) + newline + newline
const done = (newline = '\n') => 'data: [DONE]' + newline + newline
const tick = () => new Promise(resolve => setImmediate(resolve))

async function capture(mode) {
  const input = new EventEmitter()
  input.destroyed = false
  input.destroy = () => { input.destroyed = true }
  let cleanup = 0
  let outcome
  let wire = ''
  const handler = new Handler('synthetic-qwen-model', () => { cleanup++ })
  handler.setChatId('synthetic-chat')
  if (mode === 'stream') {
    const output = await handler.handleStream(input)
    output.on('data', bytes => { wire += bytes.toString('utf8') })
    output.once('end', () => { outcome = { ok: handler.hasSuccessfulTerminal() } })
    output.on('error', error => { outcome = { ok: false, error } })
  } else {
    handler.handleNonStream(input).then(
      reply => { outcome = { ok: true, reply } },
      error => { outcome = { ok: false, error } },
    )
  }
  return {
    handler,
    write: chunk => input.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    finish: (signal = 'end') => input.emit(signal, signal === 'error' ? new Error(PRIVATE) : undefined),
    result: () => ({ outcome, wire, cleanup, destroyed: input.destroyed, handler }),
  }
}

async function run(mode, chunks, signal = 'end') {
  const h = await capture(mode)
  for (const chunk of chunks) h.write(chunk)
  h.finish(signal)
  await tick()
  assert.equal(forbiddenCalls, 0)
  assert.equal(JSON.stringify(logs).includes(PRIVATE), false)
  return h.result()
}

function successful(result, mode, expected = TEXT) {
  assert.ok(result.outcome, 'the handler must settle at EOF')
  assert.equal(result.outcome.ok, true, result.outcome.error?.message || 'Expected complete synthetic response')
  assert.equal(result.handler.hasSuccessfulTerminal(), true)
  assert.equal(result.cleanup, 1)
  if (mode === 'nonstream') {
    assert.equal(result.outcome.reply.choices[0].message.role, 'assistant')
    assert.equal(result.outcome.reply.choices[0].message.content, expected)
    assert.equal(result.outcome.reply.choices[0].finish_reason, 'stop')
  } else {
    const messages = result.wire.split('\n\n').filter(value =>
      value.startsWith('data: ') && value !== 'data: [DONE]').map(value => JSON.parse(value.slice(6)))
    assert.equal(messages.map(value => value.choices[0].delta.content || '').join(''), expected)
    assert.equal((result.wire.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal((result.wire.match(/"finish_reason":"stop"/g) || []).length, 1)
    assert.doesNotMatch(result.wire, /"error"/)
  }
}

function rejected(result, mode) {
  assert.ok(result.outcome, 'invalid or incomplete framing must settle as failure')
  assert.equal(result.outcome.ok, false)
  assert.equal(result.handler.hasSuccessfulTerminal(), false)
  assert.equal(result.cleanup, 0)
  assert.equal(result.destroyed, true)
  if (mode === 'nonstream') {
    assert.match(result.outcome.error.message, /^Qwen AI /)
    assert.equal(result.outcome.error.message.includes(PRIVATE), false)
  } else {
    assert.match(result.wire, /"error"/)
    assert.doesNotMatch(result.wire, /data: \[DONE\]|"finish_reason":"(?:stop|length|tool_calls)"/)
    assert.equal(result.wire.includes(PRIVATE), false)
  }
}

for (const mode of ['nonstream', 'stream']) {
  test(mode + ': supported assistant terminal accepts CR-only lines with optional upstream DONE', async () => {
    for (const suffix of ['', done('\r')]) {
      successful(await run(mode, [frame(answer(), '\r') + suffix]), mode)
    }
  })

  test(mode + ': mixed CR, CRLF and LF delimiters preserve the same assistant answer', async () => {
    const wire = 'event: message\r' + 'data: ' + JSON.stringify(answer()) + '\r\n\r' +
      ': heartbeat\r\n\n' + done('\r') + '\n'
    successful(await run(mode, [wire]), mode)
    successful(await run(mode, ['data: ' + JSON.stringify(answer()) + '\r\r: heartbeat\r\n\r\n']), mode)
  })

  test(mode + ': CR and mixed framing survive every byte split, including UTF-8 and CRLF splits', async () => {
    for (const text of [frame(answer(), '\r') + done('\r'),
      'data: ' + JSON.stringify(answer()) + '\r\n\r' + done('\n')]) {
      const bytes = Buffer.from(text)
      for (let split = 1; split < bytes.length; split++) {
        successful(await run(mode, [bytes.subarray(0, split), Buffer.alloc(0), bytes.subarray(split)]), mode)
      }
      successful(await run(mode, Array.from(bytes, byte => Buffer.from([byte]))), mode)
    }
  })

  test(mode + ': CR terminal remains provisional until genuine EOF and never completes on close or error', async () => {
    const h = await capture(mode)
    h.write(frame(answer(), '\r'))
    h.write(Buffer.alloc(0))
    await tick()
    assert.equal(h.result().outcome, undefined)
    assert.equal(h.handler.hasSuccessfulTerminal(), false)
    assert.equal(h.result().cleanup, 0)
    assert.doesNotMatch(h.result().wire, /data: \[DONE\]|"finish_reason":"stop"/)
    h.finish()
    await tick()
    successful(h.result(), mode)
    for (const signal of ['close', 'error']) {
      rejected(await run(mode, [frame(answer(), '\r')], signal), mode)
    }
  })

  test(mode + ': LF and split CRLF controls retain existing behavior', async () => {
    for (const newline of ['\n', '\r\n']) {
      const bytes = Buffer.from(frame(answer(), newline) + done(newline))
      successful(await run(mode, Array.from(bytes, byte => Buffer.from([byte]))), mode)
    }
  })

  test(mode + ': a terminated data line still requires its blank dispatch line', async () => {
    for (const newline of ['\r', '\n', '\r\n']) {
      rejected(await run(mode, ['data: ' + JSON.stringify(answer()) + newline]), mode)
      rejected(await run(mode, [frame(answer(), newline), 'data: {']), mode)
      rejected(await run(mode, [frame(answer(), newline), 'data: [DONE]' + newline]), mode)
    }
  })

  test(mode + ': CR framing cannot rescue invalid JSON, nonassistant roles or missing completion', async () => {
    for (const bad of [
      'data: {broken ' + PRIVATE + '}\r\r',
      frame(answer(TEXT, 'finished', { role: 'user' }), '\r'),
      frame(answer(TEXT, 'finished', { role: 'system' }), '\r'),
      frame(answer(TEXT, 'streaming'), '\r'),
      frame(answer(' \t', 'finished'), '\r'),
      done('\r'),
      'event: exception\r' + frame(answer(), '\r'),
      'unknown-field: ' + PRIVATE + '\r' + frame(answer(), '\r'),
    ]) rejected(await run(mode, [bad]), mode)
  })

  test(mode + ': CR terminal rejects late errors, content, malformed bytes and duplicate terminals', async () => {
    for (const suffix of [
      frame({ error: { message: PRIVATE } }, '\r'),
      'data: {broken ' + PRIVATE + '}\r\r',
      frame(answer('late answer'), '\r'),
      done('\r') + done('\r'),
      'data: {',
      Buffer.from([0xff, 13, 13]),
      Buffer.from([0xe2, 0x82]),
    ]) rejected(await run(mode, [frame(answer(), '\r'), suffix]), mode)
    const corruptAnswer = Buffer.concat([
      Buffer.from('data: {"choices":[{"delta":{"phase":"answer","status":"finished","content":"'),
      Buffer.from([0xc3, 0x28]), Buffer.from('"}}]}\r\r'),
    ])
    rejected(await run(mode, [corruptAnswer]), mode)
  })

  test(mode + ': split final CRLF counts both bytes at the exact per-frame limit', async () => {
    const overhead = Buffer.byteLength(frame(answer(''), '\r\n'))
    const content = 'x'.repeat(1_048_576 - overhead)
    const bytes = Buffer.from(frame(answer(content), '\r\n'))
    assert.equal(bytes.length, 1_048_576)
    successful(await run(mode, [bytes.subarray(0, -1), bytes.subarray(-1)]), mode, content)
  })

  test(mode + ': a final LF cannot bypass the per-frame byte limit after its CR', async () => {
    const overhead = Buffer.byteLength(frame(answer(''), '\r\n'))
    const content = 'x'.repeat(1_048_577 - overhead)
    const bytes = Buffer.from(frame(answer(content), '\r\n'))
    assert.equal(bytes.length, 1_048_577)
    rejected(await run(mode, [bytes.subarray(0, -1), bytes.subarray(-1)]), mode)
  })
}
