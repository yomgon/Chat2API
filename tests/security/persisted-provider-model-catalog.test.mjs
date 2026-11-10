import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Isolated execution of the real StoreManager startup method, with no
// Electron, filesystem writes, OS key material, accounts, or HTTP requests.
const source = readFileSync(new URL('../../src/main/store/store.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
function extract(name, kind) {
  let found
  const visit = node => {
    if (kind === 'function' && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast)
    if (kind === 'method' && ts.isMethodDeclaration(node) && node.name.getText(ast) === name) found = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found, 'Production method missing: ' + name)
  return found
}
const snippet = `${extract('hasValidWebModelCatalog', 'function')}\nclass OfflineStore {\n${extract('initializeDefaultProviders', 'method')}\n}\n globalThis.OfflineStore = OfflineStore`
const compiled = ts.transpileModule(snippet, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
} }).outputText
const qwenBuiltin = {
  id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai', chatPath: '/api/v2/chat/completions',
  modelsApiEndpoint: 'https://chat.qwen.ai/api/models',
  headers: { Accept: 'application/json' },
  credentialFields: [{ name: 'token', required: true }],
  description: 'Qwen AI',
  supportedModels: ['Qwen3.7-Max'],
  modelMappings: { 'Qwen3.7-Max': 'qwen3.7-max' },
}
const glmBuiltin = {
  id: 'glm', apiEndpoint: 'https://chatglm.cn/api',
  headers: {}, description: 'GLM', credentialFields: [],
  supportedModels: ['GLM-5.1'], modelMappings: { 'GLM-5.1': 'glm-5.1' },
}
const safeLive = {
  id: 'qwen-ai', type: 'builtin', name: 'Qwen AI', enabled: true,
  supportedModels: ['Qwen3.8-Max', 'Qwen3.8-Omni-Flash'],
  modelMappings: { 'Qwen3.8-Max': 'qwen3.8-max', 'Qwen3.8-Omni-Flash': 'qwen3.8-omni-flash' },
  modelCatalog: { source: 'provider-web', syncedAt: Date.now() },
}
const plain = input => JSON.parse(JSON.stringify(input))

async function startup(providers, builtin = [qwenBuiltin, glmBuiltin]) {
  let write
  const context = {
    BUILTIN_PROVIDERS: plain(builtin),
    sanitizeDeepSeekModelOverrides: value => value,
    Date, Number, Object, JSON, Set,
  }
  vm.runInNewContext(compiled, context, { filename: 'offline-store-model-startup.js', timeout: 2000 })
  const manager = new context.OfflineStore()
  manager.store = {
    get: key => key === 'userModelOverrides' ? {} : undefined,
    set: () => assert.fail('Model startup should not modify unrelated settings'),
  }
  manager.readStoredProviders = () => plain(providers)
  manager.writeStoredProviders = updated => { write = plain(updated) }
  await manager.initializeDefaultProviders()
  assert.ok(write, 'Expected one provider-list write')
  return write
}

test('successful web-chat model discovery survives app restart without losing account-related provider settings', async () => {
  const updated = await startup([{ ...safeLive, extraSetting: 'unchanged', status: 'online' }])
  assert.deepEqual(updated[0].supportedModels, safeLive.supportedModels)
  assert.deepEqual(updated[0].modelMappings, safeLive.modelMappings)
  assert.deepEqual(updated[0].modelCatalog, safeLive.modelCatalog)
  assert.equal(updated[0].extraSetting, 'unchanged')
  assert.equal(updated[0].status, 'online')
  assert.equal(updated[0].apiEndpoint, qwenBuiltin.apiEndpoint)
})

test('static catalog remains authoritative until explicit, successful web refresh', async () => {
  const updated = await startup([{ ...safeLive, modelCatalog: undefined }])
  assert.deepEqual(updated[0].supportedModels, qwenBuiltin.supportedModels)
  assert.deepEqual(updated[0].modelMappings, qwenBuiltin.modelMappings)
  assert.equal(Object.hasOwn(updated[0], 'modelCatalog'), false)
})

test('invalid, expired-looking, and unsupported discovery metadata cannot override trusted built-ins', async () => {
  const cases = [
    { modelCatalog: { source: 'provider-web', syncedAt: Number.MAX_SAFE_INTEGER } },
    { modelCatalog: { source: 'manual', syncedAt: Date.now() } },
    { supportedModels: ['constructor'], modelMappings: { constructor: 'qwen3.8-max' } },
    { supportedModels: ['Qwen3.8-Max'], modelMappings: { 'Qwen3.8-Max': 'https://malicious.invalid' } },
    { supportedModels: ['Qwen3.8-Max'], modelMappings: { 'Qwen3.8-Max': 'qwen3.8-max', extra: 'extra' } },
    { supportedModels: [] },
  ]
  for (const overrides of cases) {
    const [after] = await startup([{ ...safeLive, ...overrides }])
    assert.deepEqual(after.supportedModels, qwenBuiltin.supportedModels)
    assert.deepEqual(after.modelMappings, qwenBuiltin.modelMappings)
    assert.equal(Object.hasOwn(after, 'modelCatalog'), false)
  }
  const [glm] = await startup([{ ...safeLive, id: 'glm', modelCatalog: safeLive.modelCatalog }])
  assert.deepEqual(glm.supportedModels, glmBuiltin.supportedModels)
  assert.equal(Object.hasOwn(glm, 'modelCatalog'), false)
})
