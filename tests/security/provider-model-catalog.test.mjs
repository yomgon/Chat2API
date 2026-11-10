import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { parseProviderModelCatalog } from '../../src/main/providers/modelCatalog.ts'

const ERROR_MESSAGE = 'Provider model catalog is invalid or unsupported.'
const PROVIDERS = ['deepseek', 'glm', 'kimi', 'minimax', 'mimo', 'perplexity', 'qwen', 'qwen-ai', 'zai']

// Shape supplied by Prime after its public endpoint inspection. These are
// catalog identifiers only; this test never requests a website or uses an account.
const QWEN_CATALOG = {
  data: [
    { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', info: { is_active: true } },
    { id: 'qwen3.8-max', name: 'Qwen3.8-Max', info: { is_active: true } },
    { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash', info: { is_active: true } },
  ],
}
const QWEN_RESULT = {
  supportedModels: ['Qwen3.7-Plus', 'Qwen3.8-Max', 'Qwen3.8-Omni-Flash'],
  modelMappings: {
    'Qwen3.7-Plus': 'qwen3.7-plus',
    'Qwen3.8-Max': 'qwen3.8-max',
    'Qwen3.8-Omni-Flash': 'qwen3.8-omni-flash',
  },
}

function reject(payload, providerId, forbidden = []) {
  if (arguments.length < 2) providerId = 'qwen-ai'
  let caught
  try {
    parseProviderModelCatalog(providerId, payload)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.message, ERROR_MESSAGE)
  assert.equal(caught.cause, undefined)
  assert.deepEqual(Object.getOwnPropertyNames(caught).sort(), ['message', 'stack'])
  const rendered = inspect(caught, { showHidden: true })
  for (const value of forbidden) {
    assert.equal(rendered.includes(value), false, 'Parser errors must not expose response data')
  }
}

function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeData)
    Object.freeze(value)
  }
  return value
}

test('the observed Qwen response shape preserves exact web IDs and excludes metadata', () => {
  const payload = freezeData(structuredClone(QWEN_CATALOG))
  const snapshot = structuredClone(payload)
  const result = parseProviderModelCatalog('qwen-ai', payload)
  assert.deepEqual(result, QWEN_RESULT)
  assert.deepEqual(payload, snapshot)
  assert.deepEqual(Object.keys(result).sort(), ['modelMappings', 'supportedModels'])
  assert.equal(JSON.stringify(result).includes('is_active'), false)
})

test('top-level, data, and models arrays support explicit ID aliases and display labels', () => {
  const rows = [
    { id: 'Web_ID.v1', name: 'Website model' },
    { model_id: 'raw-UUID_2', display_name: '표시 모델 (생각)' },
    { id: '003' },
  ]
  const expected = {
    supportedModels: ['Website model', '표시 모델 (생각)', '003'],
    modelMappings: {
      'Website model': 'Web_ID.v1',
      '표시 모델 (생각)': 'raw-UUID_2',
      '003': '003',
    },
  }
  for (const payload of [rows, { data: rows, object: 'list' }, { models: rows, success: true }]) {
    assert.deepEqual(parseProviderModelCatalog('glm', payload), expected)
  }
})

test('all nine built-in provider IDs use the same pure parsing contract', () => {
  for (const providerId of PROVIDERS) {
    assert.deepEqual(parseProviderModelCatalog(providerId, [{ id: 'Web_Model_01', name: 'Visible model' }]), {
      supportedModels: ['Visible model'],
      modelMappings: { 'Visible model': 'Web_Model_01' },
    })
  }
})

test('string entries are explicit IDs and are never normalized or lowercased', () => {
  assert.deepEqual(parseProviderModelCatalog('qwen', ['Qwen', 'GLM-5v-Turbo', '001', 'web_model.v2']), {
    supportedModels: ['Qwen', 'GLM-5v-Turbo', '001', 'web_model.v2'],
    modelMappings: { Qwen: 'Qwen', 'GLM-5v-Turbo': 'GLM-5v-Turbo', '001': '001', 'web_model.v2': 'web_model.v2' },
  })
})

test('display_name wins over name while matching ID fields retain the original ID', () => {
  assert.deepEqual(parseProviderModelCatalog('qwen', [{
    id: 'Opaque_Web_ID',
    model_id: 'Opaque_Web_ID',
    name: 'Marketing name',
    display_name: 'Visible label',
  }]), {
    supportedModels: ['Visible label'],
    modelMappings: { 'Visible label': 'Opaque_Web_ID' },
  })
})

test('marketing names cannot manufacture model IDs', () => {
  for (const payload of [
    [{ name: 'Qwen 3.8 Max' }],
    [{ name: 'qwen3.8-max' }],
    [{ display_name: 'Qwen3.8-Max' }],
    [{ name: 'Qwen3.8-Max', display_name: 'Qwen3.8 Max' }],
  ]) reject(payload)
  assert.deepEqual(parseProviderModelCatalog('qwen', [{ id: 'Qwen', name: 'Qwen3.8-Max' }]), {
    supportedModels: ['Qwen3.8-Max'],
    modelMappings: { 'Qwen3.8-Max': 'Qwen' },
  })
})

test('malformed ID or label fields cannot fall back to another otherwise valid field', () => {
  for (const value of [undefined, null, false, 0, 42, NaN, {}, [], new String('model-one')]) {
    reject([{ id: value, model_id: 'model-one', name: 'Visible model' }])
    reject([{ id: 'model-one', model_id: value, name: 'Visible model' }])
    reject([{ id: 'model-one', name: value, display_name: 'Visible model' }])
    reject([{ id: 'model-one', name: 'Visible model', display_name: value }])
  }
  reject([{ id: 'model-one', model_id: 'model-two', name: 'Visible model' }])
})

test('absent, competing, nested, or malformed envelopes never yield a partial catalog', () => {
  const rows = [{ id: 'model-one' }]
  for (const payload of [
    undefined, null, '', '[]', 0, 1, true, false, NaN, 1n, Symbol('catalog'),
    () => rows, new Date(), new Map(), new String('catalog'), {},
    { data: null }, { models: null }, { data: {} }, { models: 'model-one' },
    { data: { models: rows } }, { result: rows },
    { data: rows, models: rows }, { data: [], models: rows },
    { data: undefined, models: rows }, { data: 'invalid', models: rows },
  ]) reject(payload)
})

test('primitive and non-record entries are rejected without coercion', () => {
  let conversions = 0
  const withCoercion = { toString() { conversions++; return 'model-one' } }
  class Model { constructor() { this.id = 'model-one' } }
  for (const entry of [
    undefined, null, false, true, 0, 42, NaN, Infinity, 1n, Symbol('model'),
    [], ['model-one'], new Date(), new Map(), new String('model-one'),
    () => 'model-one', new Model(), withCoercion,
  ]) {
    reject([entry])
    reject([{ id: entry, name: 'Visible model' }])
  }
  assert.equal(conversions, 0)
})

test('empty catalogs and more than 200 entries are rejected instead of truncated', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: 'web-' + index }))
  assert.equal(parseProviderModelCatalog('kimi', rows).supportedModels.length, 200)
  for (const payload of [[], { data: [] }, { models: [] }, [...rows, { id: 'web-200' }]]) {
    reject(payload)
  }
})

test('160-character ID and display-name boundaries are enforced without truncation', () => {
  const id = 'm' + 'x'.repeat(159)
  const name = '모'.repeat(160)
  assert.deepEqual(parseProviderModelCatalog('mimo', [{ id, display_name: name }]), {
    supportedModels: [name],
    modelMappings: { [name]: id },
  })
  reject([{ id: id + 'x' }])
  reject([{ id: 'web-one', name: name + '모' }])
  reject([{ id: 'web-one', display_name: name + '모' }])
})

test('IDs reject whitespace, controls, URLs, paths, and unsafe punctuation', () => {
  const invalid = [
    '', ' model', 'model ', 'model name', 'model\n', 'model\r\n',
    'mo\tdel', 'model\0', 'model\u007f', 'model\u0085', 'model\u202e',
    'https://example.invalid/model', 'http://example.invalid', '//example.invalid/model',
    'www.example.invalid', 'javascript:alert(1)', 'data:text/plain,model', 'file:///C:/model',
    'namespace/model', '../model', '..', '.model', 'model?token=private', 'model#private',
    'model%2Fother', 'model:latest', 'C:\\model', 'model@host', '<model>', '모델',
  ]
  for (const id of invalid) {
    reject([id])
    reject([{ id }])
    reject([{ model_id: id, display_name: 'Visible model' }])
  }
})

test('display labels reject empty, padded, excessive, and hidden control text', () => {
  for (const label of [
    '', ' label', 'label ', '\tlabel', 'line\nbreak', 'line\rbreak',
    'null\0label', 'delete\u007f', 'next\u0085', 'bidi\u202e', 'zero\u200b',
    'separator\u2028', 'paragraph\u2029', 'isolated\ud800',
  ]) {
    reject([{ id: 'web-one', name: label }])
    reject([{ id: 'web-one', display_name: label }])
  }
})

test('duplicate IDs, duplicate labels, and conflicting label-to-ID aliases are rejected', () => {
  for (const rows of [
    ['web-one', 'web-one'],
    [{ id: 'web-one', name: 'One' }, { id: 'web-one', name: 'Two' }],
    [{ id: 'web-one', name: 'Same' }, { id: 'web-two', name: 'Same' }],
    [{ id: 'web-one', display_name: 'Same' }, { model_id: 'web-two', name: 'Same' }],
    [{ id: 'web-one', name: 'web-two' }, { id: 'web-two', name: 'Two' }],
    [{ id: 'web-one', name: 'One' }, { id: 'web-two', name: 'web-one' }],
    [{ id: 'web-one', name: 'web-two' }, { id: 'web-two', name: 'web-one' }],
  ]) {
    reject(rows)
    reject([...rows].reverse())
  }
})

test('prototype-sensitive labels and IDs are rejected in every recognized field', () => {
  for (const text of ['__proto__', 'constructor', 'prototype', 'Constructor', 'PROTOTYPE']) {
    reject([text])
    reject([{ id: text }])
    reject([{ model_id: text }])
    reject([{ id: 'web-one', name: text }])
    reject([{ id: 'web-one', display_name: text }])
  }
})

test('own pollution keys, inherited fields, and custom prototypes are rejected', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype)
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const envelope = JSON.parse('{"data":[{"id":"web-one"}],"' + key + '":{"polluted":true}}')
    const entry = JSON.parse('{"id":"web-one","' + key + '":{"polluted":true}}')
    reject(envelope)
    reject([entry])
  }
  reject(Object.create({ data: [{ id: 'web-one' }] }))
  reject([Object.create({ id: 'web-one' })])
  reject([{ __proto__: { polluted: true }, id: 'web-one' }])
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before)
})

test('plain data with a null prototype remains supported', () => {
  const record = Object.assign(Object.create(null), { id: 'web-one', name: 'One' })
  const rows = [record]
  Object.setPrototypeOf(rows, null)
  const payload = Object.assign(Object.create(null), { data: rows })
  const result = parseProviderModelCatalog('deepseek', payload)
  assert.deepEqual(result, { supportedModels: ['One'], modelMappings: { One: 'web-one' } })
  assert.equal(Object.getPrototypeOf(result.modelMappings), Object.prototype)
})

test('sparse arrays and arrays with extra properties are malformed', () => {
  const sparse = new Array(2)
  sparse[0] = { id: 'web-one' }
  const extra = [{ id: 'web-one' }]
  extra.metadata = 'not JSON array data'
  const symbol = [{ id: 'web-one' }]
  symbol[Symbol('private')] = true
  let iterations = 0
  const iterator = [{ id: 'web-one' }]
  iterator[Symbol.iterator] = function* () { iterations++; yield { id: 'web-two' } }
  for (const rows of [sparse, extra, symbol, iterator]) reject(rows)
  assert.equal(iterations, 0)
})

test('known-field accessors and hidden properties are rejected without evaluating getters', () => {
  let reads = 0
  const getter = { enumerable: true, get() { reads++; throw new Error('synthetic-private-response') } }
  for (const key of ['data', 'models']) {
    const payload = {}
    Object.defineProperty(payload, key, getter)
    reject(payload)
  }
  for (const key of ['id', 'model_id', 'name', 'display_name']) {
    const entry = { id: 'web-one' }
    Object.defineProperty(entry, key, getter)
    reject([entry])
  }
  const rows = [{ id: 'web-one' }]
  Object.defineProperty(rows, '0', getter)
  reject(rows)
  const hidden = {}
  Object.defineProperty(hidden, 'id', { value: 'web-one' })
  reject([hidden])
  assert.equal(reads, 0)
})

test('unused metadata is neither evaluated nor returned', () => {
  let reads = 0
  const entry = { id: 'web-one', name: 'One' }
  Object.defineProperty(entry, 'info', {
    enumerable: true,
    get() { reads++; throw new Error('synthetic-private-metadata') },
  })
  const result = parseProviderModelCatalog('qwen-ai', { data: [entry] })
  assert.deepEqual(result, { supportedModels: ['One'], modelMappings: { One: 'web-one' } })
  assert.equal(reads, 0)
})

test('unknown or non-string provider IDs fail before payload access', () => {
  let reads = 0
  const payload = {}
  Object.defineProperty(payload, 'data', { enumerable: true, get() { reads++; return ['web-one'] } })
  for (const id of [
    undefined, null, 0, {}, [], new String('qwen-ai'), '',
    'Qwen-ai', 'qwen-ai ', 'custom', '__proto__', 'constructor', 'prototype',
    'https://example.invalid', 'synthetic-private-provider',
  ]) reject(payload, id)
  assert.equal(reads, 0)
})

test('successful and failed parses leave originals unchanged and calls have independent outputs', () => {
  const payload = freezeData(structuredClone(QWEN_CATALOG))
  const snapshot = structuredClone(payload)
  const first = parseProviderModelCatalog('qwen-ai', payload)
  const second = parseProviderModelCatalog('qwen-ai', payload)
  assert.notEqual(first, second)
  assert.notEqual(first.supportedModels, second.supportedModels)
  assert.notEqual(first.modelMappings, second.modelMappings)
  first.supportedModels.pop()
  first.modelMappings['Qwen3.8-Max'] = 'changed-output-only'
  assert.deepEqual(second, QWEN_RESULT)
  assert.deepEqual(payload, snapshot)

  const invalid = freezeData({ data: [...structuredClone(QWEN_CATALOG.data), { id: false }] })
  const invalidSnapshot = structuredClone(invalid)
  reject(invalid)
  assert.deepEqual(invalid, invalidSnapshot)
  assert.deepEqual(parseProviderModelCatalog('qwen-ai', payload), QWEN_RESULT)
})

test('all failures use the same redacted Error without logging, output, or cause coercion', context => {
  const output = []
  const intercepted = [
    ...['log', 'info', 'warn', 'error', 'debug', 'trace'].map(method =>
      context.mock.method(console, method, (...args) => { output.push(args) })),
    context.mock.method(process.stdout, 'write', (...args) => { output.push(args); return true }),
    context.mock.method(process.stderr, 'write', (...args) => { output.push(args); return true }),
  ]
  const marker = 'synthetic-private-response-DO-NOT-LOG'
  let conversions = 0
  const unsafeError = {
    message: marker,
    cause: marker,
    toString() { conversions++; return marker },
  }
  const throwingPayload = new Proxy({}, { getPrototypeOf() { throw unsafeError } })
  try {
    assert.deepEqual(parseProviderModelCatalog('qwen-ai', QWEN_CATALOG), QWEN_RESULT)
    reject([{ id: 'https://example.invalid/' + marker }], 'qwen-ai', [marker])
    reject([{ id: 'web-one', display_name: marker + '\n' }], 'qwen-ai', [marker])
    reject(QWEN_CATALOG, marker, [marker])
    reject(throwingPayload, 'qwen-ai', [marker])
  } finally {
    intercepted.forEach(method => method.mock.restore())
  }
  assert.equal(conversions, 0)
  assert.deepEqual(output, [])
})
