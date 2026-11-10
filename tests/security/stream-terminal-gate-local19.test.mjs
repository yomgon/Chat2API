import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual product terminal gate with in-memory synthetic streams.
// No app/profile/credential/network or real provider call is ever permitted.
const relative='src/main/proxy/streamTerminalGate.ts'
const root=fileURLToPath(new URL('../../',import.meta.url))
const source=readFileSync(new URL('../../src/main/proxy/streamTerminalGate.ts',import.meta.url),'utf8')
const compiler=ts.transpileModule(source,{
  fileName:relative,
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},
  reportDiagnostics:true,
})
assert.equal(compiler.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0)
const module={exports:{}}
const requireNode=createRequire(import.meta.url)
const logs=[]
vm.runInNewContext(compiler.outputText,{
  module,exports:module.exports,
  require:name=>{
    if(name==='stream')return requireNode('node:stream')
    throw Error('Unauthorized test import: '+name)
  },
  Buffer,TextDecoder,Date,Error,console:Object.fromEntries(['log','warn','error','info'].map(k=>[
    k,(...args)=>logs.push({level:k,args}),
  ])),
}, {filename:relative,timeout:2000})
const {createOpenAIStreamTerminalGate,hasCompletedNonStreamAnswer}=module.exports

const PRIVATE='SYNTHETIC_PRIVATE_BEARER_COOKIE_UPSTREAM_ERROR_LOCAL19'
const event=obj=>'data: '+JSON.stringify(obj)+'\n\n'
const chunk=(delta={},finish_reason=null)=>event({id:'synthetic',model:'synthetic',
  object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})
const done='data: [DONE]\n\n'
const finish=chunk({},'stop')
const text=t=>chunk({role:'assistant',content:t})

async function harness(pieces,{mode='end',onAfterWrite}={}){
  const src=new PassThrough()
  const terminal=[]
  const gated=createOpenAIStreamTerminalGate(src,outcome=>terminal.push(outcome))
  const received=[]
  gated.on('data',b=>received.push(b.toString('utf8')))
  const completed=new Promise(resolve=>gated.once('end',resolve))
  for(const piece of pieces){
    src.write(typeof piece==='string'?Buffer.from(piece):piece)
  }
  if(typeof onAfterWrite==='function')onAfterWrite(received.join(''))
  if(mode==='error')src.emit('error',Object.assign(new Error(PRIVATE),{
    config:{headers:{Authorization:PRIVATE}},response:{data:{secret:PRIVATE}},
  }))
  else if(mode==='close')src.destroy()
  else src.end()
  await completed
  return {wire:received.join(''),terminal}
}
function assertFail(result){
  assert.equal(result.terminal.length,1)
  assert.equal(result.terminal[0],false)
  assert.match(result.wire,/"error"/)
  assert.doesNotMatch(result.wire,/data: \[DONE\]/)
  assert.doesNotMatch(result.wire,/"finish_reason":"stop"/)
  assert.equal(result.wire.includes(PRIVATE),false)
}
function assertPass(result){
  assert.deepEqual(result.terminal,[true])
  assert.equal((result.wire.match(/data: \[DONE\]/g)||[]).length,1)
  assert.doesNotMatch(result.wire,/"error"/)
  assert.match(result.wire,/"finish_reason":"stop"/)
}

test('completed assistant answer + upstream stop + done is confirmed only after actual EOF',async()=>{
  const outcome=await harness([text('hello accepted'),finish,done],{
    onAfterWrite:wire=>{
      assert.match(wire,/hello accepted/)
      assert.equal(wire.includes('data: [DONE]'),false,'do not publish DONE before EOF')
      assert.equal(wire.includes('"finish_reason":"stop"'),false,'defer final chunk until EOF')
    },
  })
  assertPass(outcome)
})
test('UTF-8 Korean and emoji survive every byte boundary',async()=>{
  const content='안녕 😀'
  const bytes=Buffer.from(text(content)+finish+done)
  for(const split of [1,2,3,9,bytes.indexOf(0xf0)+1,bytes.length-2]){
    if(split>0&&split<bytes.length){
      const result=await harness([bytes.subarray(0,split),bytes.subarray(split)])
      assertPass(result)
      assert.equal(result.wire.includes(content),true)
    }
  }
})
test('thinking-only, empty answer and premature close cannot be counted',async()=>{
  for(const parts of [
    [chunk({reasoning_content:'private reasoning'}),finish,done],
    [chunk({content:'   '}),finish,done],
    [text('partial')],
    [text('partial'),finish],
    [done],
  ]) assertFail(await harness(parts))
  assertFail(await harness([text('partial')],{mode:'close'}))
})
test('error after an apparently complete stop/done revokes outcome; no fake DONE',async()=>{
  assertFail(await harness([text('partial'),finish,done,
    event({error:{message:PRIVATE},status:401}),]))
  assertFail(await harness([text('partial'),finish,done],{mode:'error'}))
})
test('error envelope is fixed and redacted; failed source never becomes normal completion',async()=>{
  assertFail(await harness([text('partial'),event({error:{private:PRIVATE}})]))
  assertFail(await harness([text('partial')],{mode:'error'}))
  assert.equal(JSON.stringify(logs).includes(PRIVATE),false)
})
test('invalid UTF-8, malformed JSON and oversized SSE frame fail closed',async()=>{
  const badUtf8=Buffer.concat([Buffer.from('data: {"choices":[{"delta":{"content":"'),Buffer.from([0xc3,0x28]),
    Buffer.from('"}}]}\n\n')])
  assertFail(await harness([badUtf8]))
  assertFail(await harness([text('partial'),'data: {notjson}\n\n',finish,done]))
  assertFail(await harness(['data: '+('X'.repeat(1024*1024+10))]))
})
test('unrecognized event errors and duplicate terminal marker fail closed',async()=>{
  assertFail(await harness([text('partial'),finish,done,done]))
  assertFail(await harness([text('partial'),'event: error\ndata: '+JSON.stringify({message:PRIVATE})+'\n\n',finish,done]))
})
test('native streamed tool-call response can finish without text only when call exists',async()=>{
  const call=chunk({role:'assistant',tool_calls:[{index:0,id:'synthetic-call',type:'function',
    function:{name:'safe_tool',arguments:'{}'}}]})
  const end=chunk({},'tool_calls')
  const out=await harness([call,end,done])
  assert.equal(out.terminal[0],true)
  assert.match(out.wire,/"finish_reason":"tool_calls"/)
  assert.equal((out.wire.match(/data: \[DONE\]/g)||[]).length,1)
  const bad=await harness([chunk({role:'assistant'}),end,done])
  assertFail(bad)
})
test('source ending after [DONE] with extra unfinished SSE event rejects success',async()=>{
  assertFail(await harness([text('partial'),finish,done,'data: {']))
})
test('nonstream requires completed assistant response; HTTP200 alone is not evidence',()=>{
  const proper={object:'chat.completion',choices:[{index:0,finish_reason:'stop',
    message:{role:'assistant',content:'Confirmed model answer'}}]}
  assert.equal(hasCompletedNonStreamAnswer(proper),true)
  const error={error:{message:PRIVATE}}
  for(const bad of [
    null,{},error,{choices:[]},
    {choices:[{finish_reason:'stop',message:{role:'assistant',content:''}}]},
    {choices:[{finish_reason:'stop',message:{role:'user',content:'not assistant'}}]},
    {choices:[{finish_reason:null,message:{role:'assistant',content:'not finished'}}]},
    {choices:[{finish_reason:'stop',message:{role:'assistant',content:'   '}}]},
    {choices:[{finish_reason:'stop',message:{role:'assistant',content:PRIVATE,error:true}}]},
  ]) assert.equal(hasCompletedNonStreamAnswer(bad),false)
  assert.equal(hasCompletedNonStreamAnswer({choices:[{finish_reason:'tool_calls',
    message:{role:'assistant',content:null,tool_calls:[
      {id:'call-1',type:'function',function:{name:'safe_tool',arguments:'{}'}}]}}]}),true)
})

test('non-assistant stream role and mismatched finish reason cannot impersonate a completion',async()=>{
  for (const role of ['system','user','tool']) {
    assertFail(await harness([chunk({role,content:'not an assistant reply'}),finish,done]))
  }
  assertFail(await harness([text('text only'),chunk({},'tool_calls'),done]))
  assertFail(await harness([chunk({tool_calls:[{index:0,function:{arguments:'{}'}}]}),
    chunk({},'tool_calls'),done]))
  const textOnlyToolAnswer={choices:[{finish_reason:'tool_calls',
    message:{role:'assistant',content:'not a tool call'}}]}
  assert.equal(hasCompletedNonStreamAnswer(textOnlyToolAnswer),false)
  const incompleteCall={choices:[{finish_reason:'tool_calls',message:{role:'assistant',
    content:null,tool_calls:[{type:'function',function:{arguments:'{}'}}]}}]}
  assert.equal(hasCompletedNonStreamAnswer(incompleteCall),false)
})

test('valid incrementally emitted tool call and final OpenAI usage event are supported',async()=>{
  const tool=chunk({role:'assistant',tool_calls:[{index:0,id:'call-1',type:'function',
    function:{name:'lookup',arguments:''}}]})
  const args=chunk({tool_calls:[{index:0,function:{arguments:'{}'}}]})
  const usage=event({id:'synthetic',object:'chat.completion.chunk',choices:[],
    usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})
  const r=await harness([tool,args,chunk({},'tool_calls'),usage,done])
  assert.equal(r.terminal[0],true)
  assert.equal((r.wire.match(/data: \[DONE\]/g)||[]).length,1)
  assert.match(r.wire,/"total_tokens":5/)
})

test('malformed SSE event names and non-assistant choice envelopes fail closed',async()=>{
  const wrongEvent='event: exception\\ndata: '+JSON.stringify({choices:[{index:0,
    delta:{role:'assistant',content:'looks valid'},finish_reason:null}]})+'\\n\\n'
  assertFail(await harness([wrongEvent,finish,done]))
  const wrongIndex=event({object:'chat.completion.chunk',choices:[{index:3,
    delta:{role:'assistant',content:'invalid index'},finish_reason:null}]})
  assertFail(await harness([wrongIndex,finish,done]))
})

test('explicit tool calls require an identifiable stable tool-call ID in both OpenAI modes',async()=>{
  assert.equal(hasCompletedNonStreamAnswer({choices:[{finish_reason:'tool_calls',
    message:{role:'assistant',content:null,tool_calls:[{
      type:'function',function:{name:'lookup',arguments:'{}'},
    }]}}]}),false)
  assertFail(await harness([chunk({role:'assistant',tool_calls:[{index:0,type:'function',
    function:{name:'lookup',arguments:'{}'}}]}),chunk({},'tool_calls'),done]))
  const valid=await harness([chunk({role:'assistant',tool_calls:[{
    index:0,id:'call-1',type:'function',function:{name:'lookup',arguments:'{}'},
  }]}),chunk({},'tool_calls'),done])
  assert.equal(valid.terminal[0],true)
})

test('nested assistant/tool error envelopes must not be forwarded as normal answer',async()=>{
  const nested=chunk({role:'assistant',content:'looks completed',error:{token:PRIVATE}})
  assertFail(await harness([nested,finish,done]))
  const message=event({id:'synthetic',object:'chat.completion.chunk',choices:[{
    index:0,message:{role:'assistant',content:'valid',error:{private:PRIVATE}},finish_reason:null,
  }]})
  assertFail(await harness([message,finish,done]))
  const valid={choices:[{finish_reason:'stop',message:{
    role:'assistant',content:'valid',
  }}],type:'error'}
  assert.equal(hasCompletedNonStreamAnswer(valid),false)
  const choiceError={choices:[{finish_reason:'stop',error:{token:PRIVATE},
    message:{role:'assistant',content:'valid'}}]}
  assert.equal(hasCompletedNonStreamAnswer(choiceError),false)
})

test('malformed upstream frame closes the downstream gate without waiting on an unended source',async()=>{
  const source=new PassThrough()
  const settled=[]
  const gate=createOpenAIStreamTerminalGate(source,result=>settled.push(result))
  const chunks=[]
  const ended=new Promise(resolve=>gate.on('end',resolve))
  gate.on('data',chunk=>chunks.push(chunk.toString()))
  source.write('data: {"error":{"detail":"'+PRIVATE+'"}}\n\n')
  await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>{
    reject(new Error('Gate remained open after a malformed frame'))
  },250))])
  assert.equal(source.destroyed,true)
  assert.deepEqual(settled,[false])
  assert.doesNotMatch(chunks.join(''),/data: \[DONE\]/)
  assert.equal(chunks.join('').includes(PRIVATE),false)
})
