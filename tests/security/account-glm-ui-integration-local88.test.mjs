import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

// Real production AccountManager, exact trusted IPC registration, renderer
// validation callback and GLMAdapter. All storage/upstream/renderer capabilities
// are synthetic; no operational profile or vendor request is ever opened.
const nodeRequire = createRequire(import.meta.url)
const src = path => readFileSync(new URL('../../src/' + path, import.meta.url), 'utf8')
const compile = (source, filename) => ts.transpileModule(source, {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))
function run(source, filename, imports = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(compile(source, filename), {
    module, exports: module.exports, Date, Math, Error, Buffer, TextDecoder,
    TextEncoder, Promise, URL, URLSearchParams,
    console: { log() {}, error() {}, warn() {}, info() {} },
    process: { env: {} },
    require(id) {
      if (Object.hasOwn(imports, id)) return imports[id]
      if (id.startsWith('.')) throw Error('Unapproved local88 module: ' + id)
      return nodeRequire(id)
    },
    ...globals,
  }, { filename, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return module.exports
}
function registration(channel) {
  const source = src('main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  let result
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'handleTrusted' &&
        node.arguments[0]?.getText(tree) === channel) result = node.getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(result, 'Production trusted handler registration required: ' + channel)
  return result
}
function rendererMetadataHelper() {
  const source = src('main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = tree.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'toRendererAccountMetadata')
  assert.ok(declaration,'Actual trusted renderer-metadata boundary must exist')
  return declaration.getText(tree)
}
function updateFixture() {
  const initial = { id: 'stable88', providerId: 'glm', name: 'Local Account',
    credentials: { refreshToken: 'LOCAL88_ONLY' }, createdAt: 10,
    updatedAt: 11, status: 'error', requestCount: 2, todayUsed: 1 }
  let account = clone(initial)
  const writes = []
  const storeManager = {
    getAccountById: id => id === account.id ? clone(account) : undefined,
    updateAccount(id, changes) {
      writes.push({ id, changes: clone(changes) })
      if (id !== account.id) return null
      account = { ...account, ...clone(changes), updatedAt: Date.now() }
      return clone(account)
    },
    addLog() {},
  }
  const AccountManager = run(src('main/store/accounts.ts'), 'store/accounts.ts',
    { './store': { storeManager }, './validator': { validateCredentials: async () => ({ valid: false }) } }).AccountManager
  const callbacks = new Map()
  run(rendererMetadataHelper() + '\nexports.register = handleTrusted => { ' +
    registration('IpcChannels.ACCOUNTS_UPDATE') + '; }',
    'ipc/account-update-registration.ts', {}, { IpcChannels: { ACCOUNTS_UPDATE: 'account:update' }, AccountManager })
    .register((channel, handler) => callbacks.set(channel, handler))
  const edit = callbacks.get('account:update')
  assert.equal(typeof edit, 'function')
  return { original: initial, writes, state: () => clone(account),
    manager: AccountManager, edit: patch => edit({}, 'stable88', patch) }
}
for (const patch of [
  { id: 'imposter88' },
  { providerId: 'qwen-ai' },
  { createdAt: -1 },
  { requestCount: 99999 },
  { todayUsed: 0 },
  { status: 'active' },
  { credentials: { refreshToken: 'LOCAL88_ONLY' }, usageDay: '2099-01-01' },
]) {
  test('trusted account-edit IPC cannot mutate immutable identity/status/quota: ' +
    Object.keys(patch).join(','), async () => {
    const f = updateFixture()
    await assert.rejects(() => f.edit(patch))
    assert.deepEqual(f.state(), f.original)
    assert.equal(f.writes.length, 0, 'Never call durable writer for forbidden edit')
  })
}
test('trusted account-edit IPC still saves permitted name and limit once', async () => {
  const f = updateFixture()
  const updated = await f.edit({ name: 'Updated', dailyLimit: 6 })
  assert.equal(updated.id, f.original.id)
  assert.equal(updated.providerId, 'glm')
  assert.equal(updated.name, 'Updated')
  assert.equal(updated.dailyLimit, 6)
  assert.equal(f.writes.length, 1)
})

function rendererValidationFixture({ outcome, persistentStatus, rejected = false }) {
  const original = { id: 'stable88', providerId: 'glm', name: 'Account',
    status: 'active', credentials: {} }
  let local = clone(original)
  const notices = [], calls = { validate: 0, reread: 0, localEdits: 0 }
  const state = {
    selectedProviderId: 'glm',
    getAccountsByProvider: () => [clone(local)],
    updateAccount(id, patch) {
      calls.localEdits++
      if (id === local.id) local = { ...local, ...clone(patch) }
    },
    setAccounts(accounts) {
      local = clone(accounts.find(a => a.id === original.id))
    },
    updateAccountCount() {},
  }
  const source = src('renderer/src/pages/Providers.tsx')
  const tree = ts.createSourceFile('Providers.tsx', source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration
  let reloadDeclaration
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleValidateAccount') {
      declaration = node.getText(tree)
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'reloadAccountMetadata') {
      reloadDeclaration = node.getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(declaration, 'Real renderer callback must exist')
  assert.ok(reloadDeclaration, 'Real renderer persisted metadata reader must exist')
  const window = { electronAPI: { accounts: {
    async validate() {
      calls.validate++
      if (rejected) throw Error('LOCAL88_SYNTHETIC_PERSISTENCE_REFUSAL')
      return outcome
    },
    async getAll() {
      calls.reread++
      return [{ ...original, status: persistentStatus }]
    },
  } } }
  const useProvidersStore = { getState: () => state }
  const handler = run('const ' + reloadDeclaration + ';const ' + declaration +
    ';exports.handler=handleValidateAccount',
    'renderer-validate-local88.ts', {}, {
      store: state, window, useProvidersStore, toast: result => notices.push(clone(result)),
      t: key => key, dataRequestGenerationRef: { current: 0 },
    }).handler
  return { handler: () => handler('stable88'), calls, notices, local: () => clone(local) }
}
test('renderer validation false/in-progress cannot invent durable error state', async () => {
  const f = rendererValidationFixture({ outcome: false, persistentStatus: 'active' })
  await f.handler()
  assert.equal(f.local().status, 'active')
  assert.equal(f.calls.reread, 1, 'UI must reconcile with persisted account, not boolean')
})
test('renderer error/commit refusal cannot locally mark durable active account invalid', async () => {
  const f = rendererValidationFixture({ rejected: true, persistentStatus: 'active' })
  await f.handler()
  assert.equal(f.local().status, 'active')
  assert.equal(f.calls.reread, 1)
  assert.equal(f.notices.at(-1).variant, 'destructive')
})

const GLM_REFRESH = 'LOCAL88_REFRESH_SECRET'
const GLM_NEW_REFRESH = 'LOCAL88_NEW_REFRESH_SECRET'
const GLM_ACCESS = 'LOCAL88_NEW_ACCESS_SECRET'
function glmFixture({ stale = false } = {}) {
  const provider = { id: 'glm', type: 'builtin', apiEndpoint: 'https://chatglm.cn/chatglm' }
  const account = { id: 'glm88', providerId: 'glm', createdAt: 100,
    updatedAt: 101, status: 'active',
    credentials: { refreshToken: GLM_REFRESH, accessToken: 'LOCAL88_OLD_ACCESS',
      persistentOption: 'do-not-drop' } }
  let stored = clone(account)
  const writes = [], calls = []
  const axios = { async post(url, body, config) {
    calls.push({ url, body, config })
    if (url.includes('/user-api/user/refresh')) {
      if (stale) {
        stored.credentials.refreshToken = 'LOCAL88_CONCURRENT_REPLACEMENT'
        stored.updatedAt++
      }
      return { status: 200, data: { code: 0, result: {
        access_token: GLM_ACCESS, refresh_token: GLM_NEW_REFRESH } } }
    }
    if (url.includes('/backend-api/assistant/stream')) {
      return { status: 401, data: {}, headers: {} }
    }
    throw Error('Forbidden local88 upstream route')
  } }
  const storeManager = {
    getAccountById(id, includeCredentials) {
      assert.equal(id, account.id)
      assert.equal(includeCredentials, true)
      return clone(stored)
    },
    updateAccount(id, patch) {
      writes.push({ id, patch: clone(patch) })
      stored = { ...stored, ...clone(patch), updatedAt: stored.updatedAt + 1 }
      return clone(stored)
    },
  }
  const deny = () => { throw Error('Forbidden local88 transport or dependency') }
  const { GLMAdapter } = run(src('main/proxy/adapters/glm.ts'), 'glm.ts', {
    axios: { __esModule: true, default: axios, AxiosError: class extends Error {} },
    crypto, stream: { PassThrough },
    '../../store/store': { storeManager },
    'eventsource-parser': { createParser: deny },
    'form-data': { __esModule: true, default: class {} },
    'mime-types': {}, '../utils/tools': { toolsToSystemPrompt: deny,
      hasToolPromptInjected: () => false, TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: deny },
    '../utils/streamToolHandler': { createBaseChunk: deny },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
    'node:dns/promises': { lookup: deny },
    'node:https': { Agent: class {} },
  })
  const adapter = new GLMAdapter(provider, clone(account))
  return { stored: () => clone(stored), writes, calls,
    invoke: () => adapter.chatCompletion({
      model: 'synthetic-local88-wire', stream: false,
      messages: [{ role: 'user', content: 'Synthetic local only' }],
    }) }
}
test('GLM successful refresh rotation preserves OAuth aliases/options and updates same identity', async () => {
  const f = glmFixture()
  const result = await f.invoke()
  assert.equal(result.response.status, 401, 'Synthetic completion is intentionally rejected')
  assert.equal(f.writes.length, 1)
  assert.equal(f.stored().credentials.refreshToken, GLM_NEW_REFRESH)
  assert.equal(f.stored().credentials.refresh_token, GLM_NEW_REFRESH)
  assert.equal(f.stored().credentials.accessToken, GLM_ACCESS)
  assert.equal(f.stored().credentials.persistentOption, 'do-not-drop')
  assert.equal(f.calls.length, 2, 'One refresh plus one completion, retry0')
})
test('GLM concurrent credential replacement blocks stale refresh persistence and chat effect', async () => {
  const f = glmFixture({ stale: true })
  await assert.rejects(f.invoke(), /GLM credential persistence failed/)
  assert.equal(f.writes.length, 0, 'Stale credential must not overwrite newer login')
  assert.equal(f.stored().credentials.refreshToken, 'LOCAL88_CONCURRENT_REPLACEMENT')
  assert.equal(f.calls.length, 1, 'Do not send model POST after stale authentication')
})
