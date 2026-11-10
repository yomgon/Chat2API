import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Run: node --test tests/security/renderer-model-availability.test.mjs
// Transpile the real row-building and row-rendering callbacks in isolation.
// No app, hooks, IPC, provider transport, user data or live credentials are loaded.
const path = 'src/renderer/src/components/models/ModelList.tsx'
const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
}
const declarations = new Map()
const compiled = new Map()

function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node)
  }
  ts.forEachChild(node, visit)
}
visit(ast)

function callback(name, scope) {
  if (!compiled.has(name)) {
    const initializer = declarations.get(name)?.initializer
    assert.ok(initializer && ts.isCallExpression(initializer), name + ' must be a hook/memo callback')
    const body = initializer.arguments[0]
    assert.ok(ts.isArrowFunction(body), name + ' must expose its actual callback')
    const output = ts.transpileModule('export default (' + body.getText(ast) + ')', {
      compilerOptions, fileName: 'callback.tsx', reportDiagnostics: true,
    })
    assert.deepEqual(output.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
    compiled.set(name, output.outputText)
  }
  const module = { exports: {} }
  const jsx = (type, props, key) => ({ type, props, key })
  const context = vm.createContext({
    ...scope, module, exports: module.exports,
    require(id) {
      assert.equal(id, 'react/jsx-runtime', 'Only inert JSX objects may be imported')
      return { jsx, jsxs: jsx, Fragment: 'Fragment' }
    },
  }, { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(compiled.get(name), { filename: path + ':' + name }).runInContext(context, { timeout: 1000 })
  return module.exports.default
}

const provider = (overrides = {}) => ({ id: 'target', name: 'Synthetic provider', enabled: true, ...overrides })
const effectiveModel = { displayName: 'Visible model', actualModelId: 'actual-model', isCustom: true }
const mapping = (overrides = {}) => ({
  requestModel: 'public-alias', actualModel: 'actual-model', preferredProviderId: 'target', ...overrides,
})
function account(overrides = {}) {
  const value = { id: 'target-account', providerId: 'target', name: 'Synthetic account', status: 'active', ...overrides }
  Object.defineProperty(value, 'credentials', { get() { assert.fail('Status must use account metadata only') } })
  return value
}
function fixture(overrides = {}) {
  return {
    providers: [provider()], accounts: [account()], modelMappings: [mapping()],
    effectiveModelsMap: { target: [effectiveModel] },
    t: key => key === 'models.modelMapping' ? 'Model Mapping' : key,
    ...overrides,
  }
}
const rows = (overrides = {}) => callback('modelList', fixture(overrides))()
function mappedRow(overrides = {}) {
  const row = rows(overrides).find(item => item.providerId === 'mapping')
  assert.ok(row, 'Fixture must retain a separate mapping row')
  return row
}

test('ModelList remains valid TSX and recomputes when configuration inputs change', () => {
  assert.deepEqual(ast.parseDiagnostics, [])
  const output = ts.transpileModule(source, { compilerOptions, fileName: path, reportDiagnostics: true })
  assert.deepEqual(output.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
  const dependencies = declarations.get('modelList').initializer.arguments[1]
  assert.ok(ts.isArrayLiteralExpression(dependencies))
  for (const dependency of ['providers', 'accounts', 'modelMappings', 'effectiveModelsMap']) {
    assert.ok(dependencies.elements.some(item => item.getText(ast) === dependency), dependency)
  }
})

for (const actualModel of ['actual-model', 'Visible model']) {
  test('mapping is configured for an exact effective-model match: ' + actualModel, () => {
    assert.equal(mappedRow({
      modelMappings: [mapping({ actualModel })],
      effectiveModelsMap: { target: [{ displayName: 'Other', actualModelId: 'other' }, effectiveModel] },
    }).status, 'available')
  })
}

test('mapping requires an existing enabled preferred provider, even with stale account/model data', () => {
  const cases = [
    ['unknown provider', { providers: [provider({ id: 'other' })] }],
    ['no providers', { providers: [] }],
    ['disabled provider', { providers: [provider({ enabled: false })] }],
    ['whitespace provider is not a wildcard', { modelMappings: [mapping({ preferredProviderId: ' ' })] }],
    ['do not fall back from a preferred provider', {
      providers: [provider(), provider({ id: 'other' })],
      accounts: [account({ id: 'other-account', providerId: 'other' })],
      effectiveModelsMap: { target: [effectiveModel], other: [effectiveModel] },
    }],
  ]
  for (const [label, overrides] of cases) assert.equal(mappedRow(overrides).status, 'unavailable', label)
})

test('mapping without a preferred provider can discover any enabled configured target', () => {
  for (const preferredProviderId of [undefined, '']) {
    for (const actualModel of ['actual-model', 'Visible model']) {
      assert.equal(mappedRow({
        providers: [provider(), provider({ id: 'other' })],
        accounts: [account({ id: 'other-account', providerId: 'other' })],
        effectiveModelsMap: { target: [], other: [effectiveModel] },
        modelMappings: [mapping({ preferredProviderId, actualModel })],
      }).status, 'available')
    }
  }
})

test('unrestricted discovery cannot combine account and model evidence from different providers', () => {
  const base = {
    providers: [provider(), provider({ id: 'other' })],
    modelMappings: [mapping({ preferredProviderId: undefined })],
  }
  const cases = [
    ['no enabled providers', { providers: [provider({ enabled: false })] }],
    ['no active accounts', { accounts: [account({ status: 'expired' })] }],
    ['no matching effective models', { effectiveModelsMap: { target: [] } }],
    ['account and model belong to different providers', { effectiveModelsMap: { target: [], other: [effectiveModel] } }],
    ['only disabled provider matches', {
      providers: [provider(), provider({ id: 'other', enabled: false })],
      accounts: [account(), account({ id: 'other-account', providerId: 'other' })],
      effectiveModelsMap: { target: [], other: [effectiveModel] },
    }],
  ]
  for (const [label, overrides] of cases) assert.equal(mappedRow({ ...base, ...overrides }).status, 'unavailable', label)
})

test('mapping requires an active account belonging to its preferred provider', () => {
  const cases = [
    ['no accounts', []],
    ...['inactive', 'expired', 'error', 'disabled'].map(status => [status, [account({ status })]]),
    ['active account elsewhere', [account({ providerId: 'other' })]],
    ['inactive target and active elsewhere', [account({ status: 'expired' }), account({ id: 'other-account', providerId: 'other' })]],
  ]
  for (const [label, accounts] of cases) {
    assert.equal(mappedRow({ providers: [provider(), provider({ id: 'other' })], accounts }).status, 'unavailable', label)
  }
  assert.equal(mappedRow({ accounts: [account({ status: 'expired' }), account({ id: 'second-active' })] }).status, 'available')
})

test('mapping matches its actual target only within the preferred provider effective models', () => {
  const cases = [
    ['no effective models map entry', { effectiveModelsMap: {} }],
    ['empty target models', { effectiveModelsMap: { target: [] } }],
    ['match only on another provider', { effectiveModelsMap: { other: [effectiveModel] } }],
    ['request alias is not the mapped target', { effectiveModelsMap: { target: [{ displayName: 'Other model', actualModelId: 'public-alias' }] } }],
    ['case mismatch', { modelMappings: [mapping({ actualModel: 'ACTUAL-MODEL' })] }],
    ['empty mapped target', { modelMappings: [mapping({ actualModel: '' })] }],
    ['missing mapped target', { modelMappings: [mapping({ actualModel: undefined })], effectiveModelsMap: { target: [{ displayName: 'Visible model' }] } }],
    ['non-string mapped target', { modelMappings: [mapping({ actualModel: 123 })], effectiveModelsMap: { target: [{ displayName: 'Visible model', actualModelId: 123 }] } }],
  ]
  for (const [label, overrides] of cases) assert.equal(mappedRow(overrides).status, 'unavailable', label)
})

test('preferred account must be active on the matching provider and its display provenance is retained', () => {
  const cases = [
    [undefined, 'available', undefined],
    ['', 'available', undefined],
    ['target-account', 'available', 'Synthetic account'],
    ['missing-account', 'unavailable', undefined],
    ['inactive-account', 'unavailable', 'Inactive account'],
    ['other-account', 'unavailable', 'Other account'],
    [' ', 'unavailable', undefined],
  ]
  for (const [preferredAccountId, expectedStatus, expectedName] of cases) {
    const row = mappedRow({
      providers: [provider(), provider({ id: 'other' })],
      modelMappings: [mapping({ preferredAccountId })],
      accounts: [account(), account({ id: 'inactive-account', status: 'expired', name: 'Inactive account' }),
        account({ id: 'other-account', providerId: 'other', name: 'Other account' })],
      effectiveModelsMap: { target: [effectiveModel], other: [effectiveModel] },
    })
    assert.equal(row.status, expectedStatus, String(preferredAccountId))
    assert.equal(row.id, 'mapping-public-alias')
    assert.equal(row.name, 'public-alias')
    assert.equal(row.providerName, 'Model Mapping')
    assert.equal(row.accountId, preferredAccountId)
    assert.equal(row.accountName, expectedName)
  }
})

test('without a preferred provider the exact preferred account still binds discovery to its own provider', () => {
  const base = {
    providers: [provider(), provider({ id: 'other' })],
    accounts: [account(), account({ id: 'other-account', providerId: 'other' })],
    modelMappings: [mapping({ preferredProviderId: undefined, preferredAccountId: 'other-account' })],
    effectiveModelsMap: { target: [effectiveModel], other: [effectiveModel] },
  }
  assert.equal(mappedRow(base).status, 'available')
  const cases = [
    ['preferred account missing', { accounts: [account()] }],
    ['preferred account inactive while another account is active', {
      accounts: [account(), account({ id: 'other-account', providerId: 'other', status: 'expired' }),
        account({ id: 'other-backup', providerId: 'other' })],
    }],
    ['preferred account provider disabled', { providers: [provider(), provider({ id: 'other', enabled: false })] }],
    ['preferred account provider missing', { providers: [provider()] }],
    ['model exists only outside preferred account provider', { effectiveModelsMap: { target: [effectiveModel], other: [] } }],
  ]
  for (const [label, overrides] of cases) assert.equal(mappedRow({ ...base, ...overrides }).status, 'unavailable', label)
})

test('normal provider rows keep account-based configuration status without claiming live success', () => {
  for (const status of ['active', 'expired', 'inactive']) {
    const result = rows({ accounts: [account({ status })], modelMappings: [] })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'target-Visible model')
    assert.equal(result[0].status, status === 'active' ? 'available' : 'unavailable')
  }
  assert.equal(rows({ accounts: [], modelMappings: [] })[0].status, 'unavailable')
  assert.equal(rows({ providers: [provider({ enabled: false })], modelMappings: [] }).length, 0)
})

test('configuration changes clear mapping availability and preserve existing normal-row deduplication', () => {
  const state = fixture({
    modelMappings: [mapping({ preferredAccountId: 'target-account' })],
    accounts: [account(), account({ id: 'backup-account' })],
  })
  assert.equal(mappedRow(state).status, 'available')
  for (const change of [
    { providers: [provider({ enabled: false })] },
    { accounts: [] },
    { accounts: [account({ status: 'expired' }), account({ id: 'backup-account' })] },
    { effectiveModelsMap: { target: [] } },
    { modelMappings: [mapping({ actualModel: 'removed-model' })] },
    { modelMappings: [mapping({ preferredAccountId: 'missing-account' })] },
  ]) assert.equal(mappedRow({ ...state, ...change }).status, 'unavailable')
  const duplicate = rows({ modelMappings: [mapping({ requestModel: 'Visible model' })] })
  assert.equal(duplicate.length, 1)
  assert.equal(duplicate[0].providerId, 'target')
})

function renderedText(node) {
  if (Array.isArray(node)) return node.map(renderedText).join('')
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return renderedText(node.props?.children)
}

test('row labels explicitly distinguish configuration from live response verification', () => {
  const components = ['TableRow', 'TableCell', 'Check', 'Square', 'Database', 'Badge', 'CheckCircle2', 'XCircle']
  const render = callback('ModelRow', {
    ...Object.fromEntries(components.map(name => [name, name])), providerIcons: {},
    cn: (...values) => values.filter(Boolean).join(' '),
  })
  for (const [status, expected, unexpected] of [
    ['available', 'Configured (not live-tested)', 'Not connected'],
    ['unavailable', 'Not connected', 'Configured (not live-tested)'],
  ]) {
    const selected = []
    const row = render({ model: { ...mappedRow(), status }, isSelected: true, onSelect: id => selected.push(id) })
    const text = renderedText(row)
    assert.ok(text.includes(expected))
    assert.ok(!text.includes(unexpected))
    assert.doesNotMatch(text, /\bAvailable\b|\bUnavailable\b/)
    assert.ok(text.includes('Model Mapping'))
    row.props.onClick()
    assert.deepEqual(selected, ['mapping-public-alias'])
  }
})
