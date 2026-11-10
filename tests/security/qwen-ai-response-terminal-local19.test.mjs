import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// Execute product parsers with synthetic in-memory streams only. All transport
// methods are forbidden stubs: no app, profile, real credentials or network.
const requireNode = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const PRIVATE = 'SYNTHETIC_PRIVATE_RESPONSE_LOCAL19'
const token = 'SYNTHETIC_OPAQUE_LOCAL19_TOKEN'
const logs = []
const quiet = Object.fromEntries(['log', 'warn', 'error', 'info'].map(
  level => [level, (...args) => logs.push({ level, args })]))
const compile = relative => {
  const result = ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
    fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  })
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return result.outputText
}
const execute = (compiled, dependencies = {}) => {
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Buffer, URL, Date, Error, TextDecoder,
    setTimeout, clearTimeout, console: quiet,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Forbidden offline dependency: ' + name)
    },
  }, { timeout: 2000 })
  return module.exports
}
const promptTools = execute(compile('src/main/proxy/promptToolUse.ts'))
const adapterCode = compile('src/main/proxy/adapters/qwen-ai.ts')
const gate = execute(compile('src/main/proxy/streamTerminalGate.ts'), {
  stream: requireNode('node:stream'),
})
function load(credentials = { token }, tools = promptTools) {
  let effects = 0
  const forbidden = () => {
    effects++
    throw new Error('Synthetic transport is forbidden')
  }
  const exported = execute(adapterCode, {
    axios: { __esModule: true, default: { create: () => ({
      post: forbidden, delete: forbidden, get: forbidden,
    }) } },
    stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    '../promptToolUse': tools,
  })
  const adapter = new exported.QwenAiAdapter({
    id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai',
    modelMappings: { 'Qwen3.7-Plus': 'qwen3.7-plus' },
  }, { id: 'synthetic', providerId: 'qwen-ai', credentials })
  return { ...exported, adapter, effects: () => effects }
}
const product = load()
const event = body => 'data: ' + JSON.stringify(body) + '\n\n'
const answer = (content, status = 'streaming', extra = {}) => ({
  choices: [{ delta: { phase: 'answer', status, content, ...extra } }],
})
const finished = event(answer('confirmed answer', 'finished'))
const done = 'data: [DONE]\n\n'
const turn = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

async function capture(mode, Handler = product.QwenAiStreamHandler, useGate = false, onCleanup) {
  const upstream = new EventEmitter()
  let cleanup = 0
  let outcome
  let wire = ''
  const terminal = []
  const handler = new Handler('qwen3.7-plus', () => { cleanup++; return onCleanup?.() })
  handler.setChatId('synthetic-session')
  if (mode === 'stream') {
    const normalized = await handler.handleStream(upstream)
    const output = useGate
      ? gate.createOpenAIStreamTerminalGate(normalized, result => terminal.push(result))
      : normalized
    output.on('data', bytes => { wire += bytes.toString('utf8') })
    output.on('end', () => { outcome = { ok: handler.hasSuccessfulTerminal() } })
    output.on('error', error => { outcome = { ok: false, error } })
  } else {
    handler.handleNonStream(upstream).then(
      reply => { outcome = { ok: true, reply } },
      error => { outcome = { ok: false, error } })
  }
  return {
    handler, terminal,
    write: value => upstream.emit('data', typeof value === 'string' ? Buffer.from(value) : value),
    end: (close = true) => { upstream.emit('end'); if (close) upstream.emit('close') },
    close: () => upstream.emit('close'),
    error: () => upstream.emit('error', new Error(PRIVATE)),
    result: () => ({ outcome, wire, cleanup }),
  }
}
async function run(mode, pieces, ending = 'end', useGate = false) {
  const h = await capture(mode, undefined, useGate)
  for (const part of pieces) h.write(part)
  if (ending === 'close') h.close()
  else if (ending === 'error') { h.error(); h.close() }
  else h.end(ending !== 'end-only')
  await turn()
  return { ...h.result(), handler: h.handler, terminal: h.terminal }
}
function assertFailure(result, mode) {
  assert.ok(result.outcome, mode + ' must settle')
  assert.equal(result.outcome.ok, false, mode + ' must reject completion')
  assert.equal(result.handler.hasSuccessfulTerminal(), false)
  assert.equal(result.cleanup, 0)
  if (mode === 'stream') {
    assert.match(result.wire, /"error"/)
    assert.doesNotMatch(result.wire, /data: \[DONE\]/)
    assert.doesNotMatch(result.wire, /"finish_reason":"(?:stop|length|tool_calls)"/)
    assert.doesNotMatch(result.wire, /SYNTHETIC_PRIVATE_RESPONSE_LOCAL19/)
  } else {
    assert.match(result.outcome.error.message, /^Qwen AI /)
    assert.doesNotMatch(result.outcome.error.message, /SYNTHETIC_PRIVATE_RESPONSE_LOCAL19/)
  }
}
function streamMessages(wire) {
  return wire.split('\n\n').filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice(6)))
}

test('finished is provisional in both modes until a clean end; cleanup runs once', async () => {
  for (const mode of ['stream', 'nonstream']) {
    const h = await capture(mode)
    h.write(finished)
    await turn()
    assert.equal(h.result().outcome, undefined, mode + ' must await source end')
    assert.equal(h.handler.hasSuccessfulTerminal(), false)
    assert.equal(h.result().cleanup, 0)
    assert.doesNotMatch(h.result().wire, /data: \[DONE\]|"finish_reason":"stop"/)
    h.write(done)
    h.end()
    await turn()
    assert.equal(h.result().outcome?.ok, true)
    assert.equal(h.handler.hasSuccessfulTerminal(), true)
    assert.equal(h.result().cleanup, 1)
    h.error()
    h.close()
    assert.equal(h.result().cleanup, 1)
  }
})

test('clean end without close settles both modes and upstream DONE stays optional', async () => {
  for (const mode of ['stream', 'nonstream']) {
    for (const suffix of ['', done]) {
      const result = await run(mode, [finished, suffix], 'end-only')
      assert.equal(result.outcome?.ok, true)
      assert.equal(result.cleanup, 1)
      if (mode === 'stream') assert.equal((result.wire.match(/data: \[DONE\]/g) || []).length, 1)
      else assert.equal(result.outcome.reply.choices[0].message.content, 'confirmed answer')
    }
  }
})

test('async cleanup rejection cannot escape or revoke a confirmed response', async () => {
  for (const mode of ['stream', 'nonstream']) {
    const h = await capture(mode, undefined, false, async () => {
      throw new Error('Synthetic cleanup rejection')
    })
    h.write(finished)
    h.end()
    await turn()
    assert.equal(h.result().outcome?.ok, true)
    assert.equal(h.result().cleanup, 1)
  }
})

test('metadata, thinking, summaries and empty terminal preserve stream/nonstream content parity', async () => {
  const parts = [
    event({ 'response.created': { response_id: 'synthetic-response' } }),
    event({ choices: [{ delta: { phase: 'think', status: 'streaming', content: 'Reason. ' } }] }),
    event({ choices: [{ delta: { phase: 'think', status: 'finished' } }] }),
    event({ choices: [{ delta: { phase: 'thinking_summary',
      extra: { summary_thought: { content: ['Summary.'] } } } }] }),
    event(answer('Hello ')), event(answer('world')),
    event({ choices: [{ delta: { phase: 'answer', status: 'finished' } }] }),
  ]
  const streamed = await run('stream', parts)
  const buffered = await run('nonstream', parts)
  assert.equal(streamed.outcome?.ok, true)
  assert.equal(buffered.outcome?.ok, true)
  const messages = streamMessages(streamed.wire)
  assert.equal(messages.map(m => m.choices?.[0]?.delta.content || '').join(''),
    buffered.outcome.reply.choices[0].message.content)
  assert.equal(messages.map(m => m.choices?.[0]?.delta.reasoning_content || '').join(''),
    buffered.outcome.reply.choices[0].message.reasoning_content)
  assert.equal(buffered.outcome.reply.id, 'synthetic-response')
})

test('length finish reason and supported choice-level terminal preserve parity', async () => {
  const cases = [
    [event(answer('bounded answer', 'finished', { finish_reason: 'length' }))],
    [event({ choices: [{ delta: { role: 'assistant', content: 'bounded answer' },
      finish_reason: 'length' }] })],
  ]
  for (const parts of cases) for (const mode of ['stream', 'nonstream']) {
    const result = await run(mode, parts)
    assert.equal(result.outcome?.ok, true)
    if (mode === 'stream') assert.match(result.wire, /"finish_reason":"length"/)
    else assert.equal(result.outcome.reply.choices[0].finish_reason, 'length')
  }
})

test('valid UTF-8 including replacement character survives single-byte CRLF chunks', async () => {
  const content = '안녕 😀 \uFFFD'
  const bytes = Buffer.from(event(answer(content, 'finished')).replaceAll('\n', '\r\n'))
  for (const mode of ['stream', 'nonstream']) {
    const result = await run(mode, [...bytes].map(byte => Buffer.from([byte])))
    assert.equal(result.outcome?.ok, true)
    if (mode === 'stream') assert.equal(streamMessages(result.wire)
      .map(m => m.choices?.[0]?.delta.content || '').join(''), content)
    else assert.equal(result.outcome.reply.choices[0].message.content, content)
  }
})

test('size limit applies per SSE event, not a coalesced transport chunk', async () => {
  const part = 'a'.repeat(16000)
  const payload = event(answer(part)).repeat(68) +
    event({ choices: [{ delta: { phase: 'answer', status: 'finished' } }] })
  assert.ok(Buffer.byteLength(payload) > 1_048_576)
  for (const mode of ['stream', 'nonstream']) {
    const result = await run(mode, [payload])
    assert.equal(result.outcome?.ok, true)
  }
})

test('real legacy tool parser produces matching calls after clean end in both modes', async () => {
  const content = '<tool_use><name>lookup</name><arguments>{"query":"synthetic"}</arguments></tool_use>'
  const streamed = await run('stream', [event(answer(content, 'finished'))])
  const buffered = await run('nonstream', [event(answer(content, 'finished'))])
  assert.equal(streamed.outcome?.ok, true)
  assert.equal(buffered.outcome?.ok, true)
  const messages = streamMessages(streamed.wire)
  const calls = messages.flatMap(m => m.choices?.[0]?.delta.tool_calls || [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.name, 'lookup')
  assert.equal(buffered.outcome.reply.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(plain(buffered.outcome.reply.choices[0].message.tool_calls[0].function),
    plain(calls[0].function))
})

const badUtf8 = Buffer.concat([
  Buffer.from('data: {"choices":[{"delta":{"phase":"answer","status":"finished","content":"'),
  Buffer.from([0xc3, 0x28]), Buffer.from('"}}]}\n\n'),
])
const invalidCases = [
  ['partial answer EOF', [event(answer('partial'))]],
  ['premature DONE then finished cannot recover', [done, finished]],
  ['partial then premature DONE cannot recover', [event(answer('partial')), done, finished]],
  ['finished then root error', [finished, event({ error: { message: PRIVATE } })]],
  ['finished then malformed JSON', [finished, 'data: {' + PRIVATE + '\n\n']],
  ['finished then more answer', [finished, event(answer('late content'))]],
  ['duplicate finished', [finished, finished]],
  ['duplicate DONE', [finished, done, done]],
  ['DONE followed by late error', [finished, done, event({ error: PRIVATE })]],
  ['aborted close after finished', [finished], 'close'],
  ['transport error after finished', [finished], 'error'],
  ['incomplete frame after finished', [finished, 'data: {']],
  ['unfinished terminal frame', [finished.slice(0, -1)]],
  ['invalid UTF-8 within assistant content', [badUtf8]],
  ['invalid UTF-8 after terminal', [finished, Buffer.from([0xff, 10, 10])]],
  ['incomplete UTF-8 at EOF', [finished, Buffer.from([0xe2, 0x82])]],
  ['unknown event name', ['event: exception\n' + finished]],
  ['unknown SSE field', ['unexpected: ' + PRIVATE + '\n' + finished]],
  ['null envelope', [event(null), finished]],
  ['array envelope', [event([]), finished]],
  ['unrecognized envelope', [event({ unknown: PRIVATE }), finished]],
  ['empty choices', [event({ choices: [] }), finished]],
  ['non-array choices', [event({ choices: { 0: { delta: { content: 'fake' } }, length: 1 } }), finished]],
  ['multiple choices', [event({ choices: [answer('a', 'finished').choices[0],
    answer('b', 'finished').choices[0]] })]],
  ['wrong choice index', [event({ choices: [{ index: 1,
    delta: { phase: 'answer', status: 'finished', content: 'fake' } }] })]],
  ['array delta', [event({ choices: [{ delta: [] }] }), finished]],
  ['user role', [event(answer('not assistant', 'finished', { role: 'user' }))]],
  ['object content', [event(answer({ value: PRIVATE })), finished]],
  ['array content', [event(answer(['not text'])), finished]],
  ['number content', [event(answer(42)), finished]],
  ['boolean content', [event(answer(false)), finished]],
  ['blank answer', [event(answer(' \n\t', 'finished'))]],
  ['reasoning only', [event({ choices: [{ delta: { phase: 'think',
    status: 'finished', content: 'reasoning is not an answer' } }] })]],
  ['invalid summary array', [event({ choices: [{ delta: { phase: 'thinking_summary',
    extra: { summary_thought: { content: [{ value: PRIVATE }] } } } }] }), finished]],
  ['unknown phase', [event(answer('fake', 'finished', { phase: 'unknown' })), finished]],
  ['unknown status', [event(answer('fake', 'error')), finished]],
  ['unknown finish reason', [event(answer('fake', 'finished', { finish_reason: 'unknown' }))]],
  ['non-string finish reason', [event(answer('fake', 'finished', { finish_reason: { value: PRIVATE } }))]],
  ['conflicting finish reasons', [event({ choices: [{
    delta: { phase: 'answer', status: 'finished', content: 'fake', finish_reason: 'stop' },
    finish_reason: 'length' }] })]],
  ['tool finish without tools', [event(answer('plain text', 'finished', { finish_reason: 'tool_calls' }))]],
  ['explicit falsy root error', [event({ ...answer('fake', 'finished'), error: false })]],
  ['explicit falsy nested error', [event(answer('fake', 'finished', { error: null }))]],
  ['model error hidden on choice', [event({ choices: [{
    ...answer('fake', 'finished').choices[0], error: { message: PRIVATE } }] })]],
  ['oversized frame across short lines', [
    ...Array.from({ length: 132 }, () => 'data: ' + ' '.repeat(8000) + '\n'), finished,
  ]],
]
for (const [name, pieces, ending] of invalidCases) {
  test(name + ' fails closed in stream and nonstream', async () => {
    for (const mode of ['stream', 'nonstream']) assertFailure(await run(mode, pieces, ending), mode)
  })
}

test('adapter output composes with the actual strict route gate', async () => {
  const good = await run('stream', [finished, done], 'end', true)
  assert.equal(good.outcome?.ok, true)
  assert.deepEqual(good.terminal, [true])
  assert.equal((good.wire.match(/data: \[DONE\]/g) || []).length, 1)
  const bad = await run('stream', [finished, event({ error: PRIVATE })], 'end', true)
  assertFailure(bad, 'stream')
  assert.deepEqual(bad.terminal, [false])
})

test('optional cookie and token aliases keep exact supplied safe values without transport', () => {
  for (const credentials of [{ token }, { accessToken: token }, { apiKey: token },
    { token: '', accessToken: token }, { token, cookies: '' }, { token, cookie: null }]) {
    const h = load(credentials)
    const headers = h.adapter.getHeaders()
    assert.equal(headers.Authorization, 'Bearer ' + token)
    assert.equal(Object.hasOwn(headers, 'Cookie'), false)
    assert.equal(h.effects(), 0)
  }
  const cookies = 'session=opaque==; secondary="quoted"'
  for (const key of ['cookies', 'cookie']) {
    const h = load({ token, [key]: cookies })
    assert.equal(h.adapter.getHeaders().Cookie, cookies)
    assert.equal(h.effects(), 0)
  }
})

const invalidCredentials = [
  ['missing token', {}], ['missing credential envelope', null],
  ['array credential envelope', []], ['object token', { token: {} }],
  ['array token', { token: ['opaque'] }], ['numeric token', { token: 42 }],
  ['whitespace token', { token: '   ' }], ['space inside token', { token: 'a b' }],
  ['leading space token', { token: ' ' + token }], ['control token', { token: token + '\r\n' }],
  ['DEL token', { token: token + '\x7f' }], ['non-ASCII token', { token: 'opaque😀' }],
  ['object cookie', { token, cookies: { session: 'opaque' } }],
  ['array cookie', { token, cookies: ['session=opaque'] }],
  ['numeric cookie', { token, cookies: 42 }], ['blank cookie', { token, cookies: ' ' }],
  ['cookie without name/value', { token, cookies: 'opaque' }],
  ['cookie missing name', { token, cookies: '=opaque' }],
  ['cookie with extra bare segment', { token, cookies: 'session=opaque; bare' }],
  ['control cookie', { token, cookies: 'session=opaque\r\nInjected: ' + PRIVATE }],
]
for (const [name, credentials] of invalidCredentials) {
  test(name + ' is auth-preflight failure before any transport', async () => {
    const h = load(credentials)
    const error = await h.adapter.chatCompletion({
      model: 'Qwen3.7-Plus', messages: [{ role: 'user', content: 'synthetic' }],
    }).catch(value => value)
    assert.equal(error instanceof h.QwenAiProxyFailure, true)
    assert.equal(error.stage, 'auth-preflight')
    assert.equal(h.effects(), 0)
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_RESPONSE_LOCAL19|SYNTHETIC_OPAQUE_LOCAL19_TOKEN/)
  })
}

test('all failure diagnostics stay fixed and omit synthetic private values', () => {
  assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC_PRIVATE_RESPONSE_LOCAL19|SYNTHETIC_OPAQUE_LOCAL19_TOKEN/)
})
