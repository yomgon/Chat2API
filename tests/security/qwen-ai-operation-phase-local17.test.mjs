import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Real first-party adapter with strictly synthetic response objects only.
// Never touch actual app/accounts, home profiles, network or a provider token.
const root = fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(path.join(root, 'src/main/proxy/adapters/qwen-ai.ts'), 'utf8')
const requireNode = createRequire(import.meta.url)
const sentry = 'SYNTHETIC_PRIVATE_NETWORK_ERROR_SENTINEL'
const output = []
const consoleStub = Object.fromEntries(['log','warn','error','info'].map(
  name => [name, (...args) => output.push(args)]))

function instance(responses) {
  output.length = 0
  const requests = []
  const axios = { create: () => ({
    post: async (url, payload, config) => {
      requests.push({ url, payload, config })
      const r = responses.shift()
      if (!r) throw new Error('Synthetic unexpected repeated upstream POST')
      if (r instanceof Error) throw r
      return r
    },
  }) }
  const compiled = ts.transpileModule(source, {
    fileName: 'qwen-ai.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => {
      if (name === 'axios') return { __esModule: true, default: axios }
      if (name === 'stream') return { PassThrough }
      if (name === 'eventsource-parser') return requireNode('eventsource-parser')
      if (name === '../promptToolUse') return { hasToolUse: () => false, parseToolUse: () => null }
      if (name === '../../providers/qwenAiToken') return QWEN_AI_TOKEN_MODULE
      throw new Error('Unexpected dependency: ' + name)
    },
    console: consoleStub, Buffer, URL, Date, Error, setTimeout, clearTimeout,
  }, { timeout: 1800 })
  const { QwenAiAdapter } = module.exports
  const adapter = new QwenAiAdapter({ id:'qwen-ai', apiEndpoint:'https://chat.qwen.ai',
    modelMappings:{ 'Qwen3.7-Plus':'qwen3.7-plus' } },
    { id:'synthetic-fixed-account', providerId:'qwen-ai',
      credentials:{ token:'SYNTHETIC_FIXED_LOCAL_TOKEN' } })
  return { adapter, requests, QwenAiAdapter }
}

test('Qwen International fixed chat creation failure stage and numeric status are preserved', async () => {
  const h = instance([{status:403,data:{private:sentry}}])
  const err = await h.adapter.chatCompletion({model:'Qwen3.7-Plus',
    messages:[{role:'user',content:'synthetic'}]}).catch(e=>e)
  assert.equal(err.stage,'chat-creation')
  assert.equal(err.upstreamStatus,403)
  assert.equal(h.requests.length,1)
  assert.doesNotMatch(JSON.stringify(output),/SYNTHETIC_PRIVATE_NETWORK_ERROR_SENTINEL/)
  assert.equal(h.requests[0].config.maxRedirects,0)
})

test('Qwen create-chat malformed response is a chat-creation failure, no completion POST', async () => {
  const h = instance([{status:201,data:{data:{id:'../../bad'}}}])
  const err = await h.adapter.chatCompletion({model:'Qwen3.7-Plus',
    messages:[{role:'user',content:'synthetic'}]}).catch(e=>e)
  assert.equal(err.stage,'chat-creation')
  assert.equal(h.requests.length,1)
})

test('Qwen completed create + rejected completion reports chat-completion stage, never retries', async () => {
  const h = instance([
    {status:201,data:{data:{id:'synthetic-valid-chat'}}},
    {status:429,data:{private:sentry,destroy(){}}},
  ])
  const err = await h.adapter.chatCompletion({model:'Qwen3.7-Plus',
    messages:[{role:'user',content:'synthetic'}]}).catch(e=>e)
  assert.equal(err.stage,'chat-completion')
  assert.equal(err.upstreamStatus,429)
  assert.equal(h.requests.length,2)
  assert.equal(new URL(h.requests[1].url).searchParams.get('chat_id'),'synthetic-valid-chat')
  assert.equal(h.requests[1].config.maxRedirects,0)
})

test('network exception is classified without leaking original URL/header/body', async () => {
  const error=Object.assign(new Error(sentry), {
    config: {url:'https://chat.qwen.ai/?token='+sentry,headers:{Authorization:sentry}},
  })
  const h=instance([error])
  const err=await h.adapter.createChat('qwen3.7-plus').catch(e=>e)
  assert.equal(err.stage,'chat-creation')
  assert.doesNotMatch(err.message,/SYNTHETIC_PRIVATE_NETWORK_ERROR_SENTINEL/)
  assert.equal(err.upstreamStatus,undefined)
  assert.doesNotMatch(JSON.stringify(output),/SYNTHETIC_PRIVATE_NETWORK_ERROR_SENTINEL/)
})

test('Qwen Intl provider detection uses exact first-party HTTPS origin only', () => {
  const { QwenAiAdapter }=instance([])
  for(const bad of [
    'https://chat.qwen.ai.evil.invalid', 'https://foo.chat.qwen.ai.invalid',
    'http://chat.qwen.ai', 'https://user:password@chat.qwen.ai',
    'https://chat.qwen.ai:4443', 'not-a-url', '',
  ]) {
    assert.equal(QwenAiAdapter.isQwenAiProvider({id:'custom',apiEndpoint:bad}),false)
  }
  assert.equal(QwenAiAdapter.isQwenAiProvider({id:'qwen-ai',apiEndpoint:'invalid'}),true)
  assert.equal(QwenAiAdapter.isQwenAiProvider({id:'custom',apiEndpoint:'https://chat.qwen.ai/api/v2'}),true)
})
