import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the ACTUAL provider dialog and the ACTUAL parent navigation handler
// with inert JSX/in-memory synthetic IPC. This test cannot open a browser,
// access a real account store, inspect OS credentials, or send an HTTP request.
const componentPath = 'src/renderer/src/components/providers/AddProviderDialog.tsx'
const pagePath = 'src/renderer/src/pages/Providers.tsx'
const source = relative => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const componentSource = source(componentPath)
const parentSource = source(pagePath)
const secret = 'SYNTHETIC_FORBIDDEN_CREDENTIAL_' + 'x'.repeat(50)
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const builtinZai = { id: 'zai', name: 'Z.ai', type: 'builtin',
  authType: 'token', apiEndpoint: 'https://chat.z.ai',
  credentialFields: [{ name: 'token', required: true }], supportedModels: ['glm-5'] }
const builtinDeepSeek = { id: 'deepseek', name: 'DeepSeek', type: 'builtin',
  authType: 'userToken', apiEndpoint: 'https://chat.deepseek.com',
  credentialFields: [{ name: 'userToken', required: true }], supportedModels: ['default'] }

function componentFixture(overrides = {}) {
  const state = [], refs = [], closed = [], protectedCalls = [], genericOAuth = [], genericAdd = [], validations = []
  let cursor = 0, tree
  const jsx = (type, props = {}) => ({ type, props })
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect() {},
  }
  const ui = new Map([
    ['@/components/ui/dialog', ['Dialog','DialogContent','DialogDescription','DialogFooter','DialogHeader','DialogTitle']],
    ['@/components/ui/button', ['Button']],
    ['@/components/ui/input', ['Input']],
    ['@/components/ui/label', ['Label']],
    ['@/components/ui/badge', ['Badge']],
    ['@/components/ui/scroll-area', ['ScrollArea']],
    ['@/components/ui/tabs', ['Tabs','TabsContent','TabsList','TabsTrigger']],
  ])
  const module = { exports: {} }
  const compiled = ts.transpileModule(componentSource, {
    fileName: componentPath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  })
  assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    window: { electronAPI: { oauth: { startInAppLogin: async (...args) => {
      genericOAuth.push(plain(args)); return { success: false, error: 'synthetic-other-provider-error' }
    } } } },
    console: { log() {}, warn() {}, error() {}, info() {} },
    navigator: { clipboard: { writeText: () => assert.fail('No clipboard access permitted') } },
    setTimeout: () => assert.fail('No real timer should be scheduled'),
    require(specifier) {
      if (specifier === 'react') return hooks
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (specifier === 'react-i18next') return { useTranslation: () => ({
        t: (key, params) => params?.defaultValue ?? key,
      }) }
      if (specifier === '@/lib/utils') return { cn: (...args) => args.filter(Boolean).join(' ') }
      if (specifier === 'lucide-react') return new Proxy({}, { get: (_o, key) => String(key) })
      if (ui.has(specifier)) return Object.fromEntries(ui.get(specifier).map(name => [name, name]))
      if (specifier.endsWith('.svg')) return { __esModule: true, default: 'synthetic-image' }
      assert.fail('Blocked import ' + specifier)
    },
  }, { filename: componentPath, timeout: 1400 })
  let props = {
    open: true, builtinProviders: [builtinZai, builtinDeepSeek],
    onOpenChange: value => closed.push(value),
    onSelectBuiltin: async (...args) => { genericAdd.push(plain(args)) },
    onCreateCustom: () => assert.fail('No custom provider creation'),
    onValidateToken: async (...args) => { validations.push(plain(args)); return { valid: false } },
    onOpenProtectedZaiAccounts: async provider => {
      protectedCalls.push(provider.id)
      if (overrides.protected) return overrides.protected(provider)
    },
    ...overrides.props,
  }
  const walk = (node, found = []) => {
    if (Array.isArray(node)) for (const child of node) walk(child, found)
    else if (node && typeof node === 'object') {
      found.push(node)
      walk(node.props?.children, found)
    }
    return found
  }
  const textOf = node => Array.isArray(node) ? node.map(textOf).join(' ') :
    node == null || typeof node === 'boolean' ? '' :
    typeof node === 'object' ? textOf(node.props?.children) : String(node)
  const render = () => { cursor = 0; tree = module.exports.AddProviderDialog(props); return tree }
  const nodes = kind => walk(tree).filter(item => item.type === kind)
  const button = text => {
    const found = nodes('Button').find(node => textOf(node).includes(text))
    assert.ok(found, 'Button must exist: ' + text)
    return found
  }
  const choose = name => {
    const found = nodes('div').find(node => typeof node.props.onClick === 'function' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex items-start justify-between p-3') &&
      textOf(node).includes(name))
    assert.ok(found, 'Provider selection row exists: ' + name)
    found.props.onClick()
    render()
    button('common.next').props.onClick()
    render()
  }
  render()
  return {
    choose, render, nodes, button, protectedCalls, genericOAuth, genericAdd, validations, closed,
    text: () => textOf(tree),
    setProps(p) { props = { ...props, ...p }; render() },
  }
}

function parentHandler(name, environment = {}) {
  const ast = ts.createSourceFile(pagePath, parentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  assert.equal(ast.parseDiagnostics.length, 0)
  let expression
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(expression, 'Must find live handler: ' + name)
  const code = ts.transpileModule(`(${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const callback = vm.runInNewContext(code, environment, { timeout: 1000 })
  assert.equal(typeof callback, 'function')
  return callback
}

test('Add Provider Z.ai explicitly shows protected flow and never exposes legacy OAuth or submit', async () => {
  const h = componentFixture()
  h.choose('Z.ai')
  assert.match(h.text(), /Protected Z\.ai account connection/)
  assert.match(h.text(), /reconnect an existing/)
  assert.equal(h.nodes('Tabs').length, 0)
  assert.equal(h.nodes('Button').some(b =>
    /providers\.openOAuthLogin|providers\.validateCredentials|providers\.addAccount/.test(
      JSON.stringify(b.props.children))), false)
  const btn = h.button('Open protected Z.ai accounts')
  assert.equal(btn.props.disabled, false)
  await btn.props.onClick()
  h.render()
  assert.deepEqual(h.protectedCalls, ['zai'])
  assert.deepEqual(h.closed, [false])
  assert.equal(h.genericOAuth.length, 0)
  assert.equal(h.genericAdd.length, 0)
  assert.equal(h.validations.length, 0)
})

test('protected Z.ai button has an immediate duplicate-click fence and redacts failures', async () => {
  const pending = deferred()
  const h = componentFixture({ protected: () => pending.promise })
  h.choose('Z.ai')
  const click = h.button('Open protected Z.ai accounts').props.onClick
  const first = click()
  const duplicate = click()
  await duplicate
  h.render()
  assert.deepEqual(h.protectedCalls, ['zai'])
  assert.equal(h.button('Opening protected Z.ai accounts...').props.disabled, true)
  pending.reject(new Error(secret))
  await first
  h.render()
  assert.equal(h.closed.length, 0)
  assert.match(h.text(), /Existing accounts were not changed/)
  assert.equal(h.text().includes(secret), false)
  assert.equal(h.genericOAuth.length, 0)
  assert.equal(h.genericAdd.length, 0)
})

test('missing protected callback refuses Z.ai action without falling back to legacy OAuth', async () => {
  const h = componentFixture({ props: { onOpenProtectedZaiAccounts: undefined } })
  h.choose('Z.ai')
  const btn = h.button('Open protected Z.ai accounts')
  assert.equal(btn.props.disabled, true)
  await btn.props.onClick()
  h.render()
  assert.match(h.text(), /Protected Z\.ai account management is unavailable/)
  assert.deepEqual(h.genericOAuth, [])
  assert.deepEqual(h.genericAdd, [])
})

test('non-Z.ai generic OAuth UI and provider handling are preserved', async () => {
  const h = componentFixture()
  h.choose('DeepSeek')
  assert.ok(h.nodes('Tabs').length > 0)
  h.nodes('Tabs')[0].props.onValueChange('oauth')
  h.render()
  await h.button('providers.openOAuthLogin').props.onClick()
  assert.deepEqual(h.genericOAuth, [['deepseek', 'deepseek']])
  assert.deepEqual(h.protectedCalls, [])
})

function parentFixture(options = {}) {
  const providers = options.providers ?? [{ id: 'zai', type: 'builtin', name: 'Z.ai' }]
  const accounts = options.accounts ?? [{ id: 'account-1', providerId: 'zai', status: 'active' }]
  const all = [], adds = [], accountReads = [], writes = [], notices = []
  const state = { builtinProviders: [builtinZai], providers: [], accounts: [], selectedProviderId: null }
  const hooks = {
    getState: () => ({
      builtinProviders: state.builtinProviders,
      setProviders: p => { state.providers = p; writes.push('setProviders') },
      setAccounts: a => { state.accounts = a; writes.push('setAccounts') },
      updateAccountCount: (...args) => { writes.push(['accountCount',...args]) },
      setSelectedProviderId: p => { state.selectedProviderId = p; writes.push('selected') },
    }),
  }
  const env = {
    window: { electronAPI: {
      providers: {
        getAll: async () => { all.push('providers'); return [...providers] },
        add: async p => {
          adds.push(plain(p))
          if (options.badRegistration) return { id: 'wrong', type: 'custom' }
          providers.push({ id: 'zai', type: 'builtin', name: 'Z.ai' })
          return providers.at(-1)
        },
      },
      accounts: { getAll: async () => { accountReads.push('accounts'); return [...accounts] } },
    } },
    useProvidersStore: hooks,
    setViewMode: value => writes.push(['view', value]),
    setShowAddProviderDialog: value => writes.push(['dialog', value]),
    toast: value => notices.push(plain(value)),
    store: { providers, selectedProviderId: null },
  }
  return { callback: parentHandler('handleOpenProtectedZaiAccounts', env),
    legacy: parentHandler('handleSelectBuiltinProvider', env),
    providers, accounts, all, adds, accountReads, writes, notices, state }
}

test('parent protected Z.ai route reuses existing provider/account and changes only navigation metadata', async () => {
  const h = parentFixture()
  await h.callback(builtinZai)
  assert.equal(h.adds.length, 0)
  assert.deepEqual(h.all, ['providers', 'providers'])
  assert.deepEqual(h.accountReads, ['accounts'])
  assert.equal(h.state.selectedProviderId, 'zai')
  assert.equal(h.state.accounts.length, 1)
  assert.equal(h.accounts[0].id, 'account-1')
  assert.equal(h.state.providers.length, 1)
  assert.ok(h.writes.some(value => Array.isArray(value) && value[0] === 'view' && value[1] === 'accounts'))
  assert.match(h.notices[0].description, /Reconnect Z\.ai \(keep account\)/)
})

test('parent creates missing built-in provider once, but never creates an account or token', async () => {
  const h = parentFixture({ providers: [], accounts: [] })
  await h.callback(builtinZai)
  assert.equal(h.adds.length, 1)
  assert.deepEqual(Object.keys(h.adds[0]).sort(), ['apiEndpoint','authType','id','name','type'])
  assert.equal(h.state.accounts.length, 0)
  assert.equal(h.state.selectedProviderId, 'zai')
  assert.match(h.notices[0].description, /No saved Z\.ai account/)
})

test('parent refuses wrong ID, built-in identity conflict, and unverifiable registration without switching context', async () => {
  for (const [options, input] of [
    [{}, { ...builtinZai, id: 'deepseek' }],
    [{ providers: [{ id: 'zai', type: 'custom' }] }, builtinZai],
    [{ providers: [], badRegistration: true }, builtinZai],
  ]) {
    const h = parentFixture(options)
    await assert.rejects(h.callback(input))
    assert.equal(h.state.selectedProviderId, null)
    assert.equal(h.accountReads.length, 0)
    assert.equal(h.notices.length, 0)
  }
})

test('stale old provider-selection callback refuses Z.ai before any account or provider write', async () => {
  const h = parentFixture()
  await assert.rejects(h.legacy(builtinZai, { token: secret }), /Use protected Z\.ai account management/)
  assert.deepEqual(h.adds, [])
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.accountReads, [])
})
