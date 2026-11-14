import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual React Providers data-load callbacks run in a closed VM. Synthetic
// deferred IPC replies deliberately finish out of order; no Electron, stored
// account, OS profile, or network request is used.
const source=readFileSync(new URL('../../src/renderer/src/pages/Providers.tsx',import.meta.url),'utf8')
const tree=ts.createSourceFile('Providers.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
function declaration(name){
  let text
  function visit(node){
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===name)
      text=node.getText(tree)
    ts.forEachChild(node,visit)
  }
  visit(tree)
  assert.ok(text,'Actual renderer callback missing '+name)
  return text
}
const clone=x=>JSON.parse(JSON.stringify(x))
const deferred=()=>{
  let resolve,reject
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej})
  return {promise,resolve,reject}
}
function fixture(){
  const state={providers:[],builtinProviders:[],accounts:[],
    selectedProviderId:'glm',isLoading:false,providerStatuses:{},
    getState(){return this},
    setProviders(v){this.providers=clone(v)},setBuiltinProviders(v){this.builtinProviders=clone(v)},
    setAccounts(v){this.accounts=clone(v)},setIsLoading(v){this.isLoading=v},
    setProviderStatuses(v){this.providerStatuses=clone(v)},setAccountCounts(v){this.counts=clone(v)},
    updateAccountCount(id,total,active){this.lastCount={id,total,active}},
  }
  const providerRequests=[],builtinRequests=[],accountRequests=[]
  const newDeferred=list=>{const d=deferred();list.push(d);return d.promise}
  const window={electronAPI:{
    providers:{getAll:()=>newDeferred(providerRequests),getBuiltin:()=>newDeferred(builtinRequests)},
    accounts:{getAll:()=>newDeferred(accountRequests)},
  }}
  const useProvidersStore={getState:()=>state}
  const dataRequestGenerationRef={current:0}
  const code=`const ${declaration('loadInitialData')};
    const ${declaration('reloadAccountMetadata')};
    exports.loadInitialData=loadInitialData;
    exports.reloadAccountMetadata=reloadAccountMetadata;`
  const m={exports:{}}
  const compiled=ts.transpileModule(code,{fileName:'renderer-local98.tsx',compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
  }).outputText
  runInNewContext(compiled,{exports:m.exports,module:m,window,useProvidersStore,
    dataRequestGenerationRef,console:{error(){},log(){}},Promise,Date},
  {filename:'local98-providers-async.tsx',timeout:2000,codeGeneration:{strings:false,wasm:false}})
  const respond=(i,providerName,accountName)=>{
    providerRequests[i].resolve([{id:'glm',name:providerName,status:'unknown'}])
    builtinRequests[i].resolve([{id:'glm',name:providerName}])
    accountRequests[i].resolve([{id:'local98',providerId:'glm',name:accountName,status:'active'}])
  }
  return {state,requests:{providerRequests,builtinRequests,accountRequests},
    respond,...m.exports}
}

test('local98 RED: stale initial provider/account IPC reads cannot roll back newer change notifications',async()=>{
  const f=fixture()
  const first=f.loadInitialData(),second=f.loadInitialData()
  assert.equal(f.requests.providerRequests.length,2)
  f.respond(1,'Newest Provider','Newest Account')
  await second
  assert.equal(f.state.accounts[0].name,'Newest Account')
  f.respond(0,'Old Provider','Old Account')
  await first
  assert.equal(f.state.providers[0].name,'Newest Provider')
  assert.equal(f.state.accounts[0].name,'Newest Account')
  assert.equal(f.state.isLoading,false)
})

test('local98 RED: successful account metadata re-read dominates an older initial load',async()=>{
  const f=fixture()
  const first=f.loadInitialData()
  assert.equal(f.requests.accountRequests.length,1)
  const reread=f.reloadAccountMetadata()
  assert.equal(f.requests.accountRequests.length,2)
  f.requests.accountRequests[1].resolve([{
    id:'local98',providerId:'glm',name:'Committed Edit',status:'active',requestCount:3}])
  await reread
  assert.equal(f.state.accounts[0].name,'Committed Edit')
  f.respond(0,'Old Provider','Old Account')
  await first
  assert.equal(f.state.accounts[0].name,'Committed Edit',
    'A slow initial fetch must not undo a committed account edit in React')
})

test('local99 RED: successful metadata reload releases the loading spinner of the superseded initial fetch',async()=>{
  const f=fixture()
  const oldLoad=f.loadInitialData()
  assert.equal(f.state.isLoading,true)
  const newer=f.reloadAccountMetadata()
  f.requests.accountRequests[1].resolve([{
    id:'local99',providerId:'glm',name:'Committed Renamed Account',status:'active'}])
  await newer
  assert.equal(f.state.isLoading,false,'React must not remain Loading after a committed edit')
  f.respond(0,'Old provider','Old account')
  await oldLoad
  assert.equal(f.state.isLoading,false)
  assert.equal(f.state.accounts[0].name,'Committed Renamed Account')
})

test('local99 RED: failed latest account refresh also releases the loading spinner without publishing stale data',async()=>{
  const f=fixture()
  const oldLoad=f.loadInitialData()
  assert.equal(f.state.isLoading,true)
  const newer=f.reloadAccountMetadata()
  f.requests.accountRequests[1].reject(Error('LOCAL99_SYNTHETIC_READ_REFUSAL'))
  await assert.rejects(newer,/LOCAL99_SYNTHETIC_READ_REFUSAL/)
  assert.equal(f.state.isLoading,false,'A refused metadata refresh must not indefinitely lock the Providers page')
  f.respond(0,'Old provider','Old account')
  await oldLoad
  assert.equal(f.state.isLoading,false)
  assert.equal(f.state.accounts.length,0,'Stale initialization cannot revive previously saved accounts')
})
