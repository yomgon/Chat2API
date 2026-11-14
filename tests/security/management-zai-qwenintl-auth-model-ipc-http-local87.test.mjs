import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// REAL management authentication, AccountManager/validateCredentials,
// ProviderChecker, LoadBalancer, model routes and trusted IPC callbacks.
// Only the OS-protected store is a synthetic in-memory clone; the only HTTP
// listener is the test's 127.0.0.1:0 Koa. Vendor Axios requests are closed
// captures, never dispatched to an external host or real user profile.
const nodeRequire = createRequire(import.meta.url)
const ROOT = new URL('../../src/main/', import.meta.url)
const source = rel => readFileSync(new URL(rel, ROOT), 'utf8')
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const compile = (code, path) => ts.transpileModule(code, {
  fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const PRIVATE = 'LOCAL87_SYNTHETIC_BEARER_NEVER_EXPORT'
const SECRET = 'mgmt_11111111-1111-4111-8111-111111111111'
const SUBJECT = 'local87-account-identity'
const jwt = () => [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ id: SUBJECT })).toString('base64url'),
  Buffer.from('local87-only-fake-signature').toString('base64url'),
].join('.')
const noExpJwt = jwt()

function run(code, name, deps = {}, globals = {}) {
  const mod = { exports: {} }
  runInNewContext(compile(code, name), {
    module: mod, exports: mod.exports, Buffer, URL, Date, Math, Error,
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
    require(key) {
      if (Object.hasOwn(deps, key)) return deps[key]
      if (key.startsWith('.')) throw Error('Unmocked product import in ' + name + ': ' + key)
      return nodeRequire(key)
    },
    ...globals,
  }, { filename: name, timeout: 2000, codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}
const product = (name, imports, globals = {}) => run(source(name), name, imports, globals)
function actualFunction(relative, functionName, globals = {}) {
  const src = source(relative)
  const ast = ts.createSourceFile(relative, src, ts.ScriptTarget.Latest, true)
  const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === functionName)
  assert.ok(node, 'Actual source function unavailable: ' + functionName)
  return run(node.getText(ast) + '\nexports.' + functionName + '=' + functionName,
    relative + '::' + functionName, {}, globals)[functionName]
}
const zaiSession = product('oauth/zaiSession.ts', { crypto: nodeRequire('node:crypto') })
const qwenChina = product('providers/qwenTicket.ts', {})
const qwenIntl = product('providers/qwenAiToken.ts', {})

function registerAccountValidationIpc(globals) {
  const file = source('ipc/handlers.ts')
  const tree = ts.createSourceFile('ipc/handlers.ts', file, ts.ScriptTarget.Latest, true)
  let found
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'handleTrusted' && node.arguments.length >= 2 &&
        node.arguments[0].getText(tree) === 'IpcChannels.ACCOUNTS_VALIDATE_TOKEN') {
      found = node.getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(found, 'Actual trusted account-token handler must exist')
  const callbacks = new Map()
  const registration = run('exports.register=(handleTrusted)=>{' + found + ';}',
    'trusted-account-validation-local87.ts', {}, globals)
  registration.register((name, callback) => callbacks.set(name, callback))
  assert.equal(callbacks.size, 1)
  return callbacks.get('account:validateToken') ?? [...callbacks.values()][0]
}

async function fixture({ providerId = 'zai', identity = SUBJECT,
  firstPartyStatus = 200, malformedBody, allow = true, noExp = true,
  accountCredential,
} = {}) {
  assert.ok(providerId === 'zai' || providerId === 'qwen-ai')
  const endpoint = providerId === 'zai' ? 'https://chat.z.ai/api' : 'https://chat.qwen.ai'
  const expectedUrl = providerId === 'zai'
    ? 'https://chat.z.ai/api/v1/auths/' : 'https://chat.qwen.ai/api/v2/user'
  const accountId = 'isolated-account-' + providerId
  const alias = 'local87-' + providerId + '-alias'
  const wire = providerId === 'zai' ? 'glm-5' : 'qwen3.7-plus'
  const initialCredentials = accountCredential ??
    (providerId === 'zai' ? { token: noExpJwt } : { accessToken: PRIVATE })
  const provider = Object.freeze({
    id: providerId, name: 'Synthetic ' + providerId,
    apiEndpoint: endpoint, type: 'builtin', authType: 'jwt',
    enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
  })
  let accounts = [{ id: accountId, providerId, name: 'Synthetic existing account',
    credentials: clone(initialCredentials), status: 'error',
    createdAt: 100, updatedAt: 101,
  }]
  const effects = { gets: [], generic: 0, posts: 0, writes: 0, changes: [], accountSuccess: 0 }
  const storeManager = {
    getConfig: () => ({
      managementApi: { enableManagementApi: allow, managementApiSecret: SECRET },
      loadBalanceStrategy: 'round-robin', modelMappings: {
        [alias]: { actualModel: wire, preferredProviderId: providerId, preferredAccountId: accountId },
      },
    }),
    getAccounts: () => clone(accounts),
    getAccountById: id => clone(accounts.find(a => a.id === id)),
    getAccountsByProviderId: id => clone(accounts.filter(a => a.providerId === id)),
    getProviderById: id => id === providerId ? clone(provider) : undefined,
    getProviders: () => [clone(provider)],
    getEffectiveModels: id => id === providerId
      ? [{ displayName: wire, actualModelId: wire }]
      : [],
    updateAccount(id, patch) {
      effects.writes++
      const target = accounts.find(a => a.id === id)
      if (!target) return null
      const next = { ...target, ...clone(patch), updatedAt: target.updatedAt + 1 }
      effects.changes.push(clone(patch))
      accounts = accounts.map(a => a.id === id ? next : a)
      return clone(next)
    },
    addLog() {},
  }
  const body = malformedBody !== undefined
    ? malformedBody
    : providerId === 'zai'
      ? { id: identity }
      : { success: true, data: { name: 'Synthetic existing',
        email: 'synthetic@example.invalid', is_guest: false } }
  const axios = Object.assign(() => { effects.generic++; throw Error('No generic auth fallback') }, {
    get(url, options) {
      effects.gets.push({ url, options })
      return Promise.resolve({ status: firstPartyStatus, data: body,
        headers: { 'content-type': 'application/json' } })
    },
    post() { effects.posts++; throw Error('No first-party POST is allowed') },
  })
  const builtin = { getBuiltinProvider: id => id === providerId ? clone(provider) : undefined }
  const checker = product('providers/checker.ts', {
    axios: { __esModule: true, default: axios },
    './builtin': builtin,
    './qwenTicket': qwenChina, './qwenAiToken': qwenIntl,
    '../oauth/zaiSession': zaiSession,
  }).ProviderChecker
  const validateCredentials = actualFunction('store/validator.ts', 'validateCredentials', {
    ProviderChecker: checker,
    GenericTokenValidator: class { constructor() { throw Error('Custom validator forbidden') } },
  })
  const AccountManager = product('store/accounts.ts', {
    './store': { storeManager }, './validator': { validateCredentials },
  }).AccountManager
  const auth = product('proxy/middleware/managementAuth.ts', {
    '../../store/store': { storeManager },
  }).managementAuthMiddleware
  const accountRouter = product('proxy/routes/management/accounts.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/accounts': { __esModule: true, default: AccountManager },
  }).default
  const modelMapper = { getMatchingMapping: m => m === alias
    ? { actualModel: wire, preferredProviderId: providerId, preferredAccountId: accountId }
    : undefined,
    mapModel: m => m === alias ? wire : m,
    hasAmbiguousMatchingMapping: () => false,
  }
  const loadBalancer = product('proxy/loadbalancer.ts', {
    '../store/store': { storeManager }, './modelMapper': { modelMapper },
  }).loadBalancer
  const models = product('proxy/routes/models.ts', {
    '@koa/router': nodeRequire('@koa/router'),
    '../../store/store': { storeManager },
    '../loadbalancer': { loadBalancer }, '../modelMapper': { modelMapper },
  }).default
  const app = new (nodeRequire('koa'))()
  app.use(nodeRequire('koa-bodyparser')())
  app.use(accountRouter.routes())
  app.use(accountRouter.allowedMethods())
  app.use(models.routes())
  app.use(models.allowedMethods())
  const server = createServer(app.callback())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const http = (relative, method = 'GET', secret = SECRET) => new Promise((resolve, reject) => {
    const chunks = []
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: relative, method,
      headers: { Host: '127.0.0.1:' + port,
        ...(secret ? { Authorization: 'Bearer ' + secret } : {}) },
    }, response => {
      response.on('data', part => chunks.push(part))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: response.statusCode, raw, json })
      })
    })
    request.on('error', reject)
    request.setTimeout(3000, () => request.destroy(Error('Synthetic Koa validation timeout')))
    request.end()
  })
  const validateTokenViaIpc = registerAccountValidationIpc({
    IpcChannels: { ACCOUNTS_VALIDATE_TOKEN: 'account:validateToken' },
    ProviderManager: { getById: id => id === providerId ? clone(provider) : undefined },
    getBuiltinProvider: builtin.getBuiltinProvider,
    ProviderChecker: checker,
  })
  return {
    alias, wire, accountId, providerId, expectedUrl, effects,
    http, state: () => clone(accounts),
    trustedValidateToken: credentials => validateTokenViaIpc({}, providerId, credentials),
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

for (const [name, options, expected] of [
  ['Z.ai no-exp matching user', { providerId: 'zai' }, true],
  ['Z.ai wrong first-party user', { providerId: 'zai', identity: 'different-subject' }, false],
  ['Z.ai HTTP 401 account', { providerId: 'zai', firstPartyStatus: 401 }, false],
  ['Qwen International legacy accessToken', { providerId: 'qwen-ai' }, true],
  ['Qwen International server-declared failure', {
    providerId: 'qwen-ai', malformedBody: { success: false, data: {
      name: 'Synthetic', is_guest: false } },
  }, false],
]) {
  test('local87 actual management Koa validation and GET /v1/models agree: ' + name, async t => {
    const f = await fixture(options)
    t.after(f.close)
    const original = f.state()
    const route = '/v1/models/' + f.alias
    assert.equal((await f.http(route)).status, 404, 'Inactive account cannot advertise pinned model')
    const validation = await f.http(`/v0/management/accounts/${f.accountId}/validate`, 'POST')
    assert.equal(validation.status, 200, validation.raw)
    assert.equal(validation.json.data.valid, expected)
    assert.equal(f.effects.gets.length, 1)
    assert.equal(f.effects.gets[0].url, f.expectedUrl)
    assert.equal(f.effects.gets[0].options.maxRedirects, 0)
    assert.equal(f.effects.posts, 0)
    assert.equal(f.effects.generic, 0)
    assert.equal(f.effects.writes, 1)
    const state = f.state()[0]
    assert.equal(state.status, expected ? 'active' : 'error')
    assert.deepEqual(state.credentials, original[0].credentials, 'Auth never overwrites account token')
    assert.equal((await f.http(route)).status, expected ? 200 : 404)
    const listing = await f.http('/v1/models')
    assert.equal(listing.status, 200)
    assert.equal(listing.json.data.some(m => m.id === f.alias), expected)
    const read = await f.http(`/v0/management/accounts/${f.accountId}`)
    assert.equal(read.status, 200)
    assert.equal(Object.values(read.json.data.credentials).every(v => v === '***'), true)
    assert.equal(read.raw.includes(PRIVATE), false)
    assert.equal(read.raw.includes(noExpJwt), false)
    assert.equal(validation.raw.includes(PRIVATE), false)
    assert.equal(validation.raw.includes(noExpJwt), false)
  })
}

for (const providerId of ['zai', 'qwen-ai']) {
  test('local87 actual trusted account-token IPC is read-only and uses bound official identity: ' + providerId, async t => {
    const f = await fixture({ providerId })
    t.after(f.close)
    const stored = f.state()
    const result = await f.trustedValidateToken(stored[0].credentials)
    assert.equal(result.valid, true)
    assert.equal(f.effects.gets.length, 1)
    assert.equal(f.effects.gets[0].url, f.expectedUrl)
    assert.equal(f.effects.writes, 0, 'Pre-add account validation must not rewrite an existing account')
    assert.equal(f.effects.posts, 0)
    assert.equal(f.effects.generic, 0)
    assert.deepEqual(f.state(), stored)
  })
}

test('local87 unauthorized management account validation does not contact any provider or change saved account', async t => {
  const f = await fixture({ providerId: 'zai' })
  t.after(f.close)
  const before = f.state()
  const result = await f.http(`/v0/management/accounts/${f.accountId}/validate`, 'POST', 'incorrect')
  assert.equal(result.status, 401)
  assert.equal(f.effects.gets.length, 0)
  assert.equal(f.effects.writes, 0)
  assert.deepEqual(f.state(), before)
})
