import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// The real adapter implementation runs against synthetic in-memory transport.
// No Electron, profile, credential, HTTP, provider POST, or retry may be used.
const source=readFileSync(new URL('../../src/main/proxy/adapters/deepseek-stream.ts',import.meta.url),'utf8')
const code=ts.transpileModule(source,{fileName:'deepseek-stream.ts',compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,
}}).outputText
const requireNode=createRequire(import.meta.url)
const logs=[]
const mod={exports:{}}
vm.runInNewContext(code,{module:mod,exports:mod.exports,Buffer,TextDecoder,Date,Error,
  require(name){
    if(name==='stream')return requireNode('node:stream')
    if(name==='../utils/toolParser.ts')return {parseToolCallsFromText:content=>({content,toolCalls:[]})}
    if(name==='../toolCalling/ToolStreamParser.ts')return {ToolStreamParser:class{}}
    throw Error('Unexpected module '+name)
  },
  console:{log:()=>{},warn:()=>{},error:(...args)=>logs.push(args)},
},{filename:'deepseek-stream.ts',timeout:2000})
const {DeepSeekStreamHandler}=mod.exports
const PRIVATE='SYNTHETIC_DEEPSEEK_UNSAFE_ERROR_BODY_LOCAL19'
const message=t=>'data: '+JSON.stringify({p:'response/fragments',v:[{type:'ANSWER',content:t}]})+'\n\n'
const done='data: [DONE]\n\n'

async function streamHarness(pieces,{mode='end'}={}){
  const src=new PassThrough()
  const handler=new DeepSeekStreamHandler('deepseek-chat','local19-synthetic-session')
  const converted=await handler.handleStream(src)
  const chunks=[]
  const settled=new Promise(resolve=>{
    converted.on('data',c=>chunks.push(c.toString()))
    converted.once('end',()=>resolve('end'))
    converted.once('error',()=>resolve('error'))
  })
  for(const piece of pieces)src.write(piece)
  if(mode==='error')src.emit('error',Object.assign(new Error(PRIVATE),{config:{token:PRIVATE}}))
  else if(mode==='close')src.destroy()
  else src.end()
  const outcome=await Promise.race([settled,new Promise(resolve=>setTimeout(()=>resolve('timeout'),150))])
  return {wire:chunks.join(''),outcome}
}
async function nonstreamHarness(pieces,{mode='end'}={}){
  const src=new PassThrough()
  const handler=new DeepSeekStreamHandler('deepseek-chat','local19-synthetic-session')
  const result=handler.handleNonStream(src).then(body=>({success:true,body}),
    error=>({success:false,error:String(error?.message??'error')}))
  for(const piece of pieces)src.write(piece)
  if(mode==='error')src.emit('error',new Error(PRIVATE))
  else if(mode==='close')src.destroy()
  else src.end()
  return await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),150))])
}
const assertFailedWire=x=>{
  assert.equal(x.outcome,'end')
  assert.doesNotMatch(x.wire,/data: \[DONE\]/)
  assert.doesNotMatch(x.wire,/"finish_reason":"stop"/)
  assert.doesNotMatch(x.wire,new RegExp(PRIVATE))
}

test('DeepSeek stream succeeds for answer + explicit DONE + clean EOF, including UTF8 splits',async()=>{
  const bytes=Buffer.from(message('완료 😀')+done)
  for(const split of [1,9,bytes.indexOf(0xf0)+1,bytes.length-3]){
    const x=await streamHarness([bytes.subarray(0,split),bytes.subarray(split)])
    assert.equal(x.outcome,'end')
    assert.match(x.wire,/data: \[DONE\]/)
    assert.match(x.wire,/완료 😀/)
    assert.match(x.wire,/"finish_reason":"stop"/)
  }
})
test('DeepSeek stream never fabricates DONE for missing explicit terminal or partial close',async()=>{
  assertFailedWire(await streamHarness([message('partial')]))
  assertFailedWire(await streamHarness([message('partial')],{mode:'close'}))
})
test('DeepSeek stream does not convert late upstream error into success',async()=>{
  assertFailedWire(await streamHarness([message('partial'),done],{mode:'error'}))
  assert.equal(JSON.stringify(logs).includes(PRIVATE),false)
})
test('DeepSeek stream malformed JSON and invalid UTF8 cannot recover with a later DONE',async()=>{
  assertFailedWire(await streamHarness([message('prefix'),'data: {invalid}\n\n',done]))
  const corrupt=Buffer.concat([Buffer.from(message('prefix')),Buffer.from('data: '),
    Buffer.from([0xc3,0x28]),Buffer.from('\n\n'+done)])
  assertFailedWire(await streamHarness([corrupt]))
})
test('DeepSeek nonstream requires explicit completion; partial EOF and malformed events reject',async()=>{
  const good=await nonstreamHarness([message('confirmed')+done])
  assert.equal(good.success,true)
  assert.equal(good.body.choices[0].message.content,'confirmed')
  for(const parts of [[message('partial')],[message('partial'),'data: {bad}\n\n',done]]) {
    const result=await nonstreamHarness(parts)
    assert.equal(result.success,false)
  }
  const providerError=await nonstreamHarness([message('apparently valid'),
    'data: '+JSON.stringify({error:{code:'SYNTHETIC_FAILED_OPERATION'}})+'\n\n',done])
  assert.equal(providerError.success,false,'error followed by DONE must not recover')
  const malformedUtf8=Buffer.concat([Buffer.from(message('prefix')),
    Buffer.from('data: '),Buffer.from([0xc3,0x28]),Buffer.from('\n\n'+done)])
  assert.equal((await nonstreamHarness([malformedUtf8])).success,false)
  const closed=await nonstreamHarness([message('partial')],{mode:'close'})
  assert.equal(closed.success,false)
})
