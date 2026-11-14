import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute only this real component with inert JSX, hooks and synthetic IPC.
// No Electron, browser, account store, profile, transport or credentials are loaded.
const filename = 'src/renderer/src/components/providers/AddAccountDialog.tsx'
const source = readFileSync(new URL('../../' + filename, import.meta.url), 'utf8')
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const transpiled = ts.transpileModule(source, {
  fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  reportDiagnostics: true,
})
const secret = 'SYNTHETIC_UNTRUSTED_SECRET_' + 'x'.repeat(48)
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
const defaultProvider = { id: 'zai', name: 'Synthetic Z.ai', authType: 'token' }

function fixture(overrides = {}, behavior = {}) {
  const slots = [], logs = [], closes = [], createNames = [], adds = [], updates = [], validations = [], legacy = []
  let cursor = 0, dirty = false, mounted = true, unmountedWrites = 0, cancellations = 0, forbiddenCalls = 0
  let effects = [], tree
  const forbidden = name => { forbiddenCalls++; throw new Error('Unexpected offline operation: ' + name) }
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, value => {
        if (!mounted) { unmountedWrites++; return }
        const next = typeof value === 'function' ? value(slots[index].value) : value
        if (!Object.is(next, slots[index].value)) {
          slots[index].value = next
          dirty = true
        }
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { kind: 'ref', value: { current: initial } }
      return slots[index].value
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { kind: 'callback', value: callback, deps }
      return slots[index].value
    },
    useEffect(callback, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !sameDeps(previous.deps, deps)) {
        effects.push({ index, callback, cleanup: previous?.cleanup })
        slots[index] = { kind: 'effect', deps, cleanup: undefined }
      }
    },
  }
  const ui = {
    '@/components/ui/dialog': ['Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'],
    '@/components/ui/button': ['Button'],
    '@/components/ui/input': ['Input'],
    '@/components/ui/label': ['Label'],
    '@/components/ui/badge': ['Badge'],
    '@/components/ui/tabs': ['Tabs', 'TabsContent', 'TabsList', 'TabsTrigger'],
    'lucide-react': ['ExternalLink', 'User', 'AlertCircle', 'Loader2', 'CheckCircle2', 'Eye', 'EyeOff', 'Copy', 'Check'],
  }
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const oauth = {
    startInAppLogin: async (...args) => {
      legacy.push(args)
      return behavior.legacyResult ?? { success: false }
    },
    cancelInAppLogin: () => {
      cancellations++
      return behavior.cancel ? behavior.cancel() : Promise.resolve()
    },
  }
  if (behavior.noCancel) delete oauth.cancelInAppLogin
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports,
    window: { electronAPI: { oauth } },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [level, (...args) => logs.push({ level, args })])),
    fetch: () => forbidden('fetch'),
    setTimeout: () => forbidden('timer'),
    navigator: { clipboard: { writeText: () => forbidden('clipboard') } },
    require(id) {
      if (id === 'react') return hooks
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (id === 'react-i18next') return { useTranslation: () => ({ t: key => key }) }
      if (Object.hasOwn(ui, id)) return Object.fromEntries(ui[id].map(name => [name, name]))
      return forbidden('module ' + id)
    },
  }, { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(transpiled.outputText, { filename }).runInContext(context, { timeout: 1000 })
  const component = module.exports.AddAccountDialog
  let props = {
    open: true,
    provider: defaultProvider,
    onOpenChange: value => closes.push(value),
    onAddAccount: async data => { adds.push(plain(data)) },
    onUpdateAccount: async (...args) => { updates.push(plain(args)) },
    onValidateToken: async (...args) => { validations.push(plain(args)); return { valid: true } },
    onCreateZaiAccount: async name => {
      createNames.push(name)
      return behavior.create ? behavior.create(name) : { success: true, accountId: 'synthetic-new-account' }
    },
    ...overrides,
  }
  const render = () => {
    assert.ok(mounted)
    for (let pass = 0; pass < 20; pass++) {
      cursor = 0
      dirty = false
      effects = []
      tree = component(props)
      const batch = effects
      for (const effect of batch) effect.cleanup?.()
      for (const effect of batch) slots[effect.index].cleanup = effect.callback()
      if (!dirty) return tree
    }
    assert.fail('Hook state must settle')
  }
  const walk = (node, predicate, found = []) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, predicate, found)
    } else if (node && typeof node === 'object') {
      if (predicate(node)) found.push(node)
      walk(node.props?.children, predicate, found)
    }
    return found
  }
  const textOf = node => {
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node !== 'object') return String(node)
    return textOf(node.props?.children)
  }
  const nodes = type => walk(tree, node => node.type === type || node.type?.name === type)
  const button = label => {
    const result = nodes('Button').find(node => textOf(node).includes(label))
    assert.ok(result, 'Button exists: ' + label)
    return result
  }
  const input = id => {
    const result = nodes('Input').find(node => node.props.id === id)
    assert.ok(result, 'Input exists: ' + id)
    return result
  }
  render()
  return {
    render, nodes, button, input, closes, createNames, adds, updates, validations, legacy, logs,
    get cancellations() { return cancellations },
    get unmountedWrites() { return unmountedWrites },
    text: () => textOf(tree),
    setProps(next) { props = { ...props, ...next }; render() },
    name(value) { input('name').props.onChange({ target: { value } }); render() },
    tab(value) { nodes('Tabs')[0].props.onValueChange(value); render() },
    async flush() { await tick(); render() },
    unmount() {
      mounted = false
      for (const slot of slots) if (slot?.kind === 'effect') slot.cleanup?.()
    },
    assertPrivate() {
      assert.equal(forbiddenCalls, 0)
      assert.ok(!JSON.stringify({ text: textOf(tree), slots, logs, adds, updates, validations, legacy }).includes(secret),
        'Untrusted response/error text must never enter renderer state, actions or logs')
    },
  }
}

function prepare(h, name = '  Synthetic account  ') {
  h.name(name)
  h.tab('oauth')
  return h.button('Sign in and add Z.ai account')
}

test('the real TSX exposes the optional redacted callback and the Z.ai branch does not read credential responses', () => {
  assert.deepEqual(ast.parseDiagnostics, [])
  assert.deepEqual(transpiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
  const props = ast.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'AddAccountDialogProps')
  const callback = props.members.find(member => member.name?.getText(ast) === 'onCreateZaiAccount')
  assert.ok(callback?.questionToken)
  assert.match(callback.type.getText(ast), /name:\s*string/)
  let handler
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleCreateZaiAccount') handler = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(handler)
  assert.doesNotMatch(handler.getText(ast), /result\.(?:credentials|token|cookies|error)|error\.message|console\.|onAddAccount\(|onValidateToken\(/)
})

test('blank names and missing callbacks never reach legacy OAuth or creation', async () => {
  const empty = fixture()
  empty.tab('oauth')
  const button = empty.button('Sign in and add Z.ai account')
  assert.equal(button.props.disabled, true)
  await button.props.onClick()
  await empty.flush()
  assert.equal(empty.createNames.length, 0)
  assert.equal(empty.legacy.length, 0)
  assert.match(empty.text(), /Enter an account name/)
  const missing = fixture({ onCreateZaiAccount: undefined })
  const unavailable = prepare(missing)
  assert.equal(unavailable.props.disabled, true)
  await unavailable.props.onClick()
  await missing.flush()
  assert.equal(missing.legacy.length, 0)
  assert.match(missing.text(), /currently unavailable/)
  empty.assertPrivate()
  missing.assertPrivate()
})

test('the trimmed name creates once before rerender and blocks stale manual handlers while pending', async () => {
  const request = deferred()
  const h = fixture({}, { create: () => request.promise })
  h.name('  Named once  ')
  assert.ok(!h.nodes('Button').some(node =>
    ['providers.addAccount','providers.validateCredentials'].some(label =>
      JSON.stringify(node.props.children).includes(label))))
  h.tab('oauth')
  const click = h.button('Sign in and add Z.ai account').props.onClick
  const first = click(), second = click()
  await second
  // No stale manual Z.ai action exists to bypass the pending owner login.
  h.render()
  assert.deepEqual(h.createNames, ['Named once'])
  assert.equal(h.legacy.length, 0)
  assert.equal(h.adds.length, 0)
  assert.equal(h.validations.length, 0)
  assert.equal(h.input('name').props.disabled, true)
  assert.ok(h.nodes('TabsTrigger').every(node => node.props.disabled === true))
  assert.equal(h.nodes('Input').filter(node => node.props.id === 'dailyLimit').length, 0)
  assert.ok(!h.nodes('Button').some(node => ['providers.addAccount', 'providers.validateCredentials'].some(label =>
    JSON.stringify(node.props.children).includes(label))))
  h.tab('manual')
  assert.equal(h.nodes('Tabs')[0].props.value, 'oauth')
  assert.match(h.text(), /One NEW account record is added only after official web authentication is verified/)
  assert.match(h.text(), /Existing accounts are preserved/)
  request.resolve({ success: false, reason: 'login_cancelled' })
  await first
  await h.flush()
  h.assertPrivate()
})

test('main redacted success closes once without credential reads, validation, or a second save', async () => {
  const result = { success: true, accountId: 'synthetic-created' }
  for (const key of ['credentials', 'token', 'cookies', 'error', 'accountInfo']) {
    Object.defineProperty(result, key, { get() { assert.fail('Do not read ' + key) } })
  }
  const h = fixture({}, { create: () => Promise.resolve(result) })
  const button = prepare(h)
  await button.props.onClick()
  await h.flush()
  assert.deepEqual(h.closes, [false])
  assert.equal(h.createNames.length, 1)
  assert.equal(h.legacy.length, 0)
  assert.equal(h.adds.length, 0)
  assert.equal(h.validations.length, 0)
  await h.button('Sign in and add Z.ai account').props.onClick()
  assert.equal(h.createNames.length, 1)
  h.setProps({ open: false })
  h.unmount()
  assert.equal(h.cancellations, 0)
  h.assertPrivate()
})

test('known failures and arbitrary reasons are rendered only through fixed text', async () => {
  const cases = [
    ['busy', /Another sign-in/],
    ['invalid_name', /Enter an account name/],
    ['provider_unavailable', /currently unavailable/],
    ['login_cancelled', /was cancelled/],
    ['login_timeout', /timed out/],
    ['authentication_timeout', /timed out/],
    ['storage_unavailable', /could not be saved/],
    ['invalid_session', /could not be verified/],
    ['invalid_auth_response', /could not be verified/],
    ['authentication_failed', /could not be verified/],
    ['identity_mismatch', /could not be verified/],
    [secret, /could not be completed/],
    ['__proto__', /could not be completed/],
    ['constructor', /could not be completed/],
    [undefined, /could not be completed/],
  ]
  for (const [reason, expected] of cases) {
    const h = fixture({}, { create: () => Promise.resolve({ success: false, reason, error: secret, token: secret }) })
    await prepare(h).props.onClick()
    await h.flush()
    assert.match(h.text(), expected)
    assert.deepEqual(h.closes, [])
    assert.equal(h.button('Sign in and add Z.ai account').props.disabled, false)
    h.assertPrivate()
  }
})

test('synchronous throws and asynchronous rejections never display an exception message', async () => {
  for (const create of [() => { throw new Error(secret) }, () => Promise.reject(new Error(secret))]) {
    const h = fixture({}, { create })
    await prepare(h).props.onClick()
    await h.flush()
    assert.match(h.text(), /could not be completed/)
    assert.deepEqual(h.closes, [])
    assert.equal(h.button('Sign in and add Z.ai account').props.disabled, false)
    h.assertPrivate()
  }
})

test('incomplete committed receipts block a duplicate retry and remain open for review', async () => {
  for (const accountId of [undefined, '', '   ']) {
    const h = fixture({}, { create: () => Promise.resolve({ success: true, accountId }) })
    const click = prepare(h).props.onClick
    await click()
    await h.flush()
    assert.match(h.text(), /could not be confirmed/)
    assert.deepEqual(h.closes, [])
    assert.equal(h.button('Sign in and add Z.ai account').props.disabled, true)
    await click()
    assert.equal(h.createNames.length, 1)
    h.button('common.cancel').props.onClick()
    assert.equal(h.cancellations, 0, 'Do not cancel a reported committed operation')
    h.assertPrivate()
  }
})

test('only a boolean true success closes the dialog', async () => {
  for (const result of [null, undefined, { success: 'true', accountId: 'synthetic-id', reason: secret }, { success: 1 }]) {
    const h = fixture({}, { create: () => Promise.resolve(result) })
    await prepare(h).props.onClick()
    await h.flush()
    assert.deepEqual(h.closes, [])
    h.assertPrivate()
  }
})

test('Cancel and repeated dialog-dismiss events cancel the owned pending operation once', async () => {
  const request = deferred()
  const h = fixture({}, { create: () => request.promise })
  const pending = prepare(h).props.onClick()
  h.render()
  const dismiss = h.nodes('Dialog')[0].props.onOpenChange
  h.button('common.cancel').props.onClick()
  dismiss(false)
  dismiss(false)
  assert.equal(h.cancellations, 1)
  h.setProps({ open: false })
  const closes = h.closes.length
  request.resolve({ success: true, accountId: 'synthetic-late' })
  await pending
  await h.flush()
  assert.equal(h.closes.length, closes)
  assert.equal(h.adds.length, 0)
  h.assertPrivate()
})

test('cancellation errors or a missing cancel API never expose an exception', async () => {
  for (const behavior of [
    { cancel: () => Promise.reject(new Error(secret)) },
    { cancel: () => { throw new Error(secret) } },
    { noCancel: true },
  ]) {
    const request = deferred()
    const h = fixture({}, { ...behavior, create: () => request.promise })
    const pending = prepare(h).props.onClick()
    h.button('common.cancel').props.onClick()
    request.reject(new Error(secret))
    await pending
    await h.flush()
    assert.ok(h.closes.includes(false))
    h.assertPrivate()
  }
})

test('a late response from a closed dialog cannot clear or close a replacement creation', async () => {
  const first = deferred(), second = deferred()
  let count = 0
  const h = fixture({}, { create: () => (++count === 1 ? first.promise : second.promise) })
  const oldPending = prepare(h, 'First').props.onClick()
  h.nodes('Dialog')[0].props.onOpenChange(false)
  h.setProps({ open: false })
  h.setProps({ open: true })
  const newPending = prepare(h, 'Second').props.onClick()
  first.resolve({ success: false, reason: secret })
  await oldPending
  await h.flush()
  assert.match(h.text(), /Signing in and verifying/)
  assert.equal(h.input('name').props.value, 'Second')
  assert.deepEqual(h.createNames, ['First', 'Second'])
  assert.equal(h.cancellations, 1)
  assert.deepEqual(h.closes, [false])
  second.resolve({ success: true, accountId: 'synthetic-second' })
  await newPending
  await h.flush()
  assert.deepEqual(h.closes, [false, false])
  h.assertPrivate()
})

test('provider and editing-context changes invalidate the prior pending result', async () => {
  for (const next of [
    { provider: { ...defaultProvider, id: 'deepseek' } },
    { editingAccount: { id: 'synthetic-edit', name: 'Editing', credentials: {} } },
  ]) {
    const request = deferred()
    const h = fixture({}, { create: () => request.promise })
    const pending = prepare(h).props.onClick()
    h.setProps(next)
    assert.equal(h.cancellations, 1)
    request.resolve({ success: true, accountId: 'synthetic-late' })
    await pending
    await h.flush()
    assert.deepEqual(h.closes, [])
    assert.equal(h.adds.length, 0)
    h.assertPrivate()
  }
})

test('unmount cancels once and later rejection cannot write component state', async () => {
  const request = deferred()
  const h = fixture({}, { create: () => request.promise })
  const pending = prepare(h).props.onClick()
  h.unmount()
  request.reject(new Error(secret))
  await pending
  await tick()
  assert.equal(h.cancellations, 1)
  assert.equal(h.unmountedWrites, 0)
  assert.deepEqual(h.closes, [])
  h.assertPrivate()
})

test('ordinary parent callback identity changes do not cancel active creation', async () => {
  const request = deferred()
  const h = fixture({}, { create: () => request.promise })
  const pending = prepare(h).props.onClick()
  let replacementCalls = 0
  h.setProps({
    onCreateZaiAccount: async () => { replacementCalls++; return { success: false } },
    onOpenChange: value => h.closes.push(value),
  })
  assert.equal(h.cancellations, 0)
  assert.equal(h.createNames.length, 1)
  request.resolve({ success: true, accountId: 'synthetic-created' })
  await pending
  await h.flush()
  assert.equal(replacementCalls, 0)
  assert.deepEqual(h.closes, [false])
  h.assertPrivate()
})

test('new Z.ai accounts cannot enter the generic manual validation or single-save path', async () => {
  const h = fixture()
  h.name('  Protected account  ')
  h.render()
  assert.equal(h.nodes('CredentialFieldsForm').length,0)
  assert.equal(h.nodes('Input').filter(node => node.props.id === 'dailyLimit').length,0)
  assert.ok(!h.nodes('Button').some(node =>
    ['providers.addAccount','providers.validateCredentials'].some(label =>
      JSON.stringify(node.props.children).includes(label))))
  assert.equal(h.nodes('Tabs')[0].props.value,'oauth')
  await h.button('Sign in and add Z.ai account').props.onClick()
  await h.flush()
  assert.deepEqual(h.createNames,['Protected account'])
  assert.equal(h.legacy.length, 0)
  assert.equal(h.validations.length,0)
  assert.equal(h.adds.length,0)
})

test('non-Z.ai OAuth retains credential mapping and the later manual save', async () => {
  const h = fixture({ provider: { id: 'deepseek', name: 'Synthetic DeepSeek', authType: 'token' } }, {
    legacyResult: { success: true, credentials: { userToken: '{"value":"synthetic-provider-value"}' }, accountInfo: { name: 'Provider name' } },
  })
  h.tab('oauth')
  await h.button('providers.openOAuthLogin').props.onClick()
  await h.flush()
  assert.deepEqual(h.legacy, [['deepseek', 'deepseek']])
  assert.equal(h.createNames.length, 0)
  assert.deepEqual(h.closes, [])
  await h.button('providers.addAccount').props.onClick()
  await h.flush()
  assert.deepEqual(h.adds, [{ name: 'Provider name', credentials: { token: 'synthetic-provider-value' } }])
  assert.deepEqual(h.closes, [false])
})

test('editing a Z.ai account preserves the manual update path', async () => {
  const h = fixture({ editingAccount: { id: 'synthetic-existing', name: 'Existing account', credentials: { token: 'synthetic-existing-value' } } })
  assert.equal(h.nodes('Tabs').length, 0)
  assert.ok(!h.text().includes('Sign in and add Z.ai account'))
  await h.button('providers.saveChanges').props.onClick()
  await h.flush()
  assert.deepEqual(h.updates, [['synthetic-existing', { name: 'Existing account' }]])
  assert.equal(h.createNames.length, 0)
  assert.equal(h.adds.length, 0)
  assert.equal(h.legacy.length, 0)
})
