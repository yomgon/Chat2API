import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough, Transform } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Exact production OpenAI streaming terminal gate. Deliberately closed VM,
// synthetic bytes only: no proxy/listener, consumer account, or remote effect.
const source = readFileSync(new URL('../../src/main/proxy/streamTerminalGate.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'streamTerminalGate.ts',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, {
  module, exports: module.exports, Buffer, TextDecoder, Error,
  require(specifier) {
    if (specifier === 'stream') return { PassThrough, Transform }
    throw Error('Forbidden import: ' + specifier)
  },
}, { filename: 'streamTerminalGate.ts', timeout: 2000, codeGeneration: { strings: false, wasm: false } })
const { createOpenAIStreamTerminalGate } = module.exports

const PRIVATE = 'SYNTHETIC_ONLY_PRIVATE_STREAM_GATE_LOCAL30'
const data = body => 'data: ' + JSON.stringify(body) + '\n\n'
const answer = data({ object: 'chat.completion.chunk', choices: [{ index: 0,
  delta: { role: 'assistant', content: 'Synthetic confirmed 한글 😀' }, finish_reason: null }] })
const finish = data({ object: 'chat.completion.chunk', choices: [{ index: 0,
  delta: {}, finish_reason: 'stop' }] })
const done = 'data: [DONE]\n\n'
const valid = answer + finish + done

async function exercise(pieces, mode = 'end') {
  const upstream = new PassThrough()
  const terminal = []
  const downstream = createOpenAIStreamTerminalGate(upstream, success => terminal.push(success))
  const received = []
  const ended = new Promise((resolve, reject) => {
    downstream.on('data', part => received.push(part.toString()))
    downstream.once('end', resolve)
    downstream.once('error', reject)
  })
  for (const part of pieces) upstream.write(part)
  const beforeEof = [...terminal]
  if (mode === 'error') upstream.emit('error', Object.assign(new Error(PRIVATE), {
    config: { headers: { Authorization: PRIVATE } },
  }))
  else if (mode === 'close') upstream.destroy()
  else upstream.end()
  await ended
  return { beforeEof, terminal, wire: received.join(''), upstream }
}

function completed(result) {
  assert.deepEqual(result.beforeEof, [], 'Do not settle before actual EOF')
  assert.deepEqual(result.terminal, [true])
  assert.equal((result.wire.match(/data: \[DONE\]/g) ?? []).length, 1)
  assert.match(result.wire, /Synthetic confirmed 한글 😀/)
  assert.match(result.wire, /"finish_reason":"stop"/)
  assert.equal(result.wire.includes(PRIVATE), false)
}

function rejected(result) {
  assert.deepEqual(result.terminal, [false])
  assert.equal(result.wire.includes('data: [DONE]'), false)
  assert.equal(result.wire.includes('"finish_reason":"stop"'), false)
  assert.equal(result.wire.includes(PRIVATE), false)
}

test('baseline genuine assistant and clean EOF still completes', async () => {
  completed(await exercise([valid]))
})

for (const [label, tail] of [
  ['single LF blank line', '\n'],
  ['single CRLF blank line', '\r\n'],
  ['two LF blank lines', '\n\n'],
  ['mixed LF and CRLF blank lines', '\r\n\n\r\n'],
]) {
  test('a completely terminated empty SSE tail is not a failed completion: ' + label, async () => {
    completed(await exercise([valid, tail]))
  })
}

test('a valid blank CRLF tail split at all bytes still completes', async () => {
  const tail = Buffer.from('\r\n\n')
  for (const part of [
    [Buffer.from(valid), tail.subarray(0, 1), tail.subarray(1)],
    [Buffer.from(valid), tail.subarray(0, 2), tail.subarray(2)],
  ]) completed(await exercise(part))
})

for (const [label, tail] of [
  ['dangling carriage return', '\r'],
  ['blank spaces are not empty', ' \n'],
  ['unfinished data field', 'data: {'],
  ['stray nonempty SSE field', 'extra: unsupported\n'],
  ['new malformed event after DONE', 'data: {"error":{"private":"' + PRIVATE + '"}}\n\n'],
]) {
  test('reject ambiguous or nonempty data after terminal: ' + label, async () => {
    rejected(await exercise([valid, tail]))
  })
}

for (const mode of ['error', 'close']) {
  test('a blank tail cannot turn late ' + mode + ' into success', async () => {
    rejected(await exercise([valid, '\r\n'], mode))
  })
}

test('an empty tail cannot manufacture a missing DONE or missing answer', async () => {
  rejected(await exercise([answer + finish, '\r\n']))
  rejected(await exercise([finish + done, '\r\n']))
})
