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
  // Keep exact source-level matcher dependencies without invoking any HTTP code.
  const originConst=path.includes('/zai.ts') ? raw.match(/^const ZAI_API_BASE\s*=[^\r\n]*/m)?.[0] :
    path.includes('/kimi.ts') ? raw.match(/^const KIMI_API_BASE\s*=[^\r\n]*/m)?.[0] : ''
  const helper=path.includes('/kimi.ts') ? tree.statements.find(x =>
    ts.isFunctionDeclaration(x)&&x.name?.text==='isKimiApiEndpoint')?.getText(tree) : ''
  const wrapper=(originConst||'')+'\n'+(helper||'')+
    '\nclass ActualMatcher { '+exactMethod+' }; exports.Matcher = ActualMatcher;'
  return run(wrapper, path+'::'+methodName).Matcher[methodName]
}

async function fixture({lookalikeEndpoint}) {
  const realm = createContext({
    Buffer,Date,Math,Error,URL,TextDecoder,setImmediate,clearImmediate,
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
    zai:actualMatcher('proxy/adapters/zai.ts','ZaiAdapter','isZaiProvider',run),
    'qwen-ai':actualMatcher('proxy/adapters/qwen-ai.ts','QwenAiAdapter','isQwenAiProvider',run),
    kimi:actualMatcher('proxy/adapters/kimi.ts','KimiAdapter','isKimiProvider',run),
  }
  const defaults={
    managementApi:{enableManagementApi:true,managementApiSecret:MANAGEMENT},
    enableApiKey:true,apiKeys:[{id:'key',name:'Synthetic',key:API_KEY,
      createdAt:1,enabled:true,usageCount:0}],
    loadBalanceStrategy:'round-robin',modelMappings:{},
    proxyHost:'127.0.0.1',proxyPort:8080,retryCount:0,
    requestTimeout:60000,logRetentionDays:7,logLevel:'error',
    requestLogConfig:{enabled:false},toolCallingConfig:{advanced:{}},sessionConfig:{},
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
  const zai=class extends inert{}
  zai.isZaiProvider=actualMatchers.zai
  const qwenAi=class extends inert{}
  qwenAi.isQwenAiProvider=actualMatchers['qwen-ai']
  const kimi=class extends inert{}
  kimi.isKimiProvider=actualMatchers.kimi
  const fakeAxios={create:()=>({request:async config=>{
    effects.generic.push({url:config.url,model:config.data.model,
      authCorrect:config.headers.Authorization==='Bearer '+PRIVATE,
      providerHeader:config.headers['X-Local79-Probe']})
    return {status:200,headers:{},data:{id:'local79',object:'chat.completion',
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
    './adapters/kimi':{KimiAdapter:kimi,KimiStreamHandler:class{}},
    './adapters/qwen-ai':{QwenAiAdapter:qwenAi,QwenAiStreamHandler:class{}},
    './adapters/zai':{ZaiAdapter:zai,ZaiStreamHandler:class{}},
    './adapters/minimax':{MiniMaxAdapter:inert,MiniMaxStreamHandler:class{}},
    './adapters/mimo':{MimoAdapter:inert,MimoStreamHandler:class{}},
    './adapters/perplexity':{PerplexityAdapter:inert,PerplexityStreamHandler:class{}},
    './adapters/perplexity-stream':{PerplexityStreamHandler:class{}},
    './toolCalling/ToolCallingEngine':{ToolCallingEngine:class{}},
    './sessionManager':{sessionManager:{shouldDeleteAfterChat:()=>false}},
    './streamTerminalGate':product('proxy/streamTerminalGate.ts'),
    './services/contextManagementService':{createContextManagementService(){
      throw Error('Unexpected additional summarization')
    }},
  }).RequestForwarder)()
  for(const name of ['DeepSeek','GLM','Qwen','Zai','QwenAi','Kimi']){
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
  const completions=product('proxy/routes/completions.ts',{
    ...shared,'../legacyCompletion':{
      createLegacyCompletionStream(){throw Error('Unexpected legacy stream')},
      toLegacyCompletion(){throw Error('Unexpected legacy conversion')},
    },
  }).default
  const proxy=product('proxy/server.ts',{
    koa:requireNode('koa'),electron:{app:{getVersion:()=> 'local79-offline'}},
    '@koa/router':requireNode('@koa/router'),
    'koa-bodyparser':requireNode('koa-bodyparser'),
    './routes':[models,chat,completions],
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
  const send=(method,url,body,management=false)=>new Promise((resolve,reject)=>{
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
    req.setTimeout(3000,()=>req.destroy(Error('Closed test timeout')))
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
  return {send,setup,effects,storeManager,actualMatchers,
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

for(const [providerId,endpoint] of [
  ['deepseek','https://chat.deepseek.com'],
  ['qwen','https://www.qianwen.com'],
  ['glm','https://chatglm.cn'],
  ['zai','https://chat.z.ai'],
  ['qwen-ai','https://chat.qwen.ai'],
  ['kimi','https://www.kimi.com'],
]){
  test('local81 RED actual '+providerId+' web-origin alias refuses unsupported sampling before chat/legacy effect',async t=>{
    const f=await fixture({lookalikeEndpoint:endpoint});t.after(f.close)
    assert.equal(f.actualMatchers[providerId]({id:'custom-alias',apiEndpoint:endpoint}),true)
    const {accountId}=await f.setup()
    const chat=await f.send('POST','/v1/chat/completions',{
      model:'local79-mirror-alias',
      messages:[{role:'user',content:'Unsupported token cap must be refused locally'}],
      stream:false,max_tokens:49,
    })
    assert.equal(chat.status,400,chat.raw)
    assert.equal(chat.json?.error?.param,'max_tokens')
    const chatStream=await f.send('POST','/v1/chat/completions',{
      model:'local79-mirror-alias',
      messages:[{role:'user',content:'Streaming token cap must be rejected'}],
      stream:true,max_tokens:49,
    })
    assert.equal(chatStream.status,400,chatStream.raw)
    assert.equal(chatStream.json?.error?.param,'max_tokens')
    const legacy=await f.send('POST','/v1/completions',{
      model:'local79-mirror-alias',prompt:'Unsupported legacy cap must not be forwarded',
      stream:false,max_tokens:49,
    })
    assert.equal(legacy.status,400,legacy.raw)
    assert.equal(legacy.json?.error?.param,'max_tokens')
    const legacyStream=await f.send('POST','/v1/completions',{
      model:'local79-mirror-alias',prompt:'Streaming legacy cap must not be forwarded',
      stream:true,max_tokens:49,
    })
    assert.equal(legacyStream.status,400,legacyStream.raw)
    assert.equal(legacyStream.json?.error?.param,'max_tokens')
    assert.equal(f.effects.dedicated.length,0,
      'No dedicated provider effect may start for unsupported sampling')
    assert.equal(f.effects.generic.length,0)
    assert.equal(f.storeManager.getAccountById(accountId).requestCount,0)
  })
}

for(const [providerId,endpoint] of [
  ['deepseek','https://chat.deepseek.com'],
  ['qwen','https://www.qianwen.com'],
  ['zai','https://chat.z.ai'],
  ['qwen-ai','https://chat.qwen.ai'],
  ['kimi','https://www.kimi.com'],
]){
  test('local81 managed '+providerId+' web-origin alias rejects image content before sending a text-only projection',async t=>{
    const f=await fixture({lookalikeEndpoint:endpoint});t.after(f.close)
    const {accountId}=await f.setup()
    const chat=await f.send('POST','/v1/chat/completions',{
      model:'local79-mirror-alias',
      messages:[{role:'user',content:[
        {type:'text',text:'Do not discard this image'},
        {type:'image_url',image_url:{url:'data:image/png;base64,AA=='}},
      ]}],
    })
    assert.equal(chat.status,400,chat.raw)
    assert.equal(chat.json?.error?.code,'unsupported_message_content')
    assert.equal(f.effects.dedicated.length,0)
    assert.equal(f.effects.generic.length,0)
    assert.equal(f.storeManager.getAccountById(accountId).requestCount,0)
  })
}

test('local81 GLM first-party alias keeps its existing bounded multimodal preflight path',async t=>{
  const f=await fixture({lookalikeEndpoint:'https://chatglm.cn'});t.after(f.close)
  await f.setup()
  const chat=await f.send('POST','/v1/chat/completions',{
    model:'local79-mirror-alias',
    messages:[{role:'user',content:[
      {type:'text',text:'GLM may validate images in its own bounded preflight'},
      {type:'image_url',image_url:{url:'data:image/png;base64,AA=='}},
    ]}],
  })
  assert.equal(chat.status,502,chat.raw)
  assert.deepEqual(f.effects.dedicated,['GLM'])
  assert.equal(f.effects.generic.length,0)
})
