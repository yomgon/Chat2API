import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

// Actual production TypeScript declarations are executed under inert accounts,
// model catalogs and deferred IPC. No operating profile or external service.
const require=createRequire(import.meta.url)
const raw=relative=>readFileSync(new URL('../../src/'+relative,import.meta.url),'utf8')
const clone=x=>JSON.parse(JSON.stringify(x))
function extract(file,names){
  const src=raw(file)
  const tree=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,
    file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
  const found=new Map()
  const visit=node=>{
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.includes(node.name.text))
      found.set(node.name.text,node.getText(tree))
    if(ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text))
      found.set(node.name.text,node.getText(tree))
    if(ts.isClassDeclaration(node)&&node.name&&names.includes(node.name.text))
      found.set(node.name.text,node.getText(tree))
    ts.forEachChild(node,visit)
  }
  visit(tree)
  for(const name of names)assert.ok(found.has(name),'Missing actual production declaration '+name)
  return found
}
function execute(code,file,environment){
  const m={exports:{}}
  const js=ts.transpileModule(code,{fileName:file,compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
    jsx:ts.JsxEmit.ReactJSX,
  }}).outputText
  runInNewContext(js,{module:m,exports:m.exports,
    Date,Math,Set,Map,Promise,Error,Array,Object,JSON,Number,RegExp,
    console:{log(){},error(){}},...environment},
  {filename:file,timeout:3000,codeGeneration:{strings:false,wasm:false}})
  return m.exports
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{
  resolve=yes;reject=no
});return{promise,resolve,reject}}

test('local100 RED: newly saved credentials remain inactive until an independently completed validation',async()=>{
  const ds=extract('main/store/accounts.ts',
    ['AccountManager','isSameValidationSnapshot','logCommittedAccountChange'])
  let account
  const storeManager={
    generateId:()=> 'local100-new-inert',
    ensureProviderExists:()=>{},
    getProviderById:()=>({id:'local100-loopback',type:'custom',enabled:true}),
    getAccountById:(id)=>account?.id===id?clone(account):undefined,
    addAccount:a=>{account=clone(a)},
    updateAccount:(_,patch)=>{account={...account,...clone(patch)};return clone(account)},
    addLog:()=>{},
  }
  let validated=false
  const source=[...ds.values()].join('\n')+'\nexports.AccountManager=AccountManager;'
  const {AccountManager}=execute(source,'local100-accounts.ts',{storeManager,
    validateCredentials:async()=>({valid:validated,validatedAt:Date.now(),
      ...(validated?{}:{error:'LOCAL100_SYNTHETIC_REFUSED'})})})
  const created=AccountManager.create({providerId:'local100-loopback',name:'Synthetic New',
    credentials:{token:'INERT_LOCAL100'},dailyLimit:3})
  assert.equal(created.status,'inactive',
    'A saved but never checked token must not be advertised as an available account')
  assert.equal(AccountManager.isAvailable(created.id),false)
  assert.equal(created.requestCount,0)
  assert.equal(created.todayUsed,0)
  assert.equal(created.lastStatusCheck,undefined,
    'A saved but unchecked credential must not show a fake Last Check timestamp')
  validated=true
  const proof=await AccountManager.validate(created.id)
  assert.equal(proof.valid,true)
  assert.equal(account.status,'active')
  assert.equal(AccountManager.isAvailable(created.id),true)
  assert.equal(account.requestCount,0)
  assert.equal(account.lastStatusCheck,proof.validatedAt,
    'React account detail must show the real completed credential validation time')
  validated=false
  const refused=await AccountManager.validate(created.id)
  assert.equal(refused.valid,false)
  assert.equal(account.status,'error')
  assert.equal(account.lastStatusCheck,refused.validatedAt,
    'A failed check must be timestamped and cannot leave a falsely active account')
  assert.equal(AccountManager.isAvailable(created.id),false)
})

test('local100 RED: Models page older IPC read cannot undo account/model state changed while loading',async()=>{
  const declaration=extract('renderer/src/pages/Models.tsx',['refresh']).get('refresh')
  const queue=[]
  const state={providers:[],accounts:[],
    setProviders:p=>{state.providers=clone(p)},
    setAccounts:a=>{state.accounts=clone(a)}}
  const window={electronAPI:{
    providers:{getAll:()=>{const d=deferred();queue.push({type:'providers',d});return d.promise}},
    accounts:{getAll:()=>{const d=deferred();queue.push({type:'accounts',d});return d.promise}},
  }}
  const modelPageRequestGenerationRef={current:0}
  const {refresh}=execute('const '+declaration+';exports.refresh=refresh;',
    'local100-models-page.tsx',{window,modelPageRequestGenerationRef,
      fetchAppConfig:async()=>{},useProvidersStore:{getState:()=>state}})
  const older=refresh('accounts'),newer=refresh('accounts')
  assert.equal(queue.length,4)
  queue[2].d.resolve([{id:'qwen',name:'NEW PROVIDER'}])
  queue[3].d.resolve([{id:'new',name:'NEW VALIDATED ACCOUNT',status:'active'}])
  await newer
  queue[0].d.resolve([{id:'qwen',name:'OLD PROVIDER'}])
  queue[1].d.resolve([{id:'old',name:'STALE INACTIVE ACCOUNT',status:'inactive'}])
  await older
  assert.equal(state.accounts[0].name,'NEW VALIDATED ACCOUNT')
  assert.equal(state.providers[0].name,'NEW PROVIDER')
})

test('local100 RED: ModelEditor successful saved wire mapping cannot be overwritten by pending old list',async()=>{
  const declarations=extract('renderer/src/components/models/ModelEditor.tsx',
    ['loadModels','handleAddModel'])
  const pending=deferred()
  let catalog=[]
  const modelRequestGenerationRef={current:0}
  const state={names:[],isLoading:false}
  const env={window:{electronAPI:{providers:{
    getEffectiveModels:()=>pending.promise,
    addCustomModel:async()=>({success:true,models:[
      {displayName:'local100-new',actualModelId:'local100-wire',isCustom:true}]}),
  }}},providerId:'glm',modelRequestGenerationRef,
    newDisplayName:'local100-new',newActualModelId:'local100-wire',
    models:catalog,setModels:m=>{catalog=clone(m);state.names=catalog.map(x=>x.displayName)},
    setIsLoading:b=>{state.isLoading=b},setIsAdding(){},setNewDisplayName(){},
    setNewActualModelId(){},setIsAddDialogOpen(){},setModelsLastUpdated(){},
    toast(){},t:x=>x,Date}
  const script=['loadModels','handleAddModel'].map(n=>'const '+declarations.get(n)+';')
    .join('\n')+'\nexports.loadModels=loadModels;exports.addModel=handleAddModel;'
  const callbacks=execute(script,'local100-model-editor.tsx',env)
  const oldRead=callbacks.loadModels()
  await callbacks.addModel()
  assert.deepEqual(state.names,['local100-new'])
  pending.resolve([{displayName:'old-saved',actualModelId:'old-wire',isCustom:false}])
  await oldRead
  assert.deepEqual(state.names,['local100-new'],
    'A late getEffectiveModels read cannot visually undo a committed model mapping')
  assert.equal(state.isLoading,false)
})

test('local100 RED: ModelList overlapping reads never roll back newer effective wire catalogs',async()=>{
  const declaration=extract('renderer/src/components/models/ModelList.tsx',
    ['loadEffectiveModels']).get('loadEffectiveModels')
  const pending=[]
  const state={map:{},errors:{}}
  const enabledProviders=[{id:'qwen',enabled:true}]
  const modelListRequestGenerationRef={current:0}
  const callbacks=execute('const '+declaration+';exports.load=loadEffectiveModels;',
    'local100-model-list.tsx',{
      providers:enabledProviders,modelListRequestGenerationRef,
      useCallback:fn=>fn,
      setEffectiveModelsMap:v=>{state.map=clone(typeof v==='function'?v(state.map):v)},
      setModelReadErrors:v=>{state.errors=clone(typeof v==='function'?v(state.errors):v)},
      window:{electronAPI:{providers:{getEffectiveModels:()=>{
        const d=deferred();pending.push(d);return d.promise}}}},
    })
  const first=callbacks.load(),second=callbacks.load()
  pending[1].resolve([{displayName:'Qwen New',actualModelId:'wire-new'}])
  await second
  pending[0].resolve([{displayName:'Qwen Old',actualModelId:'wire-old'}])
  await first
  assert.equal(state.map.qwen[0].actualModelId,'wire-new')
})

test('local100: a refused model catalog refresh preserves its last saved wire and reports uncertainty',async()=>{
  let failed=false
  const state={map:{},errors:[]}
  const modelListRequestGenerationRef={current:0}
  const decl=extract('renderer/src/components/models/ModelList.tsx',
    ['loadEffectiveModels']).get('loadEffectiveModels')
  const {load}=execute('const '+decl+';exports.load=loadEffectiveModels;',
    'local100-model-catalog-error.tsx',{
      providers:[{id:'qwen-ai',enabled:true}],modelListRequestGenerationRef,
      useCallback:fn=>fn,
      setEffectiveModelsMap:update=>{state.map=clone(typeof update==='function'?update(state.map):update)},
      setModelReadErrors:update=>{state.errors=clone(typeof update==='function'?update(state.errors):update)},
      window:{electronAPI:{providers:{async getEffectiveModels(){
        if(failed)throw Error('LOCAL100_SYNTHETIC_READ_FAILURE')
        return [{displayName:'Known Web Model',actualModelId:'trusted-wire'}]
      }}}},
  })
  await load()
  assert.equal(state.map['qwen-ai'][0].actualModelId,'trusted-wire')
  failed=true
  await load()
  assert.equal(state.map['qwen-ai'][0].actualModelId,'trusted-wire')
  assert.deepEqual(state.errors,['qwen-ai'])
})

test('local100 RED: ModelList does not claim an inactive first account is the selected model account',()=>{
  const declaration=extract('renderer/src/components/models/ModelList.tsx',
    ['modelList']).get('modelList')
  const providers=[{id:'qwen',name:'Qwen China',enabled:true}]
  const accounts=[
    {id:'unverified',name:'Unverified',status:'inactive',providerId:'qwen'},
    {id:'validated',name:'Validated',status:'active',providerId:'qwen'},
  ]
  const {list}=execute('const '+declaration+';exports.list=modelList;',
    'local100-model-presentation.tsx',{providers,accounts,modelMappings:[],
      effectiveModelsMap:{qwen:[{displayName:'Qwen Web',actualModelId:'wire-qwen'}]},
      useMemo:fn=>fn(),t:x=>x})
  assert.equal(list.length,1)
  assert.equal(list[0].status,'available')
  assert.equal(list[0].accountId,'validated')
  assert.equal(list[0].accountName,'Validated')
})

function proxyStoreFixture(api){
  const parts=extract('renderer/src/stores/proxyStore.ts',
    ['DEFAULT_PROXY_CONFIG','DEFAULT_STATISTICS','useProxyStore'])
  let state
  const create=builder=>{
    const set=patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)}}
    state=builder(set,()=>state)
    return ()=>state
  }
  const {useProxyStore}=execute([...parts.values()].map(item=>'const '+item+';').join('\n')+
    '\nexports.useProxyStore=useProxyStore;',
  'local100-proxy-config.ts',{window:{electronAPI:api},create,
    appConfigReadGeneration:0})
  // Zustand's set replaces the state object. Observe its *current* snapshot,
  // not the first object captured before the awaited IPC callbacks finish.
  return new Proxy({}, {get(_target,key){return useProxyStore()[key]}})
}

test('local100 RED: stale Settings config IPC response cannot replace a newer confirmed model mapping snapshot',async()=>{
  const pending=[]
  const f=proxyStoreFixture({config:{get:()=>{
    const d=deferred();pending.push(d);return d.promise
  }}})
  const older=f.fetchAppConfig(),newer=f.fetchAppConfig()
  assert.equal(pending.length,2)
  const makeConfig=(tag)=>({proxyPort:8080,proxyHost:'127.0.0.1',
    requestTimeout:60000,retryCount:0,loadBalanceStrategy:'round-robin',
    modelMappings:{[tag]:{requestModel:tag,actualModel:'wire-'+tag}}})
  pending[1].resolve(makeConfig('new'))
  await newer
  pending[0].resolve(makeConfig('old'))
  await older
  assert.equal(f.appConfig.modelMappings.new?.actualModel,'wire-new')
  assert.equal(f.modelMappings.length,1)
  assert.equal(f.modelMappings[0].requestModel,'new')
  assert.equal(f.isLoading,false)
})

test('local100 RED: temporary Statistics IPC failure must not fake zero successful requests',async()=>{
  const f=proxyStoreFixture({statistics:{get:async()=>{
    throw Error('LOCAL100_SYNTHETIC_STATISTICS_IPC_ERROR')
  }}})
  f.setProxyStatistics({totalRequests:2,successRequests:2,failedRequests:0,
    avgLatency:42,requestsPerMinute:0,activeConnections:0,
    providerUsage:{},modelUsage:{},accountUsage:{}})
  await f.fetchProxyStatistics()
  assert.equal(f.proxyStatistics.totalRequests,2,
    'A failing statistics read is unknown, not an authoritative zero')
  assert.match(f.error,/statistics/i,
    'The renderer must reveal a non-sensitive statistics read failure')
})
