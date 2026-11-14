import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as nodeStream from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { createParser } from 'eventsource-parser'

// Actual handler + actual terminal gate, with in-memory raw transport only.
// Local destruction never proves remote cancellation or authorizes replay.
const PRIVATE = 'SYNTHETIC_DEEPSEEK_GLM_RAW_PRIVATE_LOCAL30'
const ANSWER = 'local30 normal answer 완료 😀'
const logs = []
const blockedCalls = []
const forbid = name => (..._args) => {
  blockedCalls.push(name)
  throw new Error('External effect forbidden by local30 raw cancellation fixture: ' + name)
}
const blocked = new Proxy({}, { get: (_target, name) => forbid(String(name))() })
const fakeConsole = Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
  [level, (...args) => logs.push({ level, args })]))
const filenames = ['streamTerminalGate.ts', 'adapters/deepseek-stream.ts', 'adapters/glm.ts']
const sources = Object.fromEntries(filenames.map(filename => [filename,
  readFileSync(new URL('../../src/main/proxy/' + filename, import.meta.url), 'utf8')]))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sourceHashes = Object.fromEntries(filenames.map(filename => [filename, sha256(sources[filename])]))
sourceHashes['tests/security/deepseek-glm-raw-cancellation-local30.test.mjs'] =
  sha256(readFileSync(new URL(import.meta.url)))
console.log('local30 raw cancellation source SHA256 ' + JSON.stringify(sourceHashes))

function evaluate(filename, dependencies) {
  const code = ts.transpileModule(sources[filename], { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, TextDecoder, Date, Error, URL, URLSearchParams,
    console: fakeConsole,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      return forbid('unexpected import ' + name)()
    },
  }, { filename, timeout: 2000 })
  return mod.exports
}

const toolParser = { parseToolCallsFromText: forbid('tool parsing') }
const toolStreamParser = { ToolStreamParser: class {
  constructor() { forbid('tool stream parser construction')() }
} }
const { createOpenAIStreamTerminalGate } = evaluate('streamTerminalGate.ts', { stream: nodeStream })
const { DeepSeekStreamHandler } = evaluate('adapters/deepseek-stream.ts', {
  stream: nodeStream,
  '../utils/toolParser.ts': toolParser,
  '../toolCalling/ToolStreamParser.ts': toolStreamParser,
})
const { GLMStreamHandler } = evaluate('adapters/glm.ts', {
  stream: nodeStream,
  'eventsource-parser': { createParser },
  axios: { __esModule: true, default: blocked },
  crypto: { __esModule: true, default: blocked },
  '../../store/store': { storeManager: blocked },
  'form-data': { __esModule: true, default: class {
    constructor() { forbid('FormData construction')() }
  } },
  'mime-types': { __esModule: true, default: blocked },
  '../utils/tools': {
    toolsToSystemPrompt: forbid('prompt building'), TOOL_WRAP_HINT: '',
    hasToolPromptInjected: forbid('prompt inspection'),
  },
  '../utils/toolParser': toolParser,
  '../utils/streamToolHandler': {
    createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
  },
  '../toolCalling/providerProfiles': { getProviderToolProfile: forbid('provider profile') },
  '../toolCalling/ToolStreamParser': toolStreamParser,
})

const sse = value => 'data: ' + JSON.stringify(value) + '\n\n'
const fixtures = {
  deepseek: {
    answer: sse({ p: 'response/fragments', v: [{ type: 'ANSWER', content: ANSWER }] }),
    terminal: 'data: [DONE]\n\n',
  },
  glm: {
    answer: sse({ status: 'streaming', conversation_id: 'synthetic-glm-local30', parts: [{
      logic_id: '1', status: 'streaming', content: [{ type: 'text', text: ANSWER }],
    }] }),
    terminal: sse({ status: 'finish', conversation_id: 'synthetic-glm-local30' }),
  },
}
const disabledPlan = Object.freeze({ mode: 'disabled', toolChoiceMode: 'none', shouldParseResponse: false })
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
async function drainEvents() {
  await nextTurn()
  await nextTurn()
}
function observe(stream) {
  const state = { chunks: [], errors: [], ends: 0, closes: 0 }
  stream.on('data', chunk => state.chunks.push(chunk.toString()))
  stream.on('error', error => state.errors.push(String(error?.message ?? error)))
  stream.on('end', () => { state.ends += 1 })
  stream.on('close', () => { state.closes += 1 })
  return { state, wire: () => state.chunks.join('') }
}
async function setup(t, provider) {
  const raw = new nodeStream.PassThrough({ autoDestroy: false })
  const completionCallbacks = []
  const onCompleted = () => completionCallbacks.push('completed')
  const handler = provider === 'deepseek'
    ? new DeepSeekStreamHandler('deepseek-chat', 'synthetic-deepseek-local30', onCompleted,
      false, undefined, disabledPlan)
    : new GLMStreamHandler('GLM-synthetic', onCompleted, 'synthetic-glm-local30', disabledPlan)
  const converted = await handler.handleStream(raw)
  const adapterOutput = observe(converted)
  const terminal = []
  const gate = createOpenAIStreamTerminalGate(converted, completed => terminal.push(completed))
  const gateOutput = observe(gate)
  t.after(() => {
    gate.destroy()
    converted.destroy()
    raw.destroy()
  })
  return { raw, gate, converted, completionCallbacks, terminal, adapterOutput, gateOutput }
}
function noNormalTerminal(wire) {
  assert.doesNotMatch(wire, /data: \[DONE\]/)
  assert.doesNotMatch(wire, /"finish_reason":"(?:stop|length|tool_calls)"/)
}
function noLeakOrUnexpectedEffect(h) {
  assert.equal(h.adapterOutput.wire().includes(PRIVATE), false)
  assert.equal(h.gateOutput.wire().includes(PRIVATE), false)
  assert.equal(JSON.stringify(logs).includes(PRIVATE), false)
  assert.deepEqual(blockedCalls, [])
  assert.deepEqual(h.adapterOutput.state.errors, [])
  assert.deepEqual(h.gateOutput.state.errors, [])
}

for (const provider of ['deepseek', 'glm']) {
  test(provider + ' early gate.destroy cancels the original still-open raw source', { timeout: 3000 }, async t => {
    const h = await setup(t, provider)
    await drainEvents()
    assert.equal(h.raw.destroyed, false)
    h.gate.destroy()
    await drainEvents()
    assert.deepEqual(h.terminal, [false])
    assert.deepEqual(h.completionCallbacks, [])
    noNormalTerminal(h.adapterOutput.wire())
    noNormalTerminal(h.gateOutput.wire())
    noLeakOrUnexpectedEffect(h)
    assert.equal(h.raw.destroyed, true, provider + ' downstream cancellation must reach the original raw source')
  })

  test(provider + ' cancelled downstream cannot trigger success cleanup on a later raw EOF', { timeout: 3000 }, async t => {
    const h = await setup(t, provider)
    h.raw.write(fixtures[provider].answer + fixtures[provider].terminal)
    await drainEvents()
    assert.deepEqual(h.terminal, [])
    assert.deepEqual(h.completionCallbacks, [])
    noNormalTerminal(h.adapterOutput.wire())
    noNormalTerminal(h.gateOutput.wire())
    h.gate.destroy()
    await drainEvents()
    // The unfixed handler leaves raw open. Exercise its real late EOF without
    // inventing an end event or writing after a correctly cancelled source.
    if (!h.raw.destroyed) h.raw.end()
    await drainEvents()
    assert.equal(h.completionCallbacks.length, 0,
      provider + ' late EOF after downstream cancellation must not invoke the successful completion/cleanup callback')
    assert.deepEqual(h.terminal, [false])
    noNormalTerminal(h.adapterOutput.wire())
    noNormalTerminal(h.gateOutput.wire())
    noLeakOrUnexpectedEffect(h)
    assert.equal(h.raw.destroyed, true)
  })

  test(provider + ' malformed SSE before EOF closes raw and never reports normal completion', { timeout: 3000 }, async t => {
    const h = await setup(t, provider)
    h.raw.write('data: {"unclosed":"' + PRIVATE + '"\n\n')
    // Deliberately never call raw.end(): autoDestroy cannot mask a raw leak.
    await drainEvents()
    assert.equal(h.gateOutput.state.ends, 1, 'the failure must terminate the downstream stream')
    assert.equal(h.raw.readableEnded, false)
    assert.deepEqual(h.terminal, [false])
    assert.deepEqual(h.completionCallbacks, [])
    assert.match(h.adapterOutput.wire(), /"error"/)
    assert.match(h.gateOutput.wire(), /"code":"provider_stream_incomplete"/)
    noNormalTerminal(h.adapterOutput.wire())
    noNormalTerminal(h.gateOutput.wire())
    noLeakOrUnexpectedEffect(h)
    assert.equal(h.raw.destroyed, true, provider + ' malformed SSE must destroy raw while its transport is still open')
  })

  test(provider + ' normal answer and provider terminal complete once only after clean raw EOF', { timeout: 3000 }, async t => {
    const h = await setup(t, provider)
    const bytes = Buffer.from(fixtures[provider].answer + fixtures[provider].terminal)
    const split = bytes.indexOf(0xf0) + 1
    h.raw.write(bytes.subarray(0, split))
    h.raw.write(bytes.subarray(split))
    await drainEvents()
    assert.equal(h.raw.destroyed, false)
    assert.equal(h.raw.readableEnded, false)
    assert.deepEqual(h.terminal, [])
    assert.deepEqual(h.completionCallbacks, [])
    noNormalTerminal(h.adapterOutput.wire())
    noNormalTerminal(h.gateOutput.wire())
    h.raw.end()
    await drainEvents()
    assert.equal(h.raw.readableEnded, true)
    assert.equal(h.gateOutput.state.ends, 1)
    assert.deepEqual(h.terminal, [true])
    assert.deepEqual(h.completionCallbacks, ['completed'])
    assert.equal(h.gateOutput.wire().includes(ANSWER), true)
    assert.equal((h.gateOutput.wire().match(/data: \[DONE\]/g) ?? []).length, 1)
    assert.equal((h.gateOutput.wire().match(/"finish_reason":"stop"/g) ?? []).length, 1)
    assert.doesNotMatch(h.gateOutput.wire(), /"error"/)
    noLeakOrUnexpectedEffect(h)
  })
}
