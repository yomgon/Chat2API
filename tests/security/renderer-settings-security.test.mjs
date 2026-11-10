import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const readSource = (path) => readFileSync(new URL(path, root), 'utf8')
const storeSource = readSource('src/renderer/src/stores/settingsStore.ts')
const dataSource = readSource('src/renderer/src/components/settings/DataManagement.tsx')
const keysSource = readSource('src/renderer/src/pages/ApiKeys.tsx')
const storageKey = 'chat2api-settings'
const secretValues = ['SENTINEL_API_SECRET', 'SENTINEL_MANAGEMENT_SECRET', 'SENTINEL_PROVIDER_SECRET']
const mainConfig = {
  autoStart: false,
  autoStartProxy: false,
  oauthProxyMode: 'system',
  language: 'en-US',
  apiKeys: [{ id: 'existing', key: secretValues[0], enabled: true }],
  managementApi: { managementApiSecret: secretValues[1] },
  credentials: { token: secretValues[2] },
  requestLogConfig: { enabled: true, maxEntries: 200 },
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const assertNoSecrets = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secretValues) assert.ok(!text.includes(secret), 'Secret reached a persistent boundary')
}
const legacySettings = (version = 0) => ({
  version,
  state: {
    theme: 'dark',
    language: 'zh-CN',
    sidebarCollapsed: true,
    autoStart: true,
    logRetentionDays: 45,
    maxLogs: 500,
    config: clone(mainConfig),
    apiKeys: clone(mainConfig.apiKeys),
    managementApiSecret: secretValues[1],
    fetchConfig: secretValues[2],
    futureField: secretValues[2],
  },
  extraSecret: secretValues[0],
})

function executable(source) {
  return stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^export (?:default )?/gm, '')
}

// Exercise the production selectors, storage adapter, middleware callbacks and
// store actions. React/Zustand/IPC are deliberately stubbed: this is an offline
// boundary test, not an Electron launch or a real middleware integration test.
function loadSettings(initial = null) {
  const entries = new Map(initial === null ? [] : [[storageKey, initial]])
  const writes = []
  const logs = []
  const calls = []
  const languages = []
  const failures = { read: false, write: false, remove: false, ipc: false }
  const localStorage = {
    getItem(name) {
      if (failures.read) throw new Error(secretValues[0])
      return entries.get(name) ?? null
    },
    setItem(name, value) {
      if (failures.write) throw new Error(secretValues[0])
      writes.push({ name, value })
      entries.set(name, value)
    },
    removeItem(name) {
      if (failures.remove) throw new Error(secretValues[1])
      entries.delete(name)
    },
  }
  let options
  const context = {
    localStorage,
    console: {
      warn: (...args) => logs.push(args.map(String).join(' ')),
      error: (...args) => logs.push(args.map(String).join(' ')),
    },
    i18n: { changeLanguage: async (language) => { languages.push(language) } },
    window: {
      electronAPI: {
        config: {
          get: async () => { calls.push({ method: 'get' }); return mainConfig },
          update: async (updates) => {
            calls.push({ method: 'update', updates })
            if (failures.ipc) throw new Error('Offline IPC failure')
          },
        },
      },
    },
    create: () => (initializer) => {
      let state
      const api = {
        getState: () => state,
        setState: (update) => {
          state = { ...state, ...(typeof update === 'function' ? update(state) : update) }
          options.storage.setItem(options.name, {
            state: options.partialize(state),
            version: options.version,
          })
        },
      }
      state = initializer(api.setState, api.getState, api)
      return Object.assign(() => state, api)
    },
    persist: (initializer, persistOptions) => {
      options = persistOptions
      return initializer
    },
    createJSONStorage: (getStorage) => {
      const storage = getStorage()
      return {
        getItem(name) {
          const raw = storage.getItem(name)
          return raw === null ? null : JSON.parse(raw)
        },
        setItem: (name, value) => storage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => storage.removeItem(name),
      }
    },
    fetch: () => { throw new Error('Network is forbidden in renderer security tests') },
  }
  const source = storeSource.replace(/^import[^\r\n]*\r?\n/gm, '')
  vm.runInNewContext(executable(source) + '\nObject.assign(globalThis, { useSettingsStore, pickPersistedSettings, serializeSettings, sanitizeStoredSettings, SETTINGS_STORAGE_KEY });', context, {
    filename: fileURLToPath(new URL('src/renderer/src/stores/settingsStore.ts', root)),
    timeout: 2000,
  })
  return { context, options, entries, writes, logs, calls, languages, failures, localStorage, store: context.useSettingsStore }
}

function loadDataHandlers(fixture) {
  const toasts = []
  const timers = []
  const blobs = []
  const downloads = []
  const revoked = []
  const context = {
    ...fixture.context,
    Blob,
    useState: (initial) => [initial, () => {}],
    useTranslation: () => ({ t: (key) => key }),
    useToast: () => ({ toast: (toast) => toasts.push(toast) }),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    window: { ...fixture.context.window, location: { reload: () => assert.fail('Reload must only be scheduled') } },
    URL: {
      createObjectURL: (blob) => { blobs.push(blob); return 'blob:offline-security-test' },
      revokeObjectURL: (url) => revoked.push(url),
    },
    document: {
      createElement: () => {
        const anchor = { href: '', download: '', click: () => downloads.push(anchor) }
        return anchor
      },
      body: { appendChild: () => {}, removeChild: () => {} },
    },
  }
  const start = dataSource.indexOf('export function DataManagement()')
  const end = dataSource.indexOf('\n  return (', start)
  assert.ok(start >= 0 && end > start)
  const source = dataSource.slice(start, end) + '\n  return { handleExportConfig, handleImportConfig, requestLogConfig, updateRequestLogConfig }\n}\nglobalThis.handlers = DataManagement();'
  vm.runInNewContext(executable(source), context, { timeout: 2000 })
  return { ...context.handlers, toasts, timers, blobs, downloads, revoked }
}

async function importBackup(handlers, backup) {
  const event = { target: { files: [{ text: async () => JSON.stringify(backup) }], value: 'selected.json' } }
  await handlers.handleImportConfig(event)
  assert.equal(event.target.value, '')
}

function loadKeyHelpers(crypto = webcrypto) {
  const context = {
    crypto,
    Math: Object.assign(Object.create(Math), { random: () => assert.fail('Math.random must not generate keys or IDs') }),
  }
  const start = keysSource.indexOf('function generateApiKey()')
  const end = keysSource.indexOf('export default function ApiKeysPage()')
  assert.ok(start >= 0 && end > start)
  vm.runInNewContext(executable(keysSource.slice(start, end)) + '\nObject.assign(globalThis, { generateApiKey, generateId });', context, { timeout: 2000 })
  return context
}

function loadAddKeyHandler(crypto = webcrypto) {
  const context = loadKeyHelpers(crypto)
  const updates = []
  const toasts = []
  const dialogStates = []
  const names = []
  Object.assign(context, {
    newKeyName: ' Offline test ',
    apiKeys: mainConfig.apiKeys,
    updateConfig: async (update) => updates.push(update),
    toast: (toast) => toasts.push(toast),
    t: (key) => key,
    setShowAddDialog: (state) => dialogStates.push(state),
    setNewKeyName: (name) => names.push(name),
  })
  const start = keysSource.indexOf('  const handleAddKey = async')
  const end = keysSource.indexOf('  const handleDeleteKey = async', start)
  assert.ok(start >= 0 && end > start)
  vm.runInNewContext(executable(keysSource.slice(start, end)) + '\nglobalThis.addKey = handleAddKey;', context, { timeout: 2000 })
  return { addKey: context.addKey, updates, toasts, dialogStates, names }
}

test('config stays available to IPC/UI while all store writes exclude secrets', async () => {
  const fixture = loadSettings()
  fixture.store.getState().setConfig(mainConfig)
  assert.equal(fixture.store.getState().config, mainConfig)
  fixture.store.getState().setTheme('dark')
  await fixture.store.getState().fetchConfig()
  const replacement = [{ id: 'replacement', key: secretValues[2], enabled: true }]
  await fixture.store.getState().updateConfig({ apiKeys: replacement })
  assert.equal(fixture.store.getState().config.apiKeys, replacement)
  assert.equal(fixture.calls.at(-1).updates.apiKeys, replacement)
  assert.equal(fixture.store.getState().config.managementApi.managementApiSecret, secretValues[1])
  for (const write of fixture.writes) {
    assertNoSecrets(write.value)
    assert.equal('config' in JSON.parse(write.value).state, false)
  }
  fixture.failures.ipc = true
  await fixture.store.getState().updateConfig({ apiKeys: [] })
  assert.equal(fixture.store.getState().config.apiKeys, replacement)
  assertNoSecrets(fixture.entries.get(storageKey))
})

test('legacy v0, missing-version and current v1 entries are scrubbed before hydration', () => {
  for (const version of [0, 1, undefined]) {
    const raw = legacySettings(version)
    const original = JSON.stringify(raw)
    const fixture = loadSettings(original)
    const restored = fixture.options.storage.getItem(storageKey)
    assert.equal(restored.version, version ?? 0)
    assertNoSecrets(restored)
    assertNoSecrets(fixture.entries.get(storageKey))
    assert.equal(restored.state.theme, 'dark')
    assert.equal(restored.state.language, 'zh-CN')
    assert.equal(restored.state.logRetentionDays, 45)
    assert.deepEqual(Object.keys(restored).sort(), ['state', 'version'])
    const migrated = fixture.options.migrate(restored.state, restored.version)
    const merged = fixture.options.merge(migrated, fixture.store.getState())
    assert.equal(merged.config, null)
    assert.equal(merged.fetchConfig, fixture.store.getState().fetchConfig)
    assert.equal(merged.sidebarCollapsed, true)
    fixture.options.onRehydrateStorage()(merged)
    assert.deepEqual(fixture.languages, ['zh-CN'])
    assert.equal(fixture.calls.length, 0, 'Hydration must not call main-process actions')
    assert.equal(JSON.stringify(raw), original, 'Migration must not mutate input')
    assert.equal(fixture.options.version, 1)
  }
})

test('rehydration cannot replace a config already fetched from main or overwrite actions', async () => {
  const fixture = loadSettings()
  await fixture.store.getState().fetchConfig()
  const current = fixture.store.getState()
  const merged = fixture.options.merge(legacySettings(1).state, current)
  assert.equal(merged.config, mainConfig)
  assert.equal(merged.fetchConfig, current.fetchConfig)
  assert.equal(merged.setConfig, current.setConfig)
  assert.equal(merged.language, 'zh-CN')
  assert.equal('managementApiSecret' in merged, false)
  assert.equal('apiKeys' in merged, false)
  assertNoSecrets(fixture.options.partialize(merged))
})

test('only typed, bounded preferences survive; unknown nested fields never cross', () => {
  const fixture = loadSettings()
  const state = {
    theme: secretValues[0], language: {}, oauthProxyMode: 1, closeBehavior: [],
    logLevel: false, sidebarCollapsed: 'false', autoStart: 1,
    logRetentionDays: 366, maxLogs: Infinity,
    proxyEnabled: false, credentialEncryption: true,
    config: mainConfig, unknown: { managementApiSecret: secretValues[1] },
  }
  assert.deepEqual(clone(fixture.context.pickPersistedSettings(state)), { proxyEnabled: false, credentialEncryption: true })
  for (const value of [null, [], 'dark', 4]) {
    assert.deepEqual(clone(fixture.context.pickPersistedSettings(value)), {})
  }
  for (const value of [-1, 0, 1.5, 366, NaN, Infinity, '30']) {
    assert.equal('logRetentionDays' in fixture.context.pickPersistedSettings({ logRetentionDays: value }), false)
  }
  for (const value of [-1, 0, 99, 100001, 100.5, '100']) {
    assert.equal('maxLogs' in fixture.context.pickPersistedSettings({ maxLogs: value }), false)
  }
  assert.deepEqual(clone(fixture.context.pickPersistedSettings({ logRetentionDays: 365, maxLogs: 100000 })), { logRetentionDays: 365, maxLogs: 100000 })
})

test('invalid envelopes/unsupported versions are rejected and stale stored copies are discarded', () => {
  for (const raw of ['{broken', 'null', '[]', '{}', '{"state":[]}', '{"state":{},"version":2}', '{"state":{},"version":"0"}']) {
    const fixture = loadSettings(raw)
    assert.throws(() => fixture.context.sanitizeStoredSettings(raw))
    assert.equal(fixture.options.storage.getItem(storageKey), null)
    assert.equal(fixture.entries.has(storageKey), false)
    assertNoSecrets(fixture.logs)
  }
})

test('canonical current entries are read without an unnecessary storage rewrite', () => {
  const fixture = loadSettings()
  const serialized = fixture.context.serializeSettings({ theme: 'dark', language: 'en-US' })
  fixture.entries.set(storageKey, serialized)
  assert.equal(fixture.options.storage.getItem(storageKey).state.theme, 'dark')
  assert.equal(fixture.writes.length, 0)
})

test('failed cleanup never restores raw secrets and reports a failed removal safely', () => {
  const fixture = loadSettings(JSON.stringify(legacySettings()))
  fixture.failures.write = true
  const cleaned = fixture.options.storage.getItem(storageKey)
  assertNoSecrets(cleaned)
  assert.equal(fixture.entries.has(storageKey), false)
  assertNoSecrets(fixture.logs)

  const blocked = loadSettings(JSON.stringify(legacySettings()))
  blocked.failures.write = true
  blocked.failures.remove = true
  let failure
  try { blocked.options.storage.getItem(storageKey) } catch (error) { failure = error }
  assert.ok(failure)
  blocked.options.onRehydrateStorage()(undefined, failure)
  assert.equal(blocked.store.getState().config, null)
  assert.equal(blocked.logs.length, 1)
  assertNoSecrets(blocked.logs)
})

test('export uses live safe preferences, preserves settings string format and omits secrets', async () => {
  const fixture = loadSettings()
  fixture.store.getState().setConfig(mainConfig)
  fixture.store.getState().setTheme('light')
  fixture.entries.set(storageKey, JSON.stringify(legacySettings()))
  const handlers = loadDataHandlers(fixture)
  await handlers.handleExportConfig()
  assert.equal(handlers.blobs.length, 1)
  const text = await handlers.blobs[0].text()
  assertNoSecrets(text)
  const backup = JSON.parse(text)
  assert.equal(backup.secretsIncluded, false)
  assert.equal(typeof backup.settings, 'string')
  const stored = JSON.parse(backup.settings)
  assert.equal(stored.version, 1)
  assert.equal(stored.state.theme, 'light')
  assert.equal('config' in stored.state, false)
  assert.equal(handlers.downloads.length, 1)
  assert.equal(handlers.revoked.length, 1)
})

test('legacy backup import sanitizes before any write and preserves non-secret preferences', async () => {
  const fixture = loadSettings()
  const handlers = loadDataHandlers(fixture)
  await importBackup(handlers, { version: '1.1.2', settings: JSON.stringify(legacySettings()) })
  assert.equal(fixture.writes.length, 1)
  assertNoSecrets(fixture.writes[0].value)
  const restored = JSON.parse(fixture.entries.get(storageKey))
  assert.equal(restored.state.theme, 'dark')
  assert.equal(restored.state.language, 'zh-CN')
  assert.equal(restored.state.logRetentionDays, 45)
  assert.equal(restored.version, 0)
  assert.equal(handlers.timers.length, 1)
  assert.equal(handlers.toasts.at(-1).title, 'common.success')
  assert.equal(fixture.calls.length, 0)
})

test('invalid imports and failed writes keep current preferences and never schedule success', async () => {
  for (const backup of [null, {}, [], { settings: {} }, { settings: 'bad' }, { settings: '{"state":{},"version":99}' }]) {
    const fixture = loadSettings('{"state":{"theme":"light"},"version":1}')
    const handlers = loadDataHandlers(fixture)
    const before = fixture.entries.get(storageKey)
    await importBackup(handlers, backup)
    assert.equal(fixture.entries.get(storageKey), before)
    assert.equal(fixture.writes.length, 0)
    assert.equal(handlers.timers.length, 0)
    assert.equal(handlers.toasts.at(-1).variant, 'destructive')
  }
  const fixture = loadSettings('{"state":{"theme":"light"},"version":1}')
  const handlers = loadDataHandlers(fixture)
  fixture.failures.write = true
  await importBackup(handlers, { settings: JSON.stringify(legacySettings()) })
  assert.equal(fixture.entries.get(storageKey), '{"state":{"theme":"light"},"version":1}')
  assert.equal(handlers.timers.length, 0)
  assert.equal(handlers.toasts.at(-1).variant, 'destructive')
})

test('request logging defaults to off without replacing an explicit existing setting', async () => {
  const fixture = loadSettings()
  assert.equal(loadDataHandlers(fixture).requestLogConfig.enabled, false)
  fixture.store.getState().setConfig({ ...mainConfig, requestLogConfig: undefined })
  const handlers = loadDataHandlers(fixture)
  assert.equal(handlers.requestLogConfig.enabled, false)
  assert.equal(handlers.requestLogConfig.includeBodies, false)
  await handlers.updateRequestLogConfig({ maxEntries: 300 })
  assert.equal(fixture.calls.at(-1).updates.requestLogConfig.enabled, false)
  assert.equal(fixture.calls.at(-1).updates.requestLogConfig.maxEntries, 300)
  fixture.store.getState().setConfig(mainConfig)
  assert.equal(loadDataHandlers(fixture).requestLogConfig.enabled, true)
})

test('API keys keep the sk- plus 48 alphanumeric contract using WebCrypto', () => {
  const { generateApiKey, generateId } = loadKeyHelpers()
  const keys = new Set(Array.from({ length: 16 }, () => generateApiKey()))
  assert.equal(keys.size, 16)
  for (const key of keys) assert.match(key, /^sk-[A-Za-z0-9]{48}$/)
  assert.match(generateId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('API key generation rejects biased byte values and refills from the crypto source', () => {
  let calls = 0
  const { generateApiKey } = loadKeyHelpers({
    getRandomValues(bytes) {
      calls++
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = calls === 1 ? 248 + (index % 8) : index % 62
      }
      return bytes
    },
  })
  assert.equal(generateApiKey(), 'sk-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.slice(0, 48))
  assert.equal(calls, 2)
})

test('crypto failure never falls back to Math.random or writes a partial API key', async () => {
  for (const crypto of [null, { randomUUID: () => 'test-id', getRandomValues: () => { throw new Error('crypto unavailable') } }]) {
    const { generateApiKey } = loadKeyHelpers(crypto)
    assert.throws(() => generateApiKey())
    const handlers = loadAddKeyHandler(crypto)
    await handlers.addKey()
    assert.equal(handlers.updates.length, 0)
    assert.equal(handlers.dialogStates.length, 0)
    assert.equal(handlers.names.length, 0)
    assert.equal(handlers.toasts.at(-1).variant, 'destructive')
  }
})

test('secure key creation preserves existing API key records and the updateConfig contract', async () => {
  const before = JSON.stringify(mainConfig.apiKeys)
  const handlers = loadAddKeyHandler()
  await handlers.addKey()
  assert.equal(handlers.updates.length, 1)
  assert.equal(handlers.updates[0].apiKeys[0], mainConfig.apiKeys[0])
  const created = handlers.updates[0].apiKeys[1]
  assert.equal(created.name, 'Offline test')
  assert.match(created.key, /^sk-[A-Za-z0-9]{48}$/)
  assert.equal(created.enabled, true)
  assert.equal(created.usageCount, 0)
  assert.equal(typeof created.createdAt, 'number')
  assert.equal(JSON.stringify(mainConfig.apiKeys), before)
  assert.deepEqual(handlers.dialogStates, [false])
  assert.deepEqual(handlers.names, [''])
})
