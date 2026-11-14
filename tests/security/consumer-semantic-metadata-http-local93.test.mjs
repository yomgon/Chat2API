import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual production Koa Chat route and selected-provider preflight. All six
// accounts, credentials and forwarders exist only in this closed test VM.
// No OS profile, vendor domain, token verification or provider POST is loaded.
const requireNode = createRequire(import.meta.url)
const raw = readFileSync(new URL('../../src/main/proxy/routes/chat.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(raw, { fileName: 'chat.ts', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
} }).outputText
const PRIVATE = 'LOCAL93_SYNTHETIC_IGNORED_METADATA_MUST_NOT_LEAK'
const KEY = 'LOCAL93_SYNTHETIC_API_KEY'
const answer = { id: 'local93-synthetic', choices: [{
  index: 0, message: { role: 'assistant', content: 'Synthetic answer' },
  finish_reason: 'stop',
}] }
const call = { id: 'call_93', type: 'function',
  function: { name: 'lookup', arguments: '{}' } }

async function fixture(selected, { alias = false } = {}) {
  const events = { selects: 0, reserves: 0, dispatches: 0, accountCommits: 0,
    stats: [], forwarded: [] }
  const provider = { id: alias ? 'synthetic-first-party-origin-alias' : selected,
    name: 'Synthetic ' + selected, enabled: true }
  const account = { id: 'synthetic-' + selected, providerId: provider.id,
    name: 'Synthetic', status: 'active', credentials: { token: PRIVATE } }
  const model = 'pinned-exact-wire-' + selected
  const selection = { account, provider, actualModel: model }
  const balancer = {
    selectAccount() { events.selects++; return selection },
    reserveSelectedAccount() { events.reserves++; return () => {} },
    markAccountFailed() { throw Error('Local invalid metadata must not mark an account') },
    clearAccountFailure() {},
  }
  const forwarder = {
    getConsumerWebProviderId: () => selected,
    requiresAdditionalSummary: async () => false,
    async forwardChatCompletion(request, chosenAccount, chosenProvider, wire) {
      assert.equal(chosenAccount, account)
      assert.equal(chosenProvider, provider)
      assert.equal(wire, model)
      events.dispatches++
      events.forwarded.push(JSON.parse(JSON.stringify(request)))
      return { success: true, status: 200, body: answer }
    },
  }
  const store = {
    getConfig: () => ({ loadBalanceStrategy: 'round-robin' }),
    recordAccountSuccess: () => { events.accountCommits++; return true },
    recordRequestInStats: ok => events.stats.push(ok),
    addRequestLog: () => ({ id: 'local93-test-request' }), addLog() {},
  }
  const status = { recordRequestStart() {}, recordRequestSuccess() {},
    recordRequestFailure() {} }
  const deps = {
    '@koa/router': requireNode('@koa/router'),
    '../loadbalancer': { loadBalancer: balancer },
    '../forwarder': { requestForwarder: forwarder },
    '../stream': { streamHandler: {} },
    '../streamTerminalGate': {
      hasCompletedNonStreamAnswer: x => x === answer,
      getStopSequences: () => [], applyStopSequencesNonStream: x => x,
      createOpenAIStreamTerminalGate() { throw Error('No synthetic stream should be opened') },
      createStopSequenceSseStream() { throw Error('No synthetic stop normalizer needed') },
    },
    '../status': { proxyStatusManager: status },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => provider.id, getPreferredAccount: () => account.id,
    } },
    '../../store/store': { storeManager: store },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic() { throw Error('No format conversion') },
      transformChunkToAnthropic() { throw Error('No format conversion') },
    },
  }
  const mod = { exports: {} }
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, Buffer, URL, JSON, Date, Math, Number,
    Object, Error, Set, Map, TextDecoder, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(deps,id)) return deps[id]
      throw Error('Unexpected dependency: '+id)
    },
  }, { timeout: 2000, filename: 'actual-chat-local93.ts',
    codeGeneration: { strings:false, wasm:false } })
  const Koa = requireNode('koa')
  const app = new Koa()
  app.use(async (ctx,next) => {
    if(ctx.headers.authorization !== 'Bearer '+KEY) { ctx.status=401; return }
    await next()
  })
  app.use(requireNode('koa-bodyparser')())
  app.use(mod.exports.default.routes())
  app.use(mod.exports.default.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const send = messages => new Promise((resolve,reject) => {
    const body = JSON.stringify({ model:'synthetic-alias-'+selected, stream:false, messages })
    const req = httpRequest({ hostname:'127.0.0.1',port:server.address().port,
      path:'/v1/chat/completions',method:'POST',
      headers:{ Authorization:'Bearer '+KEY, 'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body) } }, res => {
      const buffers=[]
      res.on('data',chunk=>buffers.push(chunk))
      res.on('error',reject)
      res.on('end',()=> {
        const text=Buffer.concat(buffers).toString('utf8')
        try { resolve({status:res.statusCode,text,body:JSON.parse(text)}) }
        catch(error){reject(error)}
      })
    })
    req.on('error',reject)
    req.setTimeout(3000,()=>req.destroy(Error('Offline Koa timeout')))
    req.end(body)
  })
  return { events, send, close: () => new Promise((resolve,reject) =>
    server.close(error=>error?reject(error):resolve())) }
}

const six=['deepseek','qwen','glm','zai','qwen-ai','kimi']
const badCases=[
  ['OpenAI message name silently lost',
    [{role:'user', content:'Anonymous prompt', name:'named_speaker_93'}]],
  ['unrecognized per-message payload silently dropped',
    [{role:'user', content:'Plain text', annotations:{ provenance:PRIVATE }}]],
  ['assistant historical function metadata silently dropped',
    [{role:'user',content:'Use tools'},
      {role:'assistant',content:null,tool_calls:[{
        ...call, function:{...call.function, additional_metadata:PRIVATE},
      }]}, {role:'tool',tool_call_id:call.id,content:'Result'},
      {role:'user',content:'Continue'}]],
]
for(const selected of six) for(const [label,messages] of badCases){
  test('local93 '+selected+': '+label+' must be refused before dispatch',async ()=>{
    const h=await fixture(selected,{alias:selected==='kimi'})
    try{
      const result=await h.send(messages)
      assert.equal(result.status,400)
      assert.equal(result.body?.error?.param,'messages')
      assert.equal(result.body?.error?.code,'unsupported_message_metadata')
      assert.equal(h.events.selects,1,'Reject after exact provider selection')
      assert.deepEqual([h.events.reserves,h.events.dispatches,h.events.accountCommits],[0,0,0])
      assert.deepEqual(h.events.stats,[])
      assert.equal(result.text.includes(PRIVATE),false)
    }finally{await h.close()}
  })
}
for(const selected of ['deepseek','qwen','glm','kimi']){
  test('local93 '+selected+': recognized assistant tool history remains byte-equivalent',async()=>{
    const h=await fixture(selected)
    const messages=[{role:'user',content:'Use tools'},
      {role:'assistant',content:null,tool_calls:[call]},
      {role:'tool',tool_call_id:call.id,content:'Result'},
      {role:'user',content:'Continue'}]
    try{
      const result=await h.send(messages)
      assert.equal(result.status,200)
      assert.deepEqual(h.events.forwarded[0].messages,messages)
      assert.deepEqual([h.events.reserves,h.events.dispatches,h.events.accountCommits],[1,1,1])
      assert.deepEqual(h.events.stats,[true])
    }finally{await h.close()}
  })
}
test('local93 GLM: unsupported image part metadata must fail before attachment handling',async()=>{
  const h=await fixture('glm')
  try{
    const response=await h.send([{role:'user',content:[
      {type:'image_url',image_url:{url:'https://images.example.invalid/a.png'},
        provenance:PRIVATE},
    ]}])
    assert.equal(response.status,400)
    assert.equal(response.body?.error?.param,'messages')
    assert.equal(h.events.selects,0)
    assert.equal(h.events.reserves,0)
    assert.equal(h.events.dispatches,0)
  }finally{await h.close()}
})
test('local93 GLM: unsupported nested image URL metadata must fail before attachment handling',async()=>{
  const h=await fixture('glm')
  try{
    const response=await h.send([{role:'user',content:[
      {type:'image_url',image_url:{url:'https://images.example.invalid/a.png',
        internal_marker:PRIVATE}},
    ]}])
    assert.equal(response.status,400)
    assert.equal(response.body?.error?.param,'messages')
    assert.equal(h.events.selects,0)
    assert.equal(h.events.dispatches,0)
  }finally{await h.close()}
})
