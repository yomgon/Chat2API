import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Local, purely synthetic transports. Never opens an actual Electron profile,
// proxy port, account, provider network connection, or sends a chat message.
const root=fileURLToPath(new URL('../../',import.meta.url))
const requireNode=createRequire(import.meta.url)
const source=name=>readFileSync(path.join(root,name),'utf8')
const logs=[]
const safeConsole=Object.fromEntries(['log','error','warn','info'].map(level=>
  [level,(...args)=>logs.push({level,args})]))

function loadTS(name,deps){
  const compiled=ts.transpileModule(source(name),{fileName:name,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
      esModuleInterop:true},reportDiagnostics:true})
  assert.equal((compiled.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0)
  const module={exports:{}}
  vm.runInNewContext(compiled.outputText,{module,exports:module.exports,
    require:id=>{
      if(Object.hasOwn(deps,id))return deps[id]
      throw new Error('Unexpected synthetic import: '+id)
    },console:safeConsole,Buffer,URL,URLSearchParams,Date,Error,setTimeout,clearTimeout},
  {filename:name,timeout:1200})
  return module.exports
}

function qwenHarness(statuses){
  const calls=[]
  let i=0
  const instance={post:async(url,body,config)=>{
    calls.push({url,body,config})
    const item=statuses[i++]
    if(!item)throw new Error('Unexpected second provider request')
    return item
  }}
  const axios={create:()=>instance}
  const {QwenAiAdapter}=loadTS('src/main/proxy/adapters/qwen-ai.ts',{
    axios:{__esModule:true,default:axios},stream:{PassThrough},
    'eventsource-parser':requireNode('eventsource-parser'),
    '../promptToolUse':{hasToolUse:()=>false,parseToolUse:()=>null},
  })
  const provider={id:'qwen-ai',apiEndpoint:'https://chat.qwen.ai',
    modelMappings:{'Qwen3.7-Plus':'qwen3.7-plus'}}
  const account={id:'fixture',credentials:{token:'SYNTHETIC_ACCOUNT_TOKEN_NOT_FOR_LOGS'}}
  return {adapter:new QwenAiAdapter(provider,account),calls}
}

test('Qwen International create-chat 403 stays a trusted status and never starts completion or follows redirects',async()=>{
  logs.length=0
  const h=qwenHarness([{status:403,data:{message:'SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'}}])
  const error=await h.adapter.createChat('qwen3.7-plus').catch(x=>x)
  assert.equal(error.upstreamStatus,403)
  assert.match(error.message,/Qwen AI chat creation was rejected/)
  assert.equal(h.calls.length,1)
  assert.equal(new URL(h.calls[0].url).pathname,'/api/v2/chats/new')
  assert.equal(h.calls[0].config.maxRedirects,0)
  assert.equal(h.calls[0].config.validateStatus(),true)
  assert.equal(JSON.stringify(logs).includes('SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'),false)
})

test('Qwen International completed create followed by rejected completion never replays or exposes the body',async()=>{
  logs.length=0
  let destroyed=0
  const h=qwenHarness([
    {status:201,data:{data:{id:'synthetic-chat-id'}}},
    {status:503,data:{destroy(){destroyed++},secret:'SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'}},
  ])
  const failure=await h.adapter.chatCompletion({model:'Qwen3.7-Plus',
    messages:[{role:'user',content:'synthetic only'}],stream:false}).catch(x=>x)
  assert.equal(failure.upstreamStatus,503)
  assert.equal(h.calls.length,2)
  assert.equal(new URL(h.calls[1].url).pathname,'/api/v2/chat/completions')
  assert.equal(h.calls[1].config.maxRedirects,0)
  assert.equal(destroyed,1)
  assert.equal(JSON.stringify(logs).includes('SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'),false)
})

const kimiProtocol=loadTS('src/main/proxy/adapters/providerModelOptions.ts',{})
function kimiHarness(status){
  const calls=[]
  let destroyed=0
  const axios={post:async(url,body,config)=>{
    calls.push({url,body,config})
    return {status,data:{destroy(){destroyed++},secret:'SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'}}
  }}
  const {KimiAdapter}=loadTS('src/main/proxy/adapters/kimi.ts',{
    axios:{__esModule:true,default:axios},stream:{PassThrough},
    '../utils/tools':{hasToolPromptInjected:()=>false,toolsToSystemPrompt:()=>'',TOOL_WRAP_HINT:''},
    '../utils/toolParser':{parseToolCallsFromText:()=>[]},
    '../utils/streamToolHandler':{createBaseChunk:()=>({})},
    './providerModelOptions':kimiProtocol,
    '../toolCalling/providerProfiles':{getProviderToolProfile:()=>({})},
    '../toolCalling/ToolStreamParser':{ToolStreamParser:class{}},
  })
  return {adapter:new KimiAdapter({id:'kimi',apiEndpoint:'https://www.kimi.com'},
    {id:'synthetic-kimi-account',providerId:'kimi',credentials:{token:'SYNTHETIC_TOKEN_FOR_KIMI'}}),
    calls,getDestroyed:()=>destroyed}
}

test('Kimi international Connect-RPC rejected response retains only HTTP status and refuses redirect replay',async()=>{
  logs.length=0
  const h=kimiHarness(403)
  const failure=await h.adapter.chatCompletion({model:'k2d6-chat',
    messages:[{role:'user',content:'synthetic only'}],stream:false}).catch(x=>x)
  assert.equal(failure.upstreamStatus,403)
  assert.equal(h.calls.length,1)
  assert.equal(h.calls[0].config.maxRedirects,0)
  assert.equal(h.calls[0].config.headers['Content-Type'],'application/connect+json')
  assert.equal(new URL(h.calls[0].url).pathname,'/apiv2/kimi.gateway.chat.v1.ChatService/Chat')
  assert.equal(h.getDestroyed(),1)
  assert.equal(JSON.stringify(logs).includes('SYNTHETIC_PRIVATE_PROVIDER_RESPONSE'),false)
})

test('fixed, literal failure classifications are sent to the local route without raw provider errors',()=>{
  const forward=source('src/main/proxy/forwarder.ts')
  const route=source('src/main/proxy/routes/chat.ts')
  assert.match(forward,/failureCode: 'kimi_upstream_operation_failed'/)
  assert.match(forward,/failureCode: 'qwen_ai_upstream_operation_failed'/)
  assert.match(forward,/safeWebErrorStatus\(error\) \?\? 502/)
  assert.match(forward,/const maxRetries = consumerWebAdapter \? 0 : config\.retryCount/)
  assert.match(route,/result\.failureCode \?\?/)
  assert.match(route,/provider\.id === 'zai'/)
  assert.doesNotMatch(route,/code: result\.error/)
})
