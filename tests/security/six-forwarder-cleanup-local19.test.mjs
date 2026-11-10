import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Actual dedicated RequestForwarder branches with synthetic inert adapters.
// No Electron, credential store, network, provider POST/DELETE or model call.
const source=readFileSync(new URL('../../src/main/proxy/forwarder.ts',import.meta.url),'utf8')
const code=ts.transpileModule(source,{fileName:'forwarder.ts',compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
}}).outputText
const names=['deepseek','qwen','glm','zai','qwen-ai','kimi']
const fullBody=(content='synthetic valid response')=>({object:'chat.completion',
  choices:[{index:0,finish_reason:'stop',
    message:{role:'assistant',content}}]})
const invalidBodies=[
  {},
  fullBody(''),
  {choices:[{index:0,finish_reason:'stop',
    message:{role:'assistant',content:'valid',error:{token:'SYNTHETIC_PRIVATE'}}}]},
]

function harness(providerId,body){
  const operations=[]
  const stream=new PassThrough()
  const provider={id:providerId,apiEndpoint:'https://synthetic.invalid',enabled:true}
  const account={id:'synthetic-account',providerId:provider.id,
    status:'active',credentials:{}}
  const activeAdapter=class {
    static isDeepSeekProvider(p){return p.id==='deepseek'}
    static isGLMProvider(p){return p.id==='glm'}
    static isKimiProvider(p){return p.id==='kimi'}
    static isMimoProvider(){return false}
    static isQwenProvider(p){return p.id==='qwen'}
    static isQwenAiProvider(p){return p.id==='qwen-ai'}
    static isZaiProvider(p){return p.id==='zai'}
    static isMiniMaxProvider(){return false}
    static isPerplexityProvider(){return false}
    async chatCompletion(){operations.push('create-and-complete')
      return {response:{status:200,data:stream,headers:{}},
        sessionId:'synthetic-session',conversationId:'synthetic-conversation',
        chatId:'synthetic-chat',requestId:'synthetic-request'}
    }
    async deleteSession(){operations.push('DELETE')}
    async deleteChat(){operations.push('DELETE')}
    async deleteConversation(){operations.push('DELETE')}
  }
  const inert=class {
    static isDeepSeekProvider(){return false}
    static isGLMProvider(){return false}
    static isKimiProvider(){return false}
    static isMimoProvider(){return false}
    static isQwenProvider(){return false}
    static isQwenAiProvider(){return false}
    static isZaiProvider(){return false}
    static isMiniMaxProvider(){return false}
    static isPerplexityProvider(){return false}
  }
  class FakeHandler{
    getSessionId(){return 'synthetic-session'}
    getConversationId(){return 'synthetic-conversation'}
    setChatId(){}
    async handleNonStream(){return body}
  }
  const fakeGate={hasCompletedNonStreamAnswer:value=>{
    const c=value?.choices?.[0]
    return !!c && c.finish_reason==='stop' && c.message?.role==='assistant' &&
      typeof c.message?.content==='string' && !!c.message.content.trim() &&
      c.error===undefined && c.message.error===undefined
  }}
  const deps={
    axios:{__esModule:true,default:{create:()=>({})}},
    http2:{__esModule:true,default:{}},stream:{PassThrough},
    '../store/store':{storeManager:{getConfig:()=>({retryCount:3})}},
    './status':{proxyStatusManager:{}},
    './streamTerminalGate':fakeGate,
    './adapters/deepseek':{DeepSeekAdapter:activeAdapter},
    './adapters/deepseek-stream':{DeepSeekStreamHandler:FakeHandler},
    './adapters/glm':{GLMAdapter:activeAdapter,GLMStreamHandler:FakeHandler},
    './adapters/kimi':{KimiAdapter:activeAdapter,KimiProxyFailure:class extends Error{},
      KimiStreamHandler:FakeHandler},
    './adapters/mimo':{MimoAdapter:inert,MimoStreamHandler:FakeHandler},
    './adapters/qwen':{QwenAdapter:activeAdapter,QwenStreamHandler:FakeHandler},
    './adapters/qwen-ai':{QwenAiAdapter:activeAdapter,QwenAiProxyFailure:class extends Error{},
      QwenAiStreamHandler:FakeHandler},
    './adapters/zai':{ZaiAdapter:activeAdapter,ZaiProxyFailure:class extends Error{},
      ZaiStreamHandler:FakeHandler},
    './adapters/minimax':{MiniMaxAdapter:inert,MiniMaxStreamHandler:FakeHandler},
    './adapters/perplexity':{PerplexityAdapter:inert},
    './adapters/perplexity-stream':{PerplexityStreamHandler:FakeHandler},
    './toolCalling/ToolCallingEngine':{ToolCallingEngine:class{}},
    './sessionManager':{sessionManager:{shouldDeleteAfterChat:()=>true}},
    './services/contextManagementService':{createContextManagementService:()=>{
      throw Error('Unexpected implicit summarization')
    }},
  }
  const mod={exports:{}}
  vm.runInNewContext(code,{module:mod,exports:mod.exports,Date,Error,Buffer,URL,
    require:name=>{
      if(Object.hasOwn(deps,name))return deps[name]
      throw Error('Unexpected offline import '+name)
    },console:{log(){},warn(){},error(){}},
  },{filename:'forwarder.ts',timeout:2000})
  const forwarder=new mod.exports.RequestForwarder()
  forwarder.transformRequestForPromptToolUse=req=>({messages:req.messages,
    tools:undefined,plan:{}})
  forwarder.applyToolCallsToResponse=()=>{}
  const dispatch=()=>forwarder.forwardChatCompletion(
    {model:'synthetic',messages:[{role:'user',content:'synthetic'}],stream:false},
    account,provider,'synthetic-wire-model',{requestId:'synthetic-id',
      model:'synthetic',actualModel:'synthetic-wire-model',
      startTime:Date.now(),isStream:false},
  )
  return {dispatch,operations}
}

for(const id of names){
  test(id+' dedicated nonstream valid completion allows exactly one cleanup',async()=>{
    const h=harness(id,fullBody())
    const result=await h.dispatch()
    assert.equal(result.success,true,id)
    assert.deepEqual(h.operations,['create-and-complete','DELETE'],id)
  })
  test(id+' dedicated nonstream invalid completion fails before any cleanup or replay',async()=>{
    for(const body of invalidBodies){
      const h=harness(id,body)
      const result=await h.dispatch()
      assert.equal(result.success,false,id)
      assert.equal(result.status,502,id)
      assert.equal(result.failureCode,'provider_completion_unconfirmed',id)
      assert.deepEqual(h.operations,['create-and-complete'],id)
    }
  })
}
