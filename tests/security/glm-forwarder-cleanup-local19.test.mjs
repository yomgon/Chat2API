import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// Runs the real RequestForwarder with wholly synthetic adapter, transport,
// storage and session manager dependencies. No account, profile, network or
// real provider API is accessed. Cleanup is an independent remote effect.
const source=readFileSync(new URL('../../src/main/proxy/forwarder.ts',import.meta.url),'utf8')
const js=ts.transpileModule(source,{fileName:'forwarder.ts',compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
}}).outputText
const inert=class {
  static isDeepSeekProvider(){return false}
  static isGLMProvider(){return false}
  static isKimiProvider(){return false}
  static isMimoProvider(){return false}
  static isQwenProvider(){return false}
  static isQwenAiProvider(){return false}
  static isMiniMaxProvider(){return false}
  static isPerplexityProvider(){return false}
}
const validBody={id:'glm-synthetic',object:'chat.completion',choices:[{
  index:0,finish_reason:'stop',message:{role:'assistant',content:'Confirmed reply'},
}]}
const invalidBody={id:'glm-synthetic',object:'chat.completion',choices:[{
  index:0,finish_reason:'stop',message:{role:'assistant',content:''},
}]}
function harness({stream=true,body=validBody}={}){
  const state={deletes:[],endCb:null,output:null}
  class FakeGLM {
    constructor(){ }
    async chatCompletion(){return {response:{status:200,data:new PassThrough(),headers:{}},
      conversationId:'synthetic-glm-conversation'}}
    async deleteConversation(id){state.deletes.push(id);return true}
  }
  class FakeStreamHandler {
    constructor(_model,onEnd){this.onEnd=onEnd}
    getConversationId(){return 'synthetic-glm-conversation'}
    async handleStream(){const output=new PassThrough();state.output=output;state.endCb=this.onEnd;return output}
    async handleNonStream(){return body}
  }
  const deps={
    axios:{__esModule:true,default:{create:()=>({})}},
    http2:{__esModule:true,default:{}},
    stream:{PassThrough},
    '../store/store':{storeManager:{getConfig:()=>({retryCount:3})}},
    './status':{proxyStatusManager:{}},
    './adapters/deepseek':{DeepSeekAdapter:inert},
    './adapters/deepseek-stream':{DeepSeekStreamHandler:class{}},
    './adapters/glm':{GLMAdapter:FakeGLM,GLMStreamHandler:FakeStreamHandler},
    './adapters/kimi':{KimiAdapter:inert,KimiProxyFailure:class extends Error{},KimiStreamHandler:class{}},
    './adapters/mimo':{MimoAdapter:inert,MimoStreamHandler:class{}},
    './adapters/qwen':{QwenAdapter:inert,QwenStreamHandler:class{}},
    './adapters/qwen-ai':{QwenAiAdapter:inert,QwenAiProxyFailure:class extends Error{},QwenAiStreamHandler:class{}},
    './adapters/zai':{ZaiAdapter:inert,ZaiProxyFailure:class extends Error{},ZaiStreamHandler:class{}},
    './adapters/minimax':{MiniMaxAdapter:inert,MiniMaxStreamHandler:class{}},
    './adapters/perplexity':{PerplexityAdapter:inert},
    './adapters/perplexity-stream':{PerplexityStreamHandler:class{}},
    './toolCalling/ToolCallingEngine':{ToolCallingEngine:class{}},
    './sessionManager':{sessionManager:{shouldDeleteAfterChat:()=>true}},
    './services/contextManagementService':{createContextManagementService:()=>{throw Error('no summary')}},
    './streamTerminalGate':{hasCompletedNonStreamAnswer:result=>!!result?.choices?.[0]?.message?.content?.trim()},
  }
  const mod={exports:{}}
  vm.runInNewContext(js,{module:mod,exports:mod.exports,Buffer,Date,Error,URL,
    require:name=>{
      if(Object.hasOwn(deps,name))return deps[name]
      throw Error('Unexpected forwarder import '+name)
    },console:{log(){},warn(){},error(){}},
  },{filename:'forwarder.ts',timeout:2000})
  const forwarder=new mod.exports.RequestForwarder()
  forwarder.transformRequestForPromptToolUse=req=>({messages:req.messages,tools:undefined,plan:{}})
  forwarder.applyToolCallsToResponse=()=>{}
  const forward=()=>forwarder.forwardGLM(
    {model:'glm-synthetic',messages:[{role:'user',content:'synthetic'}],stream},
    {id:'synthetic-account',providerId:'glm',status:'active',credentials:{}},
    {id:'glm'},'glm-model',Date.now())
  return {state,forward}
}
const settled=()=>new Promise(resolve=>setImmediate(resolve))

test('GLM stream error ending the local transform must NOT trigger remote delete effect',async()=>{
  const h=harness()
  const response=await h.forward()
  assert.equal(response.success,true)
  response.stream.on('data',()=>{})
  h.state.output.end('data: {"error":{"code":"glm_response_incomplete"}}\n\n')
  await settled()
  assert.deepEqual(h.state.deletes,[])
})
test('GLM success deletes exactly once only when adapter verified clean EOF',async()=>{
  const h=harness()
  const response=await h.forward()
  assert.equal(response.success,true)
  response.stream.on('data',()=>{})
  assert.equal(typeof h.state.endCb,'function')
  await h.state.endCb()
  h.state.output.end('data: [DONE]\n\n')
  await settled()
  assert.deepEqual(h.state.deletes,['synthetic-glm-conversation'])
})
test('GLM rejected nonstream empty assistant must not trigger remote delete',async()=>{
  const h=harness({stream:false,body:invalidBody})
  const response=await h.forward()
  assert.equal(response.success,false)
  assert.equal(response.status,502)
  assert.equal(response.failureCode,'provider_completion_unconfirmed')
  assert.deepEqual(h.state.deletes,[])
})
test('GLM confirmed nonstream assistant preserves successful cleanup once',async()=>{
  const h=harness({stream:false})
  const response=await h.forward()
  assert.equal(response.success,true)
  assert.deepEqual(h.state.deletes,['synthetic-glm-conversation'])
})
