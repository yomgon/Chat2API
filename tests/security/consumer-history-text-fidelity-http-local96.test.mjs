import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Real production message-to-wire projectors. The VM does not import adapters,
// operating profiles, credentials, remote hosts, Electron, or Axios. For Qwen
// China a local-only spy captures its exact outgoing request before any I/O.
const root = new URL('../../src/main/proxy/adapters/', import.meta.url)
const C = 'LOCAL96_TYPED_TOOL_RESULT'
const RESULT = 'LOCAL96_RESULT_BEGIN' + C + 'LOCAL96_RESULT_END'
const contentParts = (a,b) => [{type:'text',text:a},{type:'text',text:b}]
const call = {id:'call-local96',type:'function',
  function:{name:'lookup',arguments:'{"key":"local"}'}}
const toolProfile = id => ({
  formatAssistantToolCalls(calls){
    assert.equal(calls.length,1)
    assert.equal(calls[0].name,'lookup')
    return 'LOCAL96_TOOL_CALL_IN_WIRE'
  },
  formatToolResult(entry){
    assert.equal(entry.toolCallId,'call-local96')
    return 'TOOL_RESULT('+entry.content+')'
  },
})
function sourceFor(file){
  const raw=readFileSync(new URL(file,root),'utf8')
  const src=ts.createSourceFile(file,raw,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS)
  return {raw,src}
}
function findMethod(file,className,methodName){
  const {src}=sourceFor(file)
  const cls=src.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===className)
  assert.ok(cls,'Real '+className+' class missing')
  const method=cls.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(src)===methodName)
  assert.ok(method,'Real '+methodName+' method missing')
  return method.getText(src)
}
function loadSnippet(raw,variables,file){
  const compiled=ts.transpileModule(raw,{fileName:file,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
  const mod={exports:{}}
  runInNewContext(compiled,{
    exports:mod.exports,module:mod,JSON,Math,Date,Buffer,Error,Object,
    console:{log(){},warn(){},error(){}},...variables,
  },{timeout:2000,filename:'local96-'+file,
    codeGeneration:{strings:false,wasm:false}})
  return mod.exports
}
function deepSeekProjector(){
  const method=findMethod('deepseek.ts','DeepSeekAdapter','messagesToPrompt')
  const x=loadSnippet('class Projector {'+method+'}\nexports.Projector=Projector',
    {getProviderToolProfile:id=>{assert.equal(id,'deepseek');return toolProfile(id)}},
    'deepseek-projector.ts')
  return new x.Projector()
}
function glmProjector(){
  const method=findMethod('glm.ts','GLMAdapter','messagesToPrompt')
  const x=loadSnippet('class Projector {'+method+'}\nexports.Projector=Projector',
    {getProviderToolProfile:id=>{assert.equal(id,'glm');return toolProfile(id)}},
    'glm-projector.ts')
  return new x.Projector()
}
const flattenGlm=val=>{
  assert.ok(Array.isArray(val))
  assert.equal(val.length,1)
  return val[0].content.filter(x=>x.type==='text').map(x=>x.text).join('')
}
function sharedHistory(toolContent){
  return [
    {role:'user',content:'Call lookup'},
    {role:'assistant',content:'Before tool',tool_calls:[call]},
    {role:'tool',tool_call_id:'call-local96',content:toolContent},
    {role:'user',content:'Continue'},
  ]
}
test('local96 DeepSeek full text-array tool result must preserve bytes, not [object Object]',()=>{
  const prompt=deepSeekProjector().messagesToPrompt(sharedHistory(
    contentParts('LOCAL96_RESULT_BEGIN',C+'LOCAL96_RESULT_END')))
  assert.ok(prompt.includes('TOOL_RESULT('+RESULT+')'),prompt)
  assert.equal(prompt.includes('[object Object]'),false)
})
test('local96 GLM full text-array tool result must preserve bytes, not [object Object]',()=>{
  const prompt=flattenGlm(glmProjector().messagesToPrompt(sharedHistory(
    contentParts('LOCAL96_RESULT_BEGIN',C+'LOCAL96_RESULT_END'))))
  assert.ok(prompt.includes('TOOL_RESULT('+RESULT+')'),prompt)
  assert.equal(prompt.includes('[object Object]'),false)
})
test('local96 DeepSeek user text-part fragments concatenate without invented newline',()=>{
  const prompt=deepSeekProjector().messagesToPrompt([
    {role:'user',content:contentParts('segment-A','segment-B')},
  ])
  assert.ok(prompt.includes('segment-Asegment-B'),prompt)
  assert.equal(prompt.includes('segment-A\nsegment-B'),false)
})
test('local96 DeepSeek markdown image syntax inside plain text remains ordinary text',()=>{
  const text='Please discuss the literal Markdown ![diagram](https://example.invalid/d.svg) notation.'
  const prompt=deepSeekProjector().messagesToPrompt([{role:'user',content:text}])
  assert.ok(prompt.includes(text),'Textual markdown notation must not vanish')
})
test('local96 DeepSeek plain string tool result remains byte-equivalent',()=>{
  const prompt=deepSeekProjector().messagesToPrompt(sharedHistory(RESULT))
  assert.ok(prompt.includes('TOOL_RESULT('+RESULT+')'))
})
test('local96 GLM plain string tool result remains byte-equivalent',()=>{
  const prompt=flattenGlm(glmProjector().messagesToPrompt(sharedHistory(RESULT)))
  assert.ok(prompt.includes('TOOL_RESULT('+RESULT+')'))
})

function qwenHarness(){
  const {src}=sourceFor('qwen.ts')
  const extractor=src.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='extractTextContent')
  assert.ok(extractor,'Real Qwen text projector missing')
  const method=findMethod('qwen.ts','QwenAdapter','chatCompletion')
  const wrapper=extractor.getText(src)+'\nclass Projector { '+method+
    ' }\nexports.Projector=Projector'
  const requests=[]
  const x=loadSnippet(wrapper,{
    uuid:()=> 'LOCAL96-ID',generateNonce:()=> 'LOCAL96-NONCE',
    DEFAULT_HEADERS:{},QWEN_API_BASE:'https://invalid.example.invalid',
    getProviderToolProfile:id=>{assert.equal(id,'qwen');return toolProfile(id)},
    hasToolPromptInjected:()=>false,
    toolsToSystemPrompt:()=>{throw Error('No tool declarations in fixture')},
    TOOL_WRAP_HINT:'LOCAL96_NO_WIRE_HINT',
  },'qwen-projector.ts')
  const a=new x.Projector()
  a.getTicket=()=> 'INERT_LOCAL96_TEST_ONLY'
  a.mapModel=m=>m
  a.axiosInstance={post:async(uri,body,options)=>{
    assert.equal(new URL(uri).hostname,'invalid.example.invalid')
    assert.equal(options.maxRedirects,0)
    requests.push(JSON.parse(JSON.stringify(body)))
    return {status:200,data:{},headers:{}}
  }}
  return {adapter:a,requests}
}
async function qwenPrompt(messages){
  const f=qwenHarness()
  const result=await f.adapter.chatCompletion({model:'synthetic-wire-id',
    resolvedModelId:true,messages})
  assert.equal(result.response.status,200)
  assert.equal(f.requests.length,1)
  assert.equal(f.requests[0].model,'synthetic-wire-id')
  return f.requests[0].messages[0].content
}
test('local96 Qwen China assistant tool call retains its preceding text',async()=>{
  const value=await qwenPrompt(sharedHistory(RESULT))
  assert.ok(value.includes('Before tool'),'Assistant explanatory text silently vanished')
  assert.ok(value.includes('LOCAL96_TOOL_CALL_IN_WIRE'))
  assert.ok(value.includes('TOOL_RESULT('+RESULT+')'))
  assert.ok(value.indexOf('Before tool')<value.indexOf('LOCAL96_TOOL_CALL_IN_WIRE'))
  assert.ok(value.indexOf('LOCAL96_TOOL_CALL_IN_WIRE')<value.indexOf('TOOL_RESULT('+RESULT+')'))
})
test('local96 Qwen China assistant tool call with typed text-part retains explanation',async()=>{
  const h=sharedHistory(RESULT)
  h[1]={...h[1],content:contentParts('Before ','tool')}
  const value=await qwenPrompt(h)
  assert.ok(value.includes('Before tool'),'Multipart assistant preface vanished')
  assert.ok(value.includes('LOCAL96_TOOL_CALL_IN_WIRE'))
})
test('local96 Qwen China user text parts concatenate without invented newline',async()=>{
  const value=await qwenPrompt([{role:'user',content:contentParts('segment-A','segment-B')}])
  assert.ok(value.includes('segment-Asegment-B'))
  assert.equal(value.includes('segment-A\nsegment-B'),false)
})
test('local96 Qwen China basic string request remains available',async()=>{
  const value=await qwenPrompt([{role:'user',content:'LOCAL96_SIMPLE_TEXT'}])
  assert.ok(value.includes('LOCAL96_SIMPLE_TEXT'))
})
