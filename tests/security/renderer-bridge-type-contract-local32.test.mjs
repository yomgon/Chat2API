import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the actual Electron preload source in a closed VM. This is an
// in-memory fake IPC implementation, not a running app, store or network.
const read = relative => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const compile = (text, filename) => ts.transpileModule(text, {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText

function preloadHarness() {
  let bridge
  const calls = []
  const events = new Map()
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ kind: 'invoke', channel, args })
      return Promise.resolve({ success: true, credentials: {} })
    },
    send(channel, ...args) {
      calls.push({ kind: 'send', channel, args })
    },
    on(channel, callback) {
      events.set(channel, callback)
    },
    removeListener(channel, callback) {
      if (events.get(channel) === callback) events.delete(channel)
    },
  }
  const contextBridge = {
    exposeInMainWorld(name, api) {
      assert.equal(name, 'electronAPI')
      bridge = api
    },
  }
  const modules = {
    electron: { ipcRenderer, contextBridge },
    '../main/ipc/channels': {
      IpcChannels: {
        OAUTH_LOGIN_WITH_TOKEN: 'oauth:loginWithToken',
        OAUTH_PROGRESS: 'oauth:progress',
        APP_OPEN_EXTERNAL: 'app:openExternal',
        PROXY_GET_STATISTICS: 'proxy:getStatistics',
      },
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(compile(read('src/preload/index.ts'), 'index.ts'), {
    module, exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    require(specifier) {
      if (Object.hasOwn(modules, specifier)) return modules[specifier]
      throw Error('Unexpected preload dependency ' + specifier)
    },
  }, { filename: 'preload-index.cjs', timeout: 2000 })
  assert.ok(bridge)
  return { bridge, calls, events }
}

test('trusted preload keeps no arbitrary renderer invoke/on/send methods', () => {
  const { bridge } = preloadHarness()
  for (const name of ['invoke', 'on', 'send']) {
    assert.equal(Object.hasOwn(bridge, name), false, 'no generic IPC: ' + name)
  }
  assert.equal(typeof bridge.oauth.loginWithToken, 'function')
  assert.equal(typeof bridge.oauth.onProgress, 'function')
  assert.equal(typeof bridge.app.openExternal, 'function')
  assert.equal(typeof bridge.tray.openDashboard, 'function')
  assert.equal(typeof bridge.tray.setHeight, 'function')
  assert.equal(typeof bridge.proxy.getStatistics, 'function')
})

test('actual OAuth token method preserves optional MiniMax and MiMo fields exactly once', async () => {
  const { bridge, calls } = preloadHarness()
  const token = 'SYNTHETIC_PRIVATE_TOKEN_DO_NOT_LOG'
  const result = await bridge.oauth.loginWithToken(
    'mimo', 'mimo', token, undefined, 'SYNTHETIC_USER', 'SYNTHETIC_PH',
  )
  assert.equal(result.success, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'invoke')
  assert.equal(calls[0].channel, 'oauth:loginWithToken')
  assert.deepEqual(Object.keys(calls[0].args[0]).sort(),
    ['mimoPhToken', 'mimoUserId', 'providerId', 'providerType', 'realUserID', 'token'])
  assert.equal(calls[0].args[0].mimoUserId, 'SYNTHETIC_USER')
  assert.equal(calls[0].args[0].mimoPhToken, 'SYNTHETIC_PH')
  assert.equal(calls[0].args[0].token, token)
  calls.length = 0
  await bridge.oauth.loginWithToken('minimax', 'minimax', token, 'SYNTHETIC_REAL_USER')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[0].realUserID, 'SYNTHETIC_REAL_USER')
  assert.equal(calls[0].args[0].mimoUserId, undefined)
})

test('actual trusted main OAuth IPC consumer forwards each optional credential field once', async () => {
  const source = read('src/main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  let registration
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'handleTrusted' && node.arguments.length >= 2 &&
      ts.isPropertyAccessExpression(node.arguments[0]) &&
      node.arguments[0].name.text === 'OAUTH_LOGIN_WITH_TOKEN') {
      registration = node.getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(registration, 'real trusted token-login handler must exist')
  const collected = []
  const fakeOAuth = { loginWithToken(...args) {
    collected.push(args)
    return { success: true }
  } }
  let handler
  const mod = { exports: {} }
  vm.runInNewContext(compile(
    'exports.register = function (handleTrusted) { ' + registration + ' }',
    'trusted-handler.ts',
  ), {
    module: mod, exports: mod.exports, Promise,
    oauthManager: fakeOAuth,
    IpcChannels: { OAUTH_LOGIN_WITH_TOKEN: 'oauth:loginWithToken' },
    require(id) { throw Error('Unexpected main module ' + id) },
  }, { filename: 'trusted-main-handler.cjs', timeout: 2000 })
  mod.exports.register((channel, callback) => {
    assert.equal(channel, 'oauth:loginWithToken')
    handler = callback
  })
  assert.ok(handler)
  const result = await handler(null, {
    providerId: 'mimo', providerType: 'mimo',
    token: 'SYNTHETIC_PRIVATE_TOKEN', mimoUserId: 'USER', mimoPhToken: 'PH',
  })
  assert.equal(result.success, true)
  assert.equal(collected.length, 1)
  assert.equal(collected[0].length, 6)
  assert.deepEqual(Array.from(collected[0]), [
    'mimo', 'mimo', 'SYNTHETIC_PRIVATE_TOKEN', undefined, 'USER', 'PH',
  ])
})

test('progress event subscription has an exact unsubscribe path', () => {
  const { bridge, events } = preloadHarness()
  const received = []
  const dispose = bridge.oauth.onProgress(event => received.push(event.status))
  assert.equal(events.size, 1)
  events.get('oauth:progress')({}, { status: 'pending', message: 'offline' })
  assert.deepEqual(received, ['pending'])
  dispose()
  assert.equal(events.size, 0)
})

test('statistics, approved external link and tray actions use only dedicated bridge channels', async () => {
  const { bridge, calls } = preloadHarness()
  await bridge.proxy.getStatistics()
  await bridge.app.openExternal('https://example.invalid/help')
  bridge.tray.setHeight(460)
  bridge.tray.openDashboard()
  assert.deepEqual(calls.map(call => [call.kind, call.channel]), [
    ['invoke', 'proxy:getStatistics'],
    ['invoke', 'app:openExternal'],
    ['send', 'tray:set-height'],
    ['send', 'tray:open-dashboard'],
  ])
  assert.equal(calls[1].args[0], 'https://example.invalid/help')
  assert.equal(calls[2].args[0], 460)
})

test('all formerly unexposed generic renderer IPC calls have been replaced', () => {
  for (const file of [
    'src/renderer/src/components/oauth/LoginDialog.tsx',
    'src/renderer/src/components/oauth/TokenInput.tsx',
    'src/renderer/src/components/Tray/TrayView.tsx',
    'src/renderer/src/stores/dashboardStore.ts',
  ]) {
    const source = read(file)
    assert.doesNotMatch(source, /window\.electronAPI\?*\.(?:invoke|send|on)\s*\??\s*\(/,
      'no phantom broad IPC in ' + file)
  }
})
