import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Product forwarder methods and Qwen International's real response handler,
// with inert synthetic transports and no Electron, HTTP, credentials or app.
const root = new URL('../../', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')
const compile = (code, filename) => ts.transpileModule(code, {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const XML = '<tool_use><name>lookup</name><arguments>{"query":"synthetic"}</arguments></tool_use>'
const event = text => 'data: ' + JSON.stringify({
  choices: [{ delta: { phase: 'answer', status: 'finished', content: text } }],
}) + '\n\n'
const forbidden = () => { throw new Error('Local22 prohibits network and account effects') }
const methods = new Map()
const ast = ts.createSourceFile('forwarder.ts', source('src/main/proxy/forwarder.ts'),
  ts.ScriptTarget.Latest, true)
function walk(node) {
  if (ts.isMethodDeclaration(node) &&
      ['forwardZai', 'forwardQwenAi'].includes(node.name.getText(ast))) {
    methods.set(node.name.getText(ast), node.getText(ast))
  }
  ts.forEachChild(node, walk)
}
walk(ast)
assert.equal(methods.size, 2)
const forwardCode = compile('class OfflineForwarder { ' + [...methods.values()].join('\n') +
  '}\nexports.OfflineForwarder = OfflineForwarder;', 'forwarder-local22.ts')

function captureForward(provider, toolChoice) {
  const constructors = []
  const cleanup = []
  class StubAdapter {
    async chatCompletion() {
      return { response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'synthetic-remote-chat', parentId: '', requestId: 'synthetic-request' }
    }
    async deleteChat() { cleanup.push('forbidden-delete') }
  }
  class StubHandler {
    constructor(...args) { constructors.push(args) }
    setChatId() {}
    async handleNonStream() { return { choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: 'Synthetic answer' } }] } }
  }
  const globals = {
    QwenAiAdapter: StubAdapter, ZaiAdapter: StubAdapter,
    QwenAiStreamHandler: StubHandler, ZaiStreamHandler: StubHandler,
    QwenAiProxyFailure: class extends Error {}, ZaiProxyFailure: class extends Error {},
    shouldDeleteSession: () => false,
    hasCompletedNonStreamAnswer: body => body?.choices?.[0]?.message?.content === 'Synthetic answer',
    unconfirmedProviderCompletion: () => { throw Error('Unexpected synthetic incomplete answer') },
    safeWebErrorStatus: () => undefined,
  }
  const mod = { exports: {} }
  vm.runInNewContext(forwardCode, { module: mod, exports: mod.exports,
    ...globals, Date, Error, Promise, Buffer,
    console: { error: forbidden, log: forbidden },
  }, { filename: 'forwarder-local22.ts', timeout: 1000 })
  const forwarder = new mod.exports.OfflineForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages, plan: { shouldParseResponse: false },
  })
  forwarder.applyToolCallsToResponse = () => {}
  forwarder.extractHeaders = () => ({})
  return {
    invoke: () => forwarder[provider === 'zai' ? 'forwardZai' : 'forwardQwenAi']({
      model: 'synthetic-display', messages: [{ role: 'user', content: 'Synthetic prompt' }],
      stream: false, ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    }, { id: 'synthetic-account', credentials: {} },
    { id: provider, apiEndpoint: 'https://synthetic.invalid' },
    'synthetic-wire-model', Date.now()),
    constructors, cleanup,
  }
}

test('actual Z.ai and Qwen Intl forwarder branches preserve explicit none for handler', async () => {
  for (const provider of ['zai', 'qwen-ai']) {
    for (const [choice, expected] of [['none', false], [undefined, true]]) {
      const h = captureForward(provider, choice)
      const result = await h.invoke()
      assert.equal(result.success, true, provider)
      assert.equal(h.constructors.length, 1)
      assert.equal(h.constructors[0][2], expected,
        provider + ' must preserve explicit tool-choice boundary')
      assert.deepEqual(h.cleanup, [])
    }
  }
})

function qwenAiHandler(allowLegacyToolCalls) {
  const toolModule = { exports: {} }
  vm.runInNewContext(compile(source('src/main/proxy/promptToolUse.ts'), 'promptToolUse.ts'), {
    module: toolModule, exports: toolModule.exports, Date, Math,
    require: forbidden,
  }, { timeout: 1000 })
  const mod = { exports: {} }
  vm.runInNewContext(compile(source('src/main/proxy/adapters/qwen-ai.ts'), 'qwen-ai.ts'), {
    module: mod, exports: mod.exports, Buffer, Date, Error,
    require(name) {
      if (name === '../../providers/qwenAiToken') return QWEN_AI_TOKEN_MODULE
      if (name === 'axios') return { __esModule: true,
        default: { create: () => ({ post: forbidden, delete: forbidden, get: forbidden }) } }
      if (name === 'stream') return { PassThrough }
      if (name === '../promptToolUse') return toolModule.exports
      throw new Error('Unexpected Qwen Intl fixture import ' + name)
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
  }, { filename: 'qwen-ai.ts', timeout: 1200 })
  return new mod.exports.QwenAiStreamHandler('synthetic-qwen-web-id',
    undefined, allowLegacyToolCalls)
}

for (const mode of ['nonstream', 'stream']) {
  test('Qwen Intl explicit tool_choice none keeps legacy XML as text in ' + mode, async () => {
    const handler = qwenAiHandler(false)
    const upstream = new PassThrough()
    const completion = mode === 'nonstream'
      ? handler.handleNonStream(upstream)
      : handler.handleStream(upstream)
    const normalized = await (mode === 'nonstream' ? Promise.resolve(null) : completion)
    const frames = []
    const ended = normalized && new Promise(resolve => {
      normalized.on('data', chunk => frames.push(chunk.toString('utf8')))
      normalized.once('end', resolve)
    })
    upstream.end(Buffer.from(event(XML)))
    if (mode === 'nonstream') {
      const answer = await completion
      assert.equal(answer.choices[0].message.content, XML)
      assert.equal(answer.choices[0].finish_reason, 'stop')
      assert.equal(answer.choices[0].message.tool_calls, undefined)
    } else {
      await ended
      const parts = frames.join('')
      assert.match(parts, /data: \[DONE\]/)
      assert.equal(parts.includes('\"tool_calls\"'), false)
      const chunks = parts.split('\n\n').filter(value => value.startsWith('data: {'))
        .map(value => JSON.parse(value.slice('data: '.length)))
      assert.equal(chunks.some(chunk => chunk.choices?.[0]?.delta?.content === XML), true)
      assert.equal(parts.includes('\"finish_reason\":\"stop\"'), true)
    }
  })
}
