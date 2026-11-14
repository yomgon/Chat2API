import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { inspect } from 'node:util'
import vm from 'node:vm'

// Run with Node 24: node --experimental-vm-modules --test tests/security/credential-storage-security.test.mjs
// Only the four source files are read. Every application import, OS keystore,
// browser, timer and persistence dependency is replaced inside a fresh VM.
const prefix = 'safeStorage:v1:'
const cookiePrefix = 'safeStorage:cookies:v1:'
const fakeHome = 'C:\\synthetic-credential-test-home'
const token = 'SYNTHETIC-ACCOUNT-TOKEN-ALPHA.0123456789abcdefghijklmnopqrstuvwxyz.0123456789'
const otherToken = 'SYNTHETIC-ACCOUNT-TOKEN-BRAVO.9876543210abcdefghijklmnopqrstuvwxyz.9876543210'
const echoedSecret = 'SYNTHETIC-EXCEPTION-SECRET-CHARLIE.0123456789abcdefghijklmnopqrstuvwxyz'
const legacyJWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj'
const legacyJWE = [
  Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString('base64url'), '',
  ...['synthetic-iv', 'synthetic-ciphertext', 'synthetic-tag'].map(value => Buffer.from(value).toString('base64url')),
].join('.')
const sourceCache = new Map()
const plain = value => JSON.parse(JSON.stringify(value))
const ciphertext = value => Buffer.from(`v10\0${value}`, 'utf8')

function captureLogs() {
  const entries = []
  const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [
    level,
    (...args) => entries.push(`${level}: ${inspect(args, { depth: 20, customInspect: false, getters: false })}`),
  ]))
  return { entries, console }
}

function assertNoSecrets(entries, secrets = [token, otherToken, echoedSecret]) {
  const output = entries.join('\n')
  for (const secret of secrets) {
    for (const fragment of new Set([secret, secret.slice(0, 20), secret.slice(0, 50)])) {
      assert.equal(output.includes(fragment), false, `Log or error exposed synthetic secret: ${fragment}`)
    }
  }
}

function assertSafeThrow(operation, expected = /credential|storage|cookie/i, secrets) {
  let thrown
  try { operation() } catch (error) { thrown = error }
  assert.ok(thrown, 'Expected the operation to fail closed')
  assert.match(String(thrown.message), expected)
  assertNoSecrets([inspect(thrown, { depth: 20, customInspect: false })], secrets)
  return thrown
}

function forbidden(name) {
  return () => { throw new Error(`Unexpected real-world operation in isolated test: ${name}`) }
}

async function loadSource(relativePath, imports, globals = {}, dynamicImports = {}) {
  if (!sourceCache.has(relativePath)) {
    const url = new URL(`../../${relativePath}`, import.meta.url)
    sourceCache.set(relativePath, stripTypeScriptTypes(readFileSync(url, 'utf8'), { mode: 'transform' }))
  }
  const logs = captureLogs()
  const imported = []
  const timers = new Map()
  let timerId = 0
  const context = vm.createContext({
    Buffer,
    console: logs.console,
    process: Object.freeze({ platform: 'win32' }),
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    ...globals,
  }, { codeGeneration: { strings: false, wasm: false } })
  const modules = new Map()
  function dependency(specifier, values) {
    if (!modules.has(specifier)) {
      modules.set(specifier, new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value)
      }, { context, identifier: `synthetic:${specifier}` }))
    }
    return modules.get(specifier)
  }
  const module = new vm.SourceTextModule(sourceCache.get(relativePath), {
    context,
    identifier: relativePath,
    async importModuleDynamically(specifier) {
      imported.push(specifier)
      assert.ok(Object.hasOwn(dynamicImports, specifier), `Blocked dynamic import: ${specifier}`)
      const child = dependency(specifier, dynamicImports[specifier])
      if (child.status === 'unlinked') await child.link(forbidden('nested dynamic import'))
      if (child.status === 'linked') await child.evaluate()
      return child
    },
  })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Blocked application import: ${specifier}`)
    return dependency(specifier, imports[specifier])
  })
  await module.evaluate()
  const parseInRealm = vm.runInContext('JSON.parse', context)
  return { exports: module.namespace, logs, imported, timers, inRealm: value => parseInRealm(JSON.stringify(value)) }
}

function makeSafeStorage(overrides = {}) {
  const calls = { availability: 0, backend: 0, encrypted: [], decrypted: [] }
  const storage = {
    isEncryptionAvailable() {
      calls.availability++
      return overrides.isEncryptionAvailable ? overrides.isEncryptionAvailable() : true
    },
    getSelectedStorageBackend() {
      calls.backend++
      return overrides.getSelectedStorageBackend ? overrides.getSelectedStorageBackend() : 'gnome_libsecret'
    },
    encryptString(value) {
      calls.encrypted.push(value)
      return overrides.encryptString ? overrides.encryptString(value) : ciphertext(value)
    },
    decryptString(value) {
      calls.decrypted.push(Buffer.from(value))
      if (overrides.decryptString) return overrides.decryptString(value)
      const decoded = value.toString('utf8')
      if (!decoded.startsWith('v10\0')) throw new Error(echoedSecret)
      return decoded.slice(4)
    },
  }
  return { storage, calls }
}

const defaultConfig = Object.freeze({
  managementApi: {}, apiKeys: [], theme: 'system', logLevel: 'info', modelMappings: {},
})
const typeImports = {
  DEFAULT_CONFIG: defaultConfig,
  BUILTIN_PROVIDERS: [{ id: 'zai', headers: {} }],
  DEFAULT_SESSION_CONFIG: {},
  DEFAULT_STATISTICS: {},
  DEFAULT_USER_MODEL_OVERRIDES: {},
  DEFAULT_REQUEST_LOG_CONFIG: {},
  createDefaultModelMappings: () => ({}),
  normalizeModelMappingsWithDefaults: value => value,
  sanitizeDeepSeekModelOverrides: value => value,
}
// Explicit exports also allow source imports that have not yet adopted `import type`.
for (const name of [
  'StoreSchema', 'AppConfig', 'Account', 'Provider', 'LogEntry', 'LogLevel', 'SystemPrompt',
  'SessionRecord', 'SessionConfig', 'ChatMessage', 'RequestLogEntry', 'RequestLogConfig',
  'PersistentStatistics', 'DailyStatistics', 'EffectiveModel', 'ProviderModelOverrides',
  'UserModelOverrides', 'CustomModel', 'LoadBalanceStrategy', 'Theme', 'ModelMapping',
]) typeImports[name] = undefined

function account(credentials, extra = {}) {
  return {
    id: 'account-1', providerId: 'provider-1', name: 'Synthetic account', status: 'active',
    credentials, createdAt: 1, updatedAt: 2, requestCount: 0, todayUsed: 0, ...extra,
  }
}

async function storeHarness({ accounts = [], platform = 'win32', crypto = {}, constructorError, setError } = {}) {
  const safe = makeSafeStorage(crypto)
  const state = { accounts, config: defaultConfig }
  const writes = []
  const attempts = []
  const constructed = []
  const logManagers = []
  const memory = {
    get: key => state[key],
    set(key, value) {
      attempts.push({ key, value })
      if (setError) throw setError
      state[key] = value
      writes.push({ key, value })
    },
    clear: forbidden('store clear/reset'),
    delete: forbidden('store delete/reset'),
  }
  class FakeStore {
    constructor(options) {
      constructed.push(options)
      if (constructorError) throw constructorError
      return memory
    }
  }
  class FakeLogManager {
    constructor() { logManagers.push('created'); throw new Error('Unexpected log manager initialization') }
  }
  const loaded = await loadSource('src/main/store/store.ts', {
    electron: { app: { getPath: forbidden('Electron app path') }, safeStorage: safe.storage, BrowserWindow: forbidden('browser window') },
    os: { homedir: () => fakeHome },
    path: { join },
    './types': typeImports,
    '../data/builtin-prompts': { BUILTIN_PROMPTS: [] },
    '../requestLogs/manager': { RequestLogManager: FakeLogManager },
    '../requestLogs/types': { normalizeRequestLogConfig: value => value },
    '../../shared/toolCalling': { normalizeToolCallingConfig: value => value },
    '../appLogs/manager': { AppLogManager: FakeLogManager },
    // Config OS-secret transformations have their own direct production
    // source tests. This harness isolates the account-credential behaviors.
    './configSecrets': {
      encodeConfigSecrets: value => value,
      decodeConfigSecrets: value => value,
      redactExportConfigSecrets: value => ({ ...value, apiKeys: [], managementApi: { managementApiSecret: '' } }),
    },
  }, { process: Object.freeze({ platform }) }, { 'electron-store': { default: FakeStore } })
  const manager = loaded.exports.storeManager
  // These TypeScript private fields are ordinary properties; the real methods
  // still run unchanged, with only their persistence dependency replaced.
  manager.store = memory
  manager.isInitialized = true
  return { ...loaded, manager, safe, state, writes, attempts, constructed, logManagers, memory }
}

test('new credentials are tagged, round-trip, and never logged in plaintext or ciphertext', async () => {
  const h = await storeHarness()
  const encrypted = h.manager.encryptData(token)
  assert.equal(encrypted, prefix + ciphertext(token).toString('base64'))
  assert.equal(h.manager.decryptData(encrypted), token)
  assertNoSecrets(h.logs.entries, [token, encrypted, ciphertext(token).toString('base64')])
  assert.equal(h.safe.calls.backend, 0)
})

test('custom provider auth header is OS encrypted at rest and decrypts only for use', async () => {
  const h = await storeHarness()
  const secret = 'SYNTHETIC_CUSTOM_HEADER_AUTHENTICATION_BEARER_12345'
  const provider = {
    id: 'local-custom', name: 'Synthetic private provider', type: 'custom',
    apiEndpoint: 'https://provider.example.com/v1', headers: { Authorization: secret, 'Content-Type': 'application/json' },
  }
  h.manager.addProvider(provider)
  const stored = h.state.providers[0]
  assert.ok(stored.headers.Authorization.startsWith('safeStorage:provider-header:v1:'))
  assert.ok(!JSON.stringify(stored).includes(secret))
  assert.equal(h.manager.getProviderById('local-custom').headers.Authorization, secret)
  h.manager.updateProvider('local-custom', { name: 'Renamed' })
  assert.equal(h.manager.getProviderById('local-custom').headers.Authorization, secret)
  assert.ok(!JSON.stringify(h.state.providers).includes(secret))
  assert.equal(provider.headers.Authorization, secret)
  assertNoSecrets(h.logs.entries, [secret])
})

test('built-in provider deletion is refused by the actual storage writer before any account mutation', async () => {
  const h = await storeHarness({ accounts: [account({ token }, { id: 'synthetic-zai-account', providerId: 'zai' })] })
  h.state.providers = [
    { id: 'zai', name: 'Z.ai', type: 'builtin', headers: {}, enabled: true },
    { id: 'private-custom', name: 'Synthetic custom provider', type: 'custom', headers: {}, enabled: true },
  ]
  assertSafeThrow(() => h.manager.deleteProvider('zai'), /Built-in providers cannot be deleted/i, [])
  assert.equal(h.attempts.length, 0, 'built-in deletion must not enter any persistent writer')
  assert.equal(h.state.providers.length, 2)
  assert.equal(h.state.accounts.length, 1)
  assert.equal(h.state.accounts[0].providerId, 'zai')
  h.state.providers[0].type = 'custom'
  assertSafeThrow(() => h.manager.deleteProvider('zai'), /Built-in providers cannot be deleted/i, [])
  assert.equal(h.attempts.length, 0, 'reserved built-in identity must remain protected even when type is corrupted')
  assertNoSecrets(h.logs.entries)
})

test('legacy custom headers can be migrated only through the encrypted provider writer', async () => {
  const h = await storeHarness()
  const secret = 'SYNTHETIC_LEGACY_CUSTOM_HEADER_KEY_12345'
  h.state.providers = [{ id: 'old', name: 'Legacy', type: 'custom', headers: { 'X-Api-Key': secret } }]
  assert.equal(h.manager.getProviderById('old').headers['X-Api-Key'], secret)
  h.manager.replaceProviders(h.manager.getProviders())
  assert.ok(h.state.providers[0].headers['X-Api-Key'].startsWith('safeStorage:provider-header:v1:'))
  assert.ok(!JSON.stringify(h.state.providers).includes(secret))
})

test('provider-header encryption failure and header injection make zero persisted changes', async () => {
  const h = await storeHarness({ crypto: { isEncryptionAvailable: () => false } })
  const old = h.state.providers
  assertSafeThrow(() => h.manager.addProvider({ id: 'a', name: 'Bad', type: 'custom', headers: { Authorization: 'synthetic-token' } }))
  assert.equal(h.state.providers, old)
  assert.equal(h.writes.length, 0)
  const healthy = await storeHarness()
  assertSafeThrow(() => healthy.manager.addProvider({ id: 'b', name: 'Bad', type: 'custom', headers: { Authorization: 'synthetic\r\nInjected: 1' } }), /header/i)
  assert.equal(healthy.writes.length, 0)
})

test('canonical legacy ciphertext decrypts while recognizable legacy JWT/cookies remain readable', async () => {
  const h = await storeHarness()
  assert.equal(h.manager.decryptData(ciphertext(token).toString('base64')), token)
  const decryptedBefore = h.safe.calls.decrypted.length
  for (const legacy of [legacyJWT, legacyJWE, 'ticket=value; session=other-value']) {
    assert.equal(h.manager.decryptData(legacy), legacy)
  }
  assert.equal(h.safe.calls.decrypted.length, decryptedBefore)
  assert.equal(h.attempts.length, 0)
  assertNoSecrets(h.logs.entries)
})

test('ambiguous, malformed and unsupported credentials cannot fall back to upstream plaintext', async () => {
  const malformed = [
    'legacy-token', 'YWJj', 'YWJjZA', 'YWJj\n', 'abcd_efg-hijk',
    `${prefix}not base64!`, prefix, 'safeStorage:v2:YWJj',
    'not-a-token!', 'foo.bar.baz', 'e30.e30.c3ludGhldGlj', 'ticket=value', 'safeStorage:v1',
    'safeStorage-v1:' + ciphertext(token).toString('base64'),
    'safeStorAge:v1:' + ciphertext(token).toString('base64'),
    Buffer.from('v10').toString('base64'),
    Buffer.from([1, 0, 0, 0]).toString('base64'),
    Buffer.from('v10').toString('base64') + '!',
    Buffer.from([1, 0, 0, 0, 8, 0]).toString('base64').slice(0, -1),
  ]
  for (const value of malformed) {
    const h = await storeHarness()
    assertSafeThrow(() => h.manager.decryptData(value), /credential/i)
    assert.equal(h.attempts.length, 0)
    assertNoSecrets(h.logs.entries)
  }
})

test('Windows encryption never calls the Linux-only backend getter', async () => {
  const h = await storeHarness({ crypto: { getSelectedStorageBackend: forbidden('Linux backend on Windows') } })
  assert.ok(h.manager.encryptData(token).startsWith(prefix))
  assert.equal(h.safe.calls.backend, 0)
})

test('unavailable or throwing crypto fails closed before any account write', async () => {
  for (const isEncryptionAvailable of [() => false, () => { throw new Error(echoedSecret) }]) {
    const h = await storeHarness({ crypto: { isEncryptionAvailable } })
    assertSafeThrow(() => h.manager.encryptData(token))
    assertSafeThrow(() => h.manager.addAccount(account({ token })))
    assertSafeThrow(() => h.manager.decryptData(prefix + ciphertext(token).toString('base64')))
    assert.equal(h.attempts.length, 0)
    assert.equal(h.safe.calls.encrypted.length, 0)
    assertNoSecrets(h.logs.entries)
  }
})

test('Linux plaintext, unknown, missing and throwing backends cannot encrypt credentials', async () => {
  for (const backend of ['basic_text', 'unknown', '', null, 'throw']) {
    const h = await storeHarness({ platform: 'linux', crypto: {
      getSelectedStorageBackend: () => { if (backend === 'throw') throw new Error(echoedSecret); return backend },
    } })
    assertSafeThrow(() => h.manager.addAccount(account({ token })))
    assert.equal(h.safe.calls.encrypted.length, 0)
    assert.equal(h.attempts.length, 0)
    assertNoSecrets(h.logs.entries)
  }
})

test('crypto errors, invalid output and verification mismatch have sanitized failures and zero writes', async () => {
  const failures = [
    { encryptString: () => { throw Object.assign(new Error(echoedSecret), { config: { token } }) } },
    { encryptString: () => Buffer.alloc(0) },
    { encryptString: () => token },
    { decryptString: () => { throw new Error(echoedSecret) } },
    { decryptString: () => otherToken },
  ]
  for (const crypto of failures) {
    const h = await storeHarness({ crypto })
    assertSafeThrow(() => h.manager.addAccount(account({ token })), /Credential encryption failed/)
    assert.equal(h.attempts.length, 0)
    assertNoSecrets(h.logs.entries)
  }
})

test('optional empty fields stay empty but new encryption still checks storage availability', async () => {
  const h = await storeHarness()
  assert.equal(h.manager.encryptData(''), '')
  assert.equal(h.safe.calls.availability, 1)
  assert.equal(h.safe.calls.encrypted.length, 0)
  assert.equal(h.manager.decryptData(''), '')
  h.manager.addAccount(account({ token, optional: '' }))
  assert.equal(h.state.accounts[0].credentials.optional, '')
  const unavailable = await storeHarness({ crypto: { isEncryptionAvailable: () => false } })
  assertSafeThrow(() => unavailable.manager.encryptData(''))
  assertSafeThrow(() => unavailable.manager.addAccount(account({ optional: '' })))
  assert.equal(unavailable.attempts.length, 0)
})

test('credential decryption exceptions and invalid types cannot echo input secrets', async () => {
  const h = await storeHarness({ crypto: { decryptString: () => { throw Object.assign(new Error(echoedSecret), { credentials: { token } }) } } })
  assertSafeThrow(() => h.manager.decryptData(prefix + ciphertext(token).toString('base64')))
  for (const value of [null, undefined, {}, [], 123]) {
    assertSafeThrow(() => h.manager.encryptData(value))
    assertSafeThrow(() => h.manager.decryptData(value))
  }
  assert.equal(h.attempts.length, 0)
  assertNoSecrets(h.logs.entries, [token, otherToken, echoedSecret,
    prefix + ciphertext(token).toString('base64'), prefix + ciphertext(otherToken).toString('base64'),
    ciphertext(token).toString('base64'), ciphertext(otherToken).toString('base64')])
})

test('account creation and replacement write new objects and return only the intended plaintext', async () => {
  const existing = account({ token: prefix + ciphertext(token).toString('base64') })
  const original = [existing]
  const before = plain(original)
  const h = await storeHarness({ accounts: original })
  const result = h.manager.updateAccount(existing.id, { name: 'Changed account', credentials: { token: otherToken, optional: '' } })
  assert.equal(h.attempts.length, 1)
  assert.notEqual(h.state.accounts, original)
  assert.notEqual(h.state.accounts[0], existing)
  assert.deepEqual(plain(original), before)
  assert.equal(h.state.accounts[0].credentials.token, prefix + ciphertext(otherToken).toString('base64'))
  assert.deepEqual(plain(result.credentials), { token: otherToken, optional: '' })
  const added = account({ token }, { id: 'account-2' })
  const priorAccounts = h.state.accounts
  h.manager.addAccount(added)
  assert.notEqual(h.state.accounts, priorAccounts)
  assert.equal(priorAccounts.length, 1)
  assert.equal(added.credentials.token, token)
  assert.equal(h.state.accounts[1].credentials.token, prefix + ciphertext(token).toString('base64'))
  assertNoSecrets(h.logs.entries)
})

test('metadata updates migrate legacy credentials before one write', async () => {
  for (const legacy of [legacyJWT, ciphertext(legacyJWT).toString('base64')]) {
    const original = [account({ token: legacy })]
    const before = plain(original)
    const h = await storeHarness({ accounts: original })
    const result = h.manager.updateAccount('account-1', { name: 'Metadata change' })
    assert.equal(result.credentials.token, legacyJWT)
    assert.equal(h.state.accounts[0].credentials.token, prefix + ciphertext(legacyJWT).toString('base64'))
    assert.equal(h.attempts.length, 1)
    assert.deepEqual(plain(original), before)
    assertNoSecrets(h.logs.entries, [legacyJWT])
  }
})

test('structured OAuth cookies are encrypted at rest and round-trip as the original cookie object', async () => {
  const h = await storeHarness()
  const credentials = h.inRealm({ token, cookies: { session: otherToken, clearance: echoedSecret } })
  const before = plain(credentials)
  h.manager.addAccount(account(credentials))
  const persisted = h.state.accounts[0].credentials
  assert.equal(typeof persisted.cookies, 'string')
  assert.ok(persisted.cookies.startsWith(cookiePrefix))
  assert.equal(typeof persisted.token, 'string')
  assert.ok(persisted.token.startsWith(prefix))
  assertNoSecrets([JSON.stringify(persisted)])
  assert.deepEqual(plain(credentials), before)
  assert.deepEqual(plain(h.manager.getAccountById('account-1', true).credentials), before)
  const updated = h.manager.updateAccount('account-1', { name: 'Cookie metadata change' })
  assert.deepEqual(plain(updated.credentials), before)
  assert.deepEqual(plain(h.manager.getAccountById('account-1', true).credentials), before)
  assertNoSecrets(h.logs.entries)
})

test('invalid structured credential shapes cannot partially write an account', async () => {
  for (const credentials of [
    { token, cookies: ['cookie'] },
    { token, cookies: { session: 123 } },
    { token, cookies: { session: { nested: otherToken } } },
    { token, cookies: null },
    { token, other: { session: otherToken } },
  ]) {
    const original = [account({ token: prefix + ciphertext(token).toString('base64') })]
    const before = plain(original)
    const h = await storeHarness({ accounts: original })
    const localCredentials = h.inRealm(credentials)
    assertSafeThrow(() => h.manager.addAccount(account(localCredentials, { id: 'account-2' })))
    assertSafeThrow(() => h.manager.updateAccount('account-1', { credentials: localCredentials }))
    assert.equal(h.attempts.length, 0)
    assert.equal(h.state.accounts, original)
    assert.deepEqual(plain(original), before)
    assertNoSecrets(h.logs.entries)
  }
})

test('legacy cookie objects are validated and copied while malformed encrypted cookie payloads fail closed', async () => {
  const h = await storeHarness()
  const legacyCookies = h.inRealm({ session: token, clearance: otherToken })
  const decoded = h.manager.decryptCredentials({ cookies: legacyCookies })
  assert.deepEqual(plain(decoded.cookies), plain(legacyCookies))
  assert.notEqual(decoded.cookies, legacyCookies)
  decoded.cookies.session = 'Synthetic caller mutation'
  assert.equal(legacyCookies.session, token)
  for (const malformed of [null, [], { session: 123 }, { session: { nested: token } }]) {
    const encoded = cookiePrefix + ciphertext(JSON.stringify(malformed)).toString('base64')
    assertSafeThrow(() => h.manager.decryptCredentials({ cookies: encoded }))
  }
  for (const cookies of [
    cookiePrefix + ciphertext('not JSON').toString('base64'),
    cookiePrefix + 'not base64!',
    'safeStorage:cookies:v2:' + ciphertext('{}').toString('base64'),
  ]) assertSafeThrow(() => h.manager.decryptCredentials({ cookies }))
  assertSafeThrow(() => h.manager.decryptCredentials({ token: cookiePrefix + ciphertext('{}').toString('base64') }))
  assert.equal(h.attempts.length, 0)
  assertNoSecrets(h.logs.entries)
})

test('failed metadata decryption or later field encryption leaves the original account untouched', async () => {
  const badCipher = prefix + Buffer.from('v10').toString('base64')
  for (const failure of ['decrypt', 'second-field-encrypt']) {
    const original = [account({ token: failure === 'decrypt' ? badCipher : prefix + ciphertext(token).toString('base64') })]
    const before = plain(original)
    const h = await storeHarness({ accounts: original, crypto: failure === 'second-field-encrypt' ? {
      encryptString: value => { if (value === otherToken) throw new Error(echoedSecret); return ciphertext(value) },
    } : {} })
    const updates = failure === 'decrypt'
      ? { name: 'Must not be saved' }
      : { name: 'Must not be saved', credentials: { token, second: otherToken } }
    assertSafeThrow(() => h.manager.updateAccount('account-1', updates))
    assert.equal(h.attempts.length, 0)
    assert.equal(h.state.accounts, original)
    assert.deepEqual(plain(original), before)
    assertNoSecrets(h.logs.entries)
  }
})

test('new credentials repair unreadable old credentials without trying to decrypt the old value', async () => {
  const old = Buffer.from('v10')
  const h = await storeHarness({ accounts: [account({ token: prefix + old.toString('base64') })] })
  const result = h.manager.updateAccount('account-1', { credentials: { token } })
  assert.equal(result.credentials.token, token)
  assert.equal(h.attempts.length, 1)
  assert.equal(h.safe.calls.decrypted.some(value => value.equals(old)), false)
  assertNoSecrets(h.logs.entries)
})

test('a failed store write cannot mutate the array or account supplied by store.get', async () => {
  const original = [account({ token: prefix + ciphertext(token).toString('base64') })]
  const before = plain(original)
  const h = await storeHarness({ accounts: original, setError: new Error('Synthetic write refusal') })
  assert.throws(() => h.manager.updateAccount('account-1', { credentials: { token: otherToken } }), /Synthetic write refusal/)
  assert.equal(h.attempts.length, 1)
  assert.equal(h.writes.length, 0)
  assert.equal(h.state.accounts, original)
  assert.deepEqual(plain(original), before)
  assertNoSecrets(h.logs.entries)
})

test('initialization failures use the isolated data path without reset, rename or retry', async () => {
  for (const failure of ['unavailable', 'availability-throws', 'constructor-throws']) {
    const original = [account({ token: prefix + ciphertext(token).toString('base64') })]
    const h = await storeHarness({
      accounts: original,
      crypto: failure === 'constructor-throws' ? {} : { isEncryptionAvailable: () => {
        if (failure === 'availability-throws') throw new Error(echoedSecret)
        return false
      } },
      constructorError: failure === 'constructor-throws' ? new Error(echoedSecret) : undefined,
    })
    h.manager.isInitialized = false
    h.manager.store = null
    assert.equal(h.manager.getStorePath(), join(fakeHome, '.chat2api-local-private'))
    await assert.rejects(h.manager.initialize(), /Secure storage initialization failed/)
    assert.equal(h.manager.store, null)
    assert.equal(h.manager.isInitialized, false)
    assert.equal(h.manager.hasInitializationError(), true)
    assert.match(h.manager.getInitializationError().message, /Existing data was not reset/)
    assertNoSecrets([inspect(h.manager.getInitializationError(), { depth: 10 }), ...h.logs.entries])
    assert.deepEqual(h.imported, ['electron-store'])
    assert.equal(h.constructed.length, failure === 'constructor-throws' ? 1 : 0)
    if (h.constructed.length) assert.equal(h.constructed[0].cwd, join(fakeHome, '.chat2api-local-private'))
    assert.equal(h.attempts.length, 0)
    assert.equal(h.logManagers.length, 0)
    assert.equal(h.state.accounts, original)
  }
})

test('configuration logging contains only known top-level changedKeys, never secret values or unknown keys', async () => {
  const updates = {
    managementApi: { enabled: true, managementApiSecret: token },
    apiKeys: [{ key: otherToken }],
    [echoedSecret]: { nested: token },
  }
  const calls = []
  const appLogs = []
  const h = await loadSource('src/main/store/config.ts', {
    './store': { storeManager: {
      getConfig: () => defaultConfig,
      updateConfig(value) { calls.push(value); return { ...defaultConfig, ...value } },
      addLog(...args) { appLogs.push(plain(args)) },
    } },
    './configSecrets': { redactExportConfigSecrets: value => ({ ...value, apiKeys: [], managementApi: { managementApiSecret: '' } }) },
    './types': typeImports,
    '../../shared/toolCalling': { normalizeToolCallingConfig: value => value },
  })
  const result = h.exports.ConfigManager.update(updates)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], updates)
  assert.equal(result.managementApi.managementApiSecret, token)
  assert.deepEqual(appLogs, [['info', 'Update app configuration', { data: { changedKeys: ['managementApi', 'apiKeys'] } }]])
  assertNoSecrets([...h.logs.entries, inspect(appLogs, { depth: 20 })])
})

test('account selection preserves credentials for forwarding without logging any candidate token prefix', async () => {
  const accounts = [account({ token }), account({ token: otherToken }, { id: 'account-2', name: 'Second synthetic account' })]
  const includeCredentials = []
  const provider = { id: 'provider-1', name: 'Synthetic provider', enabled: true }
  const h = await loadSource('src/main/proxy/loadbalancer.ts', {
    '../store/types': typeImports,
    './types': { AccountSelection: undefined },
    './modelMapper': { modelMapper: {
      // This credential-only fixture has no mappings. The production
      // selector now delegates model resolution to the shared ModelMapper.
      getMatchingMapping: () => undefined,
      hasAmbiguousMatchingMapping: () => false,
      mapModel: requested => requested,
    } },
    '../store/store': { storeManager: {
      getProviders: () => [provider],
      getAccountsByProviderId(id, include) { assert.equal(id, provider.id); includeCredentials.push(include); return accounts },
      getEffectiveModels: () => [{ displayName: 'test-model', actualModelId: 'upstream-model' }],
      getConfig: () => ({ modelMappings: {} }),
    } },
  })
  const first = h.exports.loadBalancer.selectAccount('test-model')
  const second = h.exports.loadBalancer.selectAccount('test-model')
  assert.equal(first.account.credentials.token, token)
  assert.equal(second.account.credentials.token, otherToken)
  assert.equal(first.actualModel, 'upstream-model')
  assert.deepEqual(includeCredentials, [true, true])
  assertNoSecrets(h.logs.entries)
})

async function oauthHarness(validateToken) {
  const login = new EventEmitter()
  const progress = []
  const validated = []
  const completed = []
  login.startLogin = async () => ({ success: true })
  login.completeWithSuccess = credentials => { completed.push(credentials); login.emit('complete', { success: true, credentials }) }
  const adapter = {
    setMainWindow() {}, setProgressCallback() {},
    async validateToken(credentials) { validated.push(plain(credentials)); return validateToken(credentials) },
  }
  const h = await loadSource('src/main/oauth/manager.ts', {
    electron: { BrowserWindow: forbidden('OAuth window'), shell: { openExternal: forbidden('OAuth browser') }, app: {} },
    http: { default: { createServer: forbidden('OAuth callback listener') } },
    events: { EventEmitter },
    './types': Object.fromEntries(['ProviderType', 'OAuthResult', 'OAuthOptions', 'OAuthStatus', 'OAuthProgressEvent', 'TokenValidationResult', 'CredentialInfo'].map(name => [name, undefined])),
    './adapters': { createAdapter: () => adapter, BaseOAuthAdapter: undefined },
    // These generic OAuth fixtures intentionally never enter Z.ai reconnect.
    // The production JWT and partition rules have dedicated synthetic tests.
    './zaiSession': {
      readZaiSessionClaims: () => null,
      readZaiTokenIdentity: () => null,
      zaiPersistentPartition: forbidden('Z.ai persisted browser session'),
    },
    '../store/store': { storeManager: {} },
    './inAppLogin': { inAppLoginManager: login, InAppLoginResult: undefined },
  })
  h.exports.oauthManager.setMainWindow({ isDestroyed: () => false, webContents: { send: (...args) => progress.push(plain(args)) } })
  return { ...h, login, progress, validated, completed, manager: h.exports.oauthManager }
}

test('OAuth successful generic and Mimo flows do not log tokens, cookies, identities or prefixes', async () => {
  for (const provider of ['deepseek', 'mimo']) {
    const h = await oauthHarness(async () => ({ valid: true, accountInfo: { userId: echoedSecret }, extra: { token } }))
    const resultPromise = h.manager.startInAppLogin('provider-1', provider)
    if (provider === 'mimo') {
      h.login.emit('tokenFound', { key: 'serviceToken', value: token })
      h.login.emit('tokenFound', { key: 'userId', value: echoedSecret })
      h.login.emit('tokenFound', { key: 'xiaomichatbot_ph', value: otherToken })
    } else {
      h.login.emit('tokenFound', { key: 'token', value: token, allCookies: { session: otherToken } })
    }
    const result = await resultPromise
    assert.equal(result.success, true)
    assert.equal(h.completed.length, 1)
    assert.equal(h.validated.length, 1)
    if (provider === 'mimo') {
      assert.deepEqual(plain(result.credentials), { service_token: token, user_id: echoedSecret, ph_token: otherToken })
    } else {
      assert.equal(result.credentials.token, token)
      assert.equal(result.credentials.cookies.session, otherToken)
    }
    assert.equal(h.timers.size, 0)
    assertNoSecrets([...h.logs.entries, inspect(h.progress, { depth: 20 })])
    assert.equal(h.login.listenerCount('tokenFound'), 0)
  }
})

test('OAuth validation errors and malformed responses cannot leak exception or provider payloads', async () => {
  for (const validate of [
    async () => ({ valid: false, error: `${echoedSecret} ${token}`, credentials: { token: otherToken } }),
    async () => { throw Object.assign(new Error(echoedSecret), { request: { headers: { authorization: token } } }) },
    async () => null,
  ]) {
    const h = await oauthHarness(validate)
    const resultPromise = h.manager.startInAppLogin('provider-1', 'deepseek')
    h.login.emit('tokenFound', { key: 'token', value: token })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.validated.length, 1)
    assert.equal(h.completed.length, 0)
    assertNoSecrets([...h.logs.entries, inspect(h.progress, { depth: 20 })])
    h.login.emit('complete', { success: false, error: 'Synthetic login cancelled' })
    assert.equal((await resultPromise).success, false)
    assert.equal(h.login.listenerCount('tokenFound'), 0)
    assert.equal(h.timers.size, 0)
  }
})
