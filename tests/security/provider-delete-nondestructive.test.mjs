import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// The real TypeScript manager sources execute with a synthetic in-memory
// store. No Electron, user files, network, provider credentials or real logs.
const root = fileURLToPath(new URL('../../', import.meta.url))
const source = relative => readFileSync(join(root, relative), 'utf8')

function sourceHarness(relative, dependencies) {
  const transformed = ts.transpileModule(source(relative), {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  })
  assert.equal((transformed.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  const module = { exports: {} }
  const logs = []
  vm.runInNewContext(transformed.outputText, {
    module, exports: module.exports, Error,
    console: { log: (...items) => logs.push(items), warn: (...items) => logs.push(items) },
    require: specifier => {
      assert.ok(Object.hasOwn(dependencies, specifier), `Blocked external source dependency ${specifier}`)
      return dependencies[specifier]
    },
  }, { filename: relative, timeout: 1500 })
  return { exports: module.exports, logs }
}

function storeFixture(type = 'builtin') {
  const provider = { id: type === 'builtin' ? 'zai' : 'fixture-custom',
    name: 'Synthetic provider', type, apiEndpoint: 'https://fixture.invalid', headers: {} }
  const accounts = [{ id: 'synthetic-account-one', providerId: provider.id },
    { id: 'synthetic-account-two', providerId: provider.id }]
  const calls = { getAccounts: 0, deleteAccounts: 0, deleteProvider: 0, logs: 0 }
  const manager = {
    getProviderById: id => id === provider.id ? provider : undefined,
    getAccountsByProviderId(id) { calls.getAccounts++; return accounts.filter(a => a.providerId === id) },
    deleteAccount(id) { calls.deleteAccounts++; return accounts.some(a => a.id === id) },
    deleteProvider(id) { calls.deleteProvider++; return id === provider.id },
    addLog() { calls.logs++ },
  }
  return { provider, accounts, calls, manager }
}

const trust = {
  ProviderEndpointTrustError: class ProviderEndpointTrustError extends Error {},
  assertProviderEndpointChangeAllowed() {}, assertProviderIdentityUnchanged() {},
  validateProviderEndpoint: value => value,
}

for (const [label, path, providerImport, trustImport, exportName] of [
  ['renderer IPC custom deletion entry', 'src/main/providers/custom.ts', '../store/store', './endpointTrust', 'CustomProviderManager'],
  ['legacy manager deletion entry', 'src/main/store/providers.ts', './store', '../providers/endpointTrust', 'ProviderManager'],
]) {
  test(`${label}: built-in Z.ai with two accounts is never deleted`, () => {
    const h = storeFixture('builtin')
    const actual = sourceHarness(path, {
      [providerImport]: { storeManager: h.manager },
      [trustImport]: trust,
      ...(path.includes('/store/providers.ts')
        ? { './types': { BUILTIN_PROVIDERS: [{ id: 'zai' }] } }
        : { './builtin': { getBuiltinProvider: id => id === 'zai' ? { id } : undefined } }),
    })
    assert.throws(() => actual.exports[exportName].delete(h.provider.id),
      /Built-in providers cannot be deleted/)
    assert.deepEqual(h.calls, { getAccounts: 0, deleteAccounts: 0, deleteProvider: 0, logs: 0 })
    assert.equal(h.accounts.length, 2)
    assert.equal(actual.logs.length, 0)
    h.provider.type = 'custom'
    assert.throws(() => actual.exports[exportName].delete(h.provider.id),
      /Built-in providers cannot be deleted/)
    assert.deepEqual(h.calls, { getAccounts: 0, deleteAccounts: 0, deleteProvider: 0, logs: 0 })
  })

  test(`${label}: unknown provider causes no account lookup or write`, () => {
    const h = storeFixture('builtin')
    const actual = sourceHarness(path, {
      [providerImport]: { storeManager: h.manager },
      [trustImport]: trust,
      ...(path.includes('/store/providers.ts')
        ? { './types': { BUILTIN_PROVIDERS: [{ id: 'zai' }] } }
        : { './builtin': { getBuiltinProvider: id => id === 'zai' ? { id } : undefined } }),
    })
    assert.equal(actual.exports[exportName].delete('missing-provider'), false)
    assert.deepEqual(h.calls, { getAccounts: 0, deleteAccounts: 0, deleteProvider: 0, logs: 0 })
  })

  test(`${label}: a synthetic custom provider still uses the existing explicit delete path`, () => {
    const h = storeFixture('custom')
    const actual = sourceHarness(path, {
      [providerImport]: { storeManager: h.manager },
      [trustImport]: trust,
      ...(path.includes('/store/providers.ts')
        ? { './types': { BUILTIN_PROVIDERS: [{ id: 'zai' }] } }
        : { './builtin': { getBuiltinProvider: id => id === 'zai' ? { id } : undefined } }),
    })
    assert.equal(actual.exports[exportName].delete(h.provider.id), true)
    // Core StoreManager owns the complete single-write provider/account
    // cascade; neither legacy manager nor renderer IPC deletes accounts first.
    assert.deepEqual(h.calls, {
      getAccounts: path.includes('/store/providers.ts') ? 1 : 0,
      deleteAccounts: 0, deleteProvider: 1, logs: 1,
    })
  })
}

test('the renderer has no built-in provider Delete control and requires custom deletion confirmation', () => {
  const card = source('src/renderer/src/components/providers/ProviderCard.tsx')
  const page = source('src/renderer/src/pages/Providers.tsx')
  const ipc = source('src/main/ipc/handlers.ts')
  for (const [file, text] of [['ProviderCard',card],['Providers',page]]) {
    const transformed = ts.transpileModule(text, { fileName: file + '.tsx',
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      reportDiagnostics: true })
    assert.equal((transformed.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  }
  assert.match(card, /\{!isBuiltin && \(\s*<>\s*<DropdownMenuSeparator\s*\/>\s*<DropdownMenuItem[\s\S]*?onClick=\{\(\) => onDelete\(provider\.id\)\}/)
  assert.equal((card.match(/onClick=\{\(\) => onDelete\(provider\.id\)\}/g) || []).length, 1)
  assert.match(page, /if \(!provider \|\| provider\.type !== 'custom' \|\| store\.builtinProviders\.some\(builtin => builtin\.id === id\)\) return/)
  assert.match(page, /if \(!window\.confirm\(/)
  assert.match(ipc, /handleTrusted\(IpcChannels\.PROVIDERS_DELETE,[\s\S]*?CustomProviderManager\.delete\(id\)/)
})
