import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Run the actual Koa /v1/models handlers with a fake router and memory store.
// The test cannot reach an Electron credential store, real proxy, or network.
const pathname = fileURLToPath(new URL('../../src/main/proxy/routes/models.ts', import.meta.url))
const source = readFileSync(pathname, 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: pathname,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const mapperSource = readFileSync(new URL('../../src/main/proxy/modelMapper.ts', import.meta.url), 'utf8')
const mapperCompiled = ts.transpileModule(mapperSource, {
  fileName: 'modelMapper.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const loadBalancerSource = readFileSync(new URL('../../src/main/proxy/loadbalancer.ts', import.meta.url), 'utf8')
const loadBalancerCompiled = ts.transpileModule(loadBalancerSource, {
  fileName: 'loadbalancer.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function routeHarness({ providers = [], accounts = [], effective = {}, mappings = {} } = {}) {
  const routes = {}
  class Router {
    get(route, fn) { routes[route] = fn }
  }
  const storeManager = {
    getProviders: () => providers,
    getAccountsByProviderId: id => accounts.filter(a => a.providerId === id),
    getEffectiveModels: id => effective[id] || [],
    getConfig: () => ({ modelMappings: mappings }),
  }
  const mapperModule = { exports: {} }
  vm.runInNewContext(mapperCompiled, {
    module: mapperModule, exports: mapperModule.exports,
    require: name => {
      if (name === '../store/store') return { storeManager }
      throw new Error('Blocked model mapper import: ' + name)
    },
  }, { filename: 'isolated-real-modelMapper.cjs', timeout: 2000 })
  const modelMapper = new mapperModule.exports.ModelMapper()
  const loadBalancerModule = { exports: {} }
  vm.runInNewContext(loadBalancerCompiled, {
    module: loadBalancerModule, exports: loadBalancerModule.exports, Date, Math, Map, Set,
    console: { log() {} },
    require: name => {
      if (name === '../store/store') return { storeManager }
      if (name === './modelMapper') return { modelMapper }
      throw new Error('Blocked loadbalancer import: ' + name)
    },
  }, { filename: 'isolated-real-loadBalancer.cjs', timeout: 2000 })
  const loadBalancer = new loadBalancerModule.exports.LoadBalancer()
  const requireMock = specifier => {
    if (specifier === '@koa/router') return { default: Router }
    if (specifier === '../../store/store') return { storeManager }
    if (specifier === '../loadbalancer') return { loadBalancer }
    if (specifier === '../modelMapper') return { modelMapper }
    throw new Error('Blocked network/application import: ' + specifier)
  }
  const exports = {}
  vm.runInNewContext(compiled, { exports, require: requireMock, Date, Math, Set, Object }, {
    filename: 'isolated-model-route.cjs', timeout: 2000,
  })
  assert.equal(typeof routes['/models'], 'function')
  assert.equal(typeof routes['/models/:model'], 'function')
  return {
    list: async () => {
      const ctx = { status: 200, set: () => {} }
      await routes['/models'](ctx)
      return { status: ctx.status, rows: JSON.parse(JSON.stringify(ctx.body?.data || [])) }
    },
    get: async id => {
      const ctx = { status: 200, params: { model: id }, set: () => {} }
      await routes['/models/:model'](ctx)
      return { status: ctx.status, body: JSON.parse(JSON.stringify(ctx.body || {})) }
    },
  }
}

const deepseek = { id: 'deepseek', name: 'DeepSeek', enabled: true, createdAt: 1000 }
const qwen = { id: 'qwen-ai', name: 'Qwen AI', enabled: true, createdAt: 2000 }
const actual = {
  deepseek: [{ displayName: 'DeepSeek V4', actualModelId: 'deepseek-v4-flash' }],
  'qwen-ai': [{ displayName: 'Qwen3.8-Max', actualModelId: 'qwen3.8-max' }],
}
const mappings = {
  'alias-good': { requestModel: 'alias-good', actualModel: 'deepseek-v4-flash', preferredProviderId: 'deepseek' },
  'alias-unknown': { requestModel: 'alias-unknown', actualModel: 'made-up' },
  'alias-disconnected': { requestModel: 'alias-disconnected', actualModel: 'qwen3.8-max', preferredProviderId: 'qwen-ai' },
  'alias-wrong-owner': { requestModel: 'alias-wrong-owner', actualModel: 'qwen3.8-max', preferredProviderId: 'deepseek' },
  'alias-wrong-account': { requestModel: 'alias-wrong-account', actualModel: 'deepseek-v4-flash', preferredAccountId: 'different-account' },
}

test('Model mappings are not advertised merely because they exist in config', async () => {
  const h = routeHarness({
    providers: [deepseek, qwen],
    accounts: [
      { id: 'deepseek-acct', providerId: deepseek.id, status: 'active' },
      { id: 'qwen-acct', providerId: qwen.id, status: 'inactive' },
    ],
    effective: actual, mappings,
  })
  const rows = (await h.list()).rows
  const ids = rows.map(x => x.id)
  assert.deepEqual(ids, ['DeepSeek V4', 'alias-good'])
  assert.equal((await h.get('alias-good')).status, 200)
  for (const name of ['alias-disconnected', 'alias-unknown', 'alias-wrong-owner', 'alias-wrong-account']) {
    assert.equal((await h.get(name)).status, 404, name)
  }
})

test('Web-discovered model is listed only with a configured active provider account', async () => {
  const h = routeHarness({
    providers: [deepseek, qwen],
    accounts: [
      { id: 'deepseek-acct', providerId: deepseek.id, status: 'inactive' },
      { id: 'qwen-acct', providerId: qwen.id, status: 'active' },
    ],
    effective: actual, mappings,
  })
  const ids = (await h.list()).rows.map(x => x.id)
  assert.deepEqual(ids, ['Qwen3.8-Max', 'alias-disconnected'])
  assert.equal((await h.get('alias-disconnected')).status, 200)
  assert.equal((await h.get('alias-good')).status, 404)
})

test('Disabled provider or stale preferred account never claims mapping availability', async () => {
  const h = routeHarness({
    providers: [{ ...qwen, enabled: false }],
    accounts: [{ id: 'qwen-acct', providerId: 'qwen-ai', status: 'active' }],
    effective: actual,
    mappings: { alias: { requestModel: 'alias', actualModel: 'qwen3.8-max', preferredProviderId: 'qwen-ai' } },
  })
  assert.deepEqual((await h.list()).rows, [])
  assert.equal((await h.get('alias')).status, 404)
})

test('Unbound mapping may resolve only to an actual configured provider model', async () => {
  const h = routeHarness({
    providers: [deepseek],
    accounts: [{ id: 'account-1', providerId: 'deepseek', status: 'active' }],
    effective: actual,
    mappings: {
      'alias-id': { requestModel: 'alias-id', actualModel: 'deepseek-v4-flash' },
      'alias-display': { requestModel: 'alias-display', actualModel: 'DeepSeek V4' },
      'alias-absent': { requestModel: 'alias-absent', actualModel: 'not-listed-by-any-provider' },
    },
  })
  assert.deepEqual((await h.list()).rows.map(x => x.id), ['DeepSeek V4', 'alias-id', 'alias-display'])
  assert.equal((await h.get('alias-absent')).status, 404)
})
