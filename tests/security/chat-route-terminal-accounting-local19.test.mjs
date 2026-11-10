import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// This exercises the REAL /v1/chat/completions route, with ALL external
// dependencies replaced by closed in-memory synthetic fixtures. No Electron,
// account file, network, upstream POST, or native service is used.
const root=fileURLToPath(new URL('../../',import.meta.url))
const source=file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8')
const requireNode=createRequire(import.meta.url)
const transpile=file=>ts.transpileModule(source(file),{
  fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,
    module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true,
}).outputText

const gate={exports:{}}
vm.runInNewContext(transpile('src/main/proxy/streamTerminalGate.ts'),{
  module:gate,exports:gate.exports,
  require:name=>name==='stream'?requireNode('node:stream'):(()=>{throw Error('Unexpected terminal module '+name)})(),
  Buffer,TextDecoder,Date,Error,
},{timeout:1500})

const PRIVATE='SYNTHETIC_PRIVATE_ACCOUNT_ERROR_LOCAL19'
function makeHarness(providerId='qwen-ai') {
  const routes={}
  class Router {
    constructor(){ }
    post(path,callback){ routes[path]=callback }
  }
  const usage={start:0,success:0,fail:0,stats:[],accountWrites:[],logs:[],
    newReceipts:[],updatedReceipts:[],clear:0,markFailed:0}
  const account={id:'synthetic-fixed-account',providerId,status:'active',requestCount:0,todayUsed:0}
  const provider={id:providerId,name:'Synthetic Provider',enabled:true,apiEndpoint:'https://example.invalid'}
  const selection={account,provider,actualModel:'synthetic-wire-model'}
  let upstreamResult={success:true,status:200,body:null}
  const mocks={
    '@koa/router':{__esModule:true,default:Router},
    '../loadbalancer':{loadBalancer:{
      selectAccount:()=>selection,
      clearAccountFailure:()=>usage.clear++,
      markAccountFailed:()=>usage.markFailed++,
    }},
    '../modelMapper':{modelMapper:{getPreferredProvider:()=>providerId,
      getPreferredAccount:()=>account.id}},
    '../forwarder':{requestForwarder:{forwardChatCompletion:async()=>upstreamResult}},
    '../stream':{streamHandler:{createTransformStream:()=>new PassThrough()}},
    '../streamTerminalGate':gate.exports,
    '../status':{proxyStatusManager:{
      recordRequestStart:()=>usage.start++,
      recordRequestSuccess:()=>usage.success++,
      recordRequestFailure:()=>usage.fail++,
    }},
    '../../store/store':{storeManager:{
      getConfig:()=>({retryCount:3}),
      recordAccountSuccess:(id,providerId)=>{usage.accountWrites.push({id,providerId});return true},
      addLog:(_level,message)=>usage.logs.push(message),
      addRequestLog:entry=>{usage.newReceipts.push(entry);return {id:'synthetic-log'}},
      updateRequestLog:(id,updates)=>{usage.updatedReceipts.push({id,updates});return true},
      recordRequestInStats:(success)=>usage.stats.push(success),
    }},
    '../utils/toolFormatConverter':{
      isAnthropicToolFormat:()=>false,
      transformResponseToAnthropic:()=>{throw Error('Unexpected Anthropic transform')},
      transformChunkToAnthropic:()=>{throw Error('Unexpected Anthropic transform')},
    },
  }
  const module={exports:{}}
  vm.runInNewContext(transpile('src/main/proxy/routes/chat.ts'),{
    module,exports:module.exports,
    require:name=>{
      if(Object.hasOwn(mocks,name))return mocks[name]
      throw Error('Unexpected route dependency '+name)
    },
    Date,Math,JSON,Error,console:{log:()=>{},warn:()=>{},error:()=>{}},
  },{filename:'routes/chat.ts',timeout:2000})
  assert.equal(typeof routes['/completions'],'function')
  function ctx(stream=true) {
    return {status:200,headers:{},ip:'127.0.0.1',responseHeaders:{},
      res:{headersSent:false},
      request:{body:{model:'synthetic-alias',messages:[{role:'user',content:'Fixture only'}],stream}},
      set(name,value){this.responseHeaders[name]=value}}
  }
  return {invoke:routes['/completions'],setForwardResult:value=>{upstreamResult=value},
    usage,account,ctx}
}
const data=x=>'data: '+JSON.stringify(x)+'\n\n'
const delta=t=>data({id:'synthetic',object:'chat.completion.chunk',
  choices:[{index:0,delta:{role:'assistant',content:t},finish_reason:null}]})
const finish=data({id:'synthetic',object:'chat.completion.chunk',
  choices:[{index:0,delta:{},finish_reason:'stop'}]})
const done='data: [DONE]\n\n'
const reply=message=>({id:'synthetic',object:'chat.completion',
  choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:message}}]})

async function drain(readable) {
  const chunks=[]
  readable.on('data',chunk=>chunks.push(chunk.toString()))
  await new Promise(resolve=>readable.once('end',resolve))
  return chunks.join('')
}

test('real route: streaming success counted only after complete answer and upstream EOF',async()=>{
  const h=makeHarness('zai')
  const src=new PassThrough()
  h.setForwardResult({success:true,status:200,stream:src,skipTransform:true})
  const ctx=h.ctx(true)
  await h.invoke(ctx)
  assert.equal(h.usage.start,1)
  assert.equal(h.usage.success,0)
  assert.equal(h.usage.accountWrites.length,0)
  assert.equal(h.usage.stats.length,0)
  assert.equal(h.usage.newReceipts[0].status,'error','pending is fail-closed')
  const response=drain(ctx.body)
  src.end(delta('Hello model')+finish+done)
  const sse=await response
  assert.equal((sse.match(/data: \[DONE\]/g)||[]).length,1)
  assert.equal(h.usage.success,1)
  assert.equal(h.usage.fail,0)
  assert.deepEqual(h.usage.stats,[true])
  assert.equal(h.usage.accountWrites.length,1)
  assert.equal(h.usage.updatedReceipts[0].updates.status,'success')
  assert.equal(h.usage.updatedReceipts[0].updates.responseStatus,200)
})
test('real route: incomplete answer records failure, no account change and no fake DONE',async()=>{
  const h=makeHarness('qwen-ai')
  const src=new PassThrough()
  h.setForwardResult({success:true,status:200,stream:src,skipTransform:true})
  const ctx=h.ctx(true)
  await h.invoke(ctx)
  const received=drain(ctx.body)
  src.end(delta('partial without finish'))
  const wire=await received
  assert.equal(wire.includes('data: [DONE]'),false)
  assert.equal(wire.includes('"error"'),true)
  assert.deepEqual(h.usage.stats,[false])
  assert.equal(h.usage.success,0)
  assert.equal(h.usage.fail,1)
  assert.equal(h.usage.accountWrites.length,0)
  assert.equal(h.usage.updatedReceipts[0].updates.status,'error')
  assert.equal(h.usage.updatedReceipts[0].updates.responseStatus,502)
})
test('real route: source error after finish/done does not record success or replay',async()=>{
  const h=makeHarness('kimi')
  const src=new PassThrough()
  h.setForwardResult({success:true,status:200,stream:src,skipTransform:true})
  const ctx=h.ctx(true)
  await h.invoke(ctx)
  const received=drain(ctx.body)
  src.write(delta('partial')+finish+done)
  src.emit('error',Object.assign(new Error(PRIVATE),{response:{data:{token:PRIVATE}}}))
  const wire=await received
  assert.doesNotMatch(wire,/data: \[DONE\]/)
  assert.equal(wire.includes(PRIVATE),false)
  assert.equal(h.usage.success,0)
  assert.equal(h.usage.fail,1)
  assert.equal(h.usage.accountWrites.length,0)
  assert.deepEqual(h.usage.stats,[false])
})
test('real route: HTTP200 with incomplete JSON body is 502, never fabricated success',async()=>{
  const h=makeHarness('deepseek')
  h.setForwardResult({success:true,status:200,body:reply('')})
  const ctx=h.ctx(false)
  await h.invoke(ctx)
  assert.equal(ctx.status,502)
  assert.equal(ctx.body.error.code,'provider_completion_unconfirmed')
  assert.equal(h.usage.fail,1)
  assert.equal(h.usage.success,0)
  assert.equal(h.usage.accountWrites.length,0)
})
test('real route: nonstream complete actual answer succeeds without raw response logging',async()=>{
  const h=makeHarness('glm')
  h.setForwardResult({success:true,status:200,body:reply('Confirmed marker')})
  const ctx=h.ctx(false)
  await h.invoke(ctx)
  assert.equal(ctx.body.choices[0].message.content,'Confirmed marker')
  assert.equal(h.usage.success,1)
  assert.equal(h.usage.accountWrites.length,1)
  assert.equal(h.usage.newReceipts[0].responseBody,undefined)
})
test('real route: 200+missing stream must not become an empty completion',async()=>{
  const h=makeHarness('qwen')
  h.setForwardResult({success:true,status:200,body:{}})
  const ctx=h.ctx(true)
  await h.invoke(ctx)
  assert.equal(ctx.status,502)
  assert.equal(ctx.body.error.code,'provider_completion_unconfirmed')
  assert.equal(h.usage.accountWrites.length,0)
})
test('all six provider paths count strict completed SSE, never an upstream handshake',async()=>{
  for(const providerId of ['deepseek','qwen','glm','zai','qwen-ai','kimi']){
    const h=makeHarness(providerId)
    const src=new PassThrough()
    h.setForwardResult({success:true,status:200,stream:src,skipTransform:true})
    const ctx=h.ctx(true)
    await h.invoke(ctx)
    assert.equal(h.usage.success,0,providerId)
    const received=drain(ctx.body)
    src.end(delta('completed')+finish+done)
    const text=await received
    assert.equal(text.includes('data: [DONE]'),true,providerId)
    assert.equal(h.usage.success,1,providerId)
    assert.equal(h.usage.accountWrites.length,1,providerId)
  }
})

test('generic stream raw transport close without EOF does not hang or fabricate DONE',async()=>{
  const h=makeHarness('glm')
  const source=new PassThrough()
  h.setForwardResult({success:true,status:200,stream:source,skipTransform:false})
  const ctx=h.ctx(true)
  await h.invoke(ctx)
  const response=drain(ctx.body)
  source.write(delta('unconfirmed partial'))
  source.destroy()
  const wire=await Promise.race([response,new Promise((_,reject)=>
    setTimeout(()=>reject(new Error('Generic normalization stream hung after raw close')),250))])
  assert.equal(wire.includes('data: [DONE]'),false)
  assert.equal(wire.includes('"error"'),true)
  assert.equal(h.usage.success,0)
  assert.equal(h.usage.fail,1)
  assert.deepEqual(h.usage.stats,[false])
})

test('pre-commit stream failure sets HTTP502; already committed response uses safe SSE error',async()=>{
  const early=makeHarness('qwen-ai')
  const source=new PassThrough()
  early.setForwardResult({success:true,status:200,stream:source,skipTransform:true})
  const ctx=early.ctx(true)
  await early.invoke(ctx)
  const wire=drain(ctx.body)
  source.end('data: {"error":{"private":"'+PRIVATE+'"}}\n\n')
  const content=await wire
  assert.equal(ctx.status,502)
  assert.equal(content.includes(PRIVATE),false)
  assert.equal(content.includes('data: [DONE]'),false)

  const late=makeHarness('glm')
  const lateSource=new PassThrough()
  late.setForwardResult({success:true,status:200,stream:lateSource,skipTransform:true})
  const lateCtx=late.ctx(true)
  await late.invoke(lateCtx)
  const lateWire=drain(lateCtx.body)
  lateSource.write(delta('visible partial'))
  lateCtx.res.headersSent=true
  lateSource.end('data: {"error":{"private":"'+PRIVATE+'"}}\n\n')
  const lateContent=await lateWire
  assert.equal(lateCtx.status,200)
  assert.equal(lateContent.includes('data: [DONE]'),false)
  assert.equal(lateContent.includes(PRIVATE),false)
  assert.equal(late.usage.fail,1)
})
