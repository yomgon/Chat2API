import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the production request normalizer, runtime plan, Kimi consumers and
// both real response parsers. The closed loader permits only these pure source
// modules; transport, credentials, stores and request construction are blocked.
const files = [
  'src/main/proxy/adapters/kimi.ts',
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
  {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  },
).outputText]))
const LITERAL = '[function_calls][call:lookup]{}[/call][/function_calls]'
const ORDINARY = 'Ordinary synthetic assistant answer'
const MANAGED = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="lookup"><|CHAT2API|parameter name="city"><![CDATA[synthetic-city]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
const DECLARED = [{
  type: 'function',
  function: { name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object' } },
}]

function loadProduct() {
  const effects = [], logs = [], cache = new Map()
  const forbidden = name => () => {
    effects.push(name)
    throw new Error('Forbidden synthetic capability: ' + name)
  }
  const stubs = {
    axios: { __esModule: true, default: {
      get: forbidden('GET'), post: forbidden('POST'), delete: forbidden('DELETE'),
    } },
    stream: { PassThrough },
    '../utils/tools': {
      hasToolPromptInjected: forbidden('legacy prompt'),
      toolsToSystemPrompt: forbidden('legacy tool definitions'),
      TOOL_WRAP_HINT: '',
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
    },
    './providerModelOptions': {
      resolveKimiScenario: forbidden('scenario'),
      createKimiChatPayload: forbidden('request payload'),
      encodeKimiGrpcFrame: forbidden('request frame'),
    },
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    assert.ok(compiled.has(file), 'source dependency must be explicitly allowed: ' + file)
    const module = { exports: {} }
    cache.set(file, module)
    vm.runInNewContext(compiled.get(file), {
      module, exports: module.exports, Buffer, Date, Error,
      console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [
        level, (...args) => logs.push({ level, args }),
      ])),
      require: name => {
        if (file === files[0] && Object.hasOwn(stubs, name)) return stubs[name]
        assert.ok(name.startsWith('.'), 'external dependency is forbidden: ' + name)
        let target = posix.normalize(posix.join(posix.dirname(file), name))
        if (!target.endsWith('.ts')) target += '.ts'
        return load(target)
      },
    }, { filename: file, timeout: 1500 })
    return module.exports
  }
  return {
    ...load(files[0]),
    ...load('src/main/proxy/toolCalling/ToolCallingEngine.ts'),
    effects, logs,
  }
}

function production(request = {}, config = {}) {
  const h = loadProduct()
  const engine = new h.ToolCallingEngine(config)
  const { plan } = engine.transformRequest({
    request: {
      model: 'synthetic-kimi-model',
      messages: [{ role: 'user', content: 'Synthetic request' }],
      ...request,
    },
    provider: { id: 'kimi' },
    actualModel: 'synthetic-kimi-model',
  })
  return { ...h, engine, plan }
}

function frame(flag, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

async function consume(t, h, mode, text) {
  const handler = new h.KimiStreamHandler('synthetic-kimi-model', '', false, h.plan)
  const input = new PassThrough({ autoDestroy: false })
  const chunks = []
  let output, pending
  if (mode === 'stream') {
    output = await handler.handleStream(input)
    pending = new Promise((resolve, reject) => {
      output.on('data', chunk => chunks.push(chunk.toString('utf8')))
      output.once('end', resolve)
      output.once('error', reject)
    })
  } else {
    pending = handler.handleNonStream(input)
  }
  t.after(() => { input.destroy(); output?.destroy() })
  input.write(frame(0, {
    op: 'append', mask: 'block.text.content',
    message: { role: 'assistant' },
    block: { text: { content: text, flags: 'answer' } },
  }))
  input.end(frame(2, {}))
  const response = await pending
  if (mode === 'nonstream' && h.engine) {
    // The forwarder applies the same engine to the handler's completed result.
    h.engine.applyNonStreamResponse(response, h.plan)
  }
  assert.equal(handler.hasSessionError(), false)
  assert.deepEqual(h.effects, [], 'no transport, auth, store or request construction')
  if (mode === 'nonstream') {
    const choice = response.choices[0]
    assert.equal(choice.message.role, 'assistant')
    return { content: choice.message.content, calls: choice.message.tool_calls, finish: choice.finish_reason }
  }
  assert.equal(handler.hasSuccessfulTerminal(), true)
  const wire = chunks.join('')
  assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1)
  const records = wire.split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
  assert.equal(records.some(record => record.error), false)
  const choices = records.flatMap(record => record.choices ?? [])
  const finishes = choices.filter(choice => choice.finish_reason !== null && choice.finish_reason !== undefined)
  assert.equal(finishes.length, 1)
  const calls = choices.flatMap(choice => choice.delta?.tool_calls ?? [])
  return {
    content: choices.map(choice => choice.delta?.content ?? '').join(''),
    calls: calls.length ? calls : undefined,
    finish: finishes[0].finish_reason,
  }
}

function assertText(result, expected) {
  assert.equal(result.finish, 'stop')
  assert.equal(result.content, expected)
  assert.equal(result.calls, undefined, 'literal text must not become an undeclared tool call')
}

function assertLookup(result, args) {
  assert.equal(result.finish, 'tool_calls')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].type, 'function')
  assert.equal(result.calls[0].function.name, 'lookup')
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), args)
}

const disabledCases = [
  { label: 'omitted tools', request: {}, reason: 'no_tools' },
  { label: 'empty tools', request: { tools: [] }, reason: 'no_tools' },
  { label: 'mode off with declared tools', request: { tools: DECLARED }, config: { mode: 'off' }, reason: 'mode_off' },
  { label: 'enabled false with declared tools', request: { tools: DECLARED }, config: { enabled: false }, reason: 'mode_off' },
]

for (const mode of ['stream', 'nonstream']) {
  for (const scenario of disabledCases) {
    test(mode + ': actual disabled plan preserves literal tool text for ' + scenario.label, { timeout: 2000 }, async t => {
      const h = production(scenario.request, scenario.config)
      assert.equal(h.plan.mode, 'disabled')
      assert.equal(h.plan.diagnostics.reason, scenario.reason)
      assert.equal(h.plan.toolChoiceMode, 'auto')
      assert.equal(h.plan.shouldParseResponse, false)
      assertText(await consume(t, h, mode, LITERAL), LITERAL)
    })
  }

  test(mode + ': explicit tool_choice none keeps declared-tool syntax as text', { timeout: 2000 }, async t => {
    const h = production({ tools: DECLARED, tool_choice: 'none' })
    assert.equal(h.plan.mode, 'disabled')
    assert.equal(h.plan.toolChoiceMode, 'none')
    assertText(await consume(t, h, mode, LITERAL), LITERAL)
  })

  for (const [label, choice] of [
    ['auto', 'auto'],
    ['required', 'required'],
    ['forced', { type: 'function', function: { name: 'lookup' } }],
  ]) {
    test(mode + ': managed ' + label + ' plan still emits a declared tool call', { timeout: 2000 }, async t => {
      const h = production({
        tools: [...DECLARED, { type: 'function', function: { name: 'alternate', parameters: {} } }],
        tool_choice: choice,
      })
      assert.equal(h.plan.mode, 'managed')
      assert.equal(h.plan.shouldParseResponse, true)
      assert.equal(h.plan.toolChoiceMode, label)
      if (label === 'forced') assert.deepEqual([...h.plan.allowedToolNames], ['lookup'])
      assertLookup(await consume(t, h, mode, MANAGED), { city: 'synthetic-city' })
    })
  }

  for (const [label, request] of [['disabled', {}], ['managed', { tools: DECLARED }]]) {
    test(mode + ': ordinary text still completes with a ' + label + ' plan', { timeout: 2000 }, async t => {
      const h = production(request)
      assert.equal(h.plan.mode, label)
      assertText(await consume(t, h, mode, ORDINARY), ORDINARY)
    })
  }
}

for (const [label, plan] of [
  ['no plan', undefined],
  ['legacy partial auto plan', { shouldParseResponse: false, toolChoiceMode: 'auto' }],
]) {
  test('nonstream: direct ' + label + ' retains legacy tool parsing', { timeout: 2000 }, async t => {
    const h = { ...loadProduct(), plan }
    assertLookup(await consume(t, h, 'nonstream', LITERAL), {})
  })
}

test('nonstream: legacy partial none plan keeps literal text', { timeout: 2000 }, async t => {
  const h = { ...loadProduct(), plan: { shouldParseResponse: false, toolChoiceMode: 'none' } }
  assertText(await consume(t, h, 'nonstream', LITERAL), LITERAL)
})
