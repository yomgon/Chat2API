import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFileSync, existsSync } from 'node:fs'
import { QWEN_TICKET_MODULE } from './helpers/qwenTicketModule.mjs'
import { QWEN_AI_TOKEN_MODULE } from './helpers/qwenAiTokenModule.mjs'
import { ZAI_SESSION_MODULE } from './helpers/zaiSessionModule.mjs'

// Closed, synthetic evaluation of the REAL startup, trusted IPC, dashboard
// and provider checker. No Electron boot, operating home/store, credentials,
// socket, fetch, account checker, login, model refresh or real provider.
const source = relative => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const compile = (code, filename = 'offline.ts') => ts.transpileModule(code, {
  fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true },
}).outputText
const evaluate = (code, modules = {}, globals = {}) => {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Date, Math, Promise, Buffer,
    console: { log() {}, warn() {}, error() {} },
    ...globals,
    require(id) {
      if (Object.hasOwn(modules, id)) return modules[id]
      throw Error('Forbidden dependency in offline fixture ' + id)
    },
  }, { timeout: 2500, filename: 'offline.ts',
    codeGeneration: { strings: false, wasm: false } })
  return mod.exports
}

const handlersFile = source('src/main/ipc/handlers.ts')
const handlerTree = ts.createSourceFile('handlers.ts', handlersFile, ts.ScriptTarget.Latest, true)
function getRegistration(channel) {
  let selected
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'handleTrusted' && node.arguments.length >= 2 &&
      ts.isPropertyAccessExpression(node.arguments[0]) &&
      node.arguments[0].name.text === channel) {
      selected = node.getText(handlerTree)
    }
    ts.forEachChild(node, visit)
  }
  visit(handlerTree)
  assert.ok(selected, 'required real trusted IPC channel ' + channel)
  return selected
}
function registrations(channels, deps = {}) {
  const selected = channels.map(getRegistration)
  const code = compile('exports.register = function register(handleTrusted) { ' +
    selected.join(';\n') + '; }')
  const module = evaluate(code, {}, deps)
  const callbacks = new Map()
  module.register((channel, handler) => callbacks.set(channel, handler))
  return callbacks
}

test('test-only quiet startup is an exact immutable opt-in, ordinary mode unchanged', () => {
  const path = new URL('../../src/main/quietStartup.ts', import.meta.url)
  assert.ok(existsSync(path), 'explicit startup latch module must exist')
  const code = compile(readFileSync(path, 'utf8'))
  for (const [env, expected] of [
    [{}, false],
    [{ CHAT2API_PRIVATE_TEST_QUIET_STARTUP: '0' }, false],
    [{ CHAT2API_PRIVATE_TEST_QUIET_STARTUP: 'true' }, false],
    [{ CHAT2API_PRIVATE_TEST_QUIET_STARTUP: '1' }, true],
  ]) {
    const process = { env: { ...env } }
    const mod = evaluate(code, {}, { process })
    assert.equal(mod.isTestQuietStartup(), expected)
    process.env.CHAT2API_PRIVATE_TEST_QUIET_STARTUP = expected ? '0' : '1'
    assert.equal(mod.isTestQuietStartup(), expected, 'must latch at module evaluation')
  }
})

function extractAutoStartIf() {
  const src = source('src/main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', src, ts.ScriptTarget.Latest, true)
  let selected
  const visit = node => {
    if (ts.isIfStatement(node) &&
      node.expression.getText(tree).includes('config.autoStartProxy')) selected = node.getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(selected, 'must test actual autoStartProxy branch')
  return selected
}

for (const quiet of [true, false]) {
  test('actual autoStartProxy branch ' + (quiet ? 'suppressed in quiet' : 'kept in normal'), async () => {
    let started = 0
    const mod = evaluate(compile(
      'exports.run = async function run(config) { ' + extractAutoStartIf() + ' }'
    ), {}, {
      isTestQuietStartup: () => quiet,
      proxyServer: { start: async () => { started++; return true } },
      mainWindow: { webContents: { send() {} } },
      IpcChannels: { PROXY_STATUS_CHANGED: 'proxy:statusChanged' },
    })
    await mod.run({ autoStartProxy: true, proxyPort: 8080, proxyHost: '127.0.0.1' })
    assert.equal(started, quiet ? 0 : 1)
    await mod.run({ autoStartProxy: false, proxyPort: 8080 })
    assert.equal(started, quiet ? 0 : 1)
  })
}

for (const quiet of [true, false]) {
  test('real trusted IPC status handlers ' + (quiet ? 'block outbound in quiet' : 'retain normal manual path'), async () => {
    let providerReads = 0
    let checkerCalls = 0
    let providerUpdates = 0
    const provider = { id: 'synthetic', name: 'Synthetic provider', type: 'builtin' }
    const callbacks = registrations(
      ['PROVIDERS_CHECK_STATUS', 'PROVIDERS_CHECK_ALL_STATUS', 'APP_GET_TEST_QUIET_STARTUP'], {
        isTestQuietStartup: () => quiet,
        IpcChannels: {
          PROVIDERS_CHECK_STATUS: 'providers:checkStatus',
          PROVIDERS_CHECK_ALL_STATUS: 'providers:checkAllStatus',
          APP_GET_TEST_QUIET_STARTUP: 'app:getTestQuietStartup',
        },
        ProviderManager: {
          getAll: () => { providerReads++; return [provider] },
          getById: () => { providerReads++; return provider },
          update: () => { providerUpdates++ },
        },
        ProviderChecker: {
          checkProviderStatus: async () => {
            checkerCalls++
            return { providerId: provider.id, status: 'online', latency: 1 }
          },
        },
      },
    )
    assert.equal(await callbacks.get('app:getTestQuietStartup')({}), quiet)
    const single = await callbacks.get('providers:checkStatus')({}, 'synthetic')
    const batch = await callbacks.get('providers:checkAllStatus')({})
    if (quiet) {
      assert.equal(checkerCalls, 0, 'must block even direct trusted IPC calls')
      assert.equal(providerReads, 0, 'blocked before touching provider records')
      assert.equal(providerUpdates, 0, 'status remains unchanged')
      assert.equal(single.status, 'unknown')
      assert.equal(Object.keys(batch).length, 0)
    } else {
      assert.equal(checkerCalls, 2)
      assert.equal(providerReads, 2)
      assert.equal(providerUpdates, 2)
      assert.equal(single.status, 'online')
      assert.equal(batch.synthetic.status, 'online')
    }
  })
}

test('real status checker blocks redirects for built-in and custom providers without secret exposure', async () => {
  const requests = []
  const fakeAxios = Object.assign(async config => {
    requests.push(config)
    return { status: 302, data: {}, headers: { location: 'https://untrusted.invalid/' } }
  }, { default: undefined })
  const checker = evaluate(compile(source('src/main/providers/checker.ts'), 'checker.ts'), {
    axios: { __esModule: true, default: fakeAxios },
    './qwenTicket': QWEN_TICKET_MODULE,
    './qwenAiToken': QWEN_AI_TOKEN_MODULE,
    '../oauth/zaiSession': ZAI_SESSION_MODULE,
    './builtin': {
      getBuiltinProvider: id => id === 'builtin-synthetic' ? {
        id, apiEndpoint: 'https://synthetic.invalid/api',
        tokenCheckEndpoint: '/health',
      } : undefined,
    },
  }).ProviderChecker
  const builtin = await checker.checkProviderStatus({
    id: 'builtin-synthetic', type: 'builtin', apiEndpoint: 'https://synthetic.invalid/api',
  })
  const custom = await checker.checkProviderStatus({
    id: 'custom-synthetic', type: 'custom',
    apiEndpoint: 'https://synthetic.invalid',
    headers: { Authorization: 'Bearer SYNTHETIC-CANARY' },
  })
  assert.equal(requests.length, 2, 'one synthetic request per explicit check, no retry')
  for (const req of requests) {
    assert.equal(req.method, 'GET')
    assert.equal(req.maxRedirects, 0)
  }
  assert.equal(builtin.status, 'offline', 'HTTP 302 is not online')
  assert.equal(custom.status, 'offline')
  assert.equal(JSON.stringify({ builtin, custom }).includes('SYNTHETIC-CANARY'), false)
})

test('real preload exposes only the trusted read-only startup-latch IPC method', async () => {
  let bridge
  const invoked = []
  evaluate(compile(source('src/preload/index.ts'), 'preload.ts'), {
    electron: {
      contextBridge: { exposeInMainWorld(name, api) {
        assert.equal(name, 'electronAPI')
        bridge = api
      } },
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          invoked.push({ channel, args })
          return true
        },
        on() {}, removeListener() {}, send() {},
      },
    },
    '../main/ipc/channels': {
      IpcChannels: { APP_GET_TEST_QUIET_STARTUP: 'app:getTestQuietStartup' },
    },
  })
  assert.equal(await bridge.app.isTestQuietStartup(), true)
  assert.equal(invoked.length, 1)
  assert.equal(invoked[0].channel, 'app:getTestQuietStartup')
  assert.equal(invoked[0].args.length, 0, 'caller cannot set native startup mode')
})

function dashboardStore(quiet) {
  let checks = 0
  const window = { electronAPI: {
    app: { isTestQuietStartup: async () => quiet },
    providers: { getAll: async () => [], checkAllStatus: async () => { checks++; return {} } },
    accounts: { getAll: async () => [] },
    logs: { get: async () => [], getTrend: async () => [] },
    requestLogs: { getTrend: async () => [], get: async () => [] },
    statistics: { get: async () => null },
    proxy: { getStatus: async () => null },
    invoke: async () => null,
  } }
  const create = init => {
    let state
    const set = update => {
      const changes = typeof update === 'function' ? update(state) : update
      state = { ...state, ...changes }
    }
    const get = () => state
    state = init(set, get)
    return { getState: get }
  }
  const exports = evaluate(compile(source('src/renderer/src/stores/dashboardStore.ts'),
    'dashboardStore.ts'), { zustand: { create } }, { window })
  return { store: exports.useDashboardStore, getChecks: () => checks }
}
for (const quiet of [true, false]) {
  test('actual Dashboard refresh ' + (quiet ? 'skips initial/periodic status GET' : 'retains ordinary status checks'), async () => {
    const h = dashboardStore(quiet)
    await h.store.getState().refreshData()
    await h.store.getState().refreshData() // same function used by 60s and manual refresh
    assert.equal(h.getChecks(), quiet ? 0 : 2)
  })
}
