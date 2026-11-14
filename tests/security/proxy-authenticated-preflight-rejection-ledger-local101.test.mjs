import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createServer,request as httpRequest} from 'node:http'
import {once} from 'node:events'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

// The actual Koa ProxyServer middleware and router run on owned 127.0.0.1:0.
// No operating account, Electron HOME, or external provider is accessed.
const nodeRequire=createRequire(import.meta.url)
const KEY='LOCAL101_ONLY_FAKE_AUTH_KEY'
const SECRET='LOCAL101_SHOULD_NEVER_BE_IN_REQUEST_LOGS'
function product(file,deps){
  const code=readFileSync(new URL('../../src/main/'+file,import.meta.url),'utf8')
  const js=ts.transpileModule(code,{fileName:file,compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
  }}).outputText
  const module={exports:{}}
  runInNewContext(js,{module,exports:module.exports,Buffer,process:{env:{}},
    Date,Math,Error,Object,JSON,Set,Map,Promise,TextDecoder,console:{log(){},warn(){},error(){}},
    require(name){
      if(Object.hasOwn(deps,name))return deps[name]
      if(name.startsWith('.'))throw Error('Unresolved offline import '+file+':'+name)
      return nodeRequire(name)
    },
  },{filename:file,timeout:2500,codeGeneration:{strings:false,wasm:false}})
  return module.exports
}
async function fixture({logThrows=false,statsThrows=false}={}){
  const effects={stats:[],requests:[],upstream:0,configWrites:0}
  const config={
    enableApiKey:true,apiKeys:[{id:'synthetic-101',key:KEY,enabled:true,usageCount:0}],
    managementApi:{enableManagementApi:false},
  }
  const storeManager={
    getConfig:()=>config,
    updateConfig:patch=>{effects.configWrites++;Object.assign(config,patch)},
    addLog(){},
    recordRequestInStats(success,latency,model,providerId,accountId){
      if(statsThrows)throw Error(SECRET)
      effects.stats.push({success,latency,model,providerId,accountId})
    },
    addRequestLog(entry){
      if(logThrows)throw Error(SECRET)
      effects.requests.push(JSON.parse(JSON.stringify(entry)))
      return {id:'owned-local101',...entry}
    },
    recordClientPreflightRejection(data){
      try {
        this.recordRequestInStats(false,data.latency)
      } catch {}
      try {
        this.addRequestLog({
          timestamp:Date.now()-data.latency,status:'error',statusCode:data.statusCode,
          method:data.method,url:data.path,model:data.model,
          responseStatus:data.statusCode,latency:data.latency,isStream:data.isStream,
          errorMessage:'Local request rejected before provider dispatch ('+data.errorCode+')',
        })
      } catch {}
    },
  }
  const proxyStats=product('proxy/status.ts',{}).proxyStatusManager
  const serverProduct=product('proxy/server.ts',{
    koa:nodeRequire('koa'),electron:{app:{getVersion:()=> 'local101-inert'}},
    '@koa/router':nodeRequire('@koa/router'), 'koa-bodyparser':nodeRequire('koa-bodyparser'),
    './routes':[],'./routes/management':[],
    './status':{proxyStatusManager:proxyStats},
    '../store/store':{storeManager},
    './sessionManager':{sessionManager:{initialize(){throw Error('Unwanted startup')},destroy(){}}},
    './localSecurity':product('proxy/localSecurity.ts',{}),
  }).proxyServer
  // Two pre-forward refusals, plus one simulated *already-settled* upstream
  // failure. No connector or network effect is made by any of these handlers.
  serverProduct.router.post('/v1/chat/completions',ctx=>{
    ctx.status=503;ctx.body={error:{
      message:'No available account',code:'no_available_account',
    }}
  })
  serverProduct.router.post('/v1/completions',ctx=>{
    ctx.status=400;ctx.body={error:{
      message:'Unsupported local completion',code:'unsupported_completion_parameter',
    }}
  })
  serverProduct.router.post('/v1/chat/dispatch-already-recorded',ctx=>{
    ctx.state.providerDispatchStarted=true
    effects.stats.push({success:false,latency:10,model:'dispatched',providerId:'local101',accountId:'fake'})
    effects.requests.push({status:'error',statusCode:502,model:'dispatched'})
    ctx.status=502;ctx.body={error:{message:'Unconfirmed provider completion',code:'provider_completion_unconfirmed'}}
  })
  const server=createServer(serverProduct.app.callback())
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  serverProduct.port=server.address().port
  const request=(route,{key=KEY,body={model:'local101-inert',stream:false},method='POST'}={})=>
    new Promise((resolve,reject)=>{
      const payload=body===undefined?undefined:JSON.stringify(body)
      const headers={Host:'127.0.0.1:'+server.address().port}
      if(key)headers.Authorization='Bearer '+key
      if(payload!==undefined)headers['Content-Type']='application/json'
      const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,
        path:route,method,headers},res=>{
        const chunks=[]
        res.on('data',x=>chunks.push(x));res.on('error',reject)
        res.on('end',()=>{
          const raw=Buffer.concat(chunks).toString('utf8')
          let json;try{json=JSON.parse(raw)}catch{}
          resolve({status:res.statusCode,raw,json})
        })
      })
      req.on('error',reject)
      req.setTimeout(4000,()=>req.destroy(Error('Owned localhost timeout')))
      req.end(payload)
    })
  return{request,effects,proxyStats,close:async()=>{
    server.closeAllConnections()
    await new Promise((done,fail)=>server.close(e=>e?fail(e):done()))
  }}
}

test('local101 RED: authenticated no-account Chat 503 enters exactly one failure stat and one redacted request log',async t=>{
  const f=await fixture();t.after(f.close)
  const response=await f.request('/v1/chat/completions',{body:{model:'local101-inert',stream:true,
    messages:[{role:'user',content:SECRET}]}})
  assert.equal(response.status,503)
  assert.equal(response.json.error.code,'no_available_account')
  assert.equal(f.effects.stats.length,1)
  assert.equal(f.effects.stats[0].success,false)
  assert.equal(f.effects.stats[0].providerId,undefined)
  assert.equal(f.effects.stats[0].model,undefined,
    'Authenticated admission rejection is not a provider/model usage event')
  assert.equal(f.effects.requests.length,1)
  assert.equal(f.effects.requests[0].statusCode,503)
  assert.equal(f.effects.requests[0].url,'/v1/chat/completions')
  assert.equal(f.effects.requests[0].isStream,true)
  assert.equal(f.effects.requests[0].accountId,undefined)
  assert.ok(!JSON.stringify(f.effects.requests).includes(SECRET))
  assert.equal(f.effects.upstream,0)
  const live=f.proxyStats.getStatistics()
  assert.equal(live.failedRequests,1)
  assert.equal(live.totalRequests,1)
  assert.equal(live.activeConnections,0)
})

test('local101 RED: unsupported Legacy HTTP 400 is counted without claiming an upstream effect',async t=>{
  const f=await fixture();t.after(f.close)
  const response=await f.request('/v1/completions',{body:{
    model:'local101-inert',prompt:SECRET,stream:false}})
  assert.equal(response.status,400)
  assert.equal(f.effects.requests.length,1)
  assert.equal(f.effects.requests[0].statusCode,400)
  assert.equal(f.effects.requests[0].url,'/v1/completions')
  assert.equal(f.effects.stats.length,1)
  assert.equal(f.effects.upstream,0)
  assert.ok(!JSON.stringify(f.effects.requests).includes(SECRET))
})

test('local101 RED: diagnostic-sink rejection cannot turn an honest 503 into 500 or a remote retry',async t=>{
  const f=await fixture({logThrows:true});t.after(f.close)
  const response=await f.request('/v1/chat/completions')
  assert.equal(response.status,503)
  assert.equal(response.json.error.code,'no_available_account')
  assert.equal(f.effects.stats.length,1)
  assert.equal(f.effects.requests.length,0)
  assert.equal(f.effects.upstream,0)
  assert.ok(!response.raw.includes(SECRET))
})

test('local101 RED: failed stats sink still records one optional error log without provider contact',async t=>{
  const f=await fixture({statsThrows:true});t.after(f.close)
  const response=await f.request('/v1/chat/completions')
  assert.equal(response.status,503)
  assert.equal(f.effects.stats.length,0)
  assert.equal(f.effects.requests.length,1)
  assert.equal(f.effects.upstream,0)
})

test('local101: authentication failures are not mislabeled as authenticated completion requests',async t=>{
  const f=await fixture();t.after(f.close)
  const response=await f.request('/v1/chat/completions',{key:''})
  assert.equal(response.status,401)
  assert.equal(f.effects.stats.length,0)
  assert.equal(f.effects.requests.length,0)
})

test('local101: an already-settled provider failure must not receive a duplicate preflight receipt',async t=>{
  const f=await fixture();t.after(f.close)
  const response=await f.request('/v1/chat/dispatch-already-recorded')
  assert.equal(response.status,502)
  assert.equal(f.effects.stats.length,1)
  assert.equal(f.effects.requests.length,1)
  assert.equal(f.effects.requests[0].statusCode,502)
})

test('local101: actual Chat and Legacy routes set a dispatch gate immediately before their first forward',()=>{
  for(const file of ['proxy/routes/chat.ts','proxy/routes/completions.ts']){
    const source=readFileSync(new URL('../../src/main/'+file,import.meta.url),'utf8')
    assert.match(source,/ctx\.state\.providerDispatchStarted\s*=\s*true[\s\S]{0,220}recordRequestStart/)
  }
})

test('local101: production StoreManager admission recorder separates failed statistics and private request log writes',()=>{
  const source=readFileSync(new URL('../../src/main/store/store.ts',import.meta.url),'utf8')
  const tree=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true)
  let method
  function visit(node){
    if(ts.isMethodDeclaration(node)&&node.name.getText(tree)==='recordClientPreflightRejection')
      method=node.getText(tree)
    ts.forEachChild(node,visit)
  }
  visit(tree)
  assert.ok(method,'Actual production store admission method required')
  const compiled=ts.transpileModule('class Recorder { '+method+' };exports.Recorder=Recorder;',{
    fileName:'local101-production-store.ts',compilerOptions:{
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
    },
  }).outputText
  const module={exports:{}}
  runInNewContext(compiled,{module,exports:module.exports,Date,Math,JSON,Error,
    console:{error(){}}},{timeout:2000,codeGeneration:{strings:false,wasm:false}})
  const calls={stats:[],logs:[]}
  const recorder=new module.exports.Recorder()
  recorder.recordRequestInStats=(...args)=>calls.stats.push(args)
  recorder.addRequestLog=log=>calls.logs.push(JSON.parse(JSON.stringify(log)))
  const input={statusCode:503,method:'POST',path:'/v1/chat/completions',
    model:'local101-absent',latency:8,isStream:true,errorCode:'no_available_account'}
  recorder.recordClientPreflightRejection(input)
  assert.equal(calls.stats.length,1)
  assert.deepEqual(calls.stats[0],[false,8],
    'Preflight failure does not charge a model/provider/account')
  assert.equal(calls.logs.length,1)
  assert.equal(calls.logs[0].model,'local101-absent')
  assert.equal(calls.logs[0].isStream,true)
  assert.ok(!('requestBody' in calls.logs[0]))
  assert.ok(!('accountId' in calls.logs[0]))
  recorder.addRequestLog=()=>{throw Error(SECRET)}
  recorder.recordClientPreflightRejection(input)
  assert.equal(calls.stats.length,2,'Failed optional logs do not hide failed requests')
})
