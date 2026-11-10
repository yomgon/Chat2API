import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// Runs the real Kimi Connect streaming handler against synthetic in-memory
// binary framing; never accesses accounts, Electron, a socket, or an API.
const root=fileURLToPath(new URL('../../',import.meta.url))
const source=name=>readFileSync(path.join(root,name),'utf8')
const logged=[]
const fakeConsole=Object.fromEntries(['log','warn','error','info'].map(level=>[
  level,(...args)=>logged.push({level,args}),
]))
function load(relative, deps){
  const result=ts.transpileModule(source(relative),{fileName:relative,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},
    reportDiagnostics:true})
  assert.equal((result.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0)
  const module={exports:{}}
  vm.runInNewContext(result.outputText,{module,exports:module.exports,
    require:id=>{
      if(Object.hasOwn(deps,id))return deps[id]
      throw new Error('Unexpected fixture dependency '+id)
    },Buffer,URL,Date,Error,console:fakeConsole,setTimeout,clearTimeout},
  {filename:relative,timeout:1400})
  return module.exports
}
const protocol=load('src/main/proxy/adapters/providerModelOptions.ts',{})
const { KimiStreamHandler }=load('src/main/proxy/adapters/kimi.ts',{
  axios:{__esModule:true,default:{}},stream:{PassThrough},
  '../utils/tools':{hasToolPromptInjected:()=>false,toolsToSystemPrompt:()=>'',TOOL_WRAP_HINT:''},
  '../utils/toolParser':{parseToolCallsFromText:content=>({content,toolCalls:[]})},
  '../utils/streamToolHandler':{createBaseChunk:(id,model,created)=>({id,model,created,
    object:'chat.completion.chunk'})},
  './providerModelOptions':protocol,
  '../toolCalling/providerProfiles':{getProviderToolProfile:()=>({})},
  '../toolCalling/ToolStreamParser':{ToolStreamParser:class{}},
})

function frame(flag,payload){
  const bytes=Buffer.from(JSON.stringify(payload),'utf8')
  const result=Buffer.alloc(5+bytes.length)
  result.writeUInt8(flag,0)
  result.writeUInt32BE(bytes.length,1)
  bytes.copy(result,5)
  return result
}
function msg(content,op='append'){
  return {op,mask:'block.text.content',block:{text:{content,flags:'answer'}}}
}

test('Kimi nonstream waits for Connect terminal 0x02 before accepting complete answer', async()=>{
  const h=new KimiStreamHandler('k2d6-chat','')
  const upstream=new PassThrough()
  let settled=false
  const promise=h.handleNonStream(upstream).then(value=>{settled=true;return value})
  const one=frame(0,msg('Safe '))
  upstream.write(one.subarray(0,3))
  upstream.write(one.subarray(3))
  upstream.write(frame(0,msg('answer')))
  upstream.write(frame(0,{done:true}))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(settled,false,'an application done event is not Connect terminal proof')
  upstream.end(frame(2,{}))
  const reply=await promise
  assert.equal(reply.object,'chat.completion')
  assert.equal(reply.choices[0].message.content,'Safe answer')
  assert.equal(h.hasSessionError(),false)
})

test('HTTP200 Kimi terminal permission denial after data.done rejects with fixed status and no secret leak',async()=>{
  logged.length=0
  const h=new KimiStreamHandler('k2d6-chat','')
  const upstream=new PassThrough()
  const pending=h.handleNonStream(upstream)
  upstream.write(frame(0,msg('not final')))
  upstream.write(frame(0,{done:true}))
  upstream.end(frame(2,{error:{code:'permission_denied',
    message:'PRIVATE_TOKEN_NOT_FOR_OUTPUT'}}))
  const error=await pending.catch(e=>e)
  assert.equal(error.upstreamStatus,403)
  assert.equal(h.hasSessionError(),true)
  assert.equal(error.message.includes('PRIVATE_TOKEN_NOT_FOR_OUTPUT'),false)
  assert.equal(JSON.stringify(logged).includes('PRIVATE_TOKEN_NOT_FOR_OUTPUT'),false)
})

test('Kimi unknown Connect error maps to 502 and raw error is not reflected',async()=>{
  const h=new KimiStreamHandler('k2d6-chat','')
  const upstream=new PassThrough()
  const pending=h.handleNonStream(upstream)
  upstream.end(frame(2,{error:{code:'private-unrecognized',message:'PRIVATE_PAYLOAD'}}))
  const error=await pending.catch(e=>e)
  assert.equal(error.upstreamStatus,502)
  assert.equal(error.message.includes('PRIVATE_PAYLOAD'),false)
})

test('Kimi close without terminal, unsupported compressed flag and invalid JSON fail closed',async()=>{
  for (const kind of ['close','unsupported-flag','invalid-json']) {
    const h=new KimiStreamHandler('k2d6-chat','')
    const upstream=new PassThrough()
    const pending=h.handleNonStream(upstream)
    if (kind==='close') upstream.end(frame(0,msg('partial answer')))
    else if(kind==='unsupported-flag') upstream.end(frame(1,msg('should reject')))
    else {
      const b=Buffer.from('NOT JSON')
      const invalid=Buffer.alloc(5+b.length)
      invalid.writeUInt8(0,0)
      invalid.writeUInt32BE(b.length,1)
      b.copy(invalid,5)
      upstream.end(invalid)
    }
    await assert.rejects(pending)
    assert.equal(h.hasSessionError(),true)
  }
})

test('Kimi streaming output emits stop/[DONE] only after valid terminal; error trailer never becomes assistant text',async()=>{
  const success=new KimiStreamHandler('k2d6-chat','')
  const a=new PassThrough()
  const output=await success.handleStream(a)
  const chunks=[]
  output.on('data',buf=>chunks.push(buf.toString()))
  const end=new Promise(resolve=>output.once('end',resolve))
  a.write(frame(0,msg('valid stream')))
  a.write(frame(0,{done:true}))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(chunks.join('').includes('data: [DONE]'),false)
  assert.equal(success.hasSuccessfulTerminal(),false)
  a.end(frame(2,{}))
  await end
  assert.equal(success.hasSuccessfulTerminal(),true)
  assert.equal(chunks.join('').includes('data: [DONE]'),true)

  const failure=new KimiStreamHandler('k2d6-chat','')
  const b=new PassThrough()
  const errOutput=await failure.handleStream(b)
  const errChunks=[]
  errOutput.on('data',buf=>errChunks.push(buf.toString()))
  const errEnd=new Promise(resolve=>errOutput.once('end',resolve))
  b.write(frame(0,msg('partial but not complete')))
  b.write(frame(0,{done:true}))
  b.end(frame(2,{error:{code:'unauthenticated',message:'PRIVATE_TOKEN_UNSAFE'}}))
  await errEnd
  const result=errChunks.join('')
  assert.equal(failure.hasSessionError(),true)
  assert.equal(failure.hasSuccessfulTerminal(),false)
  assert.equal(result.includes('PRIVATE_TOKEN_UNSAFE'),false)
  assert.equal(result.includes('"error"'),true)
  assert.equal(result.includes('data: [DONE]'),false)
})
