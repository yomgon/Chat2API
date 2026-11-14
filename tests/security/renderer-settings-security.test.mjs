import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const readSource = (path) => readFileSync(new URL(path, root), 'utf8')
const storeSource = readSource('src/renderer/src/stores/settingsStore.ts')
const dataSource = readSource('src/renderer/src/components/settings/DataManagement.tsx')
const keysSource = readSource('src/renderer/src/pages/ApiKeys.tsx')
const dashboardSource = readSource('src/renderer/src/pages/Dashboard.tsx')
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

// The renderer no longer creates secrets or replaces the entire API key list.
// Exercise the real trusted-main create callback extracted from production AST.
function loadMainCreateHandler({ randomBytesImpl = randomBytes, randomUUIDImpl = randomUUID,
  failWrites = false } = {}) {
  const src = readSource('src/main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', src, ts.ScriptTarget.Latest, true)
  let callback
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'handleTrusted' && node.arguments.length >= 2
        && ts.isPropertyAccessExpression(node.arguments[0])
        && node.arguments[0].name.text === 'API_KEYS_CREATE') {
      callback = node.arguments[1].getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(callback, 'Dedicated key-create trusted IPC handler must exist')
  const mod = { exports: {} }
  const compiled = ts.transpileModule('exports.handler = ' + callback, {
    fileName: 'create-key-handler.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  let config = clone(mainConfig)
  const writes = []
  const storeManager = {
    getConfig: () => clone(config),
    updateConfig(patch) {
      if (failWrites) throw Error('Synthetic private persistence refusal')
      writes.push(clone(patch))
      config = { ...config, ...clone(patch) }
      return clone(config)
    },
  }
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, storeManager,
    randomBytes: randomBytesImpl, randomUUID: randomUUIDImpl,
    Buffer, Date, Error,
    Math: Object.assign(Object.create(Math), {
      random: () => assert.fail('Math.random must never produce API keys'),
    }),
  }, { timeout: 2000 })
  return { create: mod.exports.handler, writes, config: () => clone(config) }
}

function loadAddKeyHandler({ failCreate = false } = {}) {
  const context = {}
  const calls = []
  const refreshes = []
  const toasts = []
  const dialogStates = []
  const names = []
  Object.assign(context, {
    newKeyName: ' Offline test ',
    window: { electronAPI: { apiKeys: {
      create: async name => {
        calls.push(name)
        if (failCreate) throw Error('Synthetic credential store failure')
        return { id: 'synthetic-created', name, key: 'sk-' + 'A'.repeat(48) }
      },
    } } },
    fetchConfig: async () => { refreshes.push(true) },
    toast: (toast) => toasts.push(toast),
    t: (key) => key,
    setShowAddDialog: (state) => dialogStates.push(state),
    setNewKeyName: (name) => names.push(name),
  })
  const start = keysSource.indexOf('  const handleAddKey = async')
  const end = keysSource.indexOf('  const handleDeleteKey = async', start)
  assert.ok(start >= 0 && end > start)
  vm.runInNewContext(executable(keysSource.slice(start, end)) + '\nglobalThis.addKey = handleAddKey;', context, { timeout: 2000 })
  return { addKey: context.addKey, calls, refreshes, toasts, dialogStates, names }
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

test('trusted main API key generator retains the sk- plus 48 alphanumeric contract', async () => {
  const f = loadMainCreateHandler()
  const keys = new Set()
  for (let i = 0; i < 16; i++) {
    const created = await f.create(null, 'Synthetic')
    keys.add(created.key)
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
  assert.equal(keys.size, 16)
  for (const key of keys) assert.match(key, /^sk-[A-Za-z0-9]{48}$/)
  assert.equal(f.writes.length, 16)
})

test('main API key generation rejects biased byte values and refills from node:crypto', async () => {
  let calls = 0
  const f = loadMainCreateHandler({
    randomBytesImpl(size) {
      calls++
      const bytes = Buffer.alloc(size)
      for (let index = 0; index < size; index++) {
        bytes[index] = calls === 1 ? 248 + (index % 8) : index % 62
      }
      return bytes
    },
  })
  const created = await f.create(null, 'Synthetic')
  assert.equal(created.key, 'sk-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.slice(0, 48))
  assert.equal(calls, 2)
})

test('main crypto failure and GUI IPC refusal never produce a partial API key', async () => {
  const f = loadMainCreateHandler({
    randomBytesImpl: () => { throw Error('Synthetic crypto unavailable') },
  })
  await assert.rejects(f.create(null, 'Synthetic'))
  assert.equal(f.writes.length, 0)
  for (const failCreate of [true]) {
    const handlers = loadAddKeyHandler({ failCreate })
    await handlers.addKey()
    assert.equal(handlers.calls.length, 1)
    assert.equal(handlers.refreshes.length, 0)
    assert.equal(handlers.dialogStates.length, 0)
    assert.equal(handlers.names.length, 0)
    assert.equal(handlers.toasts.at(-1).variant, 'destructive')
  }
})

test('secure main key creation preserves existing records; GUI uses only keyed create IPC', async () => {
  const before = JSON.stringify(mainConfig.apiKeys)
  const f = loadMainCreateHandler()
  const created = await f.create(null, 'Offline test')
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].apiKeys[0].key, secretValues[0])
  assert.equal(f.writes[0].apiKeys[1].name, 'Offline test')
  assert.match(created.key, /^sk-[A-Za-z0-9]{48}$/)
  assert.equal(created.enabled, true)
  assert.equal(created.usageCount, 0)
  assert.equal(typeof created.createdAt, 'number')
  const handlers = loadAddKeyHandler()
  await handlers.addKey()
  assert.deepEqual(handlers.calls, ['Offline test'])
  assert.equal(handlers.refreshes.length, 1)
  assert.equal(JSON.stringify(mainConfig.apiKeys), before)
  assert.deepEqual(handlers.dialogStates, [false])
  assert.deepEqual(handlers.names, [''])
})

test('local101 RED: refused main Settings writes do not persist a false auto-start, proxy or OAuth state', async () => {
  const f = loadSettings()
  f.failures.ipc = true
  await f.store.getState().setAutoStart(true)
  await f.store.getState().setAutoStartProxy(true)
  await f.store.getState().setOauthProxyMode('none')
  await f.store.getState().setLanguage('zh-CN')
  assert.equal(f.store.getState().autoStart, false)
  assert.equal(f.store.getState().autoStartProxy, false)
  assert.equal(f.store.getState().oauthProxyMode, 'system')
  assert.equal(f.store.getState().language, 'en-US')
  assert.equal(f.languages.includes('zh-CN'), false,
    'Rejected language persistence must not change the visible UI translation')
  const saved = JSON.parse(f.entries.get(storageKey) || '{"state":{}}').state
  assert.notEqual(saved.autoStart, true)
  assert.notEqual(saved.autoStartProxy, true)
  assert.notEqual(saved.oauthProxyMode, 'none')
  assert.notEqual(saved.language, 'zh-CN')
})

test('local101 RED: previous Settings fetch cannot undo a newer committed main-config event', async () => {
  const f = loadSettings()
  let resolve
  f.context.window.electronAPI.config.get = () => new Promise(yes => { resolve = yes })
  const older = f.store.getState().fetchConfig()
  const committed = {
    ...mainConfig, autoStart: true, autoStartProxy: true, language: 'zh-CN',
    modelMappings: { newest: { requestModel: 'newest', actualModel: 'local101-wire' } },
  }
  f.store.getState().setConfig(committed)
  resolve(clone(mainConfig))
  await older
  assert.equal(f.store.getState().config.modelMappings.newest.actualModel, 'local101-wire')
  assert.equal(f.store.getState().autoStart, true)
  assert.equal(f.store.getState().autoStartProxy, true)
  assert.equal(f.store.getState().language, 'zh-CN')
})

test('local101 RED: old refused Settings mutation cannot roll back a newer committed config event', async () => {
  const f = loadSettings()
  f.store.getState().setConfig(mainConfig)
  let reject
  f.context.window.electronAPI.config.update = () =>
    new Promise((_yes,no) => {reject = no})
  const older = f.store.getState().updateConfig({ enableApiKey: true })
  const committed = { ...mainConfig, enableApiKey: false,
    requestLogConfig: { ...mainConfig.requestLogConfig, enabled: false } }
  f.store.getState().setConfig(committed)
  reject(Error('SYNTHETIC_OLD_WRITE_REFUSED'))
  await older
  assert.equal(f.store.getState().config.enableApiKey, false)
  assert.equal(f.store.getState().config.requestLogConfig.enabled, false)
})

test('local101 RED: rejected API-key global enable must not display a success toast', async () => {
  const f = loadSettings()
  f.store.getState().setConfig(mainConfig)
  f.context.window.electronAPI.config.update = async () => false
  const toasts=[]
  const context={ t:x=>x,toast:x=>toasts.push(x),
    updateConfig:f.store.getState().updateConfig }
  const start=keysSource.indexOf('  const handleToggleGlobalEnabled = async')
  const end=keysSource.indexOf('  const formatDate =',start)
  assert.ok(start>=0&&end>start)
  vm.runInNewContext(executable(keysSource.slice(start,end))+
    '\nthis.toggleGlobal=handleToggleGlobalEnabled;',context,{timeout:2000})
  await context.toggleGlobal(true)
  assert.equal(toasts.at(-1)?.variant,'destructive')
  assert.equal(f.store.getState().config.enableApiKey,mainConfig.enableApiKey,
    'A rejected write cannot change the durable enabled flag')
})

test('local101 RED: denied native Proxy Start cannot paint the Dashboard toggle as Running',async()=>{
  const tree=ts.createSourceFile('Dashboard.tsx',dashboardSource,ts.ScriptTarget.Latest,
    true,ts.ScriptKind.TSX)
  let declaration
  const visit=node=>{
    if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='handleToggleProxy')
      declaration=node.getText(tree)
    ts.forEachChild(node,visit)
  }
  visit(tree)
  assert.ok(declaration,'Production Dashboard start/stop action required')
  const events=[]
  const ctx={
    useCallback:f=>f,
    proxyStatus:{isRunning:false},
    setProxyEnabled:v=>events.push(['claimed-running',v]),
    refreshData:()=>events.push(['authoritative-refresh']),
    window:{electronAPI:{proxy:{start:async()=>false,stop:async()=>false}}},
    console:{error(){}},
  }
  vm.runInNewContext(executable('const '+declaration+';')+
    '\nthis.nativeProxyToggle=handleToggleProxy;',ctx,{timeout:2000})
  await ctx.nativeProxyToggle()
  assert.equal(events.some(event=>event[0]==='claimed-running'),false,
    'A native start() rejection is not a running Koa listener')
  assert.equal(events.some(event=>event[0]==='authoritative-refresh'),true)
})
