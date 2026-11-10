import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Execute the real adapter AND forwarder with synthetic network transports.
// No actual account, Electron profile, local proxy server or provider network.
const root = fileURLToPath(new URL('../../', import.meta.url))
const requireNode = createRequire(import.meta.url)
const source = name => readFileSync(path.join(root, name), 'utf8')
const TOKEN_SENTINEL = 'SYNTHETIC_TOKEN_FROM_SAFETY_TEST'
const capturedConsole = []
const silent = Object.fromEntries(['log','warn','error','info'].map(level =>
  [level, (...args) => capturedConsole.push({ level, args })]))

function load(relative, dependencies) {
  const result = ts.transpileModule(source(relative), { fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true }, reportDiagnostics: true })
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, { module, exports: module.exports,
    require: id => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]
      throw new Error('Unrecognized fixture module ' + id)
    },
    console: silent, Buffer, URL, URLSearchParams, Date, Error, setTimeout, clearTimeout,
  }, { filename: relative, timeout: 1800 })
  return module.exports
}

const claims = load('src/main/oauth/zaiSession.ts', { crypto })
function noExpJwt() {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const b = Buffer.from(JSON.stringify({ id: 'synthetic-verified-subject',
    email: 'example@example.invalid', note: TOKEN_SENTINEL })).toString('base64url')
  return [h, b, 'synthetic-signature'].join('.')
}

function harness(options = {}) {
  capturedConsole.length = 0
  const token = noExpJwt()
  const requests = []
  let posts = 0
  const axios = {
    get: async (url, options) => {
      requests.push({ method: 'GET', url, options })
      if (options?.throwOnAuth) throw new Error('raw sensitive upstream error ' + TOKEN_SENTINEL)
      return { status: optionsAuthStatus(), headers: { 'content-type': 'application/json' },
        data: { id: 'synthetic-verified-subject', token } }
    },
    post: async (url, body, config) => {
      posts++
      requests.push({ method: 'POST', url, body, config })
      if (posts === options.throwPost) {
        const error = new Error('raw private provider error ' + TOKEN_SENTINEL)
        error.config = { url: url + '&secret=' + TOKEN_SENTINEL,
          headers: { Authorization: 'Bearer ' + TOKEN_SENTINEL } }
        throw error
      }
      if (posts === 1) {
        return { status: options.createStatus ?? 201,
          data: options.malformedCreate ? {} : { id: 'synthetic-chat-id' } }
      }
      const stream = new PassThrough()
      if (options.completeStatus === 200) {
        queueMicrotask(() => stream.end(
          'data: '+JSON.stringify({ type:'chat:completion', data:{ phase:'answer',
            delta_content:'synthetic answer' } })+'\n\n'+
          'data: '+JSON.stringify({ type:'chat:completion', data:{ phase:'done', done:true } })+'\n\n'))
      }
      return { status: options.completeStatus ?? 503, data: stream, headers: {} }
    },
    create: () => ({ request: async () => { throw new Error('Unwanted generic forward') } }),
  }
  function optionsAuthStatus() { return options.authStatus ?? 200 }
  const fakeStreamDeps = {
    createToolCallState: () => ({ hasEmittedToolCall:false }),
    processStreamContent: () => ({ chunks:[] }),
    flushToolCallBuffer: () => [],
    createBaseChunk: () => ({}),
  }
  const adapterModule = load('src/main/proxy/adapters/zai.ts', {
    axios: { __esModule:true, default:axios }, crypto,
    stream: { PassThrough }, 'eventsource-parser':requireNode('eventsource-parser'),
    'form-data': { __esModule:true, default:class FormData {} },
    '../../oauth/zaiSession':claims,
    '../promptToolUse': { hasToolUse:()=>false, parseToolUse:()=>null },
    '../utils/toolParser': { parseToolCallsFromText:()=>[] },
    '../utils/streamToolHandler':fakeStreamDeps,
  })
  const inert = class {
    static isDeepSeekProvider() { return false }
    static isGLMProvider() { return false }
    static isKimiProvider() { return false }
    static isMimoProvider() { return false }
    static isQwenProvider() { return false }
    static isQwenAiProvider() { return false }
    static isMiniMaxProvider() { return false }
    static isPerplexityProvider() { return false }
  }
  const store = { getConfig: () => ({ retryCount:5,
    contextManagement: { enabled:true } }) }
  const forward = load('src/main/proxy/forwarder.ts', {
    axios: { __esModule:true, default:axios },
    http2:{ __esModule:true, default:{} }, stream:{ PassThrough },
    '../store/store': { storeManager:store },
    './status': { proxyStatusManager:{} },
    './adapters/deepseek': { DeepSeekAdapter:inert },
    './adapters/deepseek-stream': { DeepSeekStreamHandler:class {} },
    './adapters/glm': { GLMAdapter:inert, GLMStreamHandler:class {} },
    './adapters/kimi': { KimiAdapter:inert, KimiStreamHandler:class {} },
    './adapters/mimo': { MimoAdapter:inert, MimoStreamHandler:class {} },
    './adapters/qwen': { QwenAdapter:inert, QwenStreamHandler:class {} },
    './adapters/qwen-ai': { QwenAiAdapter:inert, QwenAiStreamHandler:class {} },
    './adapters/zai':adapterModule,
    './adapters/minimax': { MiniMaxAdapter:inert, MiniMaxStreamHandler:class {} },
    './adapters/perplexity': { PerplexityAdapter:inert },
    './adapters/perplexity-stream': { PerplexityStreamHandler:class {} },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine:class {} },
    './sessionManager': { sessionManager: {shouldDeleteAfterChat:()=>false} },
    './streamTerminalGate': {hasCompletedNonStreamAnswer:()=>false},
    './services/contextManagementService': { createContextManagementService:()=>{
      throw new Error('Z.ai must not start an implicit summary model request') } },
  })
  const forwarder = new forward.RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({ messages:request.messages, plan:{} })
  forwarder.applyToolCallsToResponse = () => {}
  const account = { id:'synthetic-account', providerId:'zai', status:'active', credentials:{ token } }
  const provider = { id:'zai', apiEndpoint:'https://chat.z.ai' }
  const request = { model:'zai-one-shot-synthetic', messages:[{role:'user',content:'Hello'}],
    stream:false, web_search:false, reasoning_effort:false }
  const forwardOne = () => forwarder.forwardChatCompletion(request, account, provider, 'x-preview-l',
    {requestId:'synthetic-local-id',model:request.model,actualModel:'x-preview-l',startTime:Date.now(),isStream:false})
  return { forwardOne, requests, token, adapterModule, forwarder, account }
}

test('all dedicated consumer-web adapters have zero automatic retries and no hidden summary requests', async () => {
  const h = harness()
  let remoteAttemptCount = 0
  h.forwarder.providerForwarders = [{
    name:'synthetic-non-zai-web',
    matches:provider=>provider.id==='qwen-ai',
    forward:async()=>{
      remoteAttemptCount++
      return { success:false, status:502, error:'synthetic upstream failure', latency:1 }
    },
  }]
  const result = await h.forwarder.forwardChatCompletion({
    model:'synthetic-model', messages:[{role:'user',content:'synthetic request'}], stream:false,
  },h.account,{id:'qwen-ai',apiEndpoint:'https://chat.qwen.ai'},'synthetic-wire-model',{
    requestId:'synthetic-id',model:'synthetic-model',startTime:Date.now(),isStream:false,
  })
  assert.equal(result.success,false)
  assert.equal(result.status,502)
  assert.equal(remoteAttemptCount,1,'web effects must not replay when global retryCount is 5')
  assert.equal(capturedConsole.some(x=>x.args.some(v=>String(v).includes('Context management failed'))),false,
    'no unexpected auxiliary summarization is permitted for a consumer-web operation')
})

test('Qwen/Kimi fixed diagnostic code survives the outer forwardChatCompletion result', async () => {
  for (const [providerId, expectedCode] of [
    ['qwen-ai', 'qwen_ai_upstream_operation_failed'],
    ['kimi', 'kimi_upstream_operation_failed'],
  ]) {
    const h = harness()
    let dispatched = 0
    h.forwarder.providerForwarders = [{
      name:'synthetic-provider',
      matches:p=>p.id===providerId,
      forward:async()=>{ dispatched++; return { success:false, status:403,
        error:'fixed', failureCode:expectedCode, latency:1 } },
    }]
    const result = await h.forwarder.forwardChatCompletion({
      model:'test-synthetic', messages:[{role:'user',content:'synthetic'}], stream:false,
    },h.account,{id:providerId,apiEndpoint:'https://unused.invalid'},'model',{
      requestId:'synthetic-id',model:'test-synthetic',startTime:Date.now(),isStream:false,
    })
    assert.equal(dispatched,1)
    assert.equal(result.status,403)
    assert.equal(result.failureCode,expectedCode)
  }
})

test('403 at first-party identity GET stays auth-preflight 403; creates zero chats even when global retries and summaries are enabled', async () => {
  const h = harness({ authStatus:403 })
  const outcome = await h.forwardOne()
  assert.equal(outcome.success, false)
  assert.equal(outcome.status, 403)
  assert.equal(outcome.failureStage, 'auth-preflight')
  assert.deepEqual(h.requests.map(c=>c.method), ['GET'])
  assert.doesNotMatch(JSON.stringify(outcome), /SYNTHETIC_TOKEN_FROM_SAFETY_TEST/)
})

test('4xx create-chat response remains a single remote POST with phase and original status, never a generic 500', async () => {
  const h = harness({ createStatus:429 })
  const outcome = await h.forwardOne()
  assert.equal(outcome.success, false)
  assert.equal(outcome.status, 429)
  assert.equal(outcome.failureStage, 'chat-creation')
  assert.deepEqual(h.requests.map(c=>c.method), ['GET','POST'])
  assert.equal(h.requests[1].url, 'https://chat.z.ai/api/v1/chats/new')
  assert.deepEqual(Array.from(h.requests[1].body.chat.models), ['x-preview-l'])
})

test('ACK loss during create-chat never replays; fixed code does not reveal raw Axios response or token', async () => {
  const h = harness({ throwPost:1 })
  const outcome = await h.forwardOne()
  assert.equal(outcome.success, false)
  assert.equal(outcome.status, 502)
  assert.equal(outcome.failureStage, 'chat-creation')
  assert.deepEqual(h.requests.map(c=>c.method), ['GET','POST'])
  assert.equal(JSON.stringify(outcome).includes(TOKEN_SENTINEL), false)
  assert.equal(JSON.stringify(capturedConsole).includes(TOKEN_SENTINEL), false)
})

test('completion 503 is distinct from create-chat and never retried', async () => {
  const h = harness({ completeStatus:503 })
  const outcome = await h.forwardOne()
  assert.equal(outcome.success, false)
  assert.equal(outcome.status, 503)
  assert.equal(outcome.failureStage, 'chat-completion')
  assert.deepEqual(h.requests.map(c=>c.method), ['GET','POST','POST'])
  assert.equal(new URL(h.requests[2].url).pathname, '/api/v2/chat/completions')
  assert.equal(h.requests[2].body.model, 'x-preview-l')
})

test('completion redirect is not treated as success, followed or replayed', async () => {
  const h = harness({ completeStatus:302 })
  const outcome = await h.forwardOne()
  assert.equal(outcome.success, false)
  assert.equal(outcome.status, 502)
  assert.equal(outcome.failureStage, 'chat-completion')
  assert.deepEqual(h.requests.map(c=>c.method), ['GET','POST','POST'])
  assert.equal(h.requests[2].config.maxRedirects, 0)
})

test('failure phases and public error codes are fixed enums, not untrusted exception strings', () => {
  const sourceRoute = source('src/main/proxy/routes/chat.ts')
  assert.match(sourceRoute, /const ZAI_FAILURE_CODES:[\s\S]*zai_auth_preflight_failed/)
  assert.match(sourceRoute, /zai_chat_creation_failed/)
  assert.match(sourceRoute, /zai_chat_completion_failed/)
  assert.match(sourceRoute, /code: safeFailureCode/)
  assert.doesNotMatch(sourceRoute, /code: result\.error/)
  const { ZaiProxyFailure } = harness().adapterModule
  const err = new ZaiProxyFailure('chat-creation', 'fixed safe error', 302)
  assert.equal(err.upstreamHttpStatus, undefined, 'redirect HTTP status is not a public redirect')
  assert.equal(new ZaiProxyFailure('chat-creation', 'fixed safe error', 403).upstreamHttpStatus, 403)
})
