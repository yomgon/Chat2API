import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Local21: the provider's logical DONE is not transport EOF. Run the actual
// parser/stream converter against isolated synthetic bytes and forbidden HTTP.
const source = readFileSync(new URL('../../src/main/proxy/adapters/zai.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: 'zai.ts', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const requireNode = createRequire(import.meta.url)
const CANARY = 'SYNTHETIC_ZAI_PRIVATE_LATE_ERROR_LOCAL21'
const answer = 'data: ' + JSON.stringify({
  type: 'chat:completion', data: { phase: 'answer', role: 'assistant', delta_content: 'Complete only after EOF' },
}) + '\n\n'
const done = 'data: ' + JSON.stringify({
  type: 'chat:completion', data: { phase: 'done', done: true },
}) + '\n\n'
const sentinel = 'data: [DONE]\n\n'
const malformed = 'data: {"error":{"credential":"' + CANARY + '"}}\n\n'
const invalidUTF8 = Buffer.from([0xc3, 0x28])

function harness() {
  const logs = []
  const callbacks = []
  const forbidden = () => { throw Error('Forbidden external request, disk or remote effect') }
  const mocks = {
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
      if (Object.hasOwn(mocks, name)) return mocks[name]
      throw Error('Forbidden import ' + name)
    },
    console: Object.fromEntries(['error', 'warn', 'log', 'info'].map(name =>
      [name, (...args) => logs.push(args)])),
    setTimeout(fn) {
      const entry = { fn, cleared: false }
      callbacks.push(entry)
      return entry
    },
    clearTimeout(entry) { entry.cleared = true },
  }, { filename: 'zai.ts', timeout: 2000 })
  const handler = new module.exports.ZaiStreamHandler('synthetic-model')
  handler.setChatId('synthetic-chat')
  return { handler, logs, callbacks }
}

async function nonstream(chunks, terminal = 'end') {
  const h = harness()
  const source = new EventEmitter()
  const settled = h.handler.handleNonStream(source).then(
    value => ({ ok: true, value }), error => ({ ok: false, error }),
  )
  for (const chunk of chunks) source.emit('data', chunk)
  if (terminal === 'error') source.emit('error', new Error(CANARY))
  else if (terminal === 'close') source.emit('close')
  else source.emit('end')
  const result = await settled
  assert.equal(JSON.stringify(h.logs).includes(CANARY), false)
  assert.equal(h.callbacks.every(entry => entry.cleared), true)
  return result
}

async function stream(chunks, terminal = 'end') {
  const h = harness()
  const upstream = new EventEmitter()
  const downstream = await h.handler.handleStream(upstream)
  const messages = []
  downstream.on('data', b => messages.push(b.toString()))
  const ended = new Promise(resolve => downstream.once('end', resolve))
  for (const chunk of chunks) upstream.emit('data', chunk)
  if (terminal === 'error') upstream.emit('error', new Error(CANARY))
  else if (terminal === 'close') upstream.emit('close')
  else upstream.emit('end')
  await ended
  assert.equal(JSON.stringify(h.logs).includes(CANARY), false)
  assert.equal(h.callbacks.every(entry => entry.cleared), true)
  return messages.join('')
}

function failed(result) {
  assert.equal(result.ok, false, 'remote effect is UNKNOWN; no full answer after failure')
  assert.doesNotMatch(result.error.message, new RegExp(CANARY))
}

function failedStream(result) {
  assert.match(result, /"error"/)
  assert.doesNotMatch(result, /data: \[DONE\]/)
  assert.doesNotMatch(result, /"finish_reason":"stop"/)
  assert.doesNotMatch(result, new RegExp(CANARY))
}

for (const suffix of [done, sentinel, done + sentinel]) {
  const label = suffix === done ? 'native done' : suffix === sentinel ? 'DONE sentinel' : 'native+DONE'
  test(label + ' must await clean transport EOF before resolving a completed answer', async () => {
    const h = harness()
    const source = new EventEmitter()
    let settled = false
    const pending = h.handler.handleNonStream(source).finally(() => { settled = true })
    source.emit('data', Buffer.from(answer + suffix))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'logical terminal must remain provisional until EOF')
    source.emit('end')
    const result = await pending
    assert.equal(result.choices[0].message.content, 'Complete only after EOF')
  })
}

for (const terminal of ['error', 'close']) {
  test('post-terminal ' + terminal + ' revokes both nonstream and streaming completion', async () => {
    const prefix = Buffer.from(answer + done)
    failed(await nonstream([prefix], terminal))
    failedStream(await stream([prefix], terminal))
  })
}

test('post-terminal error event, malformed JSON and invalid UTF-8 reject both modes', async () => {
  for (const suffix of [malformed, 'event: error\n' + done, invalidUTF8]) {
    failed(await nonstream([Buffer.from(answer + done), suffix]))
    failedStream(await stream([Buffer.from(answer + done), suffix]))
  }
})

test('a partial extra SSE frame at EOF cannot be discarded after a good logical terminal', async () => {
  const partial = 'data: {"private":'
  failed(await nonstream([Buffer.from(answer + done + partial)]))
  failedStream(await stream([Buffer.from(answer + done + partial)]))
})

test('native completion and clean EOF emit one safe finished answer in both supported modes', async () => {
  const body = await nonstream([Buffer.from(answer + done + sentinel)])
  assert.equal(body.ok, true)
  assert.equal(body.value.choices[0].message.content, 'Complete only after EOF')
  const wire = await stream([Buffer.from(answer + done + sentinel)])
  assert.equal((wire.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal((wire.match(/"finish_reason":"stop"/g) || []).length, 1)
  assert.match(wire, /Complete only after EOF/)
})

test('plain JSON response requires a genuine assistant finish and content', async () => {
  const h = harness()
  for (const bad of [
    { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: null }] },
    { choices: [{ message: { role: 'user', content: 'impersonated' }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'unexpected' }] },
    { error: { message: CANARY }, choices: [{ message: { role: 'assistant', content: 'valid' }, finish_reason: 'stop' }] },
  ]) {
    await assert.rejects(() => h.handler.handleNonStream(bad), /^Error: Z\.ai /)
  }
  const result = await h.handler.handleNonStream({
    choices: [{ message: { role: 'assistant', content: 'real completed JSON answer' }, finish_reason: 'stop' }],
  })
  assert.equal(result.choices[0].message.content, 'real completed JSON answer')
  assert.equal(JSON.stringify(h.logs).includes(CANARY), false)
})

test('an authentic length finish is preserved in nonstream JSON and streaming SSE', async () => {
  const prefix = 'data: ' + JSON.stringify({
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic truncated answer' }, finish_reason: null }],
  }) + '\n\n'
  const terminator = 'data: ' + JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
  }) + '\n\n'
  const finished = await nonstream([Buffer.from(prefix + terminator)])
  assert.equal(finished.ok, true)
  assert.equal(finished.value.choices[0].finish_reason, 'length')
  assert.equal(finished.value.choices[0].message.content, 'Synthetic truncated answer')
  assert.equal('usage' in finished.value, false, 'do not manufacture token accounting')
  const sse = await stream([Buffer.from(prefix + terminator)])
  assert.match(sse, /"finish_reason":"length"/)
  assert.doesNotMatch(sse, /"finish_reason":"stop"/)
  assert.equal((sse.match(/data: \[DONE\]/g) || []).length, 1)
  const h = harness()
  const json = await h.handler.handleNonStream({
    choices: [{ message: { role: 'assistant', content: 'Synthetic length JSON' }, finish_reason: 'length' }],
  })
  assert.equal(json.choices[0].finish_reason, 'length')
  assert.equal('usage' in json, false)
})
