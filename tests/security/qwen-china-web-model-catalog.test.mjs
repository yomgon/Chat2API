import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQwenChinaWebModelCatalog } from '../../src/main/providers/qwenChinaModelCatalog.ts'

const actualPublic = () => ({
  trace_id: 'synthetic-trace', code: 0, httpCode: 200, msg: 'success', success: true,
  data: [
    { displayModelName: 'Qwen-快速 ', modelCode: 'Qwen', legacyModelCode: 'Qwen', show: true, defaultModel: true },
    { displayModelName: 'Qwen3.7-Max', modelCode: 'tongyi-qwen37-max-model', legacyModelCode: 'tongyi-qwen3-max-model', show: true, defaultModel: false },
  ],
})
const clone = v => structuredClone(v)
const fails = v => assert.throws(() => parseQwenChinaWebModelCatalog(v),
  err => err instanceof Error && err.message === 'Qwen China website model catalog is invalid or unsupported.' && err.cause === undefined)

test('The observed first-party response uses modelCode and trims only web labels', () => {
  const source = actualPublic()
  const before = clone(source)
  assert.deepEqual(parseQwenChinaWebModelCatalog(source), {
    supportedModels: ['Qwen-快速', 'Qwen3.7-Max'],
    modelMappings: { 'Qwen-快速': 'Qwen', 'Qwen3.7-Max': 'tongyi-qwen37-max-model' },
  })
  assert.deepEqual(source, before)
})

test('Hidden rows cannot be advertised and never fall back to legacy model ID', () => {
  const x = actualPublic()
  x.data.push({displayModelName:'Hidden preview',modelCode:'hidden-model',show:false})
  assert.equal(parseQwenChinaWebModelCatalog(x).supportedModels.length, 2)
  x.data[0].show = false
  x.data[1].show = false
  fails(x)
})

test('Non-success business status and missing website fields reject without writes', () => {
  for (const v of [
    null, undefined, false, [], 'bad',
    { code: 10001, success: false, msg: 'ut' },
    { ...actualPublic(), code: 2 },
    { ...actualPublic(), success: false },
    { ...actualPublic(), data: [] },
    { ...actualPublic(), data: {} },
  ]) fails(v)
  for (const field of ['displayModelName', 'modelCode', 'show']) {
    const x=actualPublic()
    delete x.data[0][field]
    fails(x)
  }
})

test('Control characters, bad IDs, prototype attacks and duplicates fail closed', () => {
  for (const mutate of [
    x=>{x.data[0].modelCode='https://attacker.invalid'},
    x=>{x.data[0].modelCode='constructor'},
    x=>{x.data[0].displayModelName='Bad\nName'},
    x=>{x.data[0].displayModelName='  '},
    x=>{x.data[0].show='true'},
    x=>{x.data[1].modelCode=x.data[0].modelCode},
    x=>{x.data[1].displayModelName=x.data[0].displayModelName},
    x=>{Object.defineProperty(x.data[0], '__proto__', {value:{polluted:true},enumerable:true})},
    x=>{delete x.data[1]},
    x=>{x.data=Array.from({length:201},(_,i)=>({displayModelName:'Model'+i,modelCode:'model'+i,show:true}))},
  ]) { const x=actualPublic(); mutate(x); fails(x) }
})
