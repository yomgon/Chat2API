import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough, Transform } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Run the exact shared product SSE gate. In-memory upstream only: no app,
// accounts, network, provider request, credentials or side effects.
const original = readFileSync(new URL('../../src/main/proxy/streamTerminalGate.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(original, {
  fileName: 'streamTerminalGate.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, {
  module, exports: module.exports, Buffer, TextDecoder, Error,
  require(name) {
    if (name === 'stream') return { PassThrough, Transform }
    throw Error('Unexpected shared stream-gate import')
  },
}, { filename: 'streamTerminalGate.ts', timeout: 1200 })
const gate = module.exports.createOpenAIStreamTerminalGate
const frame = chunk => 'data: ' + JSON.stringify(chunk) + '\n\n'
const answer = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: { role: 'assistant', content: 'Synthetic answer' }, finish_reason: null },
] })
const finish = frame({ object: 'chat.completion.chunk', choices: [
  { index: 0, delta: {}, finish_reason: 'stop' },
] })
const usage = frame({ object: 'chat.completion.chunk', choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })
const done = 'data: [DONE]\n\n'

async function run(pieces) {
  const upstream = new PassThrough()
  const terminal = []
  const output = gate(upstream, ok => terminal.push(ok))
  const chunks = []
  const ended = new Promise((resolve, reject) => {
    output.on('data', value => chunks.push(value.toString()))
    output.once('end', resolve)
    output.once('error', reject)
  })
  for (const piece of pieces) upstream.write(piece)
  upstream.end()
  await ended
  return { wire: chunks.join(''), terminal }
}

test('genuine usage-only frame must follow the verified finish chunk, preceding DONE', async () => {
  const result = await run([answer, finish, usage, done])
  assert.deepEqual(result.terminal, [true])
  const items = result.wire.split('\n\n').filter(part => part.startsWith('data: '))
    .map(part => part.slice(6) === '[DONE]' ? '[DONE]' : JSON.parse(part.slice(6)))
  assert.equal(items.length, 4)
  assert.equal(items[0].choices[0].delta.content, 'Synthetic answer')
  assert.equal(items[1].choices[0].finish_reason, 'stop')
  assert.deepEqual(items[2].usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
  assert.deepEqual(items[2].choices, [])
  assert.equal(items[3], '[DONE]')
})

test('no upstream usage emits no manufactured usage frame', async () => {
  const result = await run([answer, finish, done])
  assert.deepEqual(result.terminal, [true])
  assert.equal(result.wire.includes('"usage"'), false)
})

test('late error after usage revokes provisional finish and usage', async () => {
  const result = await run([answer, finish, usage, frame({ error: { secret: 'SYNTHETIC_PRIVATE' } })])
  assert.deepEqual(result.terminal, [false])
  assert.equal(result.wire.includes('data: [DONE]'), false)
  assert.equal(result.wire.includes('"finish_reason":"stop"'), false)
  assert.equal(result.wire.includes('SYNTHETIC_PRIVATE'), false)
})

test('duplicate usage-only frame cannot fabricate repeated accounting', async () => {
  const result = await run([answer, finish, usage, usage, done])
  assert.deepEqual(result.terminal, [false])
  assert.equal(result.wire.includes('data: [DONE]'), false)
  assert.equal(result.wire.includes('"finish_reason":"stop"'), false)
})
