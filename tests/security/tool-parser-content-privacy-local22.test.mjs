import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Real product tool parsing code in a sandbox. No app, user data, transport,
// account, service or other filesystem operations.
const PRIVATE = 'SYNTHETIC_PRIVATE_USER_MESSAGE_AND_TOOL_ARG_LOCAL22'
const compile = relative => ts.transpileModule(
  readFileSync(new URL('../../src/main/proxy/utils/' + relative, import.meta.url), 'utf8'),
  { fileName: relative, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } },
).outputText

function load(code, dependencies, logs, name) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Date, Math, Buffer,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
      throw Error('Unexpected tool helper import ' + specifier)
    },
  }, { filename: name, timeout: 1000 })
  return mod.exports
}

test('legacy parser preserves tool content and returns a valid call without logging user tool arguments', () => {
  const logs = []
  const parser = load(compile('toolParser.ts'), {}, logs, 'toolParser.ts')
  const toolText = '[function_calls][call:lookup]{"query":"' + PRIVATE + '"}[/call][/function_calls]'
  const result = parser.parseToolCallsFromText(toolText, 'kimi')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'lookup')
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).query, PRIVATE)
  assert.equal(JSON.stringify(logs).includes(PRIVATE), false)
  assert.equal(logs.every(item => item.args.every(arg => typeof arg === 'string')), true)
})

test('legacy parser missing bracket normalization cannot log the original user text', () => {
  const logs = []
  const parser = load(compile('toolParser.ts'), {}, logs, 'toolParser.ts')
  const result = parser.parseToolCallsFromText(
    'function_calls][call:lookup]{"query":"' + PRIVATE + '"}[/call][/function_calls]', 'qwen')
  assert.ok(result.toolCalls.length >= 0)
  assert.equal(JSON.stringify(logs).includes(PRIVATE), false)
})

test('streaming tool helper never logs discarded partial model output after tool use', () => {
  const logs = []
  const parser = load(compile('toolParser.ts'), {}, logs, 'toolParser.ts')
  const stream = load(compile('streamToolHandler.ts'),
    { './toolParser': parser, './toolParser/index': {
      createStreamState: () => ({ contentBuffer: '', isBufferingToolCall: false,
        toolCallIndex: 0, hasEmittedToolCall: false }),
    } }, logs, 'streamToolHandler.ts')
  const state = stream.createToolCallState()
  state.hasEmittedToolCall = true
  state.contentBuffer = PRIVATE
  const result = stream.flushToolCallBuffer(state, { id: 'synthetic' }, 'kimi')
  assert.equal(Array.isArray(result), true)
  assert.equal(JSON.stringify(logs).includes(PRIVATE), false)
})
