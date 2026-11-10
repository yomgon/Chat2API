import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Real Kimi Connect handlers + real shared terminal gate with only in-memory
// streams. A local destroy is not proof that a remote inference was cancelled.
const root = new URL('../../', import.meta.url)
const compile = relative => ts.transpileModule(
  readFileSync(new URL('../../' + relative, import.meta.url), 'utf8'), {
    fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  }).outputText
const PRIVATE = 'SYNTHETIC_KIMI_CANCEL_PRIVATE'
const logs = []
const forbidden = () => { throw Error('Local22 forbids network and app effects') }
const common = {
  axios: { __esModule: true, default: { post: forbidden, get: forbidden, delete: forbidden } },
  stream: { PassThrough },
  '../utils/tools': { hasToolPromptInjected: () => false,
    toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
  '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
  '../utils/streamToolHandler': { createBaseChunk: (id, model, created) => ({
    id, model, created, object: 'chat.completion.chunk',
  }) },
  '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
}
function load(code, dependencies, filename) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, URL, Date, Error, TextDecoder, setTimeout, clearTimeout,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw Error('Unexpected local22 VM import ' + name)
    },
  }, { filename, timeout: 2000 })
  return mod.exports
}
const options = load(compile('src/main/proxy/adapters/providerModelOptions.ts'),
  {}, 'providerModelOptions.ts')
const kimi = load(compile('src/main/proxy/adapters/kimi.ts'),
  { ...common, './providerModelOptions': options }, 'kimi.ts')
const gate = load(compile('src/main/proxy/streamTerminalGate.ts'),
  { stream: { PassThrough, Transform: (await import('node:stream')).Transform } }, 'streamTerminalGate.ts')

const frame = (flag, object) => {
  const bytes = Buffer.from(JSON.stringify(object), 'utf8')
  const prefix = Buffer.alloc(5)
  prefix.writeUInt8(flag, 0)
  prefix.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([prefix, bytes])
}
const good = frame(0, { op: 'append', mask: 'block.text.content',
  message: { role: 'assistant' }, block: { text: { content: 'Safe answer', flags: 'answer' } } })
const done = frame(2, {})
const invalid = frame(0, { op: 'append', mask: 'block.text.content',
  chat: { id: { hidden: PRIVATE } },
  block: { text: { content: PRIVATE, flags: 'answer' } } })
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function setup(t) {
  const raw = new PassThrough({ autoDestroy: false })
  const handler = new kimi.KimiStreamHandler('synthetic-kimi-model', '')
  t.after(() => raw.destroy())
  return { raw, handler }
}

test('stream parser rejection destroys its original open provider body before teardown', async t => {
  const { raw, handler } = setup(t)
  const output = await handler.handleStream(raw)
  const chunks = []
  const end = new Promise(resolve => {
    output.on('data', value => chunks.push(value.toString()))
    output.once('end', resolve)
  })
  raw.write(invalid)
  await end
  await nextTurn()
  assert.equal(raw.destroyed, true, 'real upstream must be cancelled locally on parse failure')
  assert.equal(handler.hasSessionError(), true)
  assert.equal(handler.hasSuccessfulTerminal(), false)
  assert.match(chunks.join(''), /"error"/)
  assert.equal(chunks.join('').includes('data: [DONE]'), false)
  assert.equal(JSON.stringify(logs).includes(PRIVATE), false)
})

test('nonstream parser rejection destroys its original open provider body before teardown', async t => {
  const { raw, handler } = setup(t)
  const pending = handler.handleNonStream(raw)
  raw.write(invalid)
  await assert.rejects(pending, /Kimi /)
  await nextTurn()
  assert.equal(raw.destroyed, true)
  assert.equal(handler.hasSessionError(), true)
  assert.equal(handler.hasSuccessfulTerminal(), false)
})

test('downstream gate early close cancels original Kimi provider stream once', async t => {
  const { raw, handler } = setup(t)
  const output = await handler.handleStream(raw)
  const terminal = []
  const downstream = gate.createOpenAIStreamTerminalGate(output, success => terminal.push(success))
  downstream.on('data', () => {})
  downstream.destroy()
  await nextTurn()
  assert.equal(raw.destroyed, true, 'gateway cancellation must reach Axios response body')
  assert.equal(handler.hasSessionError(), true)
  assert.equal(handler.hasSuccessfulTerminal(), false)
  assert.deepEqual(terminal, [false])
})

test('valid Kimi Connect answer + EndStreamResponse + clean EOF still completes', async t => {
  const { raw, handler } = setup(t)
  const output = await handler.handleStream(raw)
  const terminal = []
  const downstream = gate.createOpenAIStreamTerminalGate(output, success => terminal.push(success))
  const chunks = []
  const end = new Promise(resolve => {
    downstream.on('data', value => chunks.push(value.toString()))
    downstream.once('end', resolve)
  })
  raw.end(Buffer.concat([good, done]))
  await end
  assert.equal(handler.hasSessionError(), false)
  assert.equal(handler.hasSuccessfulTerminal(), true)
  assert.deepEqual(terminal, [true])
  assert.equal(chunks.join('').includes('data: [DONE]'), true)
  assert.equal(chunks.join('').includes('Safe answer'), true)
})
