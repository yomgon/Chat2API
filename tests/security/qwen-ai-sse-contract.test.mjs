import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'

// Executes the real Qwen International SSE parser with synthetic chunks only.
// No user account, Electron, browser cookies, network or provider POST.
const root=fileURLToPath(new URL('../../',import.meta.url))
const source=file=>readFileSync(path.join(root,file),'utf8')
const requireNode=createRequire(import.meta.url)
const logs=[]
const silent=Object.fromEntries(['log','warn','error','info'].map(k=>[
  k,(...args)=>logs.push({level:k,args}),
]))
function load(){
  const relative='src/main/proxy/adapters/qwen-ai.ts'
  const transpiled=ts.transpileModule(source(relative),{fileName:relative,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},
    reportDiagnostics:true})
  assert.equal((transpiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0)
  const module={exports:{}}
  const allowed={
    '../../providers/qwenAiToken':QWEN_AI_TOKEN_MODULE,
    axios:{__esModule:true,default:{create:()=>({})}},
    stream:{PassThrough},
    'eventsource-parser':requireNode('eventsource-parser'),
    '../promptToolUse':{hasToolUse:()=>false,parseToolUse:()=>null},
  }
  vm.runInNewContext(transpiled.outputText,{module,exports:module.exports,
    require:name=>{
      if(Object.hasOwn(allowed,name))return allowed[name]
      throw new Error('Unexpected synthetic module '+name)
    },console:silent,Buffer,URL,Date,Error,setTimeout,clearTimeout},
  {filename:relative,timeout:1600})
  return module.exports.QwenAiStreamHandler
}
const Handler=load()
const event=data=>'data: '+JSON.stringify(data)+'\n\n'
const answer=(text,status='streaming')=>({choices:[{delta:{phase:'answer',status,content:text}}]})

test('Qwen AI nonstream requires finished answer and preserves UTF-8 split across arbitrary input chunks',async()=>{
  const h=new Handler('qwen3.7-plus')
  const upstream=new PassThrough()
  const pending=h.handleNonStream(upstream)
  const payload=Buffer.from(event(answer('안녕 😀', 'finished')),'utf8')
  for(const part of payload){upstream.write(Buffer.from([part]))}
  upstream.end()
  const reply=await pending
  assert.equal(reply.object,'chat.completion')
  assert.equal(reply.choices[0].message.content,'안녕 😀')
  assert.equal(reply.choices[0].finish_reason,'stop')
})

test('Qwen AI partial answer and bare DONE before finished both reject instead of synthesizing success',async()=>{
  for (const payload of [
    event(answer('partial without finish')),
    event(answer('partial without finish'))+'data: [DONE]\n\n',
    'data: [DONE]\n\n',
    '<html>challenge</html>',
  ]) {
    const h=new Handler('qwen3.7-plus')
    const upstream=new PassThrough()
    const pending=h.handleNonStream(upstream)
    upstream.end(payload)
    await assert.rejects(pending,/not confirmed/)
  }
})

test('Qwen AI SSE error envelope is not promoted to assistant answer or logged verbatim',async()=>{
  logs.length=0
  const h=new Handler('qwen3.7-plus')
  const upstream=new PassThrough()
  const pending=h.handleNonStream(upstream)
  upstream.end(event({error:{message:'PRIVATE_SYNTHETIC_TOKEN_SENTINEL'}}))
  const error=await pending.catch(e=>e)
  assert.match(error.message,/upstream returned a model error/)
  assert.doesNotMatch(error.message,/PRIVATE_SYNTHETIC/)
  assert.equal(JSON.stringify(logs).includes('PRIVATE_SYNTHETIC'),false)
})

test('Qwen AI streaming accepts one finished event and ends exactly once even after upstream closes',async()=>{
  const h=new Handler('qwen3.7-plus')
  const upstream=new PassThrough()
  const out=await h.handleStream(upstream)
  const chunks=[]
  out.on('data',b=>chunks.push(b.toString()))
  const ended=new Promise(resolve=>out.once('end',resolve))
  upstream.end(event(answer('Hello done','finished')))
  await ended
  assert.equal(h.hasSuccessfulTerminal(),true)
  assert.equal(chunks.join('').includes('Hello done'),true)
  assert.equal((chunks.join('').match(/data: \[DONE\]/g)||[]).length,1)
  assert.equal(chunks.join('').includes('"error"'),false)
})

test('Qwen AI streaming error and partial close emit a fixed error without normal DONE or false cleanup eligibility',async()=>{
  for(const payload of [
    event({error:{message:'PRIVATE_SYNTHETIC_TOKEN_SENTINEL'}}),
    event(answer('not final')),
  ]){
    const h=new Handler('qwen3.7-plus')
    const upstream=new PassThrough()
    const out=await h.handleStream(upstream)
    const chunks=[]
    out.on('data',b=>chunks.push(b.toString()))
    const ended=new Promise(resolve=>out.once('end',resolve))
    upstream.end(payload)
    await ended
    const text=chunks.join('')
    assert.equal(h.hasSuccessfulTerminal(),false)
    assert.equal(text.includes('"error"'),true)
    assert.equal(text.includes('data: [DONE]'),false)
    assert.equal(text.includes('PRIVATE_SYNTHETIC_TOKEN_SENTINEL'),false)
  }
})
