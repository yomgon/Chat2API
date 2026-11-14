import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Production selector, synthetic store only. No app/profile, credential store,
// HTTP transport, provider adapter, port, or real account is imported.
const root = fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(path.join(root, 'src/main/proxy/loadbalancer.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'loadbalancer.ts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
})
assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
const mapperCompiled = ts.transpileModule(
  readFileSync(path.join(root, 'src/main/proxy/modelMapper.ts'), 'utf8'), {
    fileName: 'modelMapper.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText

const webEndpoints = {
  deepseek: 'https://chat.deepseek.com', glm: 'https://chatglm.cn',
  kimi: 'https://www.kimi.com', qwen: 'https://www.qianwen.com',
  'qwen-ai': 'https://chat.qwen.ai', zai: 'https://chat.z.ai',
  minimax: 'https://chat.minimaxi.com', mimo: 'https://aistudio.xiaomimimo.com',
  perplexity: 'https://www.perplexity.ai',
}
const webIds = Object.keys(webEndpoints)
const strategies = ['round-robin', 'fill-first', 'failover']
const model = { displayName: 'Synthetic Display Model', actualModelId: 'synthetic-wire-model' }
const alternateModel = { displayName: 'Synthetic Other Model', actualModelId: 'synthetic-other-wire' }
const provider = (id = 'qwen-ai', extras = {}) => ({
  id, name: 'Synthetic ' + id, type: 'builtin', enabled: true,
  apiEndpoint: webEndpoints[id] || 'https://generic.example.invalid', ...extras,
})
const account = (providerId, id, extras = {}) => ({
  id, providerId, name: 'Synthetic account', status: 'active', todayUsed: 0, ...extras,
})

function harness({ providers = [provider()], accounts, catalogs, mappings = {} } = {}) {
  const syntheticAccounts = accounts ?? [account(providers[0].id, 'pinned'), account(providers[0].id, 'other')]
  const effective = catalogs ?? Object.fromEntries(providers.map(p => [p.id, [model]]))
  const requests = []
  const storeManager = {
    getProviders: () => providers,
    getConfig: () => ({ modelMappings: mappings }),
    getEffectiveModels: id => effective[id] || [],
    getAccountsByProviderId: (id, withCredentials) => {
      requests.push({ id, withCredentials })
      return syntheticAccounts.filter(a => a.providerId === id)
    },
  }
  const mapperModule = { exports: {} }
  vm.runInNewContext(mapperCompiled, {
    module: mapperModule, exports: mapperModule.exports,
    require: name => {
      if (name === '../store/store') return { storeManager }
      throw new Error('Unexpected model mapper dependency: ' + name)
    },
  }, { filename: 'synthetic-modelMapper.cjs', timeout: 1500 })
  const modelMapper = new mapperModule.exports.ModelMapper()
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, Date, URL,
    require: name => {
      if (name === '../store/store') return { storeManager }
      if (name === './modelMapper') return { modelMapper }
      throw new Error('Unexpected selector dependency: ' + name)
    },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: 'synthetic-loadbalancer.cjs', timeout: 1500 })
  return { selector: new module.exports.LoadBalancer(), requests }
}

for (const providerId of webIds) {
  test(providerId + ' refuses unavailable explicit identity under every selection strategy', () => {
    for (const condition of ['missing', 'inactive', 'expired', 'foreign', 'failed', 'quota']) {
      for (const strategy of strategies) {
        const fixed = account(providerId, 'pinned',
          condition === 'inactive' ? { status: 'inactive' }
            : condition === 'expired' ? { status: 'expired' }
              : condition === 'foreign' ? { providerId: 'foreign-provider' }
                : condition === 'quota' ? { dailyLimit: 1, todayUsed: 1 } : {})
        const h = harness({
          providers: [provider(providerId)],
          accounts: [...(condition === 'missing' ? [] : [fixed]), account(providerId, 'other')],
        })
        if (condition === 'failed') for (let i = 0; i < 3; i++) h.selector.markAccountFailed('pinned')
        const result = h.selector.selectAccount(model.displayName, strategy, providerId, 'pinned')
        assert.equal(result === null, true, providerId + '/' + condition + '/' + strategy + ' substituted an account')
      }
    }
  })
}

test('a Qwen identity pin without a provider binding cannot choose another account', () => {
  for (const strategy of strategies) {
    const h = harness({ accounts: [account('qwen-ai', 'other')] })
    assert.equal(h.selector.selectAccount(model.displayName, strategy, undefined, 'pinned') === null, true)
  }
})

test('a foreign pinned account that cannot serve the requested model is not replaced with Qwen', () => {
  const h = harness({
    providers: [provider(), provider('foreign-provider', { type: 'custom' })],
    accounts: [account('qwen-ai', 'other'), account('foreign-provider', 'pinned')],
    catalogs: { 'qwen-ai': [model], 'foreign-provider': [alternateModel] },
  })
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', undefined, 'pinned') === null, true)
})

test('an unresolved web pin cannot escape to generic candidates when its provider has no available account', () => {
  for (const condition of ['inactive', 'provider-disabled', 'missing']) {
    const h = harness({
      providers: [provider('qwen-ai', { enabled: condition !== 'provider-disabled' }),
        provider('generic', { type: 'custom', name: 'Synthetic generic API' })],
      accounts: [
        ...(condition === 'missing' ? [] : [account('qwen-ai', 'pinned', { status: 'inactive' })]),
        account('generic', 'other'),
      ],
    })
    assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', undefined, 'pinned') === null, true, condition)
  }
})

test('a web account pin cannot be substituted on another provider but a healthy generic pin remains usable', () => {
  const providers = [provider(), provider('generic', { type: 'custom', name: 'Synthetic generic API' })]
  const accounts = [account('qwen-ai', 'pinned'), account('generic', 'generic-pinned')]
  const h = harness({ providers, accounts })
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', 'generic', 'pinned') === null, true)
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', 'generic', 'generic-pinned')?.account.id, 'generic-pinned')
})

test('web endpoint/name aliases have the same explicit identity protection as builtins', () => {
  for (const [webId, endpoint] of Object.entries(webEndpoints)) {
    const id = 'custom-web-alias'
    const p = provider(id, {
      type: 'custom', apiEndpoint: endpoint,
      name: webId === 'mimo' ? 'Synthetic MiMo alias' : 'Synthetic web alias',
    })
    const h = harness({ providers: [p], accounts: [account(id, 'other')] })
    assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', id, 'pinned') === null, true, webId)
  }
})

test('legacy dispatch substring matches only tighten fallback and never switch identity', () => {
  const p = provider('legacy-custom', {
    type: 'custom', apiEndpoint: 'https://generic.example.invalid/?upstream=deepseek.com',
  })
  const h = harness({ providers: [p], accounts: [account(p.id, 'other')] })
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', p.id, 'pinned') === null, true)
})

test('healthy explicit identities and unpinned generic balancing remain available', () => {
  for (const id of webIds) {
    const h = harness({ providers: [provider(id)] })
    const result = h.selector.selectAccount(model.displayName, 'round-robin', id, 'pinned')
    assert.equal(result?.account.id, 'pinned')
    assert.equal(result?.actualModel, model.actualModelId)
  }
  const p = provider('generic', { type: 'custom', name: 'Synthetic generic API' })
  const h = harness({ providers: [p], accounts: [account(p.id, 'other')] })
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', p.id)?.account.id, 'other')
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', p.id, 'missing') === null, true)
})

test('a deleted pin or missing owner provider cannot be guessed to authorize generic fallback', () => {
  for (const orphaned of [false, true]) {
    const p = provider('generic', { type: 'custom', name: 'Synthetic generic API' })
    const h = harness({ providers: [p], accounts: [account(p.id, 'other'),
      ...(orphaned ? [account('qwen-ai', 'pinned')] : [])] })
    assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', undefined, 'pinned') === null, true)
  }
})

test('nonempty catalog rejects a stale mapped target even when provider or request display name matches', () => {
  for (const id of webIds) {
    for (const requested of ['synthetic-alias', model.displayName]) {
      const h = harness({
        providers: [provider(id)],
        mappings: { [requested]: { requestModel: requested, actualModel: 'unlisted-target', preferredProviderId: id } },
      })
      assert.equal(h.selector.selectAccount(requested, 'round-robin', id, 'pinned') === null, true, id)
    }
  }
})

test('catalog admission and actual selection reject another provider mapping and malformed targets', () => {
  for (const actualModel of ['', ' ', undefined, 42]) {
    const h = harness({ mappings: {
      alias: { requestModel: 'alias', actualModel, preferredProviderId: 'qwen-ai' },
    } })
    assert.equal(h.selector.selectAccount('alias', 'round-robin', 'qwen-ai', 'pinned') === null, true)
  }
  const h = harness({ mappings: {
    [model.displayName]: { requestModel: model.displayName, actualModel: model.actualModelId, preferredProviderId: 'other' },
  } })
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', 'qwen-ai', 'pinned') === null, true)
})

test('six configured provider catalogs preserve labels, wire IDs and bound/unbound aliases', () => {
  for (const id of ['deepseek', 'qwen', 'qwen-ai', 'glm', 'kimi', 'zai']) {
    for (const target of [model.displayName, model.actualModelId]) {
      for (const bindProvider of [true, false]) {
        const h = harness({
          providers: [provider(id)], mappings: {
            alias: { requestModel: 'alias', actualModel: target,
              ...(bindProvider ? { preferredProviderId: id } : {}) },
          },
        })
        for (const requested of [model.displayName, model.actualModelId, 'alias']) {
          const result = h.selector.selectAccount(requested, 'round-robin', bindProvider ? id : undefined, 'pinned')
          assert.equal(result?.provider.id, id)
          assert.equal(result?.account.id, 'pinned')
          assert.equal(result?.actualModel, model.actualModelId)
        }
      }
    }
  }
})

test('an explicit global mapping keeps its selected target when its alias is also a display name', () => {
  const h = harness({
    catalogs: { 'qwen-ai': [model, alternateModel] },
    mappings: { [model.displayName]: {
      requestModel: model.displayName, actualModel: alternateModel.actualModelId, preferredProviderId: 'qwen-ai',
    } },
  })
  assert.equal(h.selector.selectAccount(model.displayName, 'round-robin', 'qwen-ai', 'pinned')?.actualModel, alternateModel.actualModelId)
})

test('existing empty-catalog and wildcard passthrough is unchanged without an identity mismatch', () => {
  const empty = harness({ catalogs: { 'qwen-ai': [] } })
  assert.equal(empty.selector.selectAccount('synthetic-unlisted', 'round-robin', 'qwen-ai', 'pinned')?.actualModel, 'synthetic-unlisted')
  const wildcard = harness({ catalogs: { 'qwen-ai': [{ displayName: 'synthetic-*', actualModelId: 'synthetic-*' }] } })
  assert.equal(wildcard.selector.selectAccount('synthetic-version', 'round-robin', 'qwen-ai', 'pinned')?.actualModel, 'synthetic-version')
  const unavailable = harness({ catalogs: { 'qwen-ai': [] }, accounts: [account('qwen-ai', 'other')] })
  assert.equal(unavailable.selector.selectAccount('synthetic-unlisted', 'round-robin', 'qwen-ai', 'pinned') === null, true)
})
