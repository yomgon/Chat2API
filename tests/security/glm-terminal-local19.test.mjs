import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { createParser } from 'eventsource-parser'

// Runs real GLMStreamHandler source with an in-memory upstream. All network,
// account, store and GUI imports are inert; no actual model dispatch occurs.
const original=readFileSync(new URL('../../src/main/proxy/adapters/glm.ts',import.meta.url),'utf8')
const code=ts.transpileModule(original,{fileName:'glm.ts',compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,
}}).outputText
const log=[]
const mockModules={
  axios:{default:{}}, crypto:{}, '../../store/store':{storeManager:{}},
  stream:{PassThrough}, 'eventsource-parser':{createParser},
  'form-data':{default:class{}},'mime-types':{},path:{},
  '../utils/tools':{toolsToSystemPrompt:()=>'',TOOL_WRAP_HINT:'',hasToolPromptInjected:()=>false},
  '../utils/toolParser':{parseToolCallsFromText:content=>({content,toolCalls:[]})},
  '../utils/streamToolHandler':{createBaseChunk:(id,model,created)=>({id,model,created,object:'chat.completion.chunk'})},
  '../toolCalling/providerProfiles':{getProviderToolProfile:()=>({})},
  '../toolCalling/ToolStreamParser':{ToolStreamParser:class{}},
}
const module={exports:{}}
vm.runInNewContext(code,{module,exports:module.exports,Buffer,TextDecoder,Date,Error,
  require:name=>{
    if(Object.hasOwn(mockModules,name))return mockModules[name]
    throw Error('Unexpected GLM import '+name)
  },
  console:{log:()=>{},warn:()=>{},error:(...args)=>log.push(args)},
},{filename:'glm.ts',timeout:2000})
const {GLMStreamHandler}=module.exports
const PRIVATE='SYNTHETIC_GLM_PRIVATE_UPSTREAM_ERROR_LOCAL19'
const sse=v=>'data: '+JSON.stringify(v)+'\n\n'
const answer=sse({status:'streaming',conversation_id:'synthetic-glm-id',parts:[{
  logic_id:'1',status:'streaming',content:[{type:'text',text:'완료 😀'}],
}]})
const finish=sse({status:'finish',conversation_id:'synthetic-glm-id'})

async function streamHarness(pieces,{mode='end',beforeEnd}={}){
  const src=new PassThrough()
  const output=await new GLMStreamHandler('GLM-synthetic').handleStream(src)
  const chunks=[]
  const terminal=new Promise(resolve=>{
    output.on('data',chunk=>chunks.push(chunk.toString()))
    output.once('end',()=>resolve('end'))
    output.once('error',()=>resolve('error'))
  })
  for(const p of pieces)src.write(p)
  if(beforeEnd)await beforeEnd(chunks.join(''))
  if(mode==='error')src.emit('error',Object.assign(new Error(PRIVATE),{token:PRIVATE}))
  else if(mode==='close')src.destroy()
  else src.end()
  const outcome=await Promise.race([terminal,new Promise(resolve=>setTimeout(()=>resolve('timeout'),150))])
  return {wire:chunks.join(''),outcome}
}
async function nonstreamHarness(pieces,{mode='end',beforeEnd}={}){
  const src=new PassThrough()
  const observed=[]
  const promise=new GLMStreamHandler('GLM-synthetic').handleNonStream(src).then(
    body=>{observed.push('success');return {success:true,body}},
    error=>{observed.push('failure');return {success:false,error:String(error?.message??'error')}},
  )
  for(const p of pieces)src.write(p)
  if(beforeEnd)await beforeEnd(observed)
  if(mode==='error')src.emit('error',new Error(PRIVATE))
  else if(mode==='close')src.destroy()
  else src.end()
  return await Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),150))])
}
function noSuccess(result){
  assert.equal(result.outcome,'end')
  assert.doesNotMatch(result.wire,/data: \[DONE\]/)
  assert.doesNotMatch(result.wire,/"finish_reason":"stop"/)
  assert.equal(result.wire.includes(PRIVATE),false)
}

test('GLM valid answer+finish+EOF generates terminal only at clean EOF and preserves Unicode',async()=>{
  const encoded=Buffer.from(answer+finish)
  for(const cut of [1,encoded.indexOf(0xf0)+1,encoded.length-1]){
    const result=await streamHarness([encoded.subarray(0,cut),encoded.subarray(cut)],{
      beforeEnd:wire=>assert.equal(wire.includes('data: [DONE]'),false),
    })
    assert.equal(result.outcome,'end')
    assert.match(result.wire,/완료 😀/)
    assert.match(result.wire,/"finish_reason":"stop"/)
    assert.match(result.wire,/data: \[DONE\]/)
  }
})
test('GLM partial EOF, premature close and abnormal intervention cannot be a successful stream',async()=>{
  noSuccess(await streamHarness([answer]))
  noSuccess(await streamHarness([answer],{mode:'close'}))
  noSuccess(await streamHarness([answer,sse({status:'intervene',last_error:{intervene_text:PRIVATE}})]))
})
test('GLM upstream error after finish, malformed JSON, invalid UTF8 all fail without normal DONE',async()=>{
  noSuccess(await streamHarness([answer,finish],{mode:'error'}))
  noSuccess(await streamHarness([answer,'data: {malformed}\n\n',finish]))
  noSuccess(await streamHarness([answer,'event: error\ndata: '+JSON.stringify({
    status:'finish',conversation_id:'synthetic-glm-id'})+'\n\n']))
  const bad=Buffer.concat([Buffer.from(answer),Buffer.from('data: '),
    Buffer.from([0xc3,0x28]),Buffer.from('\n\n'+finish)])
  noSuccess(await streamHarness([bad]))
  assert.equal(JSON.stringify(log).includes(PRIVATE),false)
})
test('GLM nonstream waits for clean EOF after finish, rather than an early success',async()=>{
  const completed=await nonstreamHarness([answer,finish],{
    beforeEnd:async history=>{
      await new Promise(resolve=>setImmediate(resolve))
      assert.deepEqual(history,[])
    },
  })
  assert.equal(completed.success,true)
  assert.equal(completed.body.choices[0].message.content,'완료 😀')
})
test('GLM nonstream rejects unconfirmed EOF, after-finish error and malformed message',async()=>{
  for(const parts of [[answer],[answer,'data: {oops}\n\n',finish]]) {
    const result=await nonstreamHarness(parts)
    assert.equal(result.success,false)
  }
  const late=await nonstreamHarness([answer,finish],{mode:'error'})
  assert.equal(late.success,false)
  const wrongEvent=await nonstreamHarness([answer,'event: error\ndata: '+JSON.stringify({
    status:'finish',conversation_id:'synthetic-glm-id'})+'\n\n'])
  assert.equal(wrongEvent.success,false)
  const closed=await nonstreamHarness([answer],{mode:'close'})
  assert.equal(closed.success,false)
})
