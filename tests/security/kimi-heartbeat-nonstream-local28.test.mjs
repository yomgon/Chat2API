import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Run the actual Kimi decoder and both actual response consumers. Every
// transport, credential, application and unrelated parser capability is
// forbidden. All frames, identifiers and text below are synthetic.
const product = readFileSync(new URL('../../src/main/proxy/adapters/kimi.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(product, {
  fileName: 'kimi.ts',
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText
const PRIVATE = 'SYNTHETIC_HEARTBEAT_ONLY_PRIVATE_LOCAL28'
const ANSWER = 'Ordinary synthetic assistant answer'

function frame(flag, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

function textFrame(content, op = 'append') {
  return {
    op, mask: 'block.text.content',
    block: { text: { content, flags: 'answer' } },
  }
}

function loadHandler() {
  const effects = [], logs = []
  const forbidden = name => () => {
    effects.push(name)
    throw new Error('Forbidden synthetic capability: ' + name)
  }
  const dependencies = {
    axios: { __esModule: true, default: {
      get: forbidden('GET'), post: forbidden('POST'), delete: forbidden('DELETE'),
    } },
    stream: { PassThrough },
    '../utils/tools': {
      hasToolPromptInjected: forbidden('tool prompt'),
      toolsToSystemPrompt: forbidden('tool definitions'),
      TOOL_WRAP_HINT: '',
    },
    '../utils/toolParser': { parseToolCallsFromText: forbidden('legacy tool parsing') },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
    },
    './providerModelOptions': {
      resolveKimiScenario: forbidden('scenario'),
      createKimiChatPayload: forbidden('request payload'),
      encodeKimiGrpcFrame: forbidden('request frame'),
    },
    '../toolCalling/providerProfiles': { getProviderToolProfile: forbidden('tool profile') },
    '../toolCalling/ToolStreamParser': {
      ToolStreamParser: class { constructor() { forbidden('managed tool parsing')() } },
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Buffer, Date, Error,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [
      level, (...args) => logs.push({ level, args }),
    ])),
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected synthetic dependency: ' + name)
    },
  }, { filename: 'kimi.ts', timeout: 1500 })
  const plan = {
    mode: 'disabled', toolChoiceMode: 'none', shouldParseResponse: false,
    shouldInjectPrompt: false, tools: [],
  }
  return {
    ...module.exports, effects, logs,
    handler: new module.exports.KimiStreamHandler('synthetic-kimi-model', '', false, plan),
  }
}

async function consume(t, mode, messages, { terminal = true } = {}) {
  const h = loadHandler()
  const input = new PassThrough({ autoDestroy: false })
  let output, pending
  const chunks = []
  if (mode === 'stream') {
    output = await h.handler.handleStream(input)
    pending = new Promise((resolve, reject) => {
      output.on('data', chunk => chunks.push(chunk.toString('utf8')))
      output.once('end', () => resolve({}))
      output.once('error', reject)
    })
  } else {
    pending = h.handler.handleNonStream(input).then(
      response => ({ response }),
      error => ({ error }),
    )
  }
  t.after(() => { input.destroy(); output?.destroy() })
  for (const message of messages) input.write(frame(0, message))
  input.end(terminal ? frame(2, {}) : undefined)
  const settled = await pending
  const wire = chunks.join('')
  const records = wire.split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
  assert.deepEqual(h.effects, [], 'no request, auth, application or unrelated parser operation')
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  return { ...h, ...settled, mode, wire, records }
}

function assertCompleted(h, expectedText) {
  assert.equal(h.handler.hasSessionError(), false)
  assert.equal(h.error, undefined)
  if (h.mode === 'stream') {
    assert.equal(h.handler.hasSuccessfulTerminal(), true)
    assert.equal(h.records.some(record => record.error), false)
    assert.equal(h.records.flatMap(record => record.choices ?? [])
      .map(choice => choice.delta?.content ?? '').join(''), expectedText)
    assert.equal((h.wire.match(/data: \[DONE\]/g) ?? []).length, 1)
    const choices = h.records.flatMap(record => record.choices ?? [])
    assert.equal(choices.filter(choice => choice.finish_reason === 'stop').length, 1)
    assert.equal(choices.some(choice => choice.delta?.tool_calls), false)
  } else {
    assert.equal(h.response.choices[0].message.role, 'assistant')
    assert.equal(h.response.choices[0].message.content, expectedText)
    assert.equal(h.response.choices[0].message.tool_calls, undefined)
    assert.equal(h.response.choices[0].finish_reason, 'stop')
  }
  assert.equal(JSON.stringify({ response: h.response, records: h.records }).includes(PRIVATE), false,
    'heartbeat payload must not become a public answer or identifier')
}

function assertFailed(h) {
  assert.equal(h.handler.hasSessionError(), true)
  assert.equal(h.handler.hasSuccessfulTerminal(), false)
  if (h.mode === 'stream') {
    assert.equal(h.records.some(record => record.error), true)
    assert.equal(h.wire.includes('data: [DONE]'), false)
    assert.equal(h.records.flatMap(record => record.choices ?? [])
      .some(choice => choice.finish_reason === 'stop'), false)
    assert.equal(h.wire.includes(PRIVATE), false)
  } else {
    assert.equal(h.response, undefined)
    assert.equal(h.error instanceof h.KimiProxyFailure, true)
    assert.equal(h.error.stage, 'response-decoding')
    assert.equal(h.error.message, 'Kimi response decoding failed')
    assert.equal(h.error.message.includes(PRIVATE), false)
  }
}

for (const mode of ['stream', 'nonstream']) {
  test(mode + ': ordinary assistant answer still completes after valid terminal and EOF', { timeout: 1500 }, async t => {
    const h = await consume(t, mode, [{
      ...textFrame(ANSWER),
      chat: { id: 'synthetic-answer-chat' },
      message: { id: 'synthetic-answer-message', role: 'assistant' },
    }])
    assertCompleted(h, ANSWER)
    assert.equal(h.handler.getConversationId(), 'synthetic-answer-chat')
    assert.equal(h.handler.getLastMessageId(), 'synthetic-answer-message')
  })

  for (const op of ['append', 'set']) {
    test(mode + ': heartbeat-only ' + op + ' text cannot establish an assistant answer', { timeout: 1500 }, async t => {
      const h = await consume(t, mode, [{ heartbeat: true, ...textFrame(PRIVATE, op) }])
      assertFailed(h)
    })
  }

  for (const [label, op, text] of [
    ['append', 'append', PRIVATE],
    ['replacement', 'set', PRIVATE],
    ['empty replacement', 'set', ''],
  ]) {
    test(mode + ': heartbeat ' + label + ' cannot change an ordinary assistant answer', { timeout: 1500 }, async t => {
      const h = await consume(t, mode, [
        textFrame(ANSWER),
        { heartbeat: true, ...textFrame(text, op) },
      ])
      assertCompleted(h, ANSWER)
    })
  }

  test(mode + ': heartbeat thinking metadata cannot reclassify a later ordinary answer', { timeout: 1500 }, async t => {
    const h = await consume(t, mode, [
      { heartbeat: true, block: { text: { flags: 'thinking' } } },
      { op: 'append', block: { text: { content: ANSWER } } },
    ])
    assertCompleted(h, ANSWER)
  })

  test(mode + ': heartbeat IDs are not adopted as public answer identifiers', { timeout: 1500 }, async t => {
    const h = await consume(t, mode, [
      { heartbeat: true, chat: { id: PRIVATE }, message: { id: PRIVATE, role: 'assistant' } },
      textFrame(ANSWER),
    ])
    assertCompleted(h, ANSWER)
    assert.equal(h.handler.getConversationId(), null)
    assert.equal(h.handler.getLastMessageId(), null)
  })

  test(mode + ': heartbeat still undergoes role ID and conflicting-chat validation', { timeout: 1500 }, async t => {
    for (const bad of [
      { message: { role: 'user' } },
      { chat: { id: { private: PRIVATE } } },
      { chat: { id: 'synthetic-conflicting-chat' } },
    ]) {
      const h = await consume(t, mode, [
        { ...textFrame(ANSWER), chat: { id: 'synthetic-answer-chat' } },
        { heartbeat: true, ...bad },
      ])
      assertFailed(h)
    }
  })

  test(mode + ': answer and heartbeat still require the Connect terminal before EOF', { timeout: 1500 }, async t => {
    const h = await consume(t, mode, [textFrame(ANSWER), { heartbeat: true }], { terminal: false })
    assertFailed(h)
  })
}
