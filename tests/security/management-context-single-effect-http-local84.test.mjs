import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

// Actual Koa, bodyparser, management auth/provider/account/mapping CRUD,
// StoreManager/configSecrets safeStorage and LoadBalancer/RequestForwarder.
// The dedicated adapter static matchers are extracted verbatim from the
// production class AST; their effectful methods are replaced by a fail-closed
// local counter. Generic axios is an in-memory fake transport, never a socket.
// The only network listener is one 127.0.0.1:0 local Koa server per case.
const requireNode = createRequire(import.meta.url)
const source = p => readFileSync(new URL('../../src/main/' + p, import.meta.url),'utf8')
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const MANAGEMENT = 'mgmt_11111111-1111-4111-8111-111111111111'
const API_KEY = 'sk-' + 'S'.repeat(48)
const PRIVATE = 'LOCAL79_PRIVATE_PROVIDER_TOKEN_DO_NOT_DISCLOSE'

function actualMatcher(path, className, methodName, run) {
  const raw = source(path)
  const tree = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true)
  const cls = tree.statements.find(x => ts.isClassDeclaration(x) && x.name?.text === className)
  assert.ok(cls,'Production adapter class not found: '+className)
  const m = cls.members.find(x => ts.isMethodDeclaration(x) && x.name?.getText(tree) === methodName)
  assert.ok(m && m.modifiers?.some(x=>x.kind === ts.SyntaxKind.StaticKeyword),
    'Production static matcher not found: '+methodName)
  const exactMethod = m.getText(tree)
  const wrapper = `class ActualMatcher { ${exactMethod} }; exports.Matcher = ActualMatcher;`
  return run(wrapper, path+'::'+methodName).Matcher[methodName]
}

async function fixture({lookalikeEndpoint,genericStatus=200,retryCount=0,genericThrow=false,contextManagement}) {
  const realm = createContext({
    Buffer,Date,Math,Error,URL,TextDecoder,setImmediate,clearImmediate,setTimeout,clearTimeout,
    process:{platform:'win32',env:{}},console:{log(){},warn(){},error(){}},
  })
  const vmJSON = runInContext('JSON',realm)
  const vmClone = value => value === undefined ? undefined : vmJSON.parse(JSON.stringify(value))
  const compile = (code,filename) => ts.transpileModule(code,{
    fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,
      module:ts.ModuleKind.CommonJS,esModuleInterop:true},
  }).outputText
  function run(code,filename,deps={}) {
    const m={exports:{}}
    const compiled=compile(code,filename)
    const execute=runInContext('(function(module,exports,require){\n'+compiled+'\n})',realm,
      {filename,timeout:2000,codeGeneration:{strings:false,wasm:false}})
    execute(m,m.exports,id=>{
      if(Object.hasOwn(deps,id))return deps[id]
      if(id.startsWith('.'))throw Error('Unexpected relative import '+filename+':'+id)
      return requireNode(id)
    })
    return m.exports
  }
  const product=(path,deps)=>run(source(path),path,deps)
  const actualMatchers={
    deepseek:actualMatcher('proxy/adapters/deepseek.ts','DeepSeekAdapter','isDeepSeekProvider',run),
    glm:actualMatcher('proxy/adapters/glm.ts','GLMAdapter','isGLMProvider',run),
    qwen:actualMatcher('proxy/adapters/qwen.ts','QwenAdapter','isQwenProvider',run),
  }
  const defaults={
    managementApi:{enableManagementApi:true,managementApiSecret:MANAGEMENT},
    enableApiKey:true,apiKeys:[{id:'key',name:'Synthetic',key:API_KEY,
      createdAt:1,enabled:true,usageCount:0}],
    loadBalanceStrategy:'round-robin',modelMappings:{},
    proxyHost:'127.0.0.1',proxyPort:8080,retryCount,
    requestTimeout:60000,logRetentionDays:7,logLevel:'error',
    requestLogConfig:{enabled:false},toolCallingConfig:{advanced:{}},sessionConfig:{},
    ...(contextManagement ? {contextManagement:clone(contextManagement)} : {}),
  }
  const durable={config:clone(defaults),providers:[],accounts:[]}
  const safeStorage={
    isEncryptionAvailable:()=>true,
    encryptString:s=>Buffer.from('private-os:'+s,'utf8'),
    decryptString:buffer=>{
      const text=Buffer.from(buffer).toString('utf8')
      assert.ok(text.startsWith('private-os:'))
      return text.slice('private-os:'.length)
    },
  }
  const types={DEFAULT_CONFIG:vmClone(defaults),BUILTIN_PROVIDERS:[],
    DEFAULT_REQUEST_LOG_CONFIG:{enabled:false},DEFAULT_STATISTICS:{},
    DEFAULT_USER_MODEL_OVERRIDES:{},
    normalizeModelMappingsWithDefaults:x=>vmClone(x||{}),
    createDefaultModelMappings:()=>vmClone({}),
    sanitizeDeepSeekModelOverrides:x=>x,
  }
  const configSecrets=product('store/configSecrets.ts')
  const storeManager=new (product('store/store.ts',{
    electron:{app:{},safeStorage,BrowserWindow:{}},
    './types':types,'./configSecrets':configSecrets,
    '../data/builtin-prompts':{BUILTIN_PROMPTS:[]},
    '../requestLogs/manager':{RequestLogManager:class{}},
    '../requestLogs/types':{normalizeRequestLogConfig:x=>x},
    '../appLogs/manager':{AppLogManager:class{}},
    '../../shared/toolCalling':{normalizeToolCallingConfig:x=>x},
  }).StoreManager)()
  storeManager.store={
    get:key=>vmClone(durable[key]),
    set:(key,value)=>{
      if(typeof key==='object')Object.assign(durable,clone(key))
      else durable[key]=clone(value)
    },
  }
  storeManager.isInitialized=true
  storeManager.addLog=()=>{}
  storeManager.addRequestLog=()=>({id:'synthetic-log'})
  storeManager.updateRequestLog=()=>{}
  storeManager.recordRequestInStats=()=>{}
  const store={storeManager}
  const endpointTrust=product('providers/endpointTrust.ts')
  const providerManager=product('store/providers.ts',{
    './store':store,'./types':types,'../providers/endpointTrust':endpointTrust,
  }).default
  const accountManager=product('store/accounts.ts',{
    './store':store,
    './validator':{async validateCredentials(){
      return {valid:true,validatedAt:Date.now()}
    }},
  }).default
  const configManager=product('store/config.ts',{
    './store':store,'./types':types,'./configSecrets':configSecrets,
    '../../shared/toolCalling':{normalizeToolCallingConfig:x=>x},
  }).default
  const mgmtAuth=product('proxy/middleware/managementAuth.ts',{
    '../../store/store':store,
  }).managementAuthMiddleware
  const mgmtDeps={'@koa/router':requireNode('@koa/router'),
    '../../middleware/managementAuth':{managementAuthMiddleware:mgmtAuth}}
  const providerRoute=product('proxy/routes/management/providers.ts',{
    ...mgmtDeps,'../../../store/providers':{default:providerManager,__esModule:true},
    '../../../providers/endpointTrust':endpointTrust,
  }).default
  const accountRoute=product('proxy/routes/management/accounts.ts',{
    ...mgmtDeps,'../../../store/accounts':{default:accountManager,__esModule:true},
  }).default
  const mappingRoute=product('proxy/routes/management/modelMappings.ts',{
    ...mgmtDeps,'../../../store/config':{default:configManager,__esModule:true},
  }).default
  const modelMapper=product('proxy/modelMapper.ts',{'../store/store':store}).modelMapper
  const loadBalancer=product('proxy/loadbalancer.ts',{
    '../store/store':store,'./modelMapper':{modelMapper},
  }).loadBalancer

  const effects={dedicated:[],generic:[],network:0,accountSuccess:0}
  const inert=class {static isDeepSeekProvider(){return false}
    static isGLMProvider(){return false}
    static isKimiProvider(){return false}
    static isQwenProvider(){return false}
    static isQwenAiProvider(){return false}
    static isZaiProvider(){return false}
    static isMiniMaxProvider(){return false}
    static isMimoProvider(){return false}
    static isPerplexityProvider(){return false}}
  const deepseek=class extends inert{}
  deepseek.isDeepSeekProvider=actualMatchers.deepseek
  const glm=class extends inert{}
  glm.isGLMProvider=actualMatchers.glm
  const qwen=class extends inert{}
  qwen.isQwenProvider=actualMatchers.qwen
  const fakeAxios={create:()=>({request:async config=>{
    effects.generic.push({url:config.url,model:config.data.model,
      authCorrect:config.headers.Authorization==='Bearer '+PRIVATE,
      providerHeader:config.headers['X-Local79-Probe'],
      // Observe the actual normalized wire sent by the production forwarder.
      wireMessages:clone(config.data.messages)})
    if (genericThrow) throw Error('Synthetic transport result unknown; no resend')
    return {status:genericStatus,headers:{},data:genericStatus >= 500
      ? {error:{message:'Synthetic 503 - provider effect already attempted'}}
      : {id:'local79',object:'chat.completion',
      created:1,model:config.data.model,
      choices:[{index:0,message:{role:'assistant',content:'LOCAL79 SAFE SYNTHETIC ANSWER'},
        finish_reason:'stop'}]}}
  }})}
  const status={
    getConfig:()=>({timeout:3000}),
    recordRequestStart(){},recordRequestSuccess(){effects.accountSuccess++},
    recordRequestFailure(){},getRunningStatus:()=>({isRunning:true,uptime:0}),
    getStatistics:()=>({totalRequests:0,successRequests:0,failedRequests:0,activeConnections:0}),
    getPort:()=>8080,getHost:()=> '127.0.0.1',
  }
  const forwarder=new (product('proxy/forwarder.ts',{
    axios:{__esModule:true,default:fakeAxios,AxiosError:class AxiosError extends Error{}},
    '../store/store':store,'./status':{proxyStatusManager:status},
    './adapters/deepseek':{DeepSeekAdapter:deepseek},
    './adapters/glm':{GLMAdapter:glm,GLMAttachmentInputFailure:class extends Error{},
      GLMAuthPreflightFailure:class extends Error{},GLMStreamHandler:class{}},
    './adapters/qwen':{QwenAdapter:qwen,QwenStreamHandler:class{}},
    './adapters/deepseek-stream':{DeepSeekStreamHandler:class{}},
    './adapters/kimi':{KimiAdapter:inert,KimiStreamHandler:class{}},
    './adapters/qwen-ai':{QwenAiAdapter:inert,QwenAiStreamHandler:class{}},
    './adapters/zai':{ZaiAdapter:inert,ZaiStreamHandler:class{}},
    './adapters/minimax':{MiniMaxAdapter:inert,MiniMaxStreamHandler:class{}},
    './adapters/mimo':{MimoAdapter:inert,MimoStreamHandler:class{}},
    './adapters/perplexity':{PerplexityAdapter:inert,PerplexityStreamHandler:class{}},
    './adapters/perplexity-stream':{PerplexityStreamHandler:class{}},
    './toolCalling/ToolCallingEngine':{ToolCallingEngine:class{}},
    './sessionManager':{sessionManager:{shouldDeleteAfterChat:()=>false}},
    './streamTerminalGate':product('proxy/streamTerminalGate.ts'),
    // This independent fixture uses the actual context strategy and real
    // forwarder, not a stub that masks implicit provider-effect duplication.
    './services/contextManagementService':product('proxy/services/contextManagementService.ts'),
  }).RequestForwarder)()
  for(const name of ['DeepSeek','GLM','Qwen']){
    forwarder['forward'+name]=async()=>{
      effects.dedicated.push(name)
      return {success:false,status:502,error:'Synthetic wrong adapter; no transport performed'}
    }
  }
  const shared={
    '@koa/router':requireNode('@koa/router'),
    '../../store/store':store,'../modelMapper':{modelMapper},
    '../loadbalancer':{loadBalancer},
    '../forwarder':{requestForwarder:forwarder},
    '../status':{proxyStatusManager:status},
    '../streamTerminalGate':product('proxy/streamTerminalGate.ts'),
    '../stream':{streamHandler:{createTransformStream(){
      throw Error('Unexpected SSE fake transport')
    }}},
  }
  const models=product('proxy/routes/models.ts',shared).default
  const chat=product('proxy/routes/chat.ts',{
    ...shared,'../utils/toolFormatConverter':product('proxy/utils/toolFormatConverter.ts'),
  }).default
  const legacy=product('proxy/routes/completions.ts',{
    ...shared,'../legacyCompletion':product('proxy/legacyCompletion.ts'),
  }).default
  const proxy=product('proxy/server.ts',{
    koa:requireNode('koa'),electron:{app:{getVersion:()=> 'local79-offline'}},
    '@koa/router':requireNode('@koa/router'),
    'koa-bodyparser':requireNode('koa-bodyparser'),
    './routes':[models,chat,legacy],
    './routes/management':[providerRoute,accountRoute,mappingRoute],
    './status':{proxyStatusManager:status},
    '../store/store':store,
    './localSecurity':product('proxy/localSecurity.ts'),
    './sessionManager':{sessionManager:{initialize(){},destroy(){}}},
  }).proxyServer
  const server=createServer(proxy.app.callback())
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const port=server.address().port
  proxy.port=port
  const send=(method,url,body,management=false,timeoutMs=3000)=>new Promise((resolve,reject)=>{
    const headers={Host:'127.0.0.1:'+port,
      Authorization:'Bearer '+(management?MANAGEMENT:API_KEY)}
    if(body!==undefined)headers['Content-Type']='application/json'
    const req=httpRequest({hostname:'127.0.0.1',port,path:url,method,headers},res=>{
      const chunks=[]
      res.on('data',chunk=>chunks.push(chunk))
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8')
        let json;try{json=JSON.parse(raw)}catch{}
        resolve({status:res.statusCode,json,raw})
      })
      res.on('error',reject)
    })
    req.on('error',reject)
    req.setTimeout(timeoutMs,()=>req.destroy(Error('Closed test timeout')))
    req.end(body===undefined?undefined:JSON.stringify(body))
  })
  const setup=async()=>{
    const provider=await send('POST','/v0/management/providers/',{
      name:'LOCAL79 CUSTOM MIRROR',type:'custom',authType:'none',
      apiEndpoint:lookalikeEndpoint,supportedModels:['wire-synthetic'],
      headers:{'X-Local79-Probe':'EXPECTED'},
    },true)
    assert.equal(provider.status,201,provider.raw)
    const providerId=provider.json.data.id
    const account=await send('POST','/v0/management/accounts',{
      providerId,name:'LOCAL79 CLOSED ACCOUNT',credentials:{token:PRIVATE},
    },true)
    assert.equal(account.status,201,account.raw)
    const accountId=account.json.data.id
    assert.equal(account.json.data.status,'inactive')
    const validated=await send('POST','/v0/management/accounts/'+accountId+'/validate',{},true)
    assert.equal(validated.status,200,validated.raw)
    assert.equal(validated.json.data.valid,true)
    const mapping=await send('POST','/v0/management/model-mappings',{
      requestModel:'local79-mirror-alias',actualModel:'wire-synthetic',
      preferredProviderId:providerId,preferredAccountId:accountId,
    },true)
    assert.equal(mapping.status,201,mapping.raw)
    return {providerId,accountId}
  }
  return {send,setup,effects,storeManager,actualMatchers,forwarder,
    close:async()=>{
      server.closeAllConnections()
      await new Promise(resolve=>server.close(resolve))
    },
  }
}

for(const [label,endpoint,webName] of [
  ['DeepSeek hostname lookalike','https://api.notdeepseek.com/v1','DeepSeek'],
  ['DeepSeek URL path mention','https://ordinary-provider.org/v1/deepseek.com','DeepSeek'],
  ['GLM hostname lookalike','https://api.notchatglm.cn/v1','GLM'],
  ['Qwen hostname lookalike','https://api.notqianwen.com/v1','Qwen'],
  ['Qwen aliyun lookalike','https://api.notaliyun.com/v1','Qwen'],
]){
  test('local79 managed custom '+label+' retains its own configured generic wire',async t=>{
    const f=await fixture({lookalikeEndpoint:endpoint});t.after(f.close)
    const pin=await f.setup()
    const catalog=await f.send('GET','/v1/models/local79-mirror-alias')
    assert.equal(catalog.status,200,catalog.raw)
    const chat=await f.send('POST','/v1/chat/completions',{
      model:'local79-mirror-alias',
      messages:[{role:'user',content:'Offline custom endpoint only'}],
      stream:false,temperature:0.4,
    })
    assert.equal(chat.status,200,chat.raw)
    assert.equal(f.effects.dedicated.length,0,
      'Unrelated custom endpoint must not select '+webName+' web session adapter')
    assert.equal(f.effects.generic.length,1)
    assert.equal(f.effects.generic[0].url,endpoint+'/chat/completions')
    assert.equal(f.effects.generic[0].model,'wire-synthetic')
    assert.equal(f.effects.generic[0].authCorrect,true)
    assert.equal(f.effects.generic[0].providerHeader,'EXPECTED')
    assert.equal(chat.raw.includes(PRIVATE),false)
    assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
    assert.equal(f.effects.network,0)
  })
}

test('local79 built-in IDs and exact first-party web origins retain their dedicated matcher identity',async t=>{
  const f=await fixture({lookalikeEndpoint:'https://offline.example.org'});t.after(f.close)
  const matches=f.actualMatchers
  const cases=[
    ['deepseek','https://api.something-else.org',true],
    ['glm','https://api.something-else.org',true],
    ['qwen','https://api.something-else.org',true],
  ]
  for(const [id,endpoint,expected] of cases){
    assert.equal(matches[id]({id,apiEndpoint:endpoint}),expected)
  }
  assert.equal(matches.deepseek({id:'custom',apiEndpoint:'https://chat.deepseek.com/api'}),true)
  assert.equal(matches.glm({id:'custom',apiEndpoint:'https://chatglm.cn/api'}),true)
  assert.equal(matches.qwen({id:'custom',apiEndpoint:'https://chat2.qianwen.com'}),true)
  assert.equal(matches.qwen({id:'custom',apiEndpoint:'https://www.qianwen.com'}),true)
})

test('local80 diagnostic: real Koa custom pin with full generic sampling stays HTTP200',async t=>{
  const f=await fixture({lookalikeEndpoint:'http://127.0.0.1:60790/deepseek.com'})
  t.after(f.close)
  await f.setup()
  const r=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,temperature:0.5,top_p:0.8,max_tokens:48,
    messages:[{role:'user',content:'LOCAL79 deepseek CHAT NONSTREAM'}],
  })
  assert.equal(r.status,200,JSON.stringify({status:r.status,error:r.json?.error}))
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.effects.dedicated.length,0)
  assert.equal(f.effects.generic[0].model,'wire-synthetic')
})

test('local80 RED contract: generic 503 with configured retryCount=1 must never duplicate the attempted upstream effect',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'https://notdeepseek.com/v1',
    genericStatus:503,retryCount:1,
  })
  t.after(f.close)
  const pin=await f.setup()
  const first=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',
    messages:[{role:'user',content:'One synthetic remote effect only'}],
    stream:false,
  },false,15000)
  assert.equal(first.status,503,JSON.stringify({status:first.status,error:first.json?.error}))
  assert.equal(f.effects.dedicated.length,0)
  assert.equal(f.effects.network,0)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
  assert.equal(f.effects.generic.length,1,
    'Automatic replay must be zero even when retryCount=1 and the first POST returned 503')
})

for (const [label,status,stream] of [
  ['authentication failure',401,false],
  ['rate limit',429,false],
  ['upstream internal error',503,true],
]){
  test('local80 common forwarder does not replay custom '+label+
    (stream?' stream':' nonstream')+' with retryCount=3',async t=>{
    const f=await fixture({lookalikeEndpoint:'https://notdeepseek.com/v1',
      genericStatus:status,retryCount:3})
    t.after(f.close)
    const pin=await f.setup()
    const result=await f.send('POST','/v1/chat/completions',{
      model:'local79-mirror-alias',stream,
      messages:[{role:'user',content:'One synthetic attempt; no failover'}],
    })
    assert.equal(result.status,status,JSON.stringify({status:result.status,error:result.json?.error}))
    assert.equal(f.effects.generic.length,1)
    assert.equal(f.effects.dedicated.length,0)
    assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
  })
}

test('local80 common forwarder does not replay generic transport-unknown failure with retryCount=3',async t=>{
  const f=await fixture({lookalikeEndpoint:'https://notdeepseek.com/v1',
    retryCount:3,genericThrow:true})
  t.after(f.close)
  const pin=await f.setup()
  const result=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',
    messages:[{role:'user',content:'Transport ACK unconfirmed'}],
  })
  assert.equal(result.status,500)
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.effects.dedicated.length,0)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
})

const CONTEXT_SUMMARY = {
  enabled: true,
  strategies: {
    slidingWindow: { enabled: false, maxMessages: 20 },
    tokenLimit: { enabled: false, maxTokens: 4000 },
    summary: { enabled: true, keepRecentMessages: 1,
      summaryPrompt: 'Local-only summary would require its own model completion' },
  },
  executionOrder: ['summary'],
}
const longMessages = [
  {role:'system',content:'Keep the factual context unchanged.'},
  {role:'user',content:'Older user turn.'},
  {role:'assistant',content:'Older assistant answer.'},
  {role:'user',content:'Current user question.'},
]

test('local84 RED: configured automatic summary must not create an unseen extra generic upstream effect before Chat',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',retryCount:3,
    contextManagement:CONTEXT_SUMMARY,
  })
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,messages:longMessages,
  })
  assert.equal(f.effects.generic.length,0,
    'The configured summary must not generate an extra model POST before the main POST')
  assert.equal(response.status,400,JSON.stringify(response.json),
    'An implicit summary model call would exceed the one-effect budget before primary completion')
  assert.equal(response.json?.error?.code,'context_summary_additional_effect_not_allowed')
  assert.equal(f.effects.generic.length,0,'No summary or primary upstream effect is authorized')
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
  assert.equal(f.effects.accountSuccess,0)
  assert.equal(f.effects.network,0)
  assert.equal(response.raw.includes(PRIVATE),false)
})

test('local84 RED: failed automatic summary must not trigger a second generic model send or mis-settle the account',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',genericStatus:503,
    retryCount:3,contextManagement:CONTEXT_SUMMARY,
  })
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,messages:longMessages,
  })
  assert.equal(f.effects.generic.length,0,
    'A failed summary must not be followed by a second model POST')
  assert.equal(response.status,400,JSON.stringify(response.json),
    'Reject before a summary outcome becomes unknown; no implicit follow-up send')
  assert.equal(f.effects.generic.length,0,'No attempt when summary requires a second paid effect')
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
  assert.equal(f.effects.accountSuccess,0)
  assert.equal(response.raw.includes(PRIVATE),false)
})

test('local84 control: active context setting without summary pressure retains one verified Chat completion',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',
    contextManagement:CONTEXT_SUMMARY,
  })
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,
    messages:[{role:'user',content:'Single short prompt, no summary needed.'}],
  })
  assert.equal(response.status,200,response.raw)
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
  assert.equal(f.effects.network,0)
})

test('local84 control: local sliding-window-only context strategy remains one completion for long history',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',
    contextManagement:{ ...CONTEXT_SUMMARY,
      strategies:{...CONTEXT_SUMMARY.strategies,
        summary:{...CONTEXT_SUMMARY.strategies.summary,enabled:false},
        slidingWindow:{enabled:true,maxMessages:3}},
      executionOrder:['slidingWindow','summary'],
    },
  })
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,messages:longMessages,
  })
  assert.equal(response.status,200,response.raw)
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
  assert.equal(f.effects.network,0)
})

test('local84 direct forwarder preflight refuses automatic summary even if a caller bypasses the Chat route',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',
    contextManagement:CONTEXT_SUMMARY,
  })
  t.after(f.close)
  const pin=await f.setup()
  const reply=await f.forwarder.forwardChatCompletion({
    model:'local79-mirror-alias',messages:longMessages,stream:false,
  },f.storeManager.getAccountById(pin.accountId,true),
  f.storeManager.getProviderById(pin.providerId),'wire-synthetic',{
    requestId:'local84-direct',model:'local79-mirror-alias',actualModel:'wire-synthetic',
    providerId:pin.providerId,accountId:pin.accountId,startTime:Date.now(),isStream:false,
  })
  assert.equal(reply.success,false)
  assert.equal(reply.status,400)
  assert.equal(reply.failureCode,'context_summary_additional_effect_not_allowed')
  assert.equal(f.effects.generic.length,0)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
})

test('local84 actual Legacy HTTP with enabled context summary but one prompt completes once',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',
    contextManagement:CONTEXT_SUMMARY,
  })
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/completions',{
    model:'local79-mirror-alias',prompt:'One legacy prompt',stream:false,
  })
  assert.equal(response.status,200,response.raw)
  assert.equal(response.json.object,'text_completion')
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
})

test('local84 sliding-window-before-summary shortens history without an unnecessary second effect',async t=>{
  const f=await fixture({
    lookalikeEndpoint:'http://127.0.0.1:50888/context',
    contextManagement:{...CONTEXT_SUMMARY,
      strategies:{...CONTEXT_SUMMARY.strategies,
        summary:{...CONTEXT_SUMMARY.strategies.summary,keepRecentMessages:3},
        slidingWindow:{enabled:true,maxMessages:3}},
      executionOrder:['slidingWindow','summary'],
    },
  })
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',messages:longMessages,stream:false,
  })
  assert.equal(response.status,200,response.raw)
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
})

const CONTEXT_TOOL_HISTORY = [
  {role:'user',content:'Earlier offline request'},
  {role:'assistant',content:'I will call local_lookup.',
    tool_calls:[{id:'call_context97',type:'function',
      function:{name:'local_lookup',arguments:'{"key":"synthetic"}'}}]},
  {role:'tool',tool_call_id:'call_context97',
    content:[{type:'text',text:'LOCAL97_RESULT_'},{type:'text',text:'UTF8한글'}]},
  {role:'user',content:'Continue with the tool result.'},
]
const windowConfig=maxMessages=>({
  enabled:true,
  strategies:{
    slidingWindow:{enabled:true,maxMessages},
    tokenLimit:{enabled:false,maxTokens:4000},
    summary:{enabled:false,keepRecentMessages:20},
  },
  executionOrder:['slidingWindow'],
})

test('local97 RED: actual Koa generic context window preserves assistant tool_calls and tool result linkage in upstream JSON',async t=>{
  const f=await fixture({lookalikeEndpoint:'http://127.0.0.1:60997/v1',
    contextManagement:windowConfig(3)})
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,messages:CONTEXT_TOOL_HISTORY,
  })
  assert.equal(response.status,200,response.raw)
  assert.equal(f.effects.generic.length,1,'Exactly one generic synthetic effect')
  assert.deepEqual(f.effects.generic[0].wireMessages,CONTEXT_TOOL_HISTORY.slice(-3),
    'Trimming an older user turn must not strip tool calls or tool result ID')
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
})

test('local97 RED: orphan tool result after context window cannot dispatch or penalize account',async t=>{
  const f=await fixture({lookalikeEndpoint:'http://127.0.0.1:60997/v1',
    contextManagement:windowConfig(2)})
  t.after(f.close)
  const pin=await f.setup()
  const rejected=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,messages:CONTEXT_TOOL_HISTORY,
  })
  assert.equal(rejected.status,400,rejected.raw)
  assert.equal(rejected.json?.error?.code,'context_history_unrepresentable')
  assert.equal(f.effects.generic.length,0,'No request with orphan tool result')
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
  const next=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,
    messages:[{role:'user',content:'Healthy single synthetic request'}],
  })
  assert.equal(next.status,200,next.raw)
  assert.equal(f.effects.generic.length,1)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,1)
})

test('local97 RED: token limit erasing all messages refuses before Legacy upstream effect',async t=>{
  const f=await fixture({lookalikeEndpoint:'http://127.0.0.1:60997/v1',
    contextManagement:{...windowConfig(20),
      strategies:{...windowConfig(20).strategies,
        tokenLimit:{enabled:true,maxTokens:0}},
      executionOrder:['tokenLimit']}})
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/completions',{
    model:'local79-mirror-alias',prompt:'Legacy content',stream:false,
  })
  assert.equal(response.status,400,response.raw)
  assert.equal(response.json?.error?.code,'context_history_unrepresentable')
  assert.equal(f.effects.generic.length,0)
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
})

test('local97 RED: late system instruction cannot be silently reordered across user turns by sliding window',async t=>{
  const f=await fixture({lookalikeEndpoint:'http://127.0.0.1:60997/v1',
    contextManagement:windowConfig(3)})
  t.after(f.close)
  const pin=await f.setup()
  const messages=[
    {role:'user',content:'oldest'},
    {role:'user',content:'earlier user'},
    {role:'system',content:'late-system-order-sensitive'},
    {role:'user',content:'latest'},
  ]
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,messages,
  })
  assert.equal(response.status,400,response.raw)
  assert.equal(response.json?.error?.code,'context_history_unrepresentable')
  assert.equal(f.effects.generic.length,0,'A context reorder is not the requested prompt')
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
})

test('local97 RED: two retained systems exhausting maxMessages must not leak every old user via slice(-0)',async t=>{
  const f=await fixture({lookalikeEndpoint:'http://127.0.0.1:60997/v1',
    contextManagement:windowConfig(2)})
  t.after(f.close)
  const pin=await f.setup()
  const response=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',stream:false,
    messages:[
      {role:'system',content:'first-system'},
      {role:'system',content:'second-system'},
      {role:'user',content:'old user turn'},
      {role:'user',content:'latest user turn'},
    ],
  })
  assert.equal(response.status,400,response.raw)
  assert.equal(response.json?.error?.code,'context_history_unrepresentable')
  assert.equal(f.effects.generic.length,0,'A configured window cannot silently bypass its own maximum')
  assert.equal(f.storeManager.getAccountById(pin.accountId).requestCount,0)
})
