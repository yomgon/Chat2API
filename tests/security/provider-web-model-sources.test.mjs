import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  parseMimoWebChatCatalog,
  parseKimiWebChatCatalog,
} from '../../src/main/providers/webModelSourceParsers.ts'

const ERROR_MESSAGE = 'Web chat model catalog is invalid or unsupported.'
const MIMO_CHAT = [
  { model: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash' },
  { model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
  { model: 'mimo-v2.6-pro-ultraspeed-studio', name: 'MiMo-V2.6-Pro-UltraSpeed' },
]
const KIMI_CHAT = {
  id: 'k2d6-chat', key: 'k2d6', displayName: 'Instant', scenario: 'SCENARIO_CHAT',
}
const KIMI_AGENTS = [
  { id: 'k3-agent', key: 'k3', displayName: 'K3', scenario: 'SCENARIO_OK_COMPUTER' },
  { id: 'k28-agent-preview', key: 'k28-preview', displayName: 'K2.8 Preview', scenario: 'SCENARIO_OK_COMPUTER' },
]

function mimo(rows = MIMO_CHAT) {
  return { code: 0, data: { modelConfigList: structuredClone(rows) } }
}

function kimi(rows = [...KIMI_AGENTS, KIMI_CHAT]) {
  return { availableModels: structuredClone(rows), defaultChatModel: 'k3-agent' }
}

function expected(rows, idField, nameField) {
  return {
    supportedModels: rows.map(row => row[nameField]),
    modelMappings: Object.fromEntries(rows.map(row => [row[nameField], row[idField]])),
  }
}

function reject(parse, payload, forbidden = []) {
  let caught
  try {
    parse(payload)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.message, ERROR_MESSAGE)
  assert.equal(caught.cause, undefined)
  assert.deepEqual(Object.getOwnPropertyNames(caught).sort(), ['message', 'stack'])
  const rendered = inspect(caught, { showHidden: true })
  for (const value of forbidden) {
    assert.equal(rendered.includes(value), false, 'Error must not expose input or backend text')
  }
}

function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeData)
    Object.freeze(value)
  }
  return value
}

const SOURCES = [
  {
    parse: parseMimoWebChatCatalog,
    wrap: rows => ({ data: { modelConfigList: rows } }),
    row: () => ({ ...MIMO_CHAT[0] }),
    id: 'model',
    name: 'name',
  },
  {
    parse: parseKimiWebChatCatalog,
    wrap: rows => ({ availableModels: rows }),
    row: () => ({ ...KIMI_CHAT }),
    id: 'id',
    name: 'displayName',
  },
]

test('MiMo supplied catalog selects the complete v2.6 chat group in website order', () => {
  const payload = mimo([
    { model: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
    ...MIMO_CHAT,
    { model: 'mimo-v2.5', name: 'MiMo-V2.5' },
    { model: 'mimo-v2-flash', name: 'MiMo-V2-Flash' },
    { model: 'mimo-v9.0-tts', name: 'MiMo TTS' },
    { model: 'mimo-v9.0-asr', name: 'MiMo ASR' },
    { model: 'mimo-v9.0-agent', name: 'MiMo Agent' },
  ])
  // The separate Ng list is not an alternative chat source or a merge input.
  payload.data.modelConfigListNg = [...MIMO_CHAT, { model: 'mimo-v99.0-pro', name: 'Ng only' }]
  assert.deepEqual(parseMimoWebChatCatalog(payload), expected(MIMO_CHAT, 'model', 'name'))
})

test('MiMo real legacy display-name duplicates do not invalidate the latest chat generation', () => {
  const payload = mimo([
    { model: 'mimo-v2.5', name: 'mimo-omni' },
    { model: 'mimo-v2-omni', name: 'mimo-omni' },
    { model: 'mimo-v2-flash', name: 'mimo-flash' },
    { model: 'mimo-v2-flash-studio', name: 'mimo-flash' },
    ...MIMO_CHAT,
  ])
  assert.deepEqual(parseMimoWebChatCatalog(payload), expected(MIMO_CHAT, 'model', 'name'))
})

test('MiMo permits absent code or numeric zero and rejects error/falsy status variants', () => {
  const payload = mimo()
  delete payload.code
  assert.deepEqual(parseMimoWebChatCatalog(payload), expected(MIMO_CHAT, 'model', 'name'))
  for (const code of [undefined, null, false, true, '0', 1, -1, {}, []]) {
    reject(parseMimoWebChatCatalog, { ...payload, code })
  }
})

test('MiMo compares major/minor integers instead of decimal fractions or strings', () => {
  const generations = [
    ['mimo-v2.9-pro', 'mimo-v2.10-flash'],
    ['mimo-v2.99-pro', 'mimo-v3.0-pro'],
    ['mimo-v2-flash', 'mimo-v2.1-flash'],
    ['mimo-v9007199254740992.1-pro', 'mimo-v9007199254740993.1-pro'],
  ]
  for (const [older, latest] of generations) {
    const rows = [{ model: older, name: 'Older' }, { model: latest, name: 'Latest' }]
    assert.deepEqual(parseMimoWebChatCatalog(mimo(rows)), {
      supportedModels: ['Latest'], modelMappings: { Latest: latest },
    })
  }
})

test('MiMo keeps original casing, names, and supported legacy unsuffixed family IDs', () => {
  const rows = [
    { model: 'mimo-v2-flash', name: 'Old model with misleading V99 label' },
    { model: 'MiMo-v2.5', name: 'Website label' },
    { model: 'MIMO-v2.5-PRO', name: '另一显示名' },
  ]
  assert.deepEqual(parseMimoWebChatCatalog(mimo(rows)), expected(rows.slice(1), 'model', 'name'))
})

test('MiMo unverified suffixes and non-chat modes never choose a newer generation', () => {
  const excluded = ['tts', 'asr', 'agent', 'pro-agent', 'pro-ultraspeed', 'flash-tts', 'unknown']
    .map(suffix => ({ model: 'mimo-v99.0-' + suffix, name: 'Excluded ' + suffix }))
  assert.deepEqual(parseMimoWebChatCatalog(mimo([...excluded, ...MIMO_CHAT])),
    expected(MIMO_CHAT, 'model', 'name'))
  reject(parseMimoWebChatCatalog, mimo(excluded))
})

test('MiMo noncanonical leading-zero generations fail instead of silently using older chat', () => {
  for (const model of ['mimo-v02.6-pro', 'mimo-v2.06-pro', 'mimo-v00-pro']) {
    reject(parseMimoWebChatCatalog, mimo([...MIMO_CHAT, { model, name: 'Ambiguous version' }]))
  }
})

test('MiMo requires the primary nested list and never falls back to Ng', () => {
  for (const data of [
    {}, { modelConfigListNg: MIMO_CHAT },
    { modelConfigList: [], modelConfigListNg: MIMO_CHAT },
    { modelConfigList: null, modelConfigListNg: MIMO_CHAT },
    { modelConfigList: { models: MIMO_CHAT } },
  ]) reject(parseMimoWebChatCatalog, { data })
  reject(parseMimoWebChatCatalog, { modelConfigList: MIMO_CHAT })
  reject(parseMimoWebChatCatalog, MIMO_CHAT)
})

test('MiMo validates malformed older and excluded entries before returning any chat models', () => {
  for (const bad of [
    { model: 'mimo-v2.5-pro', name: '' },
    { model: 'mimo-v99.0-tts', name: 123 },
    { model: null, name: 'Agent' },
    { model: 'mimo-v99.0-agent', name: 'Agent\nprivate' },
  ]) reject(parseMimoWebChatCatalog, mimo([...MIMO_CHAT, bad]))
})

test('Kimi returns exact Instant to k2d6-chat mapping and excludes agent modes', () => {
  assert.deepEqual(parseKimiWebChatCatalog(kimi()), {
    supportedModels: ['Instant'],
    modelMappings: { Instant: 'k2d6-chat' },
  })
})

test('Kimi key and defaultChatModel do not replace IDs or promote agent entries', () => {
  const payload = kimi([
    ...KIMI_AGENTS,
    KIMI_CHAT,
    { id: 'OpaqueChat_V2', key: 'k2d6', displayName: 'Another chat', scenario: 'SCENARIO_CHAT' },
  ])
  assert.deepEqual(parseKimiWebChatCatalog(payload), {
    supportedModels: ['Instant', 'Another chat'],
    modelMappings: { Instant: 'k2d6-chat', 'Another chat': 'OpaqueChat_V2' },
  })
  payload.defaultChatModel = 'not-in-catalog'
  assert.equal(parseKimiWebChatCatalog(payload).modelMappings.Instant, 'k2d6-chat')
  delete payload.availableModels[2].key
  assert.equal(parseKimiWebChatCatalog(payload).modelMappings.Instant, 'k2d6-chat')
})

test('Kimi requires exact SCENARIO_CHAT and fails if every entry is unsupported', () => {
  const unsupported = ['SCENARIO_OK_COMPUTER', 'SCENARIO_CHAT_AGENT', 'SCENARIO_FUTURE']
    .map((scenario, index) => ({ id: 'mode-' + index, displayName: 'Mode ' + index, scenario }))
  assert.deepEqual(parseKimiWebChatCatalog(kimi([...unsupported, KIMI_CHAT])),
    expected([KIMI_CHAT], 'id', 'displayName'))
  reject(parseKimiWebChatCatalog, kimi(unsupported))
  reject(parseKimiWebChatCatalog, kimi(KIMI_AGENTS))
})

test('Kimi missing ID/displayName cannot fall back to key, name, or a default', () => {
  for (const row of [
    { key: 'k2d6', displayName: 'Instant', scenario: 'SCENARIO_CHAT' },
    { id: null, key: 'k2d6', displayName: 'Instant', scenario: 'SCENARIO_CHAT' },
    { id: 'k2d6-chat', name: 'Instant', scenario: 'SCENARIO_CHAT' },
    { id: 'k2d6-chat', displayName: 'Instant' },
  ]) reject(parseKimiWebChatCatalog, kimi([row]))
  reject(parseKimiWebChatCatalog, { data: kimi() })
  reject(parseKimiWebChatCatalog, { defaultChatModel: 'k2d6-chat' })
})

test('Kimi validates excluded agent entries and optional keys before filtering', () => {
  for (const row of [
    { ...KIMI_AGENTS[0], id: false },
    { ...KIMI_AGENTS[0], displayName: {} },
    { ...KIMI_AGENTS[0], scenario: null },
    { ...KIMI_AGENTS[0], key: 123 },
    { ...KIMI_AGENTS[0], key: 'https://example.invalid/private' },
    { ...KIMI_CHAT, scenario: 'scenario_chat' },
    { ...KIMI_CHAT, scenario: 'SCENARIO_CHAT\n' },
  ]) reject(parseKimiWebChatCatalog, kimi([row, KIMI_CHAT]))
})

test('both parsers reject invalid roots, nested containers, and primitive entries without coercion', () => {
  let conversions = 0
  const coercible = { toString() { conversions++; return 'synthetic-model' } }
  const primitives = [undefined, null, false, 0, NaN, 1n, Symbol('model'), 'model', [], new Date(), new Map(), coercible]
  for (const source of SOURCES) {
    for (const value of primitives) {
      reject(source.parse, value)
      reject(source.parse, source.wrap([value]))
      // A string is invalid as a whole entry but can be a valid explicit ID.
      if (typeof value !== 'string') {
        reject(source.parse, source.wrap([{ ...source.row(), [source.id]: value }]))
      }
    }
  }
  for (const data of [null, [], false, 'data', new Date()]) reject(parseMimoWebChatCatalog, { data })
  assert.equal(conversions, 0)
})

test('the 200-entry limit applies before filtering excluded modes or old generations', () => {
  const mimoRows = Array.from({ length: 200 }, (_, index) => ({
    model: 'mimo-v1.' + index + '-pro', name: 'Generation ' + index,
  }))
  assert.deepEqual(parseMimoWebChatCatalog(mimo(mimoRows)), expected(mimoRows.slice(-1), 'model', 'name'))
  reject(parseMimoWebChatCatalog, mimo([...mimoRows, ...MIMO_CHAT]))

  const agentRows = Array.from({ length: 199 }, (_, index) => ({
    id: 'agent-' + index, displayName: 'Agent ' + index, scenario: 'SCENARIO_OK_COMPUTER',
  }))
  assert.deepEqual(parseKimiWebChatCatalog(kimi([...agentRows, KIMI_CHAT])),
    expected([KIMI_CHAT], 'id', 'displayName'))
  reject(parseKimiWebChatCatalog, kimi([...agentRows, KIMI_CHAT, {
    id: 'agent-extra', displayName: 'Agent extra', scenario: 'SCENARIO_OK_COMPUTER',
  }]))
  for (const source of SOURCES) reject(source.parse, source.wrap([]))
})

test('160-character names and IDs are preserved, while 161 characters fail', () => {
  const longName = '모'.repeat(160)
  const longIds = ['mimo-v' + '9'.repeat(148) + '.1-pro', 'm' + 'x'.repeat(159)]
  for (const [index, source] of SOURCES.entries()) {
    const id = longIds[index]
    assert.equal(id.length, 160)
    const row = { ...source.row(), [source.id]: id, [source.name]: longName }
    assert.deepEqual(source.parse(source.wrap([row])), {
      supportedModels: [longName], modelMappings: { [longName]: id },
    })
    reject(source.parse, source.wrap([{ ...row, [source.id]: id + 'x' }]))
    reject(source.parse, source.wrap([{ ...row, [source.name]: longName + '모' }]))
  }
})

test('IDs reject controls, whitespace, URLs, paths, reserved names, and coercible values', () => {
  const invalid = [
    '', ' model', 'model ', 'model name', 'model\n', 'model\0', 'model\u202e',
    'https://example.invalid/model', '//example.invalid', 'www.example.invalid',
    'javascript:alert(1)', 'file:///C:/model', 'namespace/model', 'model?private',
    'model#private', '../model', '.model', 'model%2fother', 'model:latest', '모델',
    '__proto__', 'constructor', 'prototype', 'Constructor', new String('model'),
  ]
  for (const source of SOURCES) {
    for (const id of invalid) reject(source.parse, source.wrap([{ ...source.row(), [source.id]: id }]))
  }
})

test('names reject hidden characters, padding, invalid types, and dangerous mapping keys', () => {
  const invalid = [
    undefined, null, 123, [], {}, '', ' label', 'label ', 'line\nbreak', 'line\rbreak',
    'tab\tlabel', 'null\0label', 'delete\u007f', 'next\u0085', 'bidi\u202e',
    'zero\u200b', 'separator\u2028', 'paragraph\u2029', 'isolated\ud800',
    '__proto__', 'constructor', 'prototype', 'PROTOTYPE',
  ]
  for (const source of SOURCES) {
    for (const name of invalid) reject(source.parse, source.wrap([{ ...source.row(), [source.name]: name }]))
  }
})

test('duplicates are rejected in selected MiMo chat models and the Kimi source catalog', () => {
  for (const source of SOURCES) {
    const row = source.row()
    reject(source.parse, source.wrap([row, { ...row }]))
    reject(source.parse, source.wrap([row, { ...row, [source.name]: 'Different name' }]))
  }
  reject(parseMimoWebChatCatalog, mimo([
    { model: 'mimo-v2.6-pro', name: 'Same label' },
    { model: 'mimo-v2.6-flash', name: 'Same label' },
  ]))
  reject(parseKimiWebChatCatalog, kimi([...KIMI_AGENTS, KIMI_CHAT, KIMI_AGENTS[0]]))
  reject(parseKimiWebChatCatalog, kimi([
    KIMI_CHAT, { id: 'other-chat', displayName: 'Instant', scenario: 'SCENARIO_CHAT' },
  ]))
})

test('aliases cannot shadow another selected model ID in either order', () => {
  const pairs = [
    [parseMimoWebChatCatalog, mimo([
      { model: 'mimo-v2.6-flash', name: 'mimo-v2.6-pro' },
      { model: 'mimo-v2.6-pro', name: 'Pro' },
    ])],
    [parseKimiWebChatCatalog, kimi([
      { ...KIMI_CHAT, displayName: 'other-chat' },
      { id: 'other-chat', displayName: 'Other', scenario: 'SCENARIO_CHAT' },
    ])],
  ]
  for (const [parse, payload] of pairs) {
    reject(parse, payload)
    const rows = payload.availableModels ?? payload.data.modelConfigList
    rows.reverse()
    reject(parse, payload)
  }
})

test('prototype pollution and inherited model properties are rejected without global changes', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype)
  for (const source of SOURCES) {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const row = source.row()
      Object.defineProperty(row, key, { enumerable: true, value: { polluted: true } })
      reject(source.parse, source.wrap([row]))
      const root = source.wrap([source.row()])
      Object.defineProperty(root, key, { enumerable: true, value: { polluted: true } })
      reject(source.parse, root)
    }
    reject(source.parse, source.wrap([Object.create(source.row())]))
  }
  const data = JSON.parse('{"modelConfigList":[],"__proto__":{"polluted":true}}')
  reject(parseMimoWebChatCatalog, { data })
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before)
})

test('null-prototype JSON-like objects and arrays remain supported', () => {
  for (const source of SOURCES) {
    const row = Object.assign(Object.create(null), source.row())
    const rows = [row]
    Object.setPrototypeOf(rows, null)
    const payload = source.wrap(rows)
    Object.setPrototypeOf(payload, null)
    if (payload.data) Object.setPrototypeOf(payload.data, null)
    assert.deepEqual(source.parse(payload), expected([row], source.id, source.name))
  }
})

test('sparse arrays, custom iterators, and known-field accessors are rejected without execution', () => {
  let effects = 0
  const getter = { enumerable: true, get() { effects++; throw new Error('synthetic-private-response') } }
  for (const source of SOURCES) {
    const sparse = new Array(2)
    sparse[0] = source.row()
    reject(source.parse, source.wrap(sparse))
    const rows = [source.row()]
    rows[Symbol.iterator] = function* () { effects++; yield source.row() }
    reject(source.parse, source.wrap(rows))
    const accessorRows = [source.row()]
    Object.defineProperty(accessorRows, '0', getter)
    reject(source.parse, source.wrap(accessorRows))
    for (const field of [source.id, source.name]) {
      const row = source.row()
      Object.defineProperty(row, field, getter)
      reject(source.parse, source.wrap([row]))
    }
  }
  for (const field of ['key', 'scenario']) {
    const row = { ...KIMI_AGENTS[0] }
    Object.defineProperty(row, field, getter)
    reject(parseKimiWebChatCatalog, { availableModels: [row, KIMI_CHAT] })
  }
  for (const [parse, payload, field] of [
    [parseMimoWebChatCatalog, {}, 'data'],
    [parseMimoWebChatCatalog, mimo(), 'code'],
    [parseKimiWebChatCatalog, {}, 'availableModels'],
  ]) {
    Object.defineProperty(payload, field, getter)
    reject(parse, payload)
  }
  assert.equal(effects, 0)
})

test('unused Ng, defaultChatModel, and unrelated metadata are never read or copied', () => {
  let reads = 0
  const getter = { enumerable: true, get() { reads++; throw new Error('synthetic-private-metadata') } }
  const mimoPayload = mimo()
  Object.defineProperty(mimoPayload.data, 'modelConfigListNg', getter)
  const kimiPayload = kimi()
  Object.defineProperty(kimiPayload, 'defaultChatModel', getter)
  Object.defineProperty(kimiPayload.availableModels[2], 'info', getter)
  assert.deepEqual(parseMimoWebChatCatalog(mimoPayload), expected(MIMO_CHAT, 'model', 'name'))
  assert.deepEqual(parseKimiWebChatCatalog(kimiPayload), expected([KIMI_CHAT], 'id', 'displayName'))
  assert.equal(reads, 0)
})

test('success and late malformed entries preserve frozen input and return independent outputs', () => {
  for (const source of SOURCES) {
    const payload = freezeData(source.wrap([source.row()]))
    const snapshot = structuredClone(payload)
    const first = source.parse(payload)
    const second = source.parse(payload)
    assert.notEqual(first.supportedModels, second.supportedModels)
    assert.notEqual(first.modelMappings, second.modelMappings)
    first.modelMappings[first.supportedModels[0]] = 'output-only'
    first.supportedModels.pop()
    assert.deepEqual(second, expected([source.row()], source.id, source.name))
    assert.deepEqual(payload, snapshot)
    const invalid = freezeData(source.wrap([source.row(), { ...source.row(), [source.id]: false }]))
    const invalidSnapshot = structuredClone(invalid)
    reject(source.parse, invalid)
    assert.deepEqual(invalid, invalidSnapshot)
    assert.deepEqual(source.parse(payload), second)
  }
})

test('errors stay fixed and redacted with no console, stream output, or error coercion', context => {
  const output = []
  const intercepted = [
    ...['log', 'info', 'warn', 'error', 'debug', 'trace'].map(method =>
      context.mock.method(console, method, (...args) => { output.push(args) })),
    context.mock.method(process.stdout, 'write', (...args) => { output.push(args); return true }),
    context.mock.method(process.stderr, 'write', (...args) => { output.push(args); return true }),
  ]
  const marker = 'synthetic-private-response-DO-NOT-LOG'
  let conversions = 0
  const unsafeError = { message: marker, cause: marker, toString() { conversions++; return marker } }
  const throwing = new Proxy({}, { getPrototypeOf() { throw unsafeError } })
  try {
    parseMimoWebChatCatalog(mimo())
    parseKimiWebChatCatalog(kimi())
    for (const source of SOURCES) {
      reject(source.parse, source.wrap([{ ...source.row(), [source.id]: 'https://example.invalid/' + marker }]), [marker])
      reject(source.parse, source.wrap([{ ...source.row(), [source.name]: marker + '\n' }]), [marker])
      reject(source.parse, throwing, [marker])
    }
  } finally {
    intercepted.forEach(method => method.mock.restore())
  }
  assert.equal(conversions, 0)
  assert.deepEqual(output, [])
})
