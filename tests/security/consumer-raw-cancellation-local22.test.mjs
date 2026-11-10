import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough, Transform } from 'node:stream'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// Run actual Z.ai/Qwen International handler + common gate with an in-memory
// raw Readable. Local source destruction is NOT evidence of remote cancellation.
const requireNode = createRequire(import.meta.url)
const transpile = filename => ts.transpileModule(
  readFileSync(new URL('../../src/main/proxy/' + filename, import.meta.url), 'utf8'),
  { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } },
).outputText
const PRIVATE = 'SYNTHETIC_CONSUMER_RAW_PRIVATE_LOCAL22'
const log = []
const fakeConsole = Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
  [level, (...args) => log.push({ level, args })]))
const forbidden = () => { throw Error('External effect forbidden by local22 cancellation fixture') }
function evaluate(code, dependencies, name) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, TextDecoder, Date, Error, URL, URLSearchParams,
    setTimeout, clearTimeout, console: fakeConsole,
    require(importName) {
      if (Object.hasOwn(dependencies, importName)) return dependencies[importName]
      throw Error('Unexpected cancellation fixture import ' + importName)
    },
  }, { filename: name, timeout: 1400 })
  return mod.exports
}
const promptTools = evaluate(transpile('promptToolUse.ts'), {}, 'promptToolUse.ts')
const gate = evaluate(transpile('streamTerminalGate.ts'),
  { stream: { PassThrough, Transform } }, 'streamTerminalGate.ts')
const qwen = evaluate(transpile('adapters/qwen-ai.ts'), {
  axios: { __esModule: true, default: { create: () => ({
    get: forbidden, post: forbidden, delete: forbidden,
  }) } },
  stream: { PassThrough },
  '../promptToolUse': promptTools,
}, 'qwen-ai.ts')
const zai = evaluate(transpile('adapters/zai.ts'), {
  axios: { __esModule: true, default: {
    get: forbidden, post: forbidden, delete: forbidden,
  } },
  stream: { PassThrough }, crypto: {},
  'eventsource-parser': requireNode('eventsource-parser'),
  'form-data': { __esModule: true, default: class FormData {} },
  '../../oauth/zaiSession': {
    readZaiSessionClaims: forbidden, readZaiTokenIdentity: forbidden,
  },
  '../promptToolUse': promptTools,
  '../utils/toolParser': { parseToolCallsFromText: () => ({ content: '', toolCalls: [] }) },
  '../utils/streamToolHandler': {
    createToolCallState: () => ({}), processStreamContent: forbidden,
    flushToolCallBuffer: forbidden, createBaseChunk: () => ({}),
  },
}, 'zai.ts')
const bad = {
  'qwen-ai': Buffer.from('data: {"unrecognized":"' + PRIVATE + '"}\n\n'),
  zai: Buffer.from('data: {"error":{"detail":"' + PRIVATE + '"}}\n\n'),
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const Handler = provider => provider === 'zai' ? zai.ZaiStreamHandler : qwen.QwenAiStreamHandler
function setup(t, provider) {
  const raw = new PassThrough({ autoDestroy: false })
  const handler = new (Handler(provider))('synthetic-model')
  handler.setChatId('synthetic-remote-chat')
  t.after(() => raw.destroy())
  return { raw, handler }
}

for (const provider of ['qwen-ai', 'zai']) {
  test(provider + ' malformed SSE before real EOF cancels the open raw source in streaming mode', async t => {
    const { raw, handler } = setup(t, provider)
    const output = await handler.handleStream(raw)
    const emitted = []
    const ended = new Promise(resolve => {
      output.on('data', chunk => emitted.push(chunk.toString()))
      output.once('end', resolve)
    })
    raw.write(bad[provider])
    await ended
    await nextTurn()
    assert.equal(raw.destroyed, true, provider + ' must cancel its own original input')
    assert.match(emitted.join(''), /"error"/)
    assert.equal(emitted.join('').includes('data: [DONE]'), false)
    assert.equal(JSON.stringify(log).includes(PRIVATE), false)
  })
  test(provider + ' malformed SSE before real EOF cancels the raw source in nonstream mode', async t => {
    const { raw, handler } = setup(t, provider)
    const pending = handler.handleNonStream(raw)
    raw.write(bad[provider])
    await assert.rejects(pending, /Qwen AI |Z\.ai /)
    await nextTurn()
    assert.equal(raw.destroyed, true)
  })
  test(provider + ' early client cancellation propagates through the normalized gate to raw input', async t => {
    const { raw, handler } = setup(t, provider)
    const output = await handler.handleStream(raw)
    const terminal = []
    const verified = gate.createOpenAIStreamTerminalGate(output, value => terminal.push(value))
    verified.on('data', () => {})
    verified.destroy()
    await nextTurn()
    assert.equal(raw.destroyed, true)
    assert.deepEqual(terminal, [false])
    assert.equal(JSON.stringify(log).includes(PRIVATE), false)
  })
}
