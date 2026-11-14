import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual trusted IPC registration, actual editable account manager, actual
// React form callbacks. All data/keys are synthetic and remain in a VM.
// No Electron userData, operating account, network or external provider call.
const nodeRequire=createRequire(import.meta.url)
const source=p=>readFileSync(new URL('../../src/'+p,import.meta.url),'utf8')
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v))
const providerFields=[
  ['deepseek','token'],['glm','refresh_token'],['qwen','ticket'],
  ['zai','token'],['qwen-ai','token'],['kimi','accessToken'],
]
const canary=p=>'LOCAL98_SYNTHETIC_ONLY_'+p.replaceAll('-','_')
function compile(code,filename,jsx=false){return ts.transpileModule(code,{
  fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,
    module:ts.ModuleKind.CommonJS,esModuleInterop:true,
    ...(jsx?{jsx:ts.JsxEmit.ReactJSX}:{})},
}).outputText}
function run(code,filename,deps={},env={}){
  const m={exports:{}}
  runInNewContext(compile(code,filename,filename.endsWith('.tsx')),{module:m,exports:m.exports,
    Buffer,Date,Math,Error,Promise,Object,Array,JSON,console:{log(){},error(){},warn(){}},
    require(id){if(Object.hasOwn(deps,id))return deps[id]
      if(id.startsWith('.'))throw Error('Unexpected offline import '+id)
      return nodeRequire(id)},...env},
  {filename,timeout:2500,codeGeneration:{strings:false,wasm:false}})
  return m.exports
}
function declarations(file,names){
  const raw=source(file),tree=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true,
    file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
  const found=new Map()
  function visit(node){
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.includes(node.name.text))
      found.set(node.name.text,node.getText(tree))
    if(ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text))
      found.set(node.name.text,node.getText(tree))
    ts.forEachChild(node,visit)
  }
  visit(tree)
  return {tree,found}
}
function registration(tree,channel){
  let expr
  function visit(node){
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&
      node.expression.text==='handleTrusted'&&node.arguments[0]?.getText(tree)===channel)
      expr=node.getText(tree)
    ts.forEachChild(node,visit)
  }
  visit(tree)
  assert.ok(expr,'Actual IPC registration required: '+channel)
  return expr
}
function ipcFixture(provider,field){
  const raw=canary(provider)
  const account={id:'local98-'+provider,providerId:provider,name:'Saved',
    status:'active',credentials:{[field]:'safeStorage:v1:'+raw},
    requestCount:3,todayUsed:2,createdAt:101,updatedAt:102}
  const pending={...account,credentials:{[field]:raw}}
  const requests=[]
  const storeManager={
    getAccountById:(id,include)=>{
      requests.push(['getById',include===true]);return clone(include?pending:account)
    },
    getAccountsByProviderId:(id,include)=>{
      requests.push(['getByProvider',include===true]);return [clone(include?pending:account)]
    },
  }
  const AccountManager={
    getAll(include){requests.push(['getAll',include===true]);return [clone(account)]},
    getByProviderId(id){requests.push(['getByProvider',id]);return [clone(account)]},
    create(data){requests.push(['create']);
      if(provider==='zai')throw Error('Use the protected Z.ai account connection flow')
      return {...pending,name:data.name}},
    updateEditable(id,patch){requests.push(['update',clone(patch)]);return {...pending,...clone(patch)}},
  }
  const code=source('main/ipc/handlers.ts')
  const tree=ts.createSourceFile('ipc.ts',code,ts.ScriptTarget.Latest,true)
  const regs=['ACCOUNTS_GET_ALL','ACCOUNTS_GET_BY_ID','ACCOUNTS_GET_BY_PROVIDER',
    'ACCOUNTS_ADD','ACCOUNTS_UPDATE'].map(n=>registration(tree,'IpcChannels.'+n))
  // Production helper comes from source; a pre-fix build has no such helper.
  const helper=declarations('main/ipc/handlers.ts',['toRendererAccountMetadata']).found.get('toRendererAccountMetadata')||''
  const callbacks=new Map()
  const env={IpcChannels:Object.fromEntries(['ACCOUNTS_GET_ALL','ACCOUNTS_GET_BY_ID',
    'ACCOUNTS_GET_BY_PROVIDER','ACCOUNTS_ADD','ACCOUNTS_UPDATE'].map(x=>[x,x])),
    AccountManager,storeManager}
  run(`${helper}\nexports.register=handleTrusted=>{${regs.join(';')}};`,'local98-ipc.ts',{},env)
    .register((name,callback)=>callbacks.set(name,callback))
  const invoke=(name,...args)=>callbacks.get(name)({},...args)
  return {invoke,requests,raw,cipher:account.credentials[field],field,account}
}

for(const [provider,field] of providerFields){
  test('local98 RED: '+provider+' IPC list/add/edit expose metadata, no token or ciphertext',async()=>{
    const f=ipcFixture(provider,field)
    const rows=await f.invoke('ACCOUNTS_GET_ALL',true)
    const byId=await f.invoke('ACCOUNTS_GET_BY_ID',f.account.id,true)
    const byProvider=await f.invoke('ACCOUNTS_GET_BY_PROVIDER',provider)
    let added
    if(provider==='zai'){
      await assert.rejects(()=>f.invoke('ACCOUNTS_ADD',{providerId:provider,
        name:'Added',credentials:{[field]:f.raw}}),/protected Z.ai/)
    }else{
      added=await f.invoke('ACCOUNTS_ADD',{providerId:provider,
        name:'Added',credentials:{[field]:f.raw}})
    }
    const edited=await f.invoke('ACCOUNTS_UPDATE',f.account.id,{name:'Renamed'})
    for(const result of [rows[0],byId,byProvider[0],...(added?[added]:[]),edited]){
      assert.equal(result.id,f.account.id)
      assert.deepEqual(clone(result.credentials),{},'Opaque credential fields must not enter renderer state')
      assert.equal(JSON.stringify(result).includes(f.raw),false)
      assert.equal(JSON.stringify(result).includes('safeStorage:v1'),false)
    }
    assert.equal(f.requests.some(([kind,include])=>kind==='getById'&&include===true),false,
      'Even a legacy renderer includeCredentials request cannot decrypt the stored credential')
  })
}

function formFixture({isEditing=true,credentials={},fields=[{name:'token',required:true}],
  existingName='Saved',limit='9',validate=false}={}){
  const file='renderer/src/components/providers/AddAccountDialog.tsx'
  const list=['handleSubmit','handleValidate']
  const {found}=declarations(file,list)
  for(const name of list)assert.ok(found.has(name),name+' actual React callback missing')
  const updates=[],newAccounts=[],warnings=[]
  const initial={id:'local98-account',name:existingName,dailyLimit:3}
  let durable={...initial,credentials:{token:'LOCAL98_EXISTING_OS_PROTECTED'}}
  const setValidationResult=v=>warnings.push(clone(v))
  const env={isEditing,isNewZaiAccount:false,editingAccount:isEditing?{...initial}:null,
    isZaiBrowserFlow:false,zaiCreateAttempt:{current:null},credentials,
    credentialFields:fields,name:'Updated',dailyLimit:limit,
    provider:{id:'deepseek'},setValidationResult,
    isEditingSubmitLocked:false,
    onUpdateAccount:async(id,data)=>{
      updates.push(clone(data));assert.equal(id,initial.id)
      durable={...durable,...clone(data),credentials:data.credentials===undefined
        ?durable.credentials:{...durable.credentials,...data.credentials}}
    },
    onAddAccount:async data=>newAccounts.push(clone(data)),
    setIsSubmitting(){},setIsValidating(){},resetForm(){},onOpenChange(){},
    onValidateToken:async()=>{if(!validate)throw Error('Unintended provider auth call')
      return {valid:true}},t:x=>x,
  }
  const script=[...list.map(x=>'const '+found.get(x)+';'),
    'exports.submit=handleSubmit;exports.validate=handleValidate;'].join('\n')
  const callbacks=run(script,'local98-add-account.tsx',{},env)
  return {callbacks,updates,newAccounts,warnings,durable:()=>durable}
}

test('local98 RED: edit name/limit works without decrypting or resending any credential',async()=>{
  const f=formFixture()
  await f.callbacks.submit()
  assert.equal(f.updates.length,1)
  assert.deepEqual(f.updates[0],{name:'Updated',dailyLimit:9})
  assert.deepEqual(f.durable().credentials,{token:'LOCAL98_EXISTING_OS_PROTECTED'})
})

test('local98 RED: explicit credential reentry sends only the deliberately edited fields',async()=>{
  const f=formFixture({credentials:{token:'LOCAL98_REENTERED'},fields:[
    {name:'token',required:true},{name:'cookies',required:false}]})
  await f.callbacks.submit()
  assert.equal(f.updates.length,1)
  assert.deepEqual(f.updates[0].credentials,{token:'LOCAL98_REENTERED'})
})

test('local98 RED: validating an unchanged saved account never sends empty replacement tokens',async()=>{
  const f=formFixture({credentials:{}})
  await f.callbacks.validate()
  assert.equal(f.warnings.some(w=>typeof w.error==='string'&&w.error.length>0),true)
})

for(const [provider,field] of providerFields){
  test('local98 RED: '+provider+' actual editable AccountManager merges one intentional field, invalidates unverified auth',()=>{
    const old=canary(provider)
    let stored={id:'local98-'+provider,providerId:provider,status:'active',
      name:'Saved',createdAt:101,updatedAt:102,requestCount:3,todayUsed:2,
      credentials:{[field]:old,otherOptional:'KEEP_THIS_ASSOCIATED_SESSION'}}
    const writes=[]
    const storeManager={
      getAccountById:id=>id===stored.id?clone(stored):undefined,
      updateAccount(id,changes){assert.equal(id,stored.id)
        writes.push(clone(changes));stored={...stored,...clone(changes)}
        return clone(stored)},
      addLog(){},
    }
    const manager=run(source('main/store/accounts.ts'),'account-manager.ts',{
      './store':{storeManager},'./validator':{validateCredentials(){throw Error('no vendor')}}
    }).AccountManager
    const metadata=manager.updateEditable(stored.id,{name:'Renamed',dailyLimit:7})
    assert.equal(metadata.name,'Renamed')
    assert.equal(stored.status,'active')
    assert.equal(stored.credentials[field],old)
    assert.equal(writes[0].credentials,undefined,'Metadata-only edit cannot replace credentials')
    if(provider==='zai'){
      assert.throws(()=>manager.updateEditable(stored.id,{credentials:{[field]:'LOCAL98_NEW_TOKEN'}}),
        /protected Z.ai/)
      assert.equal(stored.credentials[field],old)
      assert.equal(stored.status,'active')
    }else{
      const fresh=manager.updateEditable(stored.id,{credentials:{[field]:'LOCAL98_NEW_TOKEN'}})
      assert.equal(fresh.credentials[field],'LOCAL98_NEW_TOKEN')
      assert.equal(stored.credentials.otherOptional,'KEEP_THIS_ASSOCIATED_SESSION',
        'A partial UI credential edit must not discard unrelated saved cookie or alias')
      assert.equal(stored.status,'inactive',
        'New unverified credentials must not remain marked as tested active')
    }
    assert.equal(stored.requestCount,3)
    assert.equal(stored.todayUsed,2)
  })
}
