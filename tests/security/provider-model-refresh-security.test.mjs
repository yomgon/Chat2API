import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { parseDeepSeekWebModelCatalog } from '../../src/main/providers/deepseekWebModelCatalog.ts'
import { parseQwenChinaWebModelCatalog } from '../../src/main/providers/qwenChinaModelCatalog.ts'

// Run the real main IPC discovery function in isolation, with no Electron,
// network access, provider credential store, or user profile operations.
const source = readFileSync(new URL('../../src/main/ipc/handlers.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let functionSource
for (const statement of ast.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'refreshBuiltinWebModelCatalog') {
    functionSource = statement.getText(ast)
    break
  }
}
assert.ok(functionSource, 'Guarded model-refresh handler missing')
const javascript = ts.transpileModule(functionSource + '\nglobalThis.refresh = refreshBuiltinWebModelCatalog;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const secret = 'SYNTHETIC_PRIVATE_QWEN_ACCOUNT_SECRET_2198765'
const zaiJwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl'
const catalog = { data: [
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus' },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max' },
  { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash' },
] }

function setup({
  providerId = 'qwen-ai',
  provider = { id: 'qwen-ai', type: 'builtin' },
  builtin = { id: 'qwen-ai', modelsApiEndpoint: 'https://chat.qwen.ai/api/models',
    modelsApiHeaders: { Accept: 'application/json', source: 'web' } },
  accounts = [{ id: 'qwen-account', status: 'active', credentials: { token: secret, cookies: 'a=b' } }],
  status = 200,
  payload = catalog,
  networkError = null,
  parsingError = null,
  writeError = null,
  glmGuestCatalog = {
    supportedModels: ['GLM-5.3', 'GLM-5.3-Flash'],
    modelMappings: { 'GLM-5.3': 'glm-5.3', 'GLM-5.3-Flash': 'glm-5.3-flash' },
  },
  glmGuestError = null,
} = {}) {
  const requests = []
  const writes = []
  const logs = []
  const accountReads = []
  const glmGuestReads = []
  const context = {
    URL, URLSearchParams, Date, Buffer,
    randomUUID: () => '01234567-89ab-4cde-8f01-23456789abcd',
    ProviderManager: {
      getById: id => id === providerId ? provider : undefined,
      update: (id, update) => {
        if (writeError) throw writeError
        writes.push({ id, update })
        return { id, ...update }
      },
    },
    AccountManager: { getByProviderId: (id, includeCredentials) => {
      accountReads.push({ id, includeCredentials })
      return accounts
    } },
    getBuiltinProvider: () => builtin,
    axios: { get: async (url, options) => {
      requests.push({ method: 'GET', url, options })
      if (networkError) throw networkError
      return { status, data: payload }
    }, post: async (url, body, options) => {
      requests.push({ method: 'POST', url, body, options })
      if (networkError) throw networkError
      return { status, data: payload }
    } },
    parseProviderModelCatalog: (_id, body) => {
      if (parsingError) throw parsingError
      if (!body?.data || !Array.isArray(body.data)) throw new Error('Invalid catalog')
      return {
        supportedModels: body.data.map(x => x.name),
        modelMappings: Object.fromEntries(body.data.map(x => [x.name, x.id])),
      }
    },
    parseKimiWebChatCatalog: body => {
      if (parsingError) throw parsingError
      if (!Array.isArray(body?.availableModels)) throw new Error('Invalid Kimi catalog')
      const entries = body.availableModels.filter(x => x.scenario === 'SCENARIO_CHAT')
      return {
        supportedModels: entries.map(x => x.displayName),
        modelMappings: Object.fromEntries(entries.map(x => [x.displayName, x.id])),
      }
    },
    parseMimoWebChatCatalog: body => {
      if (parsingError) throw parsingError
      if (!Array.isArray(body?.data?.modelConfigList)) throw new Error('Invalid MiMo catalog')
      return {
        supportedModels: body.data.modelConfigList.map(x => x.name),
        modelMappings: Object.fromEntries(body.data.modelConfigList.map(x => [x.name, x.model])),
      }
    },
    parseDeepSeekWebModelCatalog,
    parseQwenChinaWebModelCatalog,
    fetchGLMGuestBrowserCatalog: async () => {
      glmGuestReads.push('ephemeral-first-party-guest')
      if (glmGuestError) throw glmGuestError
      return glmGuestCatalog
    },
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) },
  }
  vm.runInNewContext(javascript, context, { filename: 'offline-guarded-refresh.js', timeout: 2000 })
  return {
    run: () => context.refresh(providerId),
    requests, writes, logs, accountReads, glmGuestReads,
  }
}

test('Only a pinned HTTPS web-chat catalog receives a synthetic active account header', async () => {
  const h = setup()
  const result = await h.run()
  assert.equal(result.success, true)
  assert.equal(result.modelsCount, 3)
  assert.deepEqual([...result.supportedModels], ['Qwen3.7-Plus', 'Qwen3.8-Max', 'Qwen3.8-Omni-Flash'])
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, 'https://chat.qwen.ai/api/models')
  assert.equal(h.requests[0].method, 'GET')
  assert.equal(h.requests[0].options.maxRedirects, 0)
  assert.equal(h.requests[0].options.timeout, 15000)
  assert.equal(h.requests[0].options.maxContentLength, 512 * 1024)
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer ' + secret)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].id, 'qwen-ai')
  assert.equal(h.writes[0].update.modelCatalog.source, 'provider-web')
  assert.ok(Number.isSafeInteger(h.writes[0].update.modelCatalog.syncedAt))
  assert.deepEqual(h.logs, [])
  assert.equal(h.accountReads[0].includeCredentials, true)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('Z.ai web-only endpoint is pinned and may receive ONLY its own active token', async () => {
  const h = setup({
    providerId: 'zai',
    provider: { id: 'zai', type: 'builtin' },
    builtin: { id: 'zai', modelsApiEndpoint: 'https://chat.z.ai/api/models' },
    accounts: [{ status: 'active', credentials: { token: zaiJwt } }],
    payload: { data: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
  })
  const result = await h.run()
  assert.equal(result.success, true)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].method, 'GET')
  assert.equal(h.requests[0].url, 'https://chat.z.ai/api/models')
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer ' + zaiJwt)
  assert.equal(h.requests[0].options.headers.Cookie, 'token=' + zaiJwt)
  assert.equal(h.requests[0].options.maxRedirects, 0)
  assert.equal(h.accountReads[0].includeCredentials, true)
  assert.equal(h.writes.length, 1)
})

test('Qwen China first-party public catalog uses fresh ut and actual modelCode fields without touching accounts', async () => {
  const h = setup({
    providerId: 'qwen', provider: { id: 'qwen', type: 'builtin' },
    builtin: { id: 'qwen', modelsApiEndpoint: 'https://chat2-api.qianwen.com/api/v1/model/list' },
    accounts: [{ status: 'active', credentials: { ticket: 'SYNTHETIC_QWEN_TICKET', token: secret } }],
    payload: {
      code: 0, success: true, data: [
        { displayModelName: 'Qwen-快速 ', modelCode: 'Qwen', show: true },
        { displayModelName: 'Qwen3.7-Max', modelCode: 'tongyi-qwen37-max-model', show: true },
      ],
    },
  })
  const result = await h.run()
  assert.equal(result.success, true)
  assert.equal(result.modelMappings['Qwen-快速'], 'Qwen')
  assert.equal(result.modelMappings['Qwen3.7-Max'], 'tongyi-qwen37-max-model')
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].method, 'GET')
  const url = new URL(h.requests[0].url)
  assert.equal(url.origin + url.pathname, 'https://chat2-api.qianwen.com/api/v1/model/list')
  assert.equal(url.searchParams.get('biz_id'), 'ai_qwen')
  assert.equal(url.searchParams.get('ut'), '01234567-89ab-4cde-8f01-23456789abcd')
  assert.equal(url.searchParams.get('pr'), 'qwen')
  assert.equal(url.searchParams.get('chat_client'), 'h5')
  assert.equal(url.searchParams.get('tz'), 'Asia/Shanghai')
  assert.equal(h.requests[0].options.headers.Cookie, undefined)
  assert.equal(h.requests[0].options.headers.Authorization, undefined)
  assert.equal(h.requests[0].options.maxRedirects, 0)
  assert.equal(h.accountReads.length, 0)
  assert.equal(h.writes.length, 1)
  assert.ok(!JSON.stringify(h.requests).includes(secret))
})

test('Qwen China public catalog works with zero linked accounts and rejects invalid business responses without writes', async () => {
  const builtin = { id: 'qwen', modelsApiEndpoint: 'https://chat2-api.qianwen.com/api/v1/model/list' }
  const noAccount = setup({
    providerId: 'qwen', provider: { id: 'qwen', type: 'builtin' }, builtin, accounts: [],
    payload: {code:0,success:true,data:[{displayModelName:'Qwen-快速 ',modelCode:'Qwen',show:true}]},
  })
  assert.equal((await noAccount.run()).success, true)
  assert.equal(noAccount.accountReads.length, 0)
  assert.equal(noAccount.writes.length, 1)

  const bad = setup({
    providerId: 'qwen', provider: { id: 'qwen', type: 'builtin' }, builtin, accounts: [],
    payload: {code:10001,success:false,msg:'ut'},
  })
  assert.equal((await bad.run()).success, false)
  assert.equal(bad.accountReads.length, 0)
  assert.equal(bad.writes.length, 0)
  assert.equal(bad.requests.length, 1)
})

test('GLM public guest catalog is pinned and never accesses saved credentials or refresh-token endpoint', async () => {
  const h = setup({
    providerId: 'glm',
    provider: { id: 'glm', type: 'builtin' },
    builtin: {
      id: 'glm',
      modelsApiEndpoint: 'https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models',
      modelsApiMethod: 'GET',
    },
    accounts: [{ status: 'active', credentials: { refresh_token: secret } }],
  })
  const result = await h.run()
  assert.equal(result.success, true)
  assert.equal(result.modelsCount, 2)
  assert.deepEqual([...result.supportedModels], ['GLM-5.3', 'GLM-5.3-Flash'])
  assert.equal(result.modelMappings['GLM-5.3'], 'glm-5.3')
  assert.equal(result.modelMappings['GLM-5.3-Flash'], 'glm-5.3-flash')
  assert.equal(h.glmGuestReads.length, 1)
  assert.equal(h.accountReads.length, 0, 'GLM public guest refresh must not read the user account')
  assert.equal(h.requests.length, 0, 'GLM must never POST /user/refresh or call Axios with a stored token')
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].update.modelCatalog.source, 'provider-web')
  assert.equal(h.logs.length, 0)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('GLM catalog rejects untrusted destinations and custom providers before opening a guest browser', async () => {
  for (const [provider, builtin] of [
    [{ id: 'glm', type: 'custom' }, {
      id: 'glm', modelsApiEndpoint: 'https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models',
    }],
    [{ id: 'glm', type: 'builtin' }, {
      id: 'glm', modelsApiEndpoint: 'https://attacker.invalid/agent-api/operation/detail?tag=available_models',
    }],
  ]) {
    const h = setup({ providerId: 'glm', provider, builtin })
    const result = await h.run()
    assert.equal(result.success, false)
    assert.equal(h.glmGuestReads.length, 0)
    assert.equal(h.accountReads.length, 0)
    assert.equal(h.requests.length, 0)
    assert.equal(h.writes.length, 0)
  }
})

test('A failed GLM guest catalog lookup preserves prior saved models without response/secret leakage', async () => {
  const h = setup({
    providerId: 'glm', provider: { id: 'glm', type: 'builtin' },
    builtin: {
      id: 'glm', modelsApiEndpoint: 'https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models',
    },
    glmGuestError: new Error('SYNTHETIC PRIVATE CREDENTIAL SHOULD NEVER ESCAPE'),
  })
  const result = await h.run()
  assert.equal(result.success, false)
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.accountReads, [])
  assert.deepEqual(h.requests, [])
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC PRIVATE CREDENTIAL/)
  assert.equal(h.glmGuestReads.length, 1)
})

test('Malformed Z.ai JWT must be refused before any credential-bearing request', async () => {
  for (const token of ['', 'synthetic-private', 'eyJnot-a-jwt', 'eyJ.one.two\r\nInjected: true', 'eyJ.one.two;unsafe=true']) {
    const h = setup({
      providerId: 'zai', provider: { id: 'zai', type: 'builtin' },
      builtin: { id: 'zai', modelsApiEndpoint: 'https://chat.z.ai/api/models' },
      accounts: [{ status: 'active', credentials: { token } }],
    })
    const result = await h.run()
    assert.equal(result.success, false)
    assert.match(result.error, /credential format/)
    assert.deepEqual(h.requests, [])
    assert.deepEqual(h.writes, [])
    assert.ok(!JSON.stringify(result).includes(token || 'synthetic-private'))
  }
})

test('A clearly expired Z.ai JWT is stopped without any remote request or token output', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: 'synthetic', exp: 1500000000 })).toString('base64url')
  const oldJwt = `${header}.${payload}.c2lnbmF0dXJl`
  const h = setup({
    providerId: 'zai', provider: { id: 'zai', type: 'builtin' },
    builtin: { id: 'zai', modelsApiEndpoint: 'https://chat.z.ai/api/models' },
    accounts: [{ status: 'active', credentials: { token: oldJwt } }],
  })
  const result = await h.run()
  assert.equal(result.success, false)
  assert.match(result.error, /expired/)
  assert.deepEqual(h.requests, [])
  assert.deepEqual(h.writes, [])
  assert.ok(!JSON.stringify(result).includes(oldJwt))
})

test('Z.ai catalog authentication and upstream HTTP error are distinguished without returning credentials', async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = setup({
      providerId: 'zai', provider: { id: 'zai', type: 'builtin' },
      builtin: { id: 'zai', modelsApiEndpoint: 'https://chat.z.ai/api/models' },
      accounts: [{ status: 'active', credentials: { token: zaiJwt } }],
      status,
    })
    const result = await h.run()
    assert.equal(result.success, false)
    assert.match(result.error, new RegExp(String(status)))
    assert.ok(!JSON.stringify(result).includes(zaiJwt))
    assert.equal(h.writes.length, 0)
    assert.equal(h.requests.length, 1)
  }
})

test('Public Kimi read-only config POST and MiMo GET NEVER receive saved tokens or cookies', async () => {
  const cases = [
    {
      id: 'kimi',
      url: 'https://www.kimi.com/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels',
      method: 'POST',
      payload: { availableModels: [
        { id: 'k2d6-chat', displayName: 'Instant', scenario: 'SCENARIO_CHAT' },
        { id: 'k3-agent', displayName: 'K3', scenario: 'SCENARIO_OK_COMPUTER' },
      ] },
    },
    {
      id: 'mimo',
      url: 'https://aistudio.xiaomimimo.com/open-apis/bot/config',
      method: 'GET',
      payload: { data: { modelConfigList: [
        { model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
      ] } },
    },
  ]
  for (const item of cases) {
    const h = setup({
      providerId: item.id,
      provider: { id: item.id, type: 'builtin' },
      builtin: {
        id: item.id, modelsApiEndpoint: item.url,
        ...(item.method === 'POST' ? { modelsApiMethod: 'POST' } : {}),
      },
      payload: item.payload,
    })
    const result = await h.run()
    assert.equal(result.success, true, item.id)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].method, item.method)
    assert.equal(h.requests[0].url, item.url)
    assert.equal(h.requests[0].options.maxRedirects, 0)
    assert.equal(h.requests[0].options.headers.Authorization, undefined)
    assert.equal(h.requests[0].options.headers.Cookie, undefined)
    assert.equal(h.accountReads.length, 0, 'Public catalog must not touch local accounts')
    assert.ok(!JSON.stringify(h.requests).includes(secret), item.id)
    if (item.method === 'POST') {
      assert.equal(typeof h.requests[0].body, 'object')
      assert.equal(Object.keys(h.requests[0].body).length, 0)
    }
    assert.equal(h.writes.length, 1)
    assert.equal(h.writes[0].update.modelCatalog.source, 'provider-web')
  }
})

test('DeepSeek public web settings use a synthetic UUID and the real wire-mode parser, never a saved token', async () => {
  const payload = {
    code: 0, data: { biz_code: 0, biz_data: { settings: { model_configs: { value: [
      { model_type: 'default', name: '快速模式', enabled: true, switchable: true },
      { model_type: 'expert', name: '专家模式', enabled: false, switchable: false },
      { model_type: 'vision', name: '识图模式', enabled: false, switchable: false },
    ] } } } },
  }
  const h = setup({
    providerId: 'deepseek', provider: { id: 'deepseek', type: 'builtin' },
    builtin: { id: 'deepseek', modelsApiEndpoint: 'https://chat.deepseek.com/api/v0/client/settings?scope=model' },
    payload,
  })
  const result = await h.run()
  assert.equal(result.success, true)
  assert.deepEqual([...result.supportedModels], ['快速模式'])
  assert.equal(result.modelMappings['快速模式'], 'default')
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, 'https://chat.deepseek.com/api/v0/client/settings?scope=model&did=01234567-89ab-4cde-8f01-23456789abcd')
  assert.equal(h.requests[0].method, 'GET')
  assert.equal(h.requests[0].options.maxRedirects, 0)
  assert.equal(h.requests[0].options.headers.Authorization, undefined)
  assert.equal(h.requests[0].options.headers.Cookie, undefined)
  assert.equal(h.accountReads.length, 0, 'DeepSeek public catalog must not touch local accounts')
  assert.ok(!JSON.stringify(h.requests).includes(secret))
  assert.equal(h.writes.length, 1)
})

test('DeepSeek HTTP 200 business errors do not overwrite existing models', async () => {
  const h = setup({
    providerId: 'deepseek', provider: { id: 'deepseek', type: 'builtin' },
    builtin: { id: 'deepseek', modelsApiEndpoint: 'https://chat.deepseek.com/api/v0/client/settings?scope=model' },
    payload: { code: 0, data: { biz_code: 2, biz_msg: 'INVALID_PARAM', biz_data: null } },
  })
  const result = await h.run()
  assert.equal(result.success, false)
  assert.match(result.error, /response format is unsupported/)
  assert.equal(h.writes.length, 0)
  assert.equal(h.requests.length, 1)
})

test('Untrusted endpoint never receives credentials, and cannot update the catalog', async () => {
  for (const url of [
    'http://chat.qwen.ai/api/models',
    'https://evil.example/api/models',
    'https://chat.qwen.ai.evil.example/api/models',
    'https://chat.qwen.ai/path',
    'https://chat.qwen.ai/api/models?key=1',
    'https://user:pass@chat.qwen.ai/api/models',
    'https://chat.qwen.ai:8443/api/models',
  ]) {
    const h = setup({ builtin: { modelsApiEndpoint: url } })
    const result = await h.run()
    assert.equal(result.success, false, url)
    assert.deepEqual(h.requests, [])
    assert.deepEqual(h.writes, [])
  }
})

test('Every additional provider rejects a mismatched method, host or path before any network request', async () => {
  for (const { id, correct, method } of [
    { id: 'zai', correct: 'https://chat.z.ai/api/models', method: 'GET' },
    { id: 'mimo', correct: 'https://aistudio.xiaomimimo.com/open-apis/bot/config', method: 'GET' },
    { id: 'kimi', correct: 'https://www.kimi.com/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels', method: 'POST' },
    { id: 'deepseek', correct: 'https://chat.deepseek.com/api/v0/client/settings?scope=model', method: 'GET' },
    { id: 'qwen', correct: 'https://chat2-api.qianwen.com/api/v1/model/list', method: 'GET' },
  ]) {
    const hBadPath = setup({
      providerId: id, provider: { id, type: 'builtin' },
      builtin: { id, modelsApiEndpoint: correct + '?access_token=' + secret, modelsApiMethod: method },
    })
    assert.equal((await hBadPath.run()).success, false)
    assert.deepEqual(hBadPath.requests, [])
    const hBadMethod = setup({
      providerId: id, provider: { id, type: 'builtin' },
      builtin: { id, modelsApiEndpoint: correct, modelsApiMethod: method === 'POST' ? 'GET' : 'POST' },
    })
    assert.equal((await hBadMethod.run()).success, false)
    assert.deepEqual(hBadMethod.requests, [])
  }
})

test('Unsupported provider, missing active account, and missing provider do not fetch or write', async () => {
  const cases = [
    setup({ provider: null }),
    setup({ provider: { id: 'qwen-ai', type: 'custom' } }),
    setup({ builtin: { id: 'qwen-ai' } }),
    setup({ accounts: [] }),
    setup({ accounts: [{ id: 'old', status: 'inactive', credentials: { token: secret } }] }),
  ]
  for (const h of cases) {
    const result = await h.run()
    assert.equal(result.success, false)
    assert.deepEqual(h.requests, [])
    assert.deepEqual(h.writes, [])
    assert.ok(!JSON.stringify(result).includes(secret))
  }
})

test('HTTP failure, parser failure, thrown AxiosError and write error do not leak or partially update', async () => {
  const cases = [
    setup({ status: 302 }),
    setup({ status: 401 }),
    setup({ status: 503 }),
    setup({ parsingError: Object.assign(new Error(secret), { headers: { Cookie: secret } }) }),
    setup({ networkError: Object.assign(new Error(secret), { config: { headers: { Authorization: secret } } }) }),
    setup({ writeError: new Error(secret) }),
  ]
  for (const h of cases) {
    const result = await h.run()
    assert.equal(result.success, false)
    assert.ok(!JSON.stringify(result).includes(secret))
    assert.deepEqual(h.logs, [])
    assert.equal(h.writes.length, 0)
  }
})

test('Malformed HTTP 200 payload is distinguishable from upstream rejection without exposing response', async () => {
  const h = setup({ parsingError: new Error('SECRET_PAYLOAD_DO_NOT_ECHO') })
  const result = await h.run()
  assert.equal(result.success, false)
  assert.match(result.error, /response format is unsupported/)
  assert.ok(!JSON.stringify(result).includes('SECRET_PAYLOAD_DO_NOT_ECHO'))
  assert.deepEqual(h.writes, [])
})
