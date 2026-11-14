import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  encodeConfigSecrets,
  decodeConfigSecrets,
  hasUnprotectedConfigSecrets,
  redactExportConfigSecrets,
} from '../../src/main/store/configSecrets.ts'

const API_KEY = 'sk-' + 'Ab09'.repeat(12)
const SECOND_API_KEY = 'sk-' + 'Zx81'.repeat(12)
const MANAGEMENT_HEX = 'sk-mgmt-' + 'aB09'.repeat(8)
const MANAGEMENT_UUID = 'mgmt_01234567-89ab-4def-8123-456789abcdef'
const INVALID_ERROR = 'Configuration secret data is invalid or unsupported.'
const ENCRYPT_ERROR = 'Configuration secrets could not be encrypted. No configuration changes were made.'
const DECRYPT_ERROR = 'Configuration secrets could not be decrypted. No configuration changes were made.'

function fixture(keys = [API_KEY], managementSecret = MANAGEMENT_HEX) {
  return {
    proxyHost: '127.0.0.1',
    proxyPort: 3000,
    theme: 'dark',
    enableApiKey: true,
    autoStartProxy: false,
    modelMappings: { example: { providers: ['offline-fixture'] } },
    requestLogConfig: { enabled: false, retentionDays: 3 },
    apiKeys: keys.map((key, index) => ({
      id: 'test-key-' + index,
      name: 'Offline key ' + index,
      key,
      enabled: index === 0,
      createdAt: 123,
      usageCount: index,
      description: 'Keep this metadata',
    })),
    managementApi: {
      enableManagementApi: true,
      managementApiSecret: managementSecret,
      managementApiPort: 3001,
    },
  }
}

function marked(value) {
  return 'safeStorage:v1:' + Buffer.from(value).toString('base64')
}

// An in-memory mapping models the caller's synchronous OS codec. The helper is
// imported directly; no Electron, real key store, user data, or network is used.
function codec() {
  const values = new Map()
  return {
    encrypt(value) {
      const ciphertext = marked('offline-ciphertext-' + values.size)
      values.set(ciphertext, value)
      return ciphertext
    },
    decrypt(value) {
      if (!values.has(value)) throw new Error('Synthetic corrupt ciphertext: ' + value)
      return values.get(value)
    },
  }
}

function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeData)
    Object.freeze(value)
  }
  return value
}

function expectRedactedError(run, message, forbidden = []) {
  let caught
  try {
    run()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.message, message)
  assert.equal(caught.cause, undefined)
  assert.deepEqual(Object.getOwnPropertyNames(caught).sort(), ['message', 'stack'])
  const rendered = inspect(caught, { showHidden: true })
  for (const value of forbidden) {
    assert.equal(rendered.includes(value), false, 'Error must not contain secret material')
  }
  return caught
}

test('roundtrip protects every secret and preserves settings, metadata, and original data', () => {
  const original = freezeData(fixture([API_KEY, SECOND_API_KEY]))
  const snapshot = structuredClone(original)
  const os = codec()
  const encoded = encodeConfigSecrets(original, os.encrypt)

  assert.deepEqual(original, snapshot)
  assert.notEqual(encoded, original)
  assert.notEqual(encoded.apiKeys, original.apiKeys)
  assert.notEqual(encoded.apiKeys[0], original.apiKeys[0])
  assert.notEqual(encoded.managementApi, original.managementApi)
  assert.equal(encoded.apiKeys[0].description, original.apiKeys[0].description)
  assert.deepEqual(encoded.modelMappings, original.modelMappings)
  assert.deepEqual(encoded.requestLogConfig, original.requestLogConfig)
  for (const secret of [API_KEY, SECOND_API_KEY, MANAGEMENT_HEX]) {
    assert.equal(JSON.stringify(encoded).includes(secret), false)
  }
  assert.equal(hasUnprotectedConfigSecrets(encoded), false)

  freezeData(encoded)
  const encodedSnapshot = structuredClone(encoded)
  const decoded = decodeConfigSecrets(encoded, os.decrypt)
  assert.deepEqual(decoded, snapshot)
  assert.deepEqual(encoded, encodedSnapshot)
  assert.notEqual(decoded.apiKeys[0], encoded.apiKeys[0])
  assert.notEqual(decoded.managementApi, encoded.managementApi)
  assert.equal(hasUnprotectedConfigSecrets(decoded), true)
})

test('legacy migration accepts GUI and management-issued proxy API keys plus management secrets', () => {
  for (const managementSecret of [
    MANAGEMENT_HEX,
    MANAGEMENT_UUID,
    'mgmt_01234567-89AB-CDEF-0123-456789ABCDEF',
  ]) {
    for (const key of [API_KEY, MANAGEMENT_HEX]) {
      const original = fixture([key], managementSecret)
      assert.equal(hasUnprotectedConfigSecrets(original), true)
      const legacy = decodeConfigSecrets(original, () => assert.fail('Plain legacy data needs no decryption'))
      assert.deepEqual(legacy, original)
      const os = codec()
      const encoded = encodeConfigSecrets(legacy, os.encrypt)
      assert.equal(hasUnprotectedConfigSecrets(encoded), false)
      assert.deepEqual(decodeConfigSecrets(encoded, os.decrypt), original)
    }
  }
})

test('empty fields and an empty key array are allowed without codec calls', () => {
  for (const original of [fixture([], ''), fixture([''], '')]) {
    const unused = () => assert.fail('Empty fields need no codec')
    assert.equal(hasUnprotectedConfigSecrets(original), false)
    assert.deepEqual(encodeConfigSecrets(original, unused), original)
    assert.deepEqual(decodeConfigSecrets(original, unused), original)
  }
  const decoded = decodeConfigSecrets(fixture([marked('empty-key')], ''), () => '')
  assert.equal(decoded.apiKeys[0].key, '')
})

test('already marked ciphertext is not double encrypted and mixed data migrates only raw values', () => {
  const os = codec()
  const protectedKey = os.encrypt(API_KEY)
  const original = fixture([protectedKey, SECOND_API_KEY], '')
  const seen = []
  const encoded = encodeConfigSecrets(original, value => {
    seen.push(value)
    return os.encrypt(value)
  })
  assert.deepEqual(seen, [SECOND_API_KEY])
  assert.equal(encoded.apiKeys[0].key, protectedKey)
  assert.deepEqual(
    encodeConfigSecrets(encoded, () => assert.fail('Do not encrypt ciphertext twice')),
    encoded,
  )
  assert.deepEqual(decodeConfigSecrets(encoded, os.decrypt), fixture([API_KEY, SECOND_API_KEY], ''))
})

test('unknown plaintext, wrong field formats, and whitespace are rejected', () => {
  const invalidApiKeys = [
    'plain-secret', 'sk-' + 'a'.repeat(47), 'sk-' + 'a'.repeat(49),
    'sk-' + '_'.repeat(48), MANAGEMENT_UUID,
    'sk-mgmt-' + 'a'.repeat(31), 'sk-mgmt-' + 'a'.repeat(33),
    'sk-mgmt-' + 'z'.repeat(32),
    API_KEY + '\n', ' ' + API_KEY, API_KEY + ' ',
  ]
  const invalidManagementSecrets = [
    'plain-secret', API_KEY, 'sk-mgmt-' + 'a'.repeat(31), 'sk-mgmt-' + 'a'.repeat(33),
    'sk-mgmt-' + 'z'.repeat(32), 'mgmt_0123456789ab4def8123456789abcdef',
    'mgmt_01234567-89ab-4def-8123-456789abcdeg',
    MANAGEMENT_UUID + '\n', MANAGEMENT_HEX + '\n', ' ' + MANAGEMENT_UUID,
  ]
  const inputs = [
    ...invalidApiKeys.map(value => fixture([value], '')),
    ...invalidManagementSecrets.map(value => fixture([], value)),
  ]
  for (const input of inputs) {
    const forbidden = [input.apiKeys[0]?.key, input.managementApi.managementApiSecret].filter(Boolean)
    expectRedactedError(() => encodeConfigSecrets(input, () => assert.fail('Invalid input')), ENCRYPT_ERROR, forbidden)
    expectRedactedError(() => decodeConfigSecrets(input, () => assert.fail('Invalid input')), DECRYPT_ERROR, forbidden)
    expectRedactedError(() => hasUnprotectedConfigSecrets(input), INVALID_ERROR, forbidden)
  }
})

test('malformed, unknown, and noncanonical protection envelopes are rejected before callbacks', () => {
  const invalid = [
    'safeStorage:v1:', 'safeStorage:v2:YQ==', 'SafeStorage:v1:YQ==',
    'safestorage:v1:YQ==', 'safeStorage:YQ==', 'safeStorage:v1:YQ',
    'safeStorage:v1:YR==', 'safeStorage:v1:YQ===', 'safeStorage:v1:YQ==\n',
    'safeStorage:v1: YQ==', 'safeStorage:v1:____', 'safeStorage:v1:!!!!',
    'safeStorage:v1:safeStorage:v1:YQ==',
  ]
  let calls = 0
  const transform = () => { calls++; return marked('unused') }
  for (const value of invalid) {
    for (const input of [fixture([value], ''), fixture([], value)]) {
      expectRedactedError(() => encodeConfigSecrets(input, transform), ENCRYPT_ERROR, [value])
      expectRedactedError(() => decodeConfigSecrets(input, transform), DECRYPT_ERROR, [value])
      expectRedactedError(() => hasUnprotectedConfigSecrets(input), INVALID_ERROR, [value])
    }
  }
  assert.equal(calls, 0)
})

test('every field is prevalidated before any codec or migration result', () => {
  let calls = 0
  const transform = () => { calls++; return marked('unused') }
  for (const input of [
    fixture([API_KEY, 'invalid-later-key'], ''),
    fixture([marked('first-key')], 'invalid-later-management'),
    fixture([API_KEY], 'invalid-later-management'),
  ]) {
    expectRedactedError(() => encodeConfigSecrets(input, transform), ENCRYPT_ERROR)
    expectRedactedError(() => decodeConfigSecrets(input, transform), DECRYPT_ERROR)
    expectRedactedError(() => hasUnprotectedConfigSecrets(input), INVALID_ERROR)
  }
  assert.equal(calls, 0)
})

test('corrupt ciphertext fails closed with a redacted error and unchanged input', () => {
  const corrupted = marked('corrupt-offline-ciphertext')
  const original = freezeData(fixture([corrupted], ''))
  const snapshot = structuredClone(original)
  const backendText = 'Synthetic decrypt failure: ' + corrupted + ' ' + API_KEY
  // Envelope recognition alone cannot authenticate OS ciphertext.
  assert.equal(hasUnprotectedConfigSecrets(original), false)
  expectRedactedError(() => decodeConfigSecrets(original, () => {
    throw new Error(backendText, { cause: new Error(MANAGEMENT_HEX) })
  }), DECRYPT_ERROR, [corrupted, API_KEY, MANAGEMENT_HEX, backendText])
  assert.deepEqual(original, snapshot)
})

test('invalid encryption callback outputs are never returned or stored', () => {
  for (const result of [
    undefined, null, 123, {}, new String(marked('boxed')), '', API_KEY,
    'safeStorage:v2:YQ==', 'safeStorage:v1:YQ', Promise.resolve(marked('async')),
  ]) {
    const original = freezeData(fixture([API_KEY], ''))
    expectRedactedError(() => encodeConfigSecrets(original, () => result), ENCRYPT_ERROR, [API_KEY])
    assert.equal(original.apiKeys[0].key, API_KEY)
  }
})

test('decrypted output must have the correct field type and supported secret format', () => {
  for (const result of [
    undefined, null, 123, {}, new String(API_KEY), 'unknown-plaintext',
    MANAGEMENT_UUID, 'sk-mgmt-' + 'g'.repeat(32), marked('nested'),
    API_KEY + '\n', Promise.resolve(API_KEY),
  ]) {
    const original = freezeData(fixture([marked('api-key')], ''))
    expectRedactedError(() => decodeConfigSecrets(original, () => result), DECRYPT_ERROR)
  }
  for (const result of [API_KEY, MANAGEMENT_HEX + '\n', 'mgmt_invalid']) {
    expectRedactedError(
      () => decodeConfigSecrets(fixture([], marked('management')), () => result),
      DECRYPT_ERROR,
    )
  }
})

test('encryption failure at either a later key or management leaves all input untouched', () => {
  for (const failAt of [2, 3]) {
    const original = freezeData(fixture([API_KEY, SECOND_API_KEY]))
    const snapshot = structuredClone(original)
    let calls = 0
    expectRedactedError(() => encodeConfigSecrets(original, value => {
      assert.equal(typeof value, 'string')
      calls++
      if (calls === failAt) throw new Error('Synthetic OS failure: ' + value)
      return marked('encrypted-before-failure-' + calls)
    }), ENCRYPT_ERROR, [API_KEY, SECOND_API_KEY, MANAGEMENT_HEX])
    assert.equal(calls, failAt)
    assert.deepEqual(original, snapshot)
  }
})

test('decryption failure after success leaves every ciphertext unchanged', () => {
  const original = freezeData(fixture([marked('key-one'), marked('key-two')], ''))
  const snapshot = structuredClone(original)
  let calls = 0
  expectRedactedError(() => decodeConfigSecrets(original, value => {
    calls++
    if (calls === 2) throw new Error('Synthetic OS failure: ' + value)
    return API_KEY
  }), DECRYPT_ERROR, [API_KEY, original.apiKeys[1].key])
  assert.equal(calls, 2)
  assert.deepEqual(original, snapshot)
})

test('invalid config containers, arrays, entries, and secret types fail closed', () => {
  const invalid = [
    undefined, null, 'config', [], new Date(), {},
    { ...fixture(), apiKeys: undefined },
    { ...fixture(), apiKeys: {} },
    { ...fixture(), apiKeys: 'secret' },
    { ...fixture(), apiKeys: [null] },
    { ...fixture(), apiKeys: [[]] },
    { ...fixture(), apiKeys: [{}] },
    { ...fixture(), apiKeys: [{ key: 123 }] },
    { ...fixture(), apiKeys: [{ key: new String(API_KEY) }] },
    { ...fixture(), apiKeys: new Array(1) },
    { ...fixture(), managementApi: undefined },
    { ...fixture(), managementApi: [] },
    { ...fixture(), managementApi: {} },
    { ...fixture(), managementApi: { managementApiSecret: null } },
    { ...fixture(), managementApi: { managementApiSecret: 123 } },
    Object.assign(Object.create({ apiKeys: [] }), { managementApi: { managementApiSecret: '' } }),
  ]
  let calls = 0
  const transform = () => { calls++; return marked('unused') }
  for (const input of invalid) {
    expectRedactedError(() => encodeConfigSecrets(input, transform), ENCRYPT_ERROR)
    expectRedactedError(() => decodeConfigSecrets(input, transform), DECRYPT_ERROR)
    expectRedactedError(() => hasUnprotectedConfigSecrets(input), INVALID_ERROR)
    expectRedactedError(() => redactExportConfigSecrets(input), INVALID_ERROR)
  }
  assert.equal(calls, 0)
})

test('secret-bearing accessors are rejected without invocation or output', () => {
  let reads = 0
  const getter = { enumerable: true, get() { reads++; throw new Error(API_KEY) } }
  const root = fixture()
  Object.defineProperty(root, 'apiKeys', getter)
  const entry = fixture()
  Object.defineProperty(entry.apiKeys[0], 'key', getter)
  const array = fixture()
  Object.defineProperty(array.apiKeys, '0', getter)
  const management = fixture()
  Object.defineProperty(management.managementApi, 'managementApiSecret', getter)
  for (const input of [root, entry, array, management]) {
    expectRedactedError(() => encodeConfigSecrets(input, () => assert.fail()), ENCRYPT_ERROR, [API_KEY])
    expectRedactedError(() => decodeConfigSecrets(input, () => assert.fail()), DECRYPT_ERROR, [API_KEY])
    expectRedactedError(() => hasUnprotectedConfigSecrets(input), INVALID_ERROR, [API_KEY])
    expectRedactedError(() => redactExportConfigSecrets(input), INVALID_ERROR, [API_KEY])
  }
  assert.equal(reads, 0)
})

test('missing codecs fail with redacted errors', () => {
  for (const callback of [undefined, null, {}, 123]) {
    expectRedactedError(() => encodeConfigSecrets(fixture(), callback), ENCRYPT_ERROR)
    expectRedactedError(() => decodeConfigSecrets(fixture(), callback), DECRYPT_ERROR)
  }
})

test('export removes raw, protected, and damaged secrets while preserving other settings', () => {
  for (const input of [
    fixture([API_KEY, SECOND_API_KEY], MANAGEMENT_HEX),
    fixture([marked('key')], marked('management')),
    fixture(['unknown-private-value'], 'safeStorage:v9:damaged-private-value'),
  ]) {
    const original = freezeData(input)
    const snapshot = structuredClone(original)
    const exported = redactExportConfigSecrets(original)
    assert.deepEqual(exported.apiKeys, [])
    assert.equal(exported.managementApi.managementApiSecret, '')
    assert.equal(exported.managementApi.enableManagementApi, original.managementApi.enableManagementApi)
    assert.equal(exported.managementApi.managementApiPort, original.managementApi.managementApiPort)
    assert.equal(exported.enableApiKey, original.enableApiKey)
    assert.deepEqual(exported.modelMappings, original.modelMappings)
    assert.deepEqual(exported.requestLogConfig, original.requestLogConfig)
    assert.deepEqual(original, snapshot)
    assert.notEqual(exported, original)
    assert.notEqual(exported.managementApi, original.managementApi)
    for (const value of [...original.apiKeys.map(entry => entry.key), original.managementApi.managementApiSecret]) {
      assert.equal(JSON.stringify(exported).includes(value), false)
    }
  }
})

test('success and failure paths produce no console or stream output and never stringify errors', context => {
  const output = []
  const intercepted = [
    ...['log', 'info', 'warn', 'error', 'debug', 'trace'].map(method =>
      context.mock.method(console, method, (...args) => { output.push(args) })),
    context.mock.method(process.stdout, 'write', (...args) => { output.push(args); return true }),
    context.mock.method(process.stderr, 'write', (...args) => { output.push(args); return true }),
  ]
  let stringifications = 0
  const unsafeError = {
    message: API_KEY,
    cause: MANAGEMENT_HEX,
    toString() { stringifications++; return API_KEY },
  }
  try {
    const os = codec()
    const original = fixture()
    const encoded = encodeConfigSecrets(original, os.encrypt)
    decodeConfigSecrets(encoded, os.decrypt)
    hasUnprotectedConfigSecrets(original)
    redactExportConfigSecrets(original)
    expectRedactedError(() => encodeConfigSecrets(original, () => { throw unsafeError }), ENCRYPT_ERROR, [API_KEY, MANAGEMENT_HEX])
    expectRedactedError(() => decodeConfigSecrets(encoded, () => { throw unsafeError }), DECRYPT_ERROR, [API_KEY, MANAGEMENT_HEX])
    expectRedactedError(() => hasUnprotectedConfigSecrets(fixture(['unknown-private-value'], '')), INVALID_ERROR)
    expectRedactedError(() => redactExportConfigSecrets(null), INVALID_ERROR)
  } finally {
    intercepted.forEach(method => method.mock.restore())
  }
  assert.equal(stringifications, 0)
  assert.deepEqual(output, [])
})
