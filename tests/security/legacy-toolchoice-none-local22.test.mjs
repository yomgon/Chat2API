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

// Tests the real four legacy dedicated nonstream decoders with the real
// bracket-style tool parser. No Electron/profile/account/HTTP/remote effects.
const root = new URL('../../', import.meta.url)
const requireNode = createRequire(import.meta.url)
const PRIVATE = 'SYNTHETIC_NONSTREAM_TOOL_NOOP_LOCAL22'
const XML = '[function_calls][call:lookup]{"query":"' + PRIVATE + '"}[/call][/function_calls]'
const loadCode = rel => ts.transpileModule(
  readFileSync(new URL(rel, root), 'utf8'),
  { fileName: rel, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } },
).outputText
const log = []
const fakeConsole = Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
  [level, (...args) => log.push({ level, args })]))
const forbidden = () => { throw Error('No external operation in tool-choice test') }
function evaluate(code, dependencies, filename) {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, TextDecoder, TextEncoder,
    Date, Error, URL, URLSearchParams, Uint8Array, setTimeout, clearTimeout,
    console: fakeConsole,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw Error('Forbidden VM import ' + filename + ': ' + name)
    },
  }, { filename, timeout: 1500 })
  return mod.exports
}
const parser = evaluate(loadCode('src/main/proxy/utils/toolParser.ts'), {}, 'toolParser.ts')
const optionModule = evaluate(loadCode('src/main/proxy/adapters/providerModelOptions.ts'),
  {}, 'providerModelOptions.ts')
const common = {
  '../../providers/qwenTicket': QWEN_TICKET_MODULE,
  axios: { __esModule: true, default: {
    get: forbidden, post: forbidden, delete: forbidden,
    create: () => ({ get: forbidden, post: forbidden, request: forbidden }),
  } },
  stream: streams, crypto: {},
  'eventsource-parser': { createParser: requireNode('eventsource-parser').createParser },
  'form-data': { __esModule: true, default: class {} },
  'mime-types': {}, path: {},
  '../../store/store': { storeManager: {} },
  '../utils/tools': { hasToolPromptInjected: () => false, shouldInjectToolPrompt: () => false,
    toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
  '../utils/toolParser': parser,
  '../utils/toolParser.ts': parser,
  '../utils/streamToolHandler': { createBaseChunk: (id, model, created) => ({
    id, model, created, object: 'chat.completion.chunk',
  }) },
  '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  '../toolCalling/ToolStreamParser.ts': { ToolStreamParser: class {} },
  './providerModelOptions': optionModule,
  '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
  zlib, 'zstd-codec': { ZstdCodec: { run: forbidden } },
}
const providers = [
  { key: 'deepseek', path: 'deepseek-stream.ts', constructor: 'DeepSeekStreamHandler' },
  { key: 'qwen', path: 'qwen.ts', constructor: 'QwenStreamHandler' },
  { key: 'glm', path: 'glm.ts', constructor: 'GLMStreamHandler' },
  { key: 'kimi', path: 'kimi.ts', constructor: 'KimiStreamHandler' },
]
const modules = new Map(providers.map(provider => [provider.key,
  evaluate(loadCode('src/main/proxy/adapters/' + provider.path), common, provider.path)]))
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n'
function grpc(flag, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(flag, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
function upstreamBytes(provider) {
  if (provider === 'deepseek') return Buffer.from(
    sse({ p: 'response/fragments', v: [{ type: 'ANSWER', content: XML }] }) + 'data: [DONE]\n\n')
  if (provider === 'qwen') return Buffer.from(sse({
    communication: { sessionid: 'synthetic-id', reqid: 'synthetic-request' },
    data: { messages: [{ mime_type: 'multi_load/iframe', status: 'complete', content: XML }] },
  }))
  if (provider === 'glm') return Buffer.from(sse({
    status: 'streaming', conversation_id: 'synthetic-id',
    parts: [{ logic_id: '0', status: 'streaming', content: [{ type: 'text', text: XML }] }],
  }) + sse({ status: 'finish', conversation_id: 'synthetic-id' }))
  return Buffer.concat([
    grpc(0, { op: 'append', mask: 'block.text.content',
      message: { role: 'assistant' }, block: { text: { content: XML, flags: 'answer' } } }),
    grpc(2, {}),
  ])
}
async function invoke(provider, choice) {
  const plan = { shouldParseResponse: false, toolChoiceMode: choice }
  const { constructor: key } = providers.find(p => p.key === provider)
  const Handler = modules.get(provider)[key]
  const handler = provider === 'deepseek'
    ? new Handler('synthetic-model', 'synthetic-session', undefined, false, undefined, plan)
    : provider === 'qwen' ? new Handler('synthetic-model', undefined, plan)
      : provider === 'glm' ? new Handler('synthetic-model', undefined, undefined, plan)
        : new Handler('synthetic-model', '', false, plan)
  const upstream = new PassThrough()
  const response = handler.handleNonStream(upstream, provider === 'qwen' ? { headers: {} } : undefined)
  upstream.end(upstreamBytes(provider))
  return await response
}

for (const provider of providers.map(p => p.key)) {
  test(provider + ' explicit OpenAI tool_choice:none cannot turn bracketed model text into a tool call', async () => {
    const result = await invoke(provider, 'none')
    assert.equal(result.choices[0].finish_reason, 'stop')
    assert.equal(result.choices[0].message.content, XML)
    assert.equal(result.choices[0].message.tool_calls, undefined)
  })
  test(provider + ' legacy auto without managed parser preserves existing bracket tool conversion', async () => {
    const result = await invoke(provider, 'auto')
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(result.choices[0].message.tool_calls.length, 1)
    assert.equal(result.choices[0].message.tool_calls[0].function.name, 'lookup')
  })
}
