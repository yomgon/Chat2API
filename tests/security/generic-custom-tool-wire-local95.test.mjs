import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Test the exact production generic/custom Axios payload builder in a
// closed VM. No requestForwarder instance, account, credential or network.
const raw=readFileSync(new URL('../../src/main/proxy/forwarder.ts',import.meta.url),'utf8')
const source=ts.createSourceFile('forwarder.ts',raw,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS)
const forwarder=source.statements.find(node=>
  ts.isClassDeclaration(node) && node.name?.text==='RequestForwarder')
assert.ok(forwarder,'Real forwarder class is present')
const method=forwarder.members.find(node=>
  ts.isMethodDeclaration(node) && node.name?.getText(source)==='buildRequestBody')
assert.ok(method,'Real custom/generic builder method is present')
const wrapper='class ExactProductionWire {'+method.getText(source)+
  '}\nmodule.exports = ExactProductionWire'
const compiled=ts.transpileModule(wrapper,{
  fileName:'exact-production-builder.ts',
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText
const module={exports:{}}
runInNewContext(compiled,{module,exports:module.exports,Object,JSON},{
  timeout:1000,filename:'exact-production-buildRequestBody.ts',
  codeGeneration:{strings:false,wasm:false},
})
const instance=new module.exports()
const messages=[{role:'user',content:'LOCAL95_ONLY_IN_MEMORY'}]
const tool={type:'function',function:{
  name:'local_read',description:'Synthetic no-effect',
  parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},
  strict:true,
}}
function wire(patch){
  const input={model:'client-alias',messages,stream:false,...patch}
  return instance.buildRequestBody(input,'exact-pinned-wire-model',
    {id:'synthetic-account',providerId:'synthetic-custom'})
}
test('local95 custom wire keeps pinned model and exact messages',()=>{
  const body=wire({})
  assert.equal(body.model,'exact-pinned-wire-model')
  assert.deepEqual(JSON.parse(JSON.stringify(body.messages)),messages)
  assert.equal(body.stream,false)
  assert.equal(body.tools,undefined)
  assert.equal(body.tool_choice,undefined)
  assert.equal(body.parallel_tool_calls,undefined)
})
test('local95 generic OpenAI custom wire must preserve strict tool schema',()=>{
  const result=wire({tools:[tool]})
  assert.deepEqual(JSON.parse(JSON.stringify(result.tools)),[tool])
})
test('local95 generic OpenAI custom wire must preserve forced tool choice',()=>{
  const choice={type:'function',function:{name:'local_read'}}
  const body=wire({tools:[tool],tool_choice:choice})
  assert.deepEqual(JSON.parse(JSON.stringify(body.tools)),[tool])
  assert.deepEqual(JSON.parse(JSON.stringify(body.tool_choice)),choice)
})
test('local95 generic OpenAI custom wire must preserve tool_choice none',()=>{
  const body=wire({tools:[tool],tool_choice:'none'})
  assert.equal(body.tool_choice,'none')
  assert.deepEqual(JSON.parse(JSON.stringify(body.tools)),[tool])
})
test('local95 generic OpenAI custom wire must preserve parallel false constraint',()=>{
  const body=wire({tools:[tool],parallel_tool_calls:false})
  assert.equal(body.parallel_tool_calls,false)
  assert.deepEqual(JSON.parse(JSON.stringify(body.tools)),[tool])
})
