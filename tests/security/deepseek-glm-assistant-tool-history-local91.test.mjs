import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Extract the real DeepSeek/GLM prompt projection methods without importing
// providers or any transport. The tool-call history is a supported public
// Chat request; no external data, operating profile, credentials or POST.
const ROOT = new URL('../../src/main/proxy/adapters/', import.meta.url)
const TOOL = '[SYNTHETIC_VALID_TOOL_CALL]'
const RESULT = '[SYNTHETIC_VALID_TOOL_RESULT]'
const assistantText = 'I checked the inputs and will now call lookup.'
const toolCall = { id: 'call1', type: 'function',
  function: { name: 'lookup', arguments: '{"key":"value"}' } }

function method(file, name) {
  const src = readFileSync(new URL(file, ROOT), 'utf8')
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(item => ts.isClassDeclaration(item) &&
    item.name?.text === (name === 'messagesToPrompt' && file === 'deepseek.ts' ? 'DeepSeekAdapter' : 'GLMAdapter'))
  assert.ok(cls)
  const match = cls.members.find(item => ts.isMethodDeclaration(item) &&
    item.name.getText(ast) === name)
  assert.ok(match, 'Actual provider message projector missing')
  const output = ts.transpileModule(
    'class IsolatedProjection { ' + match.getText(ast) +
    ' } exports.IsolatedProjection=IsolatedProjection',
    { fileName: file, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } },
  ).outputText
  const mod = { exports: {} }
  runInNewContext(output, {
    module: mod, exports: mod.exports, Math, Date, Error, Buffer, JSON,
    getProviderToolProfile: provider => {
      assert.equal(provider, file === 'glm.ts' ? 'glm' : 'deepseek')
      return {
        formatAssistantToolCalls: calls => {
          assert.equal(calls.length, 1)
          assert.equal(calls[0].name, 'lookup')
          assert.equal(calls[0].arguments, '{"key":"value"}')
          return TOOL
        },
        formatToolResult: entry => {
          assert.equal(entry.toolCallId, 'call1')
          return RESULT
        },
      }
    },
  }, { filename: 'offline-projection-' + file, timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  return new mod.exports.IsolatedProjection()
}
const cases = [
  { label: 'DeepSeek', path: 'deepseek.ts', field: 'messagesToPrompt' },
  { label: 'GLM', path: 'glm.ts', field: 'messagesToPrompt' },
]
function messages(content) {
  return [
    { role: 'system', content: 'Keep earlier context in history.' },
    { role: 'user', content: 'First explain the check, then call the tool.' },
    { role: 'assistant', content, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call1', content: 'tool-output' },
    { role: 'user', content: 'Continue using the earlier assistant explanation.' },
  ]
}
function flattened(result) {
  if (typeof result === 'string') return result
  assert.ok(Array.isArray(result))
  assert.equal(result.length, 1)
  assert.equal(result[0].role, 'user')
  assert.ok(Array.isArray(result[0].content))
  return result[0].content.filter(item => item.type === 'text').map(item => item.text).join('')
}

for (const c of cases) {
  for (const [label, content] of [
    ['assistant text string', assistantText],
    ['assistant multipart text', [
      { type: 'text', text: 'I checked the inputs ' },
      { type: 'text', text: 'and will now call lookup.' },
    ]],
  ]) {
    test('local91 ' + c.label + ' wire history preserves ' + label +
      ' alongside serialized tool call and result', () => {
      const adapter = method(c.path, c.field)
      const projected = flattened(adapter[c.field](messages(content)))
      assert.ok(projected.includes(assistantText),
        'The assistant explanatory text is not optional history metadata')
      const textAt = projected.indexOf(assistantText)
      const callAt = projected.indexOf(TOOL)
      const resultAt = projected.indexOf(RESULT)
      assert.ok(textAt >= 0 && callAt > textAt && resultAt > callAt,
        'Assistant text -> assistant tool call -> tool result must retain chronology')
      assert.ok(projected.includes('Continue using the earlier assistant explanation.'))
    })
  }
  for (const content of [null, '']) {
    test('local91 ' + c.label + ' historical assistant tool call with ' +
      (content === null ? 'null' : 'empty') + ' content still serializes correctly', () => {
      const adapter = method(c.path, c.field)
      const projected = flattened(adapter[c.field](messages(content)))
      assert.equal(projected.includes(assistantText), false)
      assert.equal(projected.split(TOOL).length - 1, 1)
      assert.equal(projected.split(RESULT).length - 1, 1)
      assert.ok(projected.indexOf(RESULT) > projected.indexOf(TOOL))
    })
  }
}
