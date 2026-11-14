import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import * as streams from 'node:stream'
import * as zlib from 'node:zlib'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'

// Run each real provider decoder and the real shared OpenAI terminal gate.
// No Electron app, account, credential store, HTTP, remote request or cleanup.
const requireNode = createRequire(import.meta.url)
const code = filename => ts.transpileModule(
  readFileSync(new URL('../../src/main/proxy/' + filename, import.meta.url), 'utf8'),
  { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } },
).outputText
const sse = data => 'data: ' + JSON.stringify(data) + '\n\n'
const qwenAnswer = sse({ communication: { sessionid: 'qwen-session', reqid: 'qwen-request' },
  data: { messages: [{ mime_type: 'multi_load/iframe', status: 'complete', content: 'Qwen synthetic answer' }] } })
const glmAnswer = sse({ status: 'streaming', conversation_id: 'glm-session', parts: [
  { logic_id: '0', status: 'streaming', content: [{ type: 'text', text: 'GLM synthetic answer' }] },
] }) + sse({ status: 'finish', conversation_id: 'glm-session' })
const toolXml = '<tool_use><name>synthetic_tool</name><arguments>{"value":1}</arguments></tool_use>'
const zaiAnswer = sse({ type: 'chat:completion', data: { phase: 'answer', role: 'assistant',
  delta_content: toolXml } }) +
  sse({ type: 'chat:completion', data: { phase: 'done', done: true } })
const zaiLength = sse({ type: 'chat:completion', data: { phase: 'answer', role: 'assistant',
  delta_content: toolXml } }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
const forbidden = () => { throw new Error('Local22 forbids all external provider and account effects') }

function harness(provider) {
  const log = []
  const stubConsole = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level =>
    [level, (...args) => log.push({ level, args })]))
  const common = {
    '../../providers/qwenTicket': QWEN_TICKET_MODULE,
    axios: { __esModule: true, default: {
      get: forbidden, post: forbidden, delete: forbidden,
      create: () => ({ get: forbidden, post: forbidden, request: forbidden }),
    } },
    crypto: {},
    stream: streams,
    'eventsource-parser': requireNode('eventsource-parser'),
    '../utils/tools': { toolsToSystemPrompt: () => '',
      hasToolPromptInjected: () => false, shouldInjectToolPrompt: () => false, TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }),
      parseToolCallsFromTextToArray: forbidden },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) =>
      ({ id, model, created, object: 'chat.completion.chunk' }),
      createToolCallState: () => ({}), processStreamContent: forbidden,
      flushToolCallBuffer: forbidden },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }
  if (provider === 'qwen') {
    common.zlib = zlib
    common['zstd-codec'] = { ZstdCodec: { run: forbidden } }
    common['../promptToolUse'] = { hasToolUse: () => false, parseToolUse: () => null }
  } else if (provider === 'glm') {
    common['../../store/store'] = { storeManager: {} }
    common['form-data'] = { __esModule: true, default: class FormData {} }
    common['mime-types'] = {}
    common.path = {}
  } else {
    const parsed = { exports: {} }
    vm.runInNewContext(code('promptToolUse.ts'), {
      module: parsed, exports: parsed.exports, Date, Math,
      require: forbidden,
    }, { filename: 'promptToolUse.ts', timeout: 1000 })
    common['../promptToolUse'] = parsed.exports
    common['../../oauth/zaiSession'] = {
      readZaiSessionClaims: forbidden, readZaiTokenIdentity: forbidden,
    }
    common['form-data'] = { __esModule: true, default: class FormData {} }
  }
  const mod = { exports: {} }
  vm.runInNewContext(code('adapters/' + provider + '.ts'), {
    module: mod, exports: mod.exports, Buffer, Date, Error, URL, URLSearchParams,
    TextDecoder, TextEncoder, Uint8Array, setTimeout, clearTimeout,
    console: stubConsole,
    require(name) {
      if (Object.hasOwn(common, name)) return common[name]
      throw new Error('Local22 unexpected dependency: ' + name)
    },
  }, { filename: provider + '.ts', timeout: 2000 })
  const Handler = provider === 'qwen' ? mod.exports.QwenStreamHandler
    : provider === 'glm' ? mod.exports.GLMStreamHandler : mod.exports.ZaiStreamHandler
  return { Handler, log }
}

async function perform(provider, mode, { length = false, zaiText = toolXml,
  allowLegacyToolCalls = true } = {}) {
  const { Handler, log } = harness(provider)
  const upstream = new PassThrough()
  const cleanup = []
  const handler = new Handler(provider + '-synthetic-model',
    () => cleanup.push('cleanup'), allowLegacyToolCalls)
  if (provider === 'zai') handler.setChatId('synthetic-chat-id')
  const raw = provider === 'qwen' ? qwenAnswer : provider === 'glm' ? glmAnswer
    : zaiText === toolXml ? (length ? zaiLength : zaiAnswer)
      : sse({ type: 'chat:completion', data: { phase: 'answer', role: 'assistant',
        delta_content: zaiText } }) +
        (length ? sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
          : sse({ type: 'chat:completion', data: { phase: 'done', done: true } }))
  if (mode === 'nonstream') {
    const result = handler.handleNonStream(upstream)
    upstream.end(Buffer.from(raw))
    const value = await result
    return { value, log, cleanup }
  }
  const output = await handler.handleStream(upstream, provider === 'qwen' ? { headers: {} } : undefined)
  const wire = []
  const ended = new Promise((resolve, reject) => {
    output.on('data', part => wire.push(part.toString('utf8')))
    output.once('end', resolve)
    output.once('error', reject)
  })
  upstream.end(Buffer.from(raw))
  await ended
  return { wire: wire.join(''), log, cleanup }
}

test('Z.ai must preserve upstream length instead of upgrading partial XML to a successful tool call', async () => {
  const { value } = await perform('zai', 'nonstream', { length: true })
  assert.equal(value.choices[0].finish_reason, 'length')
  assert.equal(value.choices[0].message.content, toolXml)
  const { wire } = await perform('zai', 'stream', { length: true })
  const frames = wire.split('\n\n').filter(s => s.startsWith('data: {'))
    .map(s => JSON.parse(s.slice('data: '.length)))
  assert.equal(frames.some(f => f.choices?.[0]?.finish_reason === 'length'), true)
  assert.equal(frames.some(f => f.choices?.[0]?.finish_reason === 'tool_calls'), false)
  assert.equal(frames.some(f => f.choices?.[0]?.delta?.tool_calls), false)
  assert.equal(frames.some(f => Object.hasOwn(f, 'usage')), false)
})

test('Z.ai rejects invalid legacy tool arguments before finish or session cleanup', async () => {
  const malformed = '<tool_use><name>lookup</name><arguments></arguments></tool_use>'
  const { wire, cleanup } = await perform('zai', 'stream', { zaiText: malformed })
  assert.match(wire, /"error"/)
  assert.equal(wire.includes('data: [DONE]'), false)
  assert.equal(cleanup.length, 0)
})

test('Z.ai explicit tool_choice none preserves XML as ordinary assistant text', async () => {
  const { wire, cleanup } = await perform('zai', 'stream', { allowLegacyToolCalls: false })
  const frames = wire.split('\n\n').filter(s => s.startsWith('data: {'))
    .map(s => JSON.parse(s.slice('data: '.length)))
  assert.equal(frames.some(f => f.choices?.[0]?.delta?.tool_calls), false)
  assert.equal(frames.some(f => f.choices?.[0]?.delta?.content === toolXml), true)
  assert.equal(frames.some(f => f.choices?.[0]?.finish_reason === 'stop'), true)
  assert.equal(wire.includes('data: [DONE]'), true)
  assert.equal(cleanup.length, 1)
})

test('Z.ai verified nonstream completion carries its already-bound conversation ID', async () => {
  const result = await perform('zai', 'nonstream')
  assert.equal(result.value.id, 'synthetic-chat-id')
  assert.equal(result.value.choices[0].message.role, 'assistant')
  assert.equal(result.value.choices[0].finish_reason, 'stop')
})

for (const provider of ['qwen', 'glm', 'zai']) {
  test(provider + ' nonstream must not invent token counts without upstream accounting', async () => {
    const { value, log } = await perform(provider, 'nonstream')
    assert.equal(value.choices?.[0]?.message?.role, 'assistant')
    assert.equal(value.choices?.[0]?.finish_reason, 'stop')
    assert.equal('usage' in value, false, 'unmeasured token counts are false accounting')
    assert.equal(JSON.stringify(log).includes('Authorization'), false)
  })
  test(provider + ' stream must not invent usage on any normal terminal', async () => {
    const { wire, log } = await perform(provider, 'stream')
    assert.match(wire, /data: \[DONE\]/)
    const frames = wire.split('\n\n').filter(s => s.startsWith('data: {'))
      .map(s => JSON.parse(s.slice('data: '.length)))
    assert.equal(frames.some(f => f.choices?.[0]?.finish_reason), true)
    assert.equal(frames.some(f => Object.hasOwn(f, 'usage')), false,
      'unmeasured token counts must never be fabricated')
    assert.equal(JSON.stringify(log).includes('Authorization'), false)
  })
}
