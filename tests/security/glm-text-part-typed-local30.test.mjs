import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import * as streams from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { createParser } from 'eventsource-parser'

const { PassThrough } = streams
// Actual GLM consumer, engine/plan/parsers and completion gate; only synthetic
// in-memory SSE is accepted. No transport, account, attachment or application
// store can run in this closed module loader.
const files = [
  'src/main/proxy/adapters/glm.ts',
  'src/main/proxy/streamTerminalGate.ts',
  'src/main/proxy/utils/toolParser.ts',
  'src/shared/toolCalling.ts',
  'src/main/proxy/toolCalling/ToolCallingEngine.ts',
  'src/main/proxy/toolCalling/ToolStreamParser.ts',
  'src/main/proxy/toolCalling/runtimePlan.ts',
  'src/main/proxy/toolCalling/providerProfiles.ts',
  'src/main/proxy/toolCalling/clientAdapters/index.ts',
  'src/main/proxy/toolCalling/clientAdapters/standardOpenAiTools.ts',
  'src/main/proxy/toolCalling/clientAdapters/cherryStudioMcp.ts',
  'src/main/proxy/toolCalling/protocols/index.ts',
  'src/main/proxy/toolCalling/protocols/shared.ts',
  'src/main/proxy/toolCalling/protocols/managedXml.ts',
  'src/main/proxy/toolCalling/protocols/managedBracket.ts',
  'src/main/proxy/toolCalling/protocols/anthropicToolUse.ts',
  'src/main/proxy/toolCalling/protocols/codexResponses.ts',
]
const compiled = new Map(files.map(file => [file, ts.transpileModule(
  readFileSync(new URL('../../' + file, import.meta.url), 'utf8'),
  { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } },
).outputText]))
const PRIVATE = 'SYNTHETIC_GLM_TYPED_ERROR_LOCAL30'
const ANSWER = 'Ordinary synthetic assistant answer'
const LITERAL = '[function_calls][call:lookup]{}[/call][/function_calls]'
const MANAGED = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="lookup"><|CHAT2API|parameter name="city"><![CDATA[synthetic-city]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

function harness({ managed = false } = {}) {
  const effects = [], logs = [], cache = new Map()
  const forbidden = name => () => {
    effects.push(name)
    throw new Error('Forbidden synthetic capability: ' + name)
  }
  const stubs = {
    axios: { __esModule: true, default: {
      get: forbidden('GET'), post: forbidden('POST'), delete: forbidden('DELETE'),
    } },
    crypto: {}, stream: streams, 'eventsource-parser': { createParser },
    'form-data': { __esModule: true, default: class {} }, 'mime-types': {},
    '../../store/store': { storeManager: { updateAccount: forbidden('credential persistence') } },
    '../utils/tools': {
      hasToolPromptInjected: forbidden('legacy prompt'),
      toolsToSystemPrompt: forbidden('request tools'),
      TOOL_WRAP_HINT: '',
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
    },
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    assert.ok(compiled.has(file), 'dependency must be explicitly allowed: ' + file)
    const module = { exports: {} }
    cache.set(file, module)
    vm.runInNewContext(compiled.get(file), {
      module, exports: module.exports, Buffer, TextDecoder, Date, Error,
      console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [
        level, (...args) => logs.push({ level, args }),
      ])),
      require: name => {
        if (Object.hasOwn(stubs, name)) return stubs[name]
        assert.ok(name.startsWith('.'), 'external dependency is forbidden: ' + name)
        let target = posix.normalize(posix.join(posix.dirname(file), name))
        if (!target.endsWith('.ts')) target += '.ts'
        return load(target)
      },
    }, { filename: file, timeout: 1500 })
    return module.exports
  }
  const { ToolCallingEngine } = load('src/main/proxy/toolCalling/ToolCallingEngine.ts')
  const engine = new ToolCallingEngine()
  const { plan } = engine.transformRequest({
    request: {
      model: 'synthetic-glm-model',
      messages: [{ role: 'user', content: 'Synthetic request' }],
      ...(managed ? { tools: [{
        type: 'function', function: { name: 'lookup', parameters: { type: 'object' } },
      }] } : {}),
    },
    provider: { id: 'glm' }, actualModel: 'synthetic-glm-model',
  })
  assert.equal(plan.mode, managed ? 'managed' : 'disabled')
  return {
    ...load(files[0]), ...load(files[1]),
    engine, plan, effects, logs, cleanupCount: 0,
  }
}

const sse = value => 'data: ' + JSON.stringify(value) + '\n\n'
const part = (content, logicId = '1') => ({
  status: 'streaming', conversation_id: 'synthetic-glm-conversation',
  parts: [{ logic_id: logicId, status: 'streaming', content }],
})
const textPart = (text, logicId) => part([{ type: 'text', text }], logicId)
const finish = { status: 'finish', conversation_id: 'synthetic-glm-conversation' }

async function consume(t, mode, messages, options = {}) {
  const h = harness(options)
  const input = new PassThrough({ autoDestroy: false })
  const handler = new h.GLMStreamHandler('synthetic-glm-model', () => { h.cleanupCount++ }, undefined, h.plan)
  const chunks = [], terminals = [], settlements = []
  let converted, output, pending
  if (mode === 'stream') {
    converted = await handler.handleStream(input)
    output = h.createOpenAIStreamTerminalGate(converted, completed => terminals.push(completed))
    pending = new Promise((resolve, reject) => {
      output.on('data', chunk => chunks.push(chunk.toString('utf8')))
      output.once('end', () => { settlements.push('end'); resolve({}) })
      output.once('error', reject)
    })
  } else {
    pending = handler.handleNonStream(input).then(
      body => { settlements.push('body'); return { body } },
      error => { settlements.push('error'); return { error } },
    )
  }
  t.after(() => { input.destroy(); output?.destroy(); converted?.destroy() })
  for (const message of messages) input.write(sse(message))
  if (options.beforeEnd) {
    await options.beforeEnd({ settlements, terminals, cleanupCount: h.cleanupCount, wire: chunks.join('') })
  }
  if (options.end === 'error') input.emit('error', new Error(PRIVATE))
  else if (options.end === 'close') input.destroy()
  else input.end()
  const result = await pending
  if (result.body) h.engine.applyNonStreamResponse(result.body, h.plan)
  const wire = chunks.join('')
  const records = wire.split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
  const choices = records.flatMap(record => record.choices ?? [])
  const content = mode === 'nonstream' ? result.body?.choices[0]?.message?.content
    : choices.map(choice => choice.delta?.content ?? '').join('')
  const completed = mode === 'nonstream' ? h.hasCompletedNonStreamAnswer(result.body)
    : terminals.length === 1 && terminals[0] === true
  assert.deepEqual(h.effects, [])
  assert.equal(JSON.stringify(h.logs).includes(PRIVATE), false)
  assert.equal(wire.includes(PRIVATE), false)
  assert.equal(result.error?.message?.includes(PRIVATE) ?? false, false)
  return { ...h, ...result, mode, wire, records, choices, terminals, content, completed }
}

function assertRejected(result) {
  assert.equal(result.completed, false,
    'malformed provider text must not become a completed assistant: ' + JSON.stringify({
      content: result.content,
      finish: result.body?.choices[0]?.finish_reason ?? result.choices.map(choice => choice.finish_reason),
    }))
  assert.equal(result.cleanupCount, 0)
  if (result.mode === 'nonstream') {
    assert.equal(result.body, undefined)
    assert.equal(result.error?.message, 'GLM response decoding failed')
  } else {
    assert.deepEqual(result.terminals, [false])
    assert.equal(result.wire.includes('data: [DONE]'), false)
    assert.equal(result.choices.some(choice => choice.finish_reason), false)
  }
}

function assertText(result, text, reasoning) {
  assert.equal(result.completed, true)
  assert.equal(result.content, text)
  if (result.mode === 'nonstream') {
    const choice = result.body.choices[0]
    assert.equal(choice.finish_reason, 'stop')
    assert.equal(choice.message.tool_calls, undefined)
    assert.equal(choice.message.reasoning_content, reasoning ?? null)
    assert.equal(Object.hasOwn(result.body, 'usage'), false)
  } else {
    assert.equal(result.cleanupCount, 1)
    assert.equal(result.choices.some(choice => choice.delta?.tool_calls), false)
    assert.equal(result.choices.filter(choice => choice.finish_reason === 'stop').length, 1)
    assert.equal(result.choices.map(choice => choice.delta?.reasoning_content ?? '').join(''), reasoning ?? '')
    assert.equal(result.records.some(record => Object.hasOwn(record, 'usage')), false)
    assert.equal((result.wire.match(/data: \[DONE\]/g) ?? []).length, 1)
  }
}

const invalid = [
  ['missing', { type: 'text' }],
  ['null', { type: 'text', text: null }],
  ['number', { type: 'text', text: 0 }],
  ['boolean', { type: 'text', text: false }],
  ['object', { type: 'text', text: {} }],
  ['array', { type: 'text', text: ['fabricated'] }],
]

for (const mode of ['stream', 'nonstream']) {
  for (const [label, value] of invalid) {
    test('GLM ' + mode + ': invalid text ' + label + ' cannot manufacture a completed assistant', { timeout: 2500 }, async t => {
      assertRejected(await consume(t, mode, [part([value]), finish]))
    })
  }

  test('GLM ' + mode + ': a later valid snapshot cannot hide earlier invalid text', { timeout: 2500 }, async t => {
    assertRejected(await consume(t, mode, [
      part([{ type: 'text' }]), textPart(ANSWER), finish,
    ]))
  })

  test('GLM ' + mode + ': invalid text after an ordinary answer stays failed at terminal EOF', { timeout: 2500 }, async t => {
    assertRejected(await consume(t, mode, [
      textPart(ANSWER), part([{ type: 'text' }], '2'), finish,
    ]))
  })

  test('GLM ' + mode + ': normal text still completes without invented usage', { timeout: 2500 }, async t => {
    assertText(await consume(t, mode, [textPart(ANSWER), finish]), ANSWER)
  })

  test('GLM ' + mode + ': empty text fragments and valid Unicode thinking remain valid', { timeout: 2500 }, async t => {
    assertText(await consume(t, mode, [
      textPart(''),
      part([{ type: 'think', think: 'Synthetic reasoning' }, { type: 'text', text: '완료 😀' }]),
      finish,
    ]), '완료 😀', 'Synthetic reasoning')
  })

  test('GLM ' + mode + ': disabled plan preserves tool-like text', { timeout: 2500 }, async t => {
    assertText(await consume(t, mode, [textPart(LITERAL), finish]), LITERAL)
  })

  test('GLM ' + mode + ': managed declared tool still completes through the real parser', { timeout: 2500 }, async t => {
    const result = await consume(t, mode, [textPart(MANAGED), finish], { managed: true })
    assert.equal(result.completed, true)
    const calls = mode === 'nonstream' ? result.body.choices[0].message.tool_calls
      : result.choices.flatMap(choice => choice.delta?.tool_calls ?? [])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].function.name, 'lookup')
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: 'synthetic-city' })
    if (mode === 'nonstream') assert.equal(result.body.choices[0].finish_reason, 'tool_calls')
    else {
      assert.equal(result.choices.filter(choice => choice.finish_reason === 'tool_calls').length, 1)
      assert.equal(result.cleanupCount, 1)
    }
  })

  test('GLM ' + mode + ': normal terminal waits for real EOF before success and cleanup', { timeout: 2500 }, async t => {
    const result = await consume(t, mode, [textPart(ANSWER), finish], {
      beforeEnd: async snapshot => {
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(snapshot.settlements, [])
        assert.deepEqual(snapshot.terminals, [])
        assert.equal(snapshot.cleanupCount, 0)
        assert.equal(snapshot.wire.includes('data: [DONE]'), false)
      },
    })
    assertText(result, ANSWER)
  })

  test('GLM ' + mode + ': missing terminal still rejects at EOF', { timeout: 2500 }, async t => {
    assertRejected(await consume(t, mode, [textPart(ANSWER)]))
  })

  test('GLM ' + mode + ': upstream error after finish still rejects without cleanup', { timeout: 2500 }, async t => {
    assertRejected(await consume(t, mode, [textPart(ANSWER), finish], { end: 'error' }))
  })

  test('GLM ' + mode + ': premature source close cannot become completed', { timeout: 2500 }, async t => {
    assertRejected(await consume(t, mode, [textPart(ANSWER), finish], { end: 'close' }))
  })
}
