import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

// The real request serializer runs against a memory-only transport. No provider,
// credential store, app, socket, or production account is imported or invoked.
const root = new URL('../../', import.meta.url)
const PRIVATE = 'SYNTHETIC_UNSUPPORTED_CONTENT_NOT_FOR_LOGS'
const text = value => ({ type: 'text', text: value })
const toolCall = { id: 'synthetic-call', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }
const compile = relative => ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
  fileName: relative, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const adapterCode = compile('src/main/proxy/adapters/kimi.ts')
const protocolCode = compile('src/main/proxy/adapters/providerModelOptions.ts')
function load(code, dependencies, logs) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, URL, Date, Error,
    require: name => { if (Object.hasOwn(dependencies, name)) return dependencies[name]; throw new Error('Unexpected offline dependency') },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [level, (...args) => logs.push({ level, args })])),
  }, { timeout: 1500 })
  return module.exports
}
function harness() {
  const calls = [], logs = [], toolResults = []
  const exports = load(adapterCode, {
    axios: { __esModule: true, default: { post: async (url, body, config) => {
      calls.push({ url, body, config }); return { status: 200, data: {} }
    } } }, stream: { PassThrough },
    './providerModelOptions': load(protocolCode, {}, logs),
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => 'fixture tool prompt', TOOL_WRAP_HINT: '\nfixture tool hint' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: () => ({}) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({
      formatAssistantToolCalls: () => 'fixture serialized tool calls',
      formatToolResult: result => { toolResults.push(result); return 'fixture tool result: ' + result.content },
    }) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }, logs)
  const adapter = new exports.KimiAdapter({ id: 'kimi', apiEndpoint: 'https://www.kimi.com' },
    { id: 'synthetic-account', providerId: 'kimi', credentials: { token: 'SYNTHETIC_TOKEN' } })
  return { adapter, calls, logs, toolResults }
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
async function payload(messages, extra = {}) {
  const h = harness()
  await h.adapter.chatCompletion(freeze({ model: 'k2d6-chat', messages, ...extra }))
  assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat')
  assert.equal(call.config.maxRedirects, 0)
  assert.equal(call.body.readUInt8(0), 0)
  assert.equal(call.body.readUInt32BE(1), call.body.length - 5)
  return { ...h, payload: JSON.parse(call.body.subarray(5).toString('utf8')) }
}
const content = h => h.payload.message.blocks[0].text.content

test('ordered UTF8 text parts serialize identically to ordinary strings', async () => {
  const plain = await payload([{ role: 'user', content: 'Hello 한😀 world' }], { enableThinking: true, enableWebSearch: true })
  const parts = await payload([{ role: 'user', content: [text('Hello '), text('한😀'), text(' world')] }], { enableThinking: true, enableWebSearch: true })
  assert.deepEqual(parts.payload, plain.payload)
  assert.equal(content(parts), 'Hello 한😀 world\n')
  assert.equal(parts.payload.scenario, 'SCENARIO_CHAT')
  assert.equal(parts.payload.message.scenario, 'SCENARIO_CHAT')
  assert.equal(parts.payload.message.role, 'user')
})

test('every system message is preserved in source order, including text-part arrays', async () => {
  const h = await payload([{ role: 'system', content: 'first system' },
    { role: 'user', content: 'question' }, { role: 'system', content: [text('second '), text('system')] }])
  assert.equal(content(h), 'system:first system\nsystem:second system\nquestion\n')
  const single = await payload([{ role: 'system', content: [text('system text')] }, { role: 'user', content: 'question' }])
  assert.equal(content(single), 'system:system text\nquestion\n')
})

test('text parts preserve history, URL wrapping, and tool prompt hint placement', async () => {
  const messages = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'see https://example.invalid/fixture' }]
  const tools = [{ type: 'function', function: { name: 'fixture_tool', parameters: {} } }]
  const plain = await payload(messages, { tools })
  const parts = await payload(messages.map(message => ({ ...message, content: [text(message.content)] })), { tools })
  assert.deepEqual(parts.payload, plain.payload)
  assert.equal(content(parts).includes('old answer'), true)
  assert.equal(content(parts).includes('fixture tool hint'), true)
  assert.equal(content(parts).endsWith('fixture tool prompt'), true)
})

test('assistant text and tool calls both survive, and tool text parts are not object-coerced', async () => {
  const h = await payload([{ role: 'assistant', content: [text('assistant context')], tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: toolCall.id, content: [text('result '), text('text')] },
    { role: 'user', content: 'continue' }])
  assert.equal(content(h).includes('assistant context\nfixture serialized tool calls'), true)
  assert.equal(content(h).includes('fixture tool result: result text'), true)
  assert.equal(h.toolResults[0].content, 'result text')
  assert.equal(content(h).includes('[object Object]'), false)
})

test('null assistant content with tool calls preserves the existing tool-only request', async () => {
  const h = await payload([{ role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: toolCall.id, content: 'result' }])
  assert.equal(content(h).includes('fixture serialized tool calls'), true)
  assert.equal(content(h).includes('fixture tool result: result'), true)
})

test('unsupported and malformed content is rejected before any synthetic transport', async () => {
  const invalid = [null, false, 7, { private: PRIVATE }, [PRIVATE], [null],
    [{ type: 'text' }], [{ type: 'text', text: null }], [{ type: 'text', text: { private: PRIVATE } }],
    [{ type: 'image_url', image_url: { url: PRIVATE } }], [{ type: 'file', file: PRIVATE }],
    [{ type: 'input_audio', input_audio: { data: PRIVATE } }], [text('valid prefix'), { type: 'image_url', image_url: { url: PRIVATE } }]]
  for (const value of invalid) for (const role of ['system', 'user', 'assistant', 'tool']) {
    const h = harness()
    const message = { role, content: value, ...(role === 'tool' ? { tool_call_id: toolCall.id } : {}) }
    const failure = await h.adapter.chatCompletion({ model: 'k2d6-chat', messages: [message] }).catch(error => error)
    assert.equal(failure instanceof Error, true)
    assert.equal(failure.message, 'Kimi message content is not supported')
    assert.equal(failure.cause, undefined)
    assert.equal(h.calls.length, 0)
    assert.equal(inspect({ failure, logs: h.logs }, { showHidden: true }).includes(PRIVATE), false)
  }
})

test('tool-call metadata cannot conceal an unsupported assistant content part', async () => {
  const h = harness()
  const failure = await h.adapter.chatCompletion({ model: 'k2d6-chat', messages: [{ role: 'assistant',
    content: [{ type: 'image_url', image_url: { url: PRIVATE } }], tool_calls: [toolCall] }] }).catch(error => error)
  assert.equal(failure.message, 'Kimi message content is not supported')
  assert.equal(h.calls.length, 0)
})

test('Kimi direct adapter must reject extra text-part metadata rather than silently remove it', async () => {
  const h = harness()
  const failure = await h.adapter.chatCompletion({
    model: 'k2d6-chat',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Visible text', provenance: PRIVATE },
    ] }],
  }).catch(error => error)
  assert.equal(failure instanceof Error, true)
  assert.equal(failure.message, 'Kimi message content is not supported')
  assert.equal(h.calls.length, 0, 'Unexpected metadata must fail before ChatService POST')
  assert.equal(inspect({ failure, logs: h.logs }).includes(PRIVATE), false)
})
