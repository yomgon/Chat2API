import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { isIP } from 'node:net'
import { inspect } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

// Run: node --test tests/security/provider-endpoint-trust.test.mjs
// Evaluate only the four owned sources in one VM. Store, management auth and
// router are doubles; only net.isIP is exposed. Unknown imports fail closed.
// No Electron, request transport, DNS, OS keystore or user data is loaded.
const sourceFiles = {
  trust: 'src/main/providers/endpointTrust.ts',
  custom: 'src/main/providers/custom.ts',
  manager: 'src/main/store/providers.ts',
  routes: 'src/main/proxy/routes/management/providers.ts',
}
const compiled = new Map()
const copy = value => JSON.parse(JSON.stringify(value))
const savedToken = 'safeStorage:v1:SYNTHETIC_ENDPOINT_TRUST_CIPHERTEXT'
const secretMarker = 'SYNTHETIC_ENDPOINT_TRUST_SECRET_DO_NOT_LOG'

function source(path) {
  return readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
}

function provider(overrides = {}) {
  return {
    id: 'provider-one', name: 'Synthetic provider', type: 'custom', authType: 'token',
    apiEndpoint: 'https://api.example.com/v1', headers: {}, enabled: true,
    createdAt: 1, updatedAt: 1, ...overrides,
  }
}

function account(credentials = { token: savedToken }, overrides = {}) {
  return {
    id: 'account-one', providerId: 'provider-one', name: 'Synthetic account',
    status: 'active', credentials, createdAt: 1, updatedAt: 1, ...overrides,
  }
}

function fixture({ providers = [provider()], accounts = [] } = {}) {
  const state = { providers: copy(providers), accounts: copy(accounts) }
  const writes = []
  const accountReads = []
  const logs = []
  let nextId = 0
  const store = {
    getProviders: () => state.providers,
    getProviderById: id => state.providers.find(item => item.id === id),
    getAccountsByProviderId(id, includeCredentials) {
      assert.equal(includeCredentials, false, 'Endpoint checks must not request decrypted credentials')
      accountReads.push(id)
      return state.accounts.filter(item => item.providerId === id)
    },
    addProvider(value) {
      writes.push({ operation: 'add', value: copy(value) })
      state.providers = [...state.providers, copy(value)]
    },
    updateProvider(id, updates) {
      const current = state.providers.find(item => item.id === id)
      if (!current) return null
      const updated = { ...current, ...updates, updatedAt: 2 }
      writes.push({ operation: 'update', id, value: copy(updates) })
      state.providers = state.providers.map(item => item.id === id ? copy(updated) : item)
      return updated
    },
    generateId: () => 'generated-provider-' + ++nextId,
    addLog: (...args) => logs.push(args),
    decryptCredentials() { assert.fail('No credential decryption is allowed') },
    decryptData() { assert.fail('No credential decryption is allowed') },
  }
  const callbacks = new Map()
  const middleware = []
  class Router {
    use(callback) { middleware.push(callback) }
    get(path, callback) { callbacks.set('GET ' + path, callback) }
    post(path, callback) { callbacks.set('POST ' + path, callback) }
    put(path, callback) { callbacks.set('PUT ' + path, callback) }
    patch(path, callback) { callbacks.set('PATCH ' + path, callback) }
    delete(path, callback) { callbacks.set('DELETE ' + path, callback) }
  }
  const context = vm.createContext({
    URL,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [
      level, (...args) => logs.push([level, ...args]),
    ])),
  }, { codeGeneration: { strings: false, wasm: false } })
  function load(path, imports) {
    if (!compiled.has(path)) {
      const output = ts.transpileModule(source(path), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
        reportDiagnostics: true,
        fileName: path,
      })
      assert.deepEqual(output.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
      compiled.set(path, output.outputText)
    }
    const module = { exports: {} }
    const evaluate = new vm.Script(
      '(function(require, module, exports) {\n' + compiled.get(path) + '\n})',
      { filename: path },
    ).runInContext(context)
    evaluate(name => {
      assert.ok(Object.hasOwn(imports, name), 'Unexpected import blocked: ' + name)
      return imports[name]
    }, module, module.exports)
    return module.exports
  }
  const trust = load(sourceFiles.trust, { 'node:net': { isIP } })
  const manager = load(sourceFiles.manager, {
    './store': { storeManager: store },
    './types': { BUILTIN_PROVIDERS: [] },
    '../providers/endpointTrust': trust,
  }).ProviderManager
  const custom = load(sourceFiles.custom, {
    '../store/store': { storeManager: store },
    './endpointTrust': trust,
    './builtin': { getBuiltinProvider: id => ['deepseek', 'glm', 'kimi', 'minimax', 'mimo',
      'perplexity', 'qwen', 'qwen-ai', 'zai'].includes(id) ? { id } : undefined },
  }).CustomProviderManager
  const auth = async (_ctx, next) => next()
  load(sourceFiles.routes, {
    '@koa/router': Router,
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/providers': { default: manager, __esModule: true },
    '../../../providers/endpointTrust': trust,
  })
  async function request(method, body, id = 'provider-one') {
    const ctx = {
      request: { body }, params: { id }, status: 200, body: undefined,
      set() {},
    }
    const callback = callbacks.get(method)
    assert.ok(callback, 'Expected management route: ' + method)
    await callback(ctx)
    return ctx
  }
  return { trust, manager, custom, state, store, writes, accountReads, logs, request, middleware, auth }
}

function assertBlocked(f, operation, code = 'invalid_endpoint') {
  const before = copy(f.state)
  const writeCount = f.writes.length
  assert.throws(operation, { name: 'ProviderEndpointTrustError', code })
  assert.deepEqual(f.state, before, 'Rejected change must preserve providers and encrypted accounts')
  assert.equal(f.writes.length, writeCount, 'Rejected change must not write')
}

const publicEndpoints = [
  'https://api.example.com',
  'https://api.example.com/v1',
  'https://api.example.com:8443/custom/path',
  'HTTPS://API.EXAMPLE.COM:443/v1/',
  'https://xn--bcher-kva.example.com/v1',
  'https://api.example.com/%E2%9C%93',
  'https://8.8.8.8/v1',
  'https://[2001:4860:4860::8888]/v1',
  'https://[2606:4700:4700::1111]:443/v1',
  'http://127.0.0.1:11434/v1',
  'http://[::1]:11434/v1',
  'https://127.0.0.1:8443/v1',
  'https://[::1]/v1',
]

test('accepted endpoints retain their exact path, casing and slash convention', () => {
  const { trust } = fixture()
  for (const url of publicEndpoints) assert.equal(trust.validateProviderEndpoint(url), url)
})

test('credentials, empty query/fragment, schemes, malformed input and control characters are rejected', () => {
  const { trust } = fixture()
  const bad = [
    undefined, null, 1, {}, [], '', ' '.repeat(2), 'https://api.example.com/' + 'x'.repeat(4096),
    'file:///tmp/provider', 'data:text/plain,hello', 'javascript:alert(1)',
    'ftp://api.example.com', 'ws://api.example.com', '//api.example.com',
    'https:api.example.com', 'https:///api.example.com', 'https:////api.example.com',
    'https://user:password@api.example.com', 'https://@api.example.com',
    'https://api.example.com?', 'https://api.example.com?token=synthetic',
    'https://api.example.com#', 'https://api.example.com#synthetic',
    ' https://api.example.com', 'https://api.example.com ', 'https://api.example.com/\n',
    'https://api.exa\tmple.com', 'https://api.example.com/\u0000',
    'https://api.example.com\\@127.0.0.1', 'https:\\\\api.example.com',
    'https://api.example.com:', 'https://api.example.com:0', 'https://api.example.com:65536',
    'https://api.example.com:NaN', 'https://api.example.com:443.evil.com',
  ]
  for (const url of bad) assert.throws(() => trust.validateProviderEndpoint(url), { code: 'invalid_endpoint' })
})

test('HTTP exception applies only to the exact loopback literals', () => {
  const { trust } = fixture()
  for (const url of [
    'http://api.example.com', 'http://8.8.8.8', 'http://localhost',
    'http://localhost.example.com', 'http://127.0.0.1.example.com',
    'http://[2001:4860::1]', 'http://[0:0:0:0:0:0:0:1]',
  ]) assert.throws(() => trust.validateProviderEndpoint(url), { code: 'invalid_endpoint' })
})

test('numeric IPv4 aliases and encoded hostnames cannot acquire loopback trust', () => {
  const { trust } = fixture()
  for (const host of [
    '127.1', '127.0.1', '2130706433', '0x7f000001', '0177.0.0.1',
    '127.000.000.001', '127.0.0.1.', '0x08080808', '8.8.8',
    '%31%32%37.0.0.1', 'api%2eexample.com', '１２７。０。０。１',
  ]) {
    for (const scheme of ['http', 'https']) {
      assert.throws(() => trust.validateProviderEndpoint(scheme + '://' + host + '/v1'), { code: 'invalid_endpoint' })
    }
  }
})

test('private, metadata, shared, documentation and multicast IPv4 literals are rejected', () => {
  const { trust } = fixture()
  for (const host of [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.100.100.200',
    '100.127.255.254', '127.0.0.2', '169.254.169.254', '172.16.0.1', '172.31.255.254',
    '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.254', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
  ]) assert.throws(() => trust.validateProviderEndpoint('https://' + host), { code: 'invalid_endpoint' })
})

test('IPv6 local, mapped IPv4, translation, transition and special prefixes are rejected', () => {
  const { trust } = fixture()
  for (const host of [
    '::', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '::8.8.8.8', '64:ff9b::808:808', '64:ff9b:1::1',
    'fc00::1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '2001::1', '2001:2::1', '2001:10::1', '2001:1ff::1',
    '2001:db8::1', '2002:808:808::1', '3ffe::1', '3fff::1',
    'fe80::1%25eth0',
  ]) assert.throws(() => trust.validateProviderEndpoint('https://[' + host + ']/v1'), { code: 'invalid_endpoint' })
})

test('single-label, local-suffix and ambiguous DNS names are rejected', () => {
  const { trust } = fixture()
  for (const host of [
    'localhost', 'printer', 'service.localhost', 'service.local', 'service.localdomain',
    'service.lan', 'service.home', 'service.home.arpa', 'metadata.google.internal',
    'service.intranet', 'service.corp', 'service.private', 'service.onion',
    'service.test', 'service.invalid', 'service.example', 'service.alt',
    'api.example.com.', 'api..example.com', '-api.example.com', 'api-.example.com',
    'api_example.com', 'api.example.1', 'a'.repeat(64) + '.example.com', 'bücher.example.com',
  ]) assert.throws(() => trust.validateProviderEndpoint('https://' + host + '/v1'), { code: 'invalid_endpoint' })
})

test('all shipped built-in endpoint and chat paths remain accepted without rewriting', () => {
  const { trust } = fixture()
  const root = new URL('../../src/main/providers/builtin/', import.meta.url)
  let checked = 0
  for (const name of readdirSync(root).filter(name => name.endsWith('.ts'))) {
    const ast = ts.createSourceFile(name, readFileSync(new URL(name, root), 'utf8'), ts.ScriptTarget.Latest, true)
    const values = {}
    function visit(node) {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) &&
          ['apiEndpoint', 'chatPath'].includes(node.name.text) && ts.isStringLiteral(node.initializer)) {
        values[node.name.text] = node.initializer.text
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    if (!values.apiEndpoint) continue
    assert.equal(trust.validateProviderEndpoint(values.apiEndpoint), values.apiEndpoint)
    const f = fixture({ providers: [] })
    const created = f.manager.create({
      name: 'Built-in fixture ' + name, type: 'builtin', authType: 'token', ...values,
    })
    assert.equal(created.apiEndpoint, values.apiEndpoint)
    assert.equal(created.chatPath, values.chatPath)
    checked++
  }
  assert.ok(checked >= 9, 'Every current built-in endpoint should be included')
})

test('canonical origins allow path, host casing and explicit default-port edits with stored credentials', () => {
  for (const kind of ['manager', 'custom']) {
    const f = fixture({ accounts: [account()] })
    const beforeAccounts = copy(f.state.accounts)
    const input = Object.freeze({ apiEndpoint: 'HTTPS://API.EXAMPLE.COM:443/other/path/' })
    const updated = f[kind].update('provider-one', input)
    assert.equal(updated.apiEndpoint, input.apiEndpoint)
    assert.deepEqual(f.state.accounts, beforeAccounts)
    assert.deepEqual(f.accountReads, ['provider-one'])
    assert.equal(f.writes.length, 1)
  }
})

test('scheme, host and port changes cannot reuse saved credentials', () => {
  for (const kind of ['manager', 'custom']) {
    for (const endpoint of [
      'https://other.example.com/v1', 'https://api.example.com:8443/v1',
      'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1',
    ]) {
      const f = fixture({ accounts: [account()] })
      assertBlocked(f, () => f[kind].update('provider-one', { apiEndpoint: endpoint }),
        'endpoint_origin_change_requires_reconnect')
    }
    const f = fixture({
      providers: [provider({ apiEndpoint: 'https://127.0.0.1:11434/v1' })], accounts: [account()],
    })
    assertBlocked(f, () => f[kind].update('provider-one', { apiEndpoint: 'http://127.0.0.1:11434/v1' }),
      'endpoint_origin_change_requires_reconnect')
  }
})

test('disabled accounts, encrypted fields, legacy cookie maps and malformed credential envelopes bind origin', () => {
  for (const credentials of [
    { token: savedToken }, { refresh_token: savedToken }, { apiKey: savedToken },
    { cookies: 'safeStorage:cookies:v1:SYNTHETIC' }, { cookies: { session: 'SYNTHETIC' } },
    { sessionKey: 'SYNTHETIC' }, { customField: savedToken }, 'opaque-legacy-envelope', [],
  ]) {
    const f = fixture({ accounts: [account(credentials, { status: 'disabled' })] })
    assertBlocked(f, () => f.manager.update('provider-one', { apiEndpoint: 'https://other.example.com/v2' }),
      'endpoint_origin_change_requires_reconnect')
    assert.deepEqual(f.accountReads, ['provider-one'])
  }
})

test('another provider account does not bind this endpoint; empty credentials allow change', () => {
  for (const accounts of [
    [], [account({}, { providerId: 'another-provider' })],
    [account()], [account({})], [account({ token: '', cookie: '', cookies: {} })],
  ]) {
    const relevant = accounts.map(item => item.credentials?.token === savedToken
      ? { ...item, providerId: 'another-provider' } : item)
    const f = fixture({ accounts: relevant })
    assert.equal(f.manager.update('provider-one', { apiEndpoint: 'https://other.example.com/v2' }).apiEndpoint,
      'https://other.example.com/v2')
  }
})

test('deleting saved accounts permits endpoint change and reconnecting binds the new origin', () => {
  const f = fixture({ accounts: [account()] })
  assertBlocked(f, () => f.manager.update('provider-one', { apiEndpoint: 'https://other.example.com/v1' }),
    'endpoint_origin_change_requires_reconnect')
  f.state.accounts = []
  assert.equal(f.manager.update('provider-one', { apiEndpoint: 'https://other.example.com/v1' }).apiEndpoint,
    'https://other.example.com/v1')
  f.state.accounts = [account({ token: 'safeStorage:v1:SYNTHETIC_RECONNECTED' })]
  assertBlocked(f, () => f.manager.update('provider-one', { apiEndpoint: 'https://api.example.com/v1' }),
    'endpoint_origin_change_requires_reconnect')
})

test('legacy unsafe endpoints require reconnect for rewrites but metadata changes remain possible', () => {
  for (const oldEndpoint of [
    'not a URL', 'http://api.example.com/v1', 'https://user:old@api.example.com/v1',
    'https://api.example.com/v1?old=value', 'https://api.example.com/v1#old',
  ]) {
    for (const kind of ['manager', 'custom']) {
      const f = fixture({ providers: [provider({ apiEndpoint: oldEndpoint })], accounts: [account()] })
      assertBlocked(f, () => f[kind].update('provider-one', { apiEndpoint: 'https://api.example.com/v2' }),
        'endpoint_origin_change_requires_reconnect')
      const updated = f[kind].update('provider-one', { description: 'Safe metadata update' })
      assert.equal(updated.apiEndpoint, oldEndpoint)
      assert.equal(updated.description, 'Safe metadata update')
    }
  }
})

test('runtime provider ID and type tampering cannot rebind saved accounts', () => {
  for (const kind of ['manager', 'custom']) {
    for (const updates of [
      { id: 'victim-provider', apiEndpoint: 'https://other.example.com' },
      { type: 'builtin' }, { type: undefined }, { id: undefined },
    ]) {
      const f = fixture({ accounts: [account({ token: savedToken }, { providerId: 'victim-provider' })] })
      assertBlocked(f, () => f[kind].update('provider-one', updates), 'invalid_provider_update')
    }
    const f = fixture()
    assert.equal(f[kind].update('provider-one', { id: 'provider-one', type: 'custom', description: 'kept' }).id,
      'provider-one')
  }
})

test('caller-supplied empty account/credential fields cannot bypass the trusted account snapshot', () => {
  for (const kind of ['manager', 'custom']) {
    const f = fixture({ accounts: [account()] })
    assertBlocked(f, () => f[kind].update('provider-one', {
      apiEndpoint: 'https://other.example.com', accounts: [], credentials: {},
    }), 'endpoint_origin_change_requires_reconnect')
  }
})

test('non-object updates and explicit invalid endpoints fail without a write', () => {
  for (const kind of ['manager', 'custom']) {
    for (const updates of [null, [], 'https://other.example.com']) {
      const f = fixture()
      assertBlocked(f, () => f[kind].update('provider-one', updates), 'invalid_provider_update')
    }
    for (const apiEndpoint of [undefined, null, '', 0, {}, 'http://api.example.com']) {
      const f = fixture()
      assertBlocked(f, () => f[kind].update('provider-one', { apiEndpoint }))
    }
  }
})

test('both create managers validate before adding or returning a duplicate provider', () => {
  for (const kind of ['manager', 'custom']) {
    for (const type of ['custom', 'builtin']) {
      const f = fixture()
      assertBlocked(f, () => f[kind].create({
        id: 'provider-one', name: 'Synthetic provider', type, authType: 'token',
        apiEndpoint: 'http://api.example.com',
      }))
      assert.equal(f.logs.length, 0)
    }
    const f = fixture({ providers: [] })
    const created = f[kind].create({
      name: 'New provider', authType: 'token', apiEndpoint: 'http://[::1]:11434/v1',
    })
    assert.equal(created.apiEndpoint, 'http://[::1]:11434/v1')
    assert.equal(f.writes.length, 1)
  }
})

test('creation cannot hijack an orphaned provider ID that still has saved accounts', () => {
  for (const kind of ['manager', 'custom']) {
    const f = fixture({ providers: [], accounts: [account()] })
    assertBlocked(f, () => f[kind].create({
      id: 'provider-one', name: 'Recreated provider', type: 'custom', authType: 'token',
      apiEndpoint: 'https://other.example.com/v1',
    }), 'endpoint_origin_change_requires_reconnect')
  }
})

test('duplicate creation returns the existing provider without changing its endpoint', () => {
  for (const kind of ['manager', 'custom']) {
    const f = fixture({ accounts: [account()] })
    const returned = f[kind].create({
      id: 'provider-one', name: 'Synthetic provider', type: 'custom', authType: 'token',
      apiEndpoint: 'https://other.example.com/v1',
    })
    assert.equal(returned.apiEndpoint, 'https://api.example.com/v1')
    assert.equal(f.writes.length, 0)
    assert.equal(f.logs.length, 0)
  }
})

test('unavailable account lookup fails closed without persisting or decrypting', () => {
  const f = fixture({ accounts: [account()] })
  f.store.getAccountsByProviderId = () => { throw new Error('Synthetic account lookup unavailable') }
  assert.throws(() => f.manager.update('provider-one', { apiEndpoint: 'https://other.example.com' }),
    /lookup unavailable/)
  assert.equal(f.writes.length, 0)
})

test('built-in core configuration remains immutable and metadata updates preserve its paths', () => {
  const f = fixture({
    providers: [provider({ type: 'builtin', apiEndpoint: 'https://chat.deepseek.com/api', chatPath: '/v0/chat/completion' })],
    accounts: [account()],
  })
  assert.throws(() => f.manager.update('provider-one', { apiEndpoint: 'https://other.example.com' }),
    /Built-in providers cannot modify/)
  assert.throws(() => f.custom.update('provider-one', { apiEndpoint: 'https://other.example.com' }),
    /Cannot modify built-in provider/)
  assert.equal(f.writes.length, 0)
  const updated = f.manager.update('provider-one', { enabled: false })
  assert.equal(updated.apiEndpoint, 'https://chat.deepseek.com/api')
  assert.equal(updated.chatPath, '/v0/chat/completion')
  assert.equal(f.accountReads.length, 0)
})

test('public CustomProviderManager.validate uses the same endpoint policy', () => {
  const f = fixture({ providers: [] })
  const data = { name: 'New provider', authType: 'token', apiEndpoint: 'http://api.example.com' }
  assert.equal(f.custom.validate(data).valid, false)
  assert.equal(f.custom.validate({ ...data, apiEndpoint: 'https://api.example.com/v1' }).valid, true)
  assert.equal(f.writes.length, 0)
})

test('management POST returns 400 for invalid endpoints, including forged built-in type', async () => {
  for (const apiEndpoint of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://10.0.0.1']) {
    for (const type of ['custom', 'builtin']) {
      const f = fixture({ providers: [] })
      const ctx = await f.request('POST /', { name: 'New provider', authType: 'token', type, apiEndpoint })
      assert.equal(ctx.status, 400)
      assert.equal(ctx.body.error.code, 'invalid_endpoint')
      assert.equal(f.writes.length, 0)
      assert.deepEqual(f.middleware, [f.auth])
    }
  }
})

test('management POST accepts valid loopback and external HTTPS endpoints', async () => {
  for (const apiEndpoint of ['http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1', 'https://api.example.com/v1']) {
    const f = fixture({ providers: [] })
    const ctx = await f.request('POST /', {
      name: 'New provider', authType: 'token', type: 'custom', apiEndpoint, chatPath: '/chat/completions',
    })
    assert.equal(ctx.status, 201)
    assert.equal(ctx.body.data.apiEndpoint, apiEndpoint)
    assert.equal(ctx.body.data.chatPath, '/chat/completions')
    assert.equal(f.writes.length, 1)
  }
})

test('management PUT returns 409 with reconnect guidance and leaves saved data unchanged', async () => {
  const f = fixture({ accounts: [account()] })
  const before = copy(f.state)
  const ctx = await f.request('PUT /:id', {
    apiEndpoint: 'https://other.example.com/v1', headers: { Authorization: secretMarker },
  })
  assert.equal(ctx.status, 409)
  assert.equal(ctx.body.error.code, 'endpoint_origin_change_requires_reconnect')
  assert.match(ctx.body.error.message, /Delete.*saved accounts.*reconnect/)
  assert.equal(JSON.stringify(ctx.body).includes(secretMarker), false)
  assert.deepEqual(f.state, before)
  assert.equal(f.writes.length, 0)
})

test('management PUT accepts same-origin edits and origin changes without saved credentials', async () => {
  for (const [accounts, apiEndpoint] of [
    [[account()], 'https://API.EXAMPLE.COM:443/v2'],
    [[], 'https://other.example.com/v1'],
  ]) {
    const f = fixture({ accounts })
    const ctx = await f.request('PUT /:id', { apiEndpoint })
    assert.equal(ctx.status, 200)
    assert.equal(ctx.body.success, true)
    assert.equal(ctx.body.data.apiEndpoint, apiEndpoint)
    assert.equal(f.writes.length, 1)
    assert.deepEqual(f.state.accounts, accounts)
  }
})

test('management malformed bodies and endpoints return 400; built-in restriction still returns 403', async () => {
  for (const method of ['POST /', 'PUT /:id']) {
    for (const body of [undefined, null, [], 'invalid']) {
      const f = fixture()
      assert.equal((await f.request(method, body)).status, 400)
      assert.equal(f.writes.length, 0)
    }
  }
  for (const apiEndpoint of [null, '', 0, 'https://api.example.com?']) {
    const f = fixture()
    assert.equal((await f.request('PUT /:id', { apiEndpoint })).status, 400)
    assert.equal(f.writes.length, 0)
  }
  const f = fixture({ providers: [provider({ type: 'builtin' })] })
  assert.equal((await f.request('PUT /:id', { apiEndpoint: 'https://other.example.com' })).status, 403)
  assert.equal(f.writes.length, 0)
})

test('rejected endpoint values and encrypted credential markers never appear in errors or logs', () => {
  const f = fixture({ accounts: [account({ token: secretMarker })] })
  const errors = []
  for (const apiEndpoint of [
    'https://user:' + secretMarker + '@other.example.com',
    'https://other.example.com?token=' + secretMarker,
    'https://other.example.com',
  ]) {
    try { f.manager.update('provider-one', { apiEndpoint }) } catch (error) { errors.push(error) }
  }
  assert.equal(errors.length, 3)
  assert.equal(inspect({ errors, logs: f.logs }, { depth: 10 }).includes(secretMarker), false)
  assert.equal(f.writes.length, 0)
})
