import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/main/ipc/handlers.ts', import.meta.url), 'utf8')
const sf = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let addHandler
const visit = node => {
  if (ts.isCallExpression(node)
    && node.arguments[0]?.getText(sf) === 'IpcChannels.PROVIDERS_ADD'
    && node.arguments[1]) addHandler = node.arguments[1].getText(sf)
  ts.forEachChild(node, visit)
}
visit(sf)
assert.ok(addHandler, 'Live authenticated provider-add route must be present')
const js = ts.transpileModule('globalThis.addHandler = ' + addHandler + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const builtin = {
  id: 'qwen-ai', type: 'builtin', name: 'Qwen AI (International)',
  authType: 'jwt', apiEndpoint: 'https://chat.qwen.ai',
  chatPath: '/api/v2/chat/completions',
  supportedModels: ['Qwen3.7-Plus', 'Qwen3.8-Max'],
  modelMappings: { 'Qwen3.7-Plus': 'qwen3.7-plus', 'Qwen3.8-Max': 'qwen3.8-max' },
  headers: { source: 'web' }, enabled: true,
}
const input = {
  id: builtin.id, type: 'builtin', name: builtin.name,
  authType: builtin.authType, apiEndpoint: builtin.apiEndpoint,
  supportedModels: builtin.supportedModels,
}

function harness() {
  const calls = []
  const context = {
    getBuiltinProvider: id => id === builtin.id ? builtin : undefined,
    storeManager: {
      ensureProviderExists: id => calls.push({ action: 'trustedInitialize', id }),
    },
    ProviderManager: {
      getById: id => { calls.push({ action: 'trustedRead', id }); return { ...builtin } },
    },
    CustomProviderManager: {
      create: data => { calls.push({ action: 'customCreate' }); return { ...data } },
    },
  }
  vm.runInNewContext(js, context, { filename: 'builtin-provider-init.js', timeout: 2000 })
  return { invoke: data => context.addHandler(null, data), calls }
}

test('adding a built-in provider obtains complete shipped chat path and model IDs, not partial renderer fields', async () => {
  const h = harness()
  const value = await h.invoke(input)
  assert.equal(value.chatPath, '/api/v2/chat/completions')
  assert.equal(value.modelMappings['Qwen3.8-Max'], 'qwen3.8-max')
  assert.deepEqual(h.calls.map(c => c.action), ['trustedInitialize', 'trustedRead'])
  assert.equal(h.calls[0].id, builtin.id)
})

test('built-in endpoint/name/type spoofing cannot create a credential-bearing provider', async () => {
  for (const update of [
    { apiEndpoint: 'https://attacker.example' },
    { name: 'Forged Qwen' },
    { authType: 'cookie' },
    { id: 'unknown-provider' },
  ]) {
    const h = harness()
    await assert.rejects(h.invoke({ ...input, ...update }), /Invalid built-in provider configuration/)
    assert.deepEqual(h.calls, [])
  }
})

test('custom providers cannot reserve a built-in ID, while normal custom creation is unchanged', async () => {
  const blocked = harness()
  await assert.rejects(blocked.invoke({ ...input, type: 'custom' }), /Built-in provider identity is reserved/)
  assert.deepEqual(blocked.calls, [])

  const custom = harness()
  const result = await custom.invoke({ name: 'Custom', type: 'custom', apiEndpoint: 'https://service.example', authType: 'jwt' })
  assert.equal(result.name, 'Custom')
  assert.deepEqual(custom.calls.map(c => c.action), ['customCreate'])
})
