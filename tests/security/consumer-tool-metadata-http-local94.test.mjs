import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real production Koa Chat router with synthetic accounts/selection/transport.
// No Electron operating profile, provider URL, token verification or paid POST.
const requireNode = createRequire(import.meta.url)
const source = readFileSync(new URL('../../src/main/proxy/routes/chat.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName:'chat.ts', compilerOptions:{
  target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, esModuleInterop:true,
} }).outputText
const KEY='LOCAL94_IN_MEMORY_TEST_KEY'
const tool={ type:'function', function:{
  name:'local_lookup', description:'Synthetic read-only lookup',
  parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},
} }
const response={id:'chatcmpl-local94',object:'chat.completion',
  choices:[{index:0,message:{role:'assistant',content:'LOCALLY_COMPLETE'},
    finish_reason:'stop'}]}

async function fixture(selected){
  const events={selected:0,reserved:0,sent:0,commits:0,stats:[],requests:[]}
  const provider={id:selected==='custom'?'only-custom':'fake-'+selected,
    name:'Synthetic '+selected,type:'custom',enabled:true}
  const account={id:'inert-'+selected,providerId:provider.id,name:'Inert',
    status:'active',credentials:{token:'NEVER_SEND_INERT_SYNTHETIC_TOKEN'}}
  const selection={provider,account,actualModel:'synthetic-model'}
  const loadBalancer={
    selectAccount(){events.selected++;return selection},
    reserveSelectedAccount(){events.reserved++;return ()=>{}},
    markAccountFailed(){throw Error('Invalid user request must not mark account failure')},
    clearAccountFailure(){},
  }
  const forwarder={
    getConsumerWebProviderId:()=>selected==='custom'?undefined:selected,
    requiresAdditionalSummary:async()=>false,
    async forwardChatCompletion(req,a,p,model){
      assert.equal(a,account);assert.equal(p,provider);assert.equal(model,'synthetic-model')
      events.sent++;events.requests.push(JSON.parse(JSON.stringify(req)))
      return {success:true,status:200,body:response}
    },
  }
  const store={
    getConfig:()=>({loadBalanceStrategy:'round-robin'}),
    recordAccountSuccess:()=>{events.commits++;return true},
    recordRequestInStats:ok=>events.stats.push(ok),
    addRequestLog:()=>({id:'synthetic-log'}),addLog(){},
  }
  const deps={
    '@koa/router':requireNode('@koa/router'),
    '../loadbalancer':{loadBalancer},
    '../forwarder':{requestForwarder:forwarder},
    '../stream':{streamHandler:{}},
    '../streamTerminalGate':{
      hasCompletedNonStreamAnswer:r=>r===response,getStopSequences:()=>[],
      applyStopSequencesNonStream:x=>x,
      createOpenAIStreamTerminalGate(){throw Error('Unexpected stream')},
      createStopSequenceSseStream(){throw Error('Unexpected stop stream')},
    },
    '../status':{proxyStatusManager:{
      recordRequestStart(){},recordRequestSuccess(){},recordRequestFailure(){},
    }},
    '../modelMapper':{modelMapper:{
      getPreferredProvider:()=>provider.id,getPreferredAccount:()=>account.id,
    }},
    '../../store/store':{storeManager:store},
    '../utils/toolFormatConverter':{
      isAnthropicToolFormat:()=>false,
      transformResponseToAnthropic(){throw Error('No transform')},
      transformChunkToAnthropic(){throw Error('No stream transform')},
    },
  }
  const module={exports:{}}
  runInNewContext(compiled,{
    module,exports:module.exports,Buffer,URL,JSON,Date,Math,Number,
    Object,Set,Map,Error,TextDecoder,
    console:{log(){},warn(){},error(){}},
    require:id=>{
      if(Object.hasOwn(deps,id))return deps[id]
      throw Error('Unexpected dependency '+id)
    },
  },{timeout:2000,filename:'local94-current-production-chat.ts',
    codeGeneration:{strings:false,wasm:false}})
  const app=new (requireNode('koa'))()
  app.use(async(ctx,next)=>{
    if(ctx.headers.authorization!=='Bearer '+KEY){ctx.status=401;return}
    await next()
  })
  app.use(requireNode('koa-bodyparser')())
  app.use(module.exports.default.routes())
  app.use(module.exports.default.allowedMethods())
  const server=createServer(app.callback())
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const send=patch=>new Promise((resolve,reject)=>{
    const body=JSON.stringify({
      model:'synthetic-model',stream:false,messages:[{role:'user',content:'Hello'}],
      tools:[tool],...patch,
    })
    const req=httpRequest({
      hostname:'127.0.0.1',port:server.address().port,
      method:'POST',path:'/v1/chat/completions',
      headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body)},
    },res=>{
      const chunks=[]
      res.on('data',x=>chunks.push(x))
      res.on('error',reject)
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8')
        try {resolve({status:res.statusCode,body:JSON.parse(raw),raw})}
        catch(e){reject(e)}
      })
    })
    req.on('error',reject)
    req.setTimeout(5000,()=>req.destroy(Error('Local Koa timeout')))
    req.end(body)
  })
  return {events,send,close:()=>new Promise((resolve,reject)=>
    server.close(e=>e?reject(e):resolve()))}
}
const six=['deepseek','qwen','glm','zai','qwen-ai','kimi']
const privateMarker='LOCAL94_UNSUPPORTED_TOOL_METADATA_NEVER_REFLECT'
const bad=[
  ['unsupported strict structured tool result guarantee',
    {tools:[{...tool,function:{...tool.function,strict:true}}]}],
  ['unrecognized tool-level metadata',
    {tools:[{...tool,provenance:privateMarker}]}],
  ['unrecognized function-level metadata',
    {tools:[{...tool,function:{...tool.function,consumer_extra:privateMarker}}]}],
  ['unrecognized tool_choice root metadata',
    {tool_choice:{type:'function',function:{name:'local_lookup'},
      extra_constraint:privateMarker}}],
  ['unrecognized tool_choice function metadata',
    {tool_choice:{type:'function',function:{name:'local_lookup',other:privateMarker}}}],
]
for(const selected of six)for(const [label,patch] of bad){
  test('local94 '+selected+' must refuse '+label+' before any dispatch',async()=>{
    const f=await fixture(selected)
    try{
      const result=await f.send(patch)
      assert.equal(result.status,400)
      assert.equal(result.body?.error?.code,'unsupported_tool_metadata')
      assert.ok(['tools','tool_choice'].includes(result.body?.error?.param))
      assert.equal(f.events.selected,1)
      assert.deepEqual([f.events.reserved,f.events.sent,f.events.commits],[0,0,0])
      assert.deepEqual(f.events.stats,[])
      assert.equal(result.raw.includes(privateMarker),false)
    }finally{await f.close()}
  })
}
for(const selected of six){
  test('local94 '+selected+' explicit strict:false is a safe non-guarantee default',async()=>{
    const f=await fixture(selected)
    try{
      const result=await f.send({
        tools:[{...tool,function:{...tool.function,strict:false}}],
        tool_choice:'none',
      })
      assert.equal(result.status,200)
      assert.equal(result.body.choices[0].message.content,'LOCALLY_COMPLETE')
      assert.deepEqual([f.events.selected,f.events.reserved,f.events.sent,f.events.commits],[1,1,1,1])
      assert.deepEqual(f.events.stats,[true])
    }finally{await f.close()}
  })
}
test('local94 generic custom can forward strict:true and extra fields to its own endpoint',async()=>{
  const f=await fixture('custom')
  try{
    const declared={...tool,function:{...tool.function,strict:true,custom_extra:'LOCAL_ONLY'}}
    const result=await f.send({tools:[declared]})
    assert.equal(result.status,200)
    assert.deepEqual(JSON.parse(JSON.stringify(f.events.requests[0].tools)),[declared])
    assert.deepEqual([f.events.selected,f.events.reserved,f.events.sent,f.events.commits],[1,1,1,1])
  }finally{await f.close()}
})
