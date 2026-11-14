import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createServer,request as httpRequest } from 'node:http'
import { once } from 'node:events'
import ts from 'typescript'

// The protected Z.ai owner-login flow must not be bypassed by a generic
// renderer or management CRUD request. Closed synthetic store and 127.0.0.1:0
// Koa only; never touches a real session, token or external endpoint.
const nodeRequire=createRequire(import.meta.url)
const source=rel=>readFileSync(new URL('../../src/main/'+rel,import.meta.url),'utf8')
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x))
function production(rel,deps={}){
  const output=ts.transpileModule(source(rel),{fileName:rel,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText
  const m={exports:{}}
  runInNewContext(output,{module:m,exports:m.exports,Date,Math,JSON,Error,Promise,Buffer,
    console:{log(){},error(){},warn(){}},require(id){
      if(Object.hasOwn(deps,id))return deps[id]
      if(id.startsWith('.'))throw Error('Unexpected local98 import '+id)
      return nodeRequire(id)
    }},{filename:rel,timeout:2500,codeGeneration:{strings:false,wasm:false}})
  return m.exports
}
async function fixture(){
  const original={id:'local98-zai',providerId:'zai',name:'Protected',
    status:'active',credentials:{token:'LOCAL98_EXISTING_PROTECTED_SESSION'},
    requestCount:5,todayUsed:2,createdAt:100,updatedAt:101}
  const providers=[{id:'zai',type:'builtin',enabled:true},
    {id:'deepseek',type:'builtin',enabled:true}]
  let accounts=[clone(original)],effectWrites=0
  const store={
    getConfig:()=>({managementApi:{enableManagementApi:true,managementApiSecret:'mgmt_local98_synthetic'}}),
    ensureProviderExists(){},
    getProviderById:id=>clone(providers.find(p=>p.id===id)),
    generateId:()=> 'synthetic-created',
    getAccounts:()=>clone(accounts),
    getAccountById:(id)=>clone(accounts.find(a=>a.id===id)),
    updateAccount:(id,patch)=>{
      effectWrites++
      accounts=accounts.map(a=>a.id===id?{...a,...clone(patch)}:a)
      return clone(accounts.find(a=>a.id===id))
    },
    addAccount:a=>{effectWrites++;accounts.push(clone(a))},
    addLog(){},
  }
  const Manager=production('store/accounts.ts',{'./store':{storeManager:store},
    './validator':{validateCredentials(){throw Error('Unexpected network validation')}}}).AccountManager
  const auth=production('proxy/middleware/managementAuth.ts',{
    '../../store/store':{storeManager:store}}).managementAuthMiddleware
  const routes=production('proxy/routes/management/accounts.ts',{
    '@koa/router':nodeRequire('@koa/router'),
    '../../middleware/managementAuth':{managementAuthMiddleware:auth},
    '../../../store/accounts':{__esModule:true,default:Manager},
  }).default
  const koa=new (nodeRequire('koa'))()
  koa.use(nodeRequire('koa-bodyparser')())
  koa.use(routes.routes());koa.use(routes.allowedMethods())
  const server=createServer(koa.callback())
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const port=server.address().port
  function request(method,path,body){return new Promise((resolve,reject)=>{
    const headers={Host:'127.0.0.1:'+port,Authorization:'Bearer mgmt_local98_synthetic'}
    if(body!==undefined)headers['Content-Type']='application/json'
    const r=httpRequest({host:'127.0.0.1',port,path,method,headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject)
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8')
        let json;try{json=JSON.parse(raw)}catch{}
        resolve({status:res.statusCode,json,raw})
      })
    });r.on('error',reject);r.setTimeout(2500,()=>r.destroy(Error('Local only timeout')))
    r.end(body===undefined?undefined:JSON.stringify(body))
  })}
  return {request,Manager,original,all:()=>clone(accounts),writes:()=>effectWrites,
    close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))}}
}
test('local98 RED: generic management POST cannot create fake active Z.ai web account',async t=>{
  const f=await fixture();t.after(f.close)
  const result=await f.request('POST','/v0/management/accounts',{
    providerId:'zai',name:'Invalid Z.ai',credentials:{token:'LOCAL98_UNVERIFIED_JWT'}})
  assert.equal(result.status,400)
  assert.equal(result.json?.error?.code,'protected_login_required')
  assert.deepEqual(f.all(),[f.original])
  assert.equal(f.writes(),0)
})
test('local98 RED: generic management PUT cannot replace a protected Z.ai login',async t=>{
  const f=await fixture();t.after(f.close)
  const result=await f.request('PUT','/v0/management/accounts/local98-zai',{
    credentials:{token:'LOCAL98_UNVERIFIED_REPLACEMENT'}})
  assert.equal(result.status,400)
  assert.equal(result.json?.error?.code,'protected_login_required')
  assert.deepEqual(f.all(),[f.original])
  assert.equal(f.writes(),0)
})
test('local98 RED: protected main AccountManager rejects direct generic Z.ai writes',async t=>{
  const f=await fixture();t.after(f.close)
  assert.throws(()=>f.Manager.create({providerId:'zai',name:'Unverified',
    credentials:{token:'LOCAL98_INVALID'}}),/protected Z.ai/)
  assert.throws(()=>f.Manager.updateEditable('local98-zai',{
    credentials:{token:'LOCAL98_INVALID'}}),/protected Z.ai/)
  assert.equal(f.writes(),0)
})
test('local98 control: Z.ai metadata edit keeps original verified session and counters',async t=>{
  const f=await fixture();t.after(f.close)
  const result=await f.request('PUT','/v0/management/accounts/local98-zai',{
    name:'Renamed Z.ai',dailyLimit:7})
  assert.equal(result.status,200,result.raw)
  assert.equal(f.all()[0].credentials.token,f.original.credentials.token)
  assert.equal(f.all()[0].status,'active')
  assert.equal(f.all()[0].requestCount,5)
  assert.equal(f.writes(),1)
})
test('local98 control: generic non-Z.ai account creation remains supported',async t=>{
  const f=await fixture();t.after(f.close)
  const result=await f.request('POST','/v0/management/accounts',{
    providerId:'deepseek',name:'Local only',credentials:{token:'LOCAL98_INERT'}})
  assert.equal(result.status,201,result.raw)
  assert.equal(f.all().length,2)
  assert.equal(f.writes(),1)
})
test('local98 RED: management credential reentry preserves other session fields, clears unverified active state',async t=>{
  const f=await fixture();t.after(f.close)
  const created=await f.request('POST','/v0/management/accounts',{
    providerId:'deepseek',name:'Local only',credentials:{
      token:'LOCAL98_ORIGINAL',cookies:'LOCAL98_ASSOCIATED_COOKIE'}})
  assert.equal(created.status,201,created.raw)
  const id=created.json.data.id
  const patched=await f.request('PUT','/v0/management/accounts/'+id,{
    credentials:{token:'LOCAL98_NEW'}})
  assert.equal(patched.status,200,patched.raw)
  const account=f.all().find(a=>a.id===id)
  assert.equal(account.credentials.token,'LOCAL98_NEW')
  assert.equal(account.credentials.cookies,'LOCAL98_ASSOCIATED_COOKIE',
    'Editing one credential must not erase the untouched stored session field')
  assert.equal(account.status,'inactive','An unverified replacement must not stay active')
  assert.equal(f.writes(),2,'Exactly one create and one update; no extra effect')
  assert.equal(patched.raw.includes('LOCAL98_NEW'),false)
  assert.equal(patched.raw.includes('LOCAL98_ASSOCIATED_COOKIE'),false)
})
