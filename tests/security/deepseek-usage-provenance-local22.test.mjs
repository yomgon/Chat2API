import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Real DeepSeek web completion decoder with synthetic SSE only. The web
// response may provide aggregate usage, but cannot establish prompt/output
// token counts separately. Never invent 1/1 or token total 2.
const original = readFileSync(new URL('../../src/main/proxy/adapters/deepseek-stream.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(original, { fileName: 'deepseek-stream.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const logs = []
const mod = { exports: {} }
vm.runInNewContext(code, {
  module: mod, exports: mod.exports, Buffer, TextDecoder, Date, Error,
  require(name) {
    if (name === 'stream') return { PassThrough }
    if (name === '../utils/toolParser.ts') return {
      parseToolCallsFromText: value => ({ content: value, toolCalls: [] }),
    }
    if (name === '../toolCalling/ToolStreamParser.ts') return { ToolStreamParser: class {} }
    throw Error('Forbidden external dependency in DeepSeek usage test: ' + name)
  },
  console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args),
    warn: (...args) => logs.push(args) },
}, { filename: 'deepseek-stream.ts', timeout: 2000 })
const Handler = mod.exports.DeepSeekStreamHandler
const sse = data => 'data: ' + JSON.stringify(data) + '\n\n'
const valid = sse({ p: 'response/fragments',
  v: [{ type: 'ANSWER', content: 'DeepSeek synthetic completed answer' }] })
const totalOnly = sse({ p: 'response',
  v: [{ p: 'accumulated_token_usage', v: 19 }] })
const done = 'data: [DONE]\n\n'

async function complete(body) {
  const source = new PassThrough()
  const handler = new Handler('deepseek-chat', 'synthetic-id')
  const result = handler.handleNonStream(source)
  source.end(Buffer.from(body, 'utf8'))
  return await result
}

for (const [name, body] of [
  ['no upstream usage', valid + done],
  ['aggregate total only with no prompt/output breakdown', valid + totalOnly + done],
]) {
  test('DeepSeek nonstream ' + name + ' cannot manufacture OpenAI usage counters', async () => {
    const response = await complete(body)
    assert.equal(response.choices[0].message.content, 'DeepSeek synthetic completed answer')
    assert.equal(response.choices[0].finish_reason, 'stop')
    assert.equal('usage' in response, false)
    assert.equal(JSON.stringify(logs).includes('Authorization'), false)
  })
}
