import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'

// This test exercises the actual Z.ai stream adapter with synthetic SSE only.
// No app, user profile, network, authorization, external service or live model.
const root = fileURLToPath(new URL('../../', import.meta.url))
const relative = 'src/main/proxy/adapters/zai.ts'
const source = readFileSync(new URL('../../src/main/proxy/adapters/zai.ts', import.meta.url), 'utf8')
const requireNode = createRequire(import.meta.url)
const PRIVATE = 'SYNTHETIC_PRIVATE_STREAM_ERROR_CANARY_LOCAL18'
const logs = []
let externalEffects = 0
const forbidden = () => { externalEffects++; throw new Error('Synthetic test forbids external effects') }
const fakeConsole = Object.fromEntries(['log','warn','error','info'].map(k => [
  k, (...args) => logs.push(args),
]))
const compiled = ts.transpileModule(source, {
  fileName: relative,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  reportDiagnostics: true,
})
assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
const module = { exports: {} }
vm.runInNewContext(compiled.outputText, {
  module, exports: module.exports,
  require(name) {
    const allowed = {
      axios: { __esModule:true, default:{get:forbidden,post:forbidden,delete:forbidden} },
      crypto: {}, stream: { PassThrough },
      'eventsource-parser': requireNode('eventsource-parser'),
      'form-data': { __esModule:true, default:class FormData {} },
      '../../oauth/zaiSession': {readZaiSessionClaims:forbidden,readZaiTokenIdentity:forbidden},
      '../promptToolUse': {hasToolUse:()=>false,parseToolUse:()=>null},
      '../utils/toolParser': {parseToolCallsFromText:()=>[]},
      '../utils/streamToolHandler': {
        createToolCallState:()=>({hasEmittedToolCall:false}),
        processStreamContent:()=>({chunks:[],shouldFlush:false}),
        flushToolCallBuffer:()=>[],
        createBaseChunk:()=>({}),
      },
    }
    if (Object.hasOwn(allowed,name)) return allowed[name]
    throw new Error('Unexpected synthetic module '+name)
  },
  Buffer, TextDecoder, Date, Error, URL, URLSearchParams,
  console:fakeConsole, setTimeout, clearTimeout,
}, { filename:relative, timeout:2000 })

const Handler = module.exports.ZaiStreamHandler
const evt = value => 'data: '+JSON.stringify(value)+'\n\n'
const message = data => ({type:'chat:completion',data})
const answer = content => evt(message({phase:'answer',role:'assistant',delta_content:content}))
const done = evt(message({phase:'done',done:true}))
const sentinel = 'data: [DONE]\n\n'

async function perform(chunks,{signal='end'}={}) {
  const handler=new Handler('local18-synthetic-model')
  handler.setChatId('synthetic-chat')
  const upstream=new EventEmitter()
  const output=await handler.handleStream(upstream)
  const emissions=[]
  output.on('data',chunk=>emissions.push(chunk.toString()))
  const ended=new Promise(resolve=>output.once('end',resolve))
  for(const part of chunks) upstream.emit('data',typeof part==='string'?Buffer.from(part):part)
  upstream.emit(signal,signal==='error'?new Error(PRIVATE):undefined)
  await ended
  return {handler,text:emissions.join('')}
}

function chunksFrom(text) {
  return text.split('data: ').filter(Boolean).map(s=>'data: '+s)
}

function assertSuccess(result, content) {
  const wire=result.text
  assert.equal((wire.match(/data: \[DONE\]/g)||[]).length,1)
  assert.equal(wire.includes('"error"'),false)
  const events=wire.split('\n\n').filter(Boolean).filter(x=>x.startsWith('data: {'))
    .map(x=>JSON.parse(x.slice(6)))
  assert.equal(events.some(x=>x.choices?.[0]?.delta?.content===content),true)
  assert.equal(events.some(x=>x.choices?.[0]?.finish_reason==='stop'),true)
}

function assertFailure(result) {
  assert.equal(result.text.includes('"error"'),true,'bad stream needs fixed error event')
  assert.equal(result.text.includes('data: [DONE]'),false,'bad stream cannot claim completion')
  assert.equal(result.text.includes('"finish_reason":"stop"'),false)
  assert.equal(result.text.includes(PRIVATE),false,'never forward provider secret/error')
}

test('valid upstream answer and phase done yields final content + exactly one true DONE',async()=>{
  assertSuccess(await perform([answer('Real synthetic answer'),done]),'Real synthetic answer')
})

test('valid answer and [DONE] sentinel supports an explicit upstream completion',async()=>{
  assertSuccess(await perform([answer('SSE sentinel answer'),sentinel]),'SSE sentinel answer')
})

test('OpenAI compatible choices deltas and finish_reason produce a complete answer',async()=>{
  const e1=evt({choices:[{index:0,delta:{role:'assistant',content:'Ready '},finish_reason:null}]})
  const e2=evt({choices:[{index:0,delta:{content:'and done'},finish_reason:'stop'}]})
  assertSuccess(await perform([e1,e2]),'Ready and done')
})

test('UTF-8 byte splits preserve Korean characters and emoji in true streaming API',async()=>{
  const expected='안녕하세요 😀'
  const bytes=Buffer.from(answer(expected)+sentinel,'utf8')
  for(const split of [1,2,3,4,bytes.indexOf(0xf0)+1,bytes.length-3]){
    if(split<1||split>=bytes.length)continue
    assertSuccess(await perform([bytes.subarray(0,split),bytes.subarray(split)]),expected)
  }
})

test('modern snapshot/UTF-16 edit replacement emits only final assembled content',async()=>{
  const replacement=evt(message({phase:'answer',content:'최종 문장😀'}))
  assertSuccess(await perform([
    answer('bad prefix'),
    evt(message({phase:'answer',edit_index:4,edit_content:' updated'})),
    replacement,done,
  ]),'최종 문장😀')
})

test('premature EOF or partial answer cannot emit fake normal DONE',async()=>{
  for(const chunks of [
    [answer('partial')],
    [answer('partial'),'data: {"type":"chat:completion"'],
    [answer('partial'),'data: [DONE]\n'],
  ]) assertFailure(await perform(chunks))
})

test('an upstream error envelope cannot be repaired by following done events',async()=>{
  const raw={error:{detail:PRIVATE},type:'chat:completion',data:{phase:'answer',delta_content:PRIVATE}}
  assertFailure(await perform([answer('partial'),evt(raw),done,sentinel]))
})

test('transport error after partial assistant output has fixed error, never DONE',async()=>{
  assertFailure(await perform([answer('partial')],{signal:'error'}))
})

test('no answer or thinking-only terminal cannot return successful stream',async()=>{
  for(const input of [[sentinel],[evt(message({phase:'thinking',delta_content:'thought'})),done]]) {
    assertFailure(await perform(input))
  }
})

test('synthetic execution never attempts network operations or logs private upstream values',()=>{
  assert.equal(externalEffects,0)
  assert.equal(JSON.stringify(logs).includes(PRIVATE),false)
})
