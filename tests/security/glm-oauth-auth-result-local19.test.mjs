import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source=readFileSync(new URL('../../src/main/oauth/adapters/glm.ts',import.meta.url),'utf8')
const code=ts.transpileModule(source,{fileName:'glm.ts',compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
}}).outputText
const PRIVATE='SYNTHETIC_GLM_REFRESH_TOKEN_LOCAL19'
const PRIVATE_URL='https://mock.invalid/?access_token='+PRIVATE
const logs=[]
const fakeAxios={post:async()=>{throw Error(PRIVATE_URL+' Authorization: Bearer '+PRIVATE)},
  get:async()=>{throw Error('Never requested in this scenario')}}
class Base {
  constructor(config){this.config=config;this.progress=[]}
  emitProgress(type,message){this.progress.push({type,message})}
  generateUUID(){return '12345678-1234-4123-8123-123456789012'}
  md5(){return 'synthetic-signature'}
  getTimestamp(){return 1000000000}
}
const module={exports:{}}
vm.runInNewContext(code,{module,exports:module.exports,Buffer,Date,Number,Error,
  require:name=>{
    if(name==='axios')return {__esModule:true,default:fakeAxios}
    if(name==='electron')return {shell:{openExternal:async()=>{throw Error(PRIVATE_URL)}}}
    if(name==='./base')return {BaseOAuthAdapter:Base}
    throw Error('Unexpected offline import '+name)
  },
  console:{log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},
},{filename:'glm-oauth.ts',timeout:2000})
const {GLMAdapter}=module.exports
function adapter(){return new GLMAdapter({id:'glm',providerId:'glm'})}

test('GLM login refuses a false token validation instead of storing another success credential',async()=>{
  const a=adapter()
  a.refreshToken=async()=>({value:'synthetic-access-token',refreshToken:PRIVATE})
  a.validateToken=async()=>({valid:false,error:'Guest account not allowed'})
  const result=await a.loginWithToken('glm',PRIVATE)
  assert.equal(result.success,false)
  assert.equal(result.credentials,undefined)
  assert.equal(a.progress.some(p=>p.type==='success'),false)
})
test('GLM login refuses a malformed access token, even if refresh endpoint returned HTTP 200',async()=>{
  const a=adapter()
  a.refreshToken=async()=>({value:{token:PRIVATE},refreshToken:PRIVATE})
  a.validateToken=async()=>({valid:true,accountInfo:{userId:'synthetic-id'}})
  const result=await a.loginWithToken('glm',PRIVATE)
  assert.equal(result.success,false)
  assert.equal(result.credentials,undefined)
})
test('GLM successful validated refresh preserves token and account metadata without diagnostics',async()=>{
  const a=adapter()
  const access='valid-synthetic-access-token'
  a.refreshToken=async()=>({value:access,refreshToken:PRIVATE})
  a.validateToken=async()=>({valid:true,accountInfo:{userId:'synthetic-id'}})
  const result=await a.loginWithToken('glm',PRIVATE)
  assert.equal(result.success,true)
  assert.equal(result.credentials.refreshToken,PRIVATE)
  assert.equal(result.credentials.accessToken,access)
  assert.equal(result.accountInfo.userId,'synthetic-id')
  assert.deepEqual(a.progress.map(p=>p.type),['pending','success'])
})
test('GLM OAuth catches sanitize transport errors from validation, refresh and external shell',async()=>{
  const a=adapter()
  const validation=await a.validateToken({refreshToken:PRIVATE})
  assert.equal(validation.valid,false)
  assert.equal(JSON.stringify(validation).includes(PRIVATE),false)
  const b=adapter()
  b.refreshToken=async()=>{throw Error(PRIVATE_URL+' Authorization: Bearer '+PRIVATE)}
  const result=await b.loginWithToken('glm',PRIVATE)
  assert.equal(result.success,false)
  assert.equal(JSON.stringify(result).includes(PRIVATE),false)
  assert.equal(JSON.stringify(b.progress).includes(PRIVATE),false)
  const c=adapter()
  const shell=await c.startLogin({providerId:'glm'})
  assert.equal(shell.success,false)
  assert.equal(JSON.stringify(shell).includes(PRIVATE),false)
  assert.equal(JSON.stringify(c.progress).includes(PRIVATE),false)
  assert.equal(JSON.stringify(logs).includes(PRIVATE),false)
})
