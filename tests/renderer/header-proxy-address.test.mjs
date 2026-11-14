import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { IpcChannels } from '../../src/main/ipc/channels.ts'
import { isTrustedIpcSender } from '../../src/main/ipc/trustedSender.ts'

// Run the actual Main trusted IPC registration, actual preload bridge, and
// actual renderer Header in sealed VMs. Only native Electron objects, storage
// and the browser rendering primitives are synthetic. No profile or socket.
const root = fileURLToPath(new URL('../../', import.meta.url))
const read = relative => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const compile = (source, filename, jsx = false) => ts.transpileModule(source, {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  },
}).outputText

function actualMainRegistrations(names) {
  const source = read('src/main/ipc/handlers.ts')
  const tree = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  const gate = tree.statements.find(node => ts.isFunctionDeclaration(node) &&
    node.name?.text === 'makeTrustedHandler')
  assert.ok(gate, 'The real owner/sender gate must exist')
  const found = new Map()
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'handleTrusted' &&
        ts.isPropertyAccessExpression(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[0].expression) &&
        node.arguments[0].expression.text === 'IpcChannels') {
      const name = node.arguments[0].name.text
      if (names.includes(name)) found.set(name, node.getText(tree))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.deepEqual([...found.keys()].sort(), [...names].sort(),
    'Every contract uses its actual registered Main handler')
  return gate.getText(tree) + '\nexports.register = function (owner) {\n' +
    'const mainWindow = owner;\n' +
    'const handleTrusted = makeTrustedHandler(owner);\n' +
    names.map(name => found.get(name) + ';').join('\n') + '\n}'
}

function trustedBridgeFixture() {
  const registered = new Map()
  const subscriptions = new Map()
  const invocations = []
  const updates = []
  const emissions = []
  const generatedFixtures = []
  let latestSmokeResult = null
  let config = {
    proxyHost: '127.0.0.1', proxyPort: 8080,
    managementApi: { managementApiSecret: 'SYNTHETIC_NEVER_REAL_LOCAL37' },
    toolCallingConfig: { clientAdapterId: 'synthetic-tools' },
  }
  const mainFrame = {
    url: pathToFileURL(join(root, 'out/renderer/index.html')).href + '#/dashboard',
  }
  let ownerDestroyed = false
  const ownerContents = {
    mainFrame,
    send(channel, ...args) {
      emissions.push({ channel, args })
      for (const callback of subscriptions.get(channel) || []) callback({}, ...args)
    },
  }
  const owner = { webContents: ownerContents, isDestroyed: () => ownerDestroyed }
  const destroyedWindow = {
    webContents: { send() { throw Error('Destroyed renderer was notified') } },
    isDestroyed: () => true,
  }
  const event = { sender: ownerContents, senderFrame: mainFrame }
  const storeManager = {
    getConfig: () => config,
    updateConfig: updatesInput => {
      updates.push(updatesInput)
      config = { ...config, ...updatesInput }
      return config
    },
  }
  const proxyStatusManager = {
    getPort: () => config.proxyPort,
    getHost: () => config.proxyHost,
    getRunningStatus: () => ({ isRunning: false, uptime: 0 }),
    getStatistics: () => ({ activeConnections: 0 }),
  }
  const mainModule = { exports: {} }
  const mainSource = actualMainRegistrations([
    'CONFIG_GET', 'CONFIG_UPDATE', 'PROXY_GET_STATUS',
    'TOOL_CALLING_GET_STATUS', 'TOOL_CALLING_RUN_SMOKE',
  ])
  vm.runInNewContext(compile(mainSource, 'trusted-main-extracted.ts'), {
    module: mainModule, exports: mainModule.exports,
    ipcMain: { handle: (channel, handler) => {
      assert.equal(registered.has(channel), false, 'Duplicate privileged IPC registration')
      registered.set(channel, handler)
    } },
    isTrustedIpcSender, IpcChannels,
    BrowserWindow: { getAllWindows: () => [owner, destroyedWindow] },
    storeManager, proxyStatusManager,
    proxyServer: { isRunning: () => false },
    ConfigManager: { get: () => config },
    getLatestToolCallingSmokeResult: () => latestSmokeResult,
    buildSmokeFixture: adapterId => {
      generatedFixtures.push(adapterId)
      return { messages: [{ role: 'user', content: 'synthetic smoke only' }] }
    },
    setLatestToolCallingSmokeResult: result => { latestSmokeResult = result; return result },
    process: { env: { NODE_ENV: 'production' } },
    __dirname: join(root, 'out/main'), join, pathToFileURL, Date, Error,
    require: name => { throw Error('Unexpected trusted Main dependency ' + name) },
  }, { filename: 'trusted-main-extracted.cjs', timeout: 2000 })
  mainModule.exports.register(owner)

  let bridge
  const preloadModule = { exports: {} }
  vm.runInNewContext(compile(read('src/preload/index.ts'), 'src/preload/index.ts'), {
    module: preloadModule, exports: preloadModule.exports,
    require(name) {
      if (name === 'electron') return {
        contextBridge: { exposeInMainWorld(key, value) {
          assert.equal(key, 'electronAPI')
          bridge = value
        } },
        ipcRenderer: {
          invoke(channel, ...args) {
            invocations.push({ channel, args })
            const handler = registered.get(channel)
            if (!handler) throw Error('Unregistered native IPC ' + channel)
            return Promise.resolve().then(() => handler(event, ...args))
          },
          on(channel, callback) {
            const callbacks = subscriptions.get(channel) || new Set()
            callbacks.add(callback)
            subscriptions.set(channel, callbacks)
          },
          removeListener(channel, callback) {
            subscriptions.get(channel)?.delete(callback)
          },
          send() { throw Error('Unexpected renderer fire-and-forget command') },
        },
      }
      if (name === '../main/ipc/channels') return { IpcChannels }
      throw Error('Unexpected preload dependency ' + name)
    },
    fetch() { throw Error('Preload must not issue browser HTTP requests') },
  }, { filename: 'actual-preload.cjs', timeout: 2000 })
  assert.ok(bridge)
  return {
    bridge, owner, event, mainFrame, ownerContents,
    updates, emissions, invocations, generatedFixtures,
    rawInvoke: (channel, requestedEvent, ...args) => registered.get(channel)(requestedEvent, ...args),
    publishStatus: status => ownerContents.send(IpcChannels.PROXY_STATUS_CHANGED, status),
    subscriptionCount: channel => subscriptions.get(channel)?.size || 0,
    setOwnerDestroyed: value => { ownerDestroyed = value },
  }
}

function renderActualHeader(bridge) {
  const state = []
  const pendingEffects = []
  let nextState = 0
  let mounted = false
  let unsubscribe
  const jsx = (type, props) => ({ type, props: props || {} })
  const react = {
    useState(initial) {
      const slot = nextState++
      if (!(slot in state)) state[slot] = initial
      return [state[slot], value => { state[slot] = value }]
    },
    useEffect(callback) { if (!mounted) pendingEffects.push(callback) },
  }
  const module = { exports: {} }
  vm.runInNewContext(compile(read('src/renderer/src/components/layout/Header.tsx'),
    'Header.tsx', true), {
    module, exports: module.exports, window: { electronAPI: bridge },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) }
      if (name === 'lucide-react') return { Sun: 'Sun', Moon: 'Moon',
        Languages: 'Languages', Play: 'Play', Pause: 'Pause' }
      if (name === '@/hooks/useTheme') return { useTheme: () => ({
        toggleTheme() {}, isDark: true,
      }) }
      if (name === '@/lib/utils') return { cn: (...parts) => parts.filter(Boolean).join(' ') }
      if (name === '@/assets/icons/icons.png') return { __esModule: true, default: 'synthetic-icon' }
      if (name === '@/stores/settingsStore') return { useSettingsStore: () => ({
        language: 'en-US', setLanguage() {},
      }) }
      throw Error('Unexpected renderer dependency ' + name)
    },
  }, { filename: 'actual-Header.cjs', timeout: 2000 })
  function treeText(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(treeText).join('')
    return treeText(node.props?.children)
  }
  return {
    render() {
      nextState = 0
      const tree = module.exports.Header()
      if (!mounted) {
        mounted = true
        unsubscribe = pendingEffects.map(effect => effect())
      }
      return treeText(tree)
    },
    close() { unsubscribe?.forEach(dispose => dispose?.()) },
  }
}

test('real header + dedicated preload + trusted Main config update reflect the bind address and unsubscribe', async () => {
  const h = trustedBridgeFixture()
  const header = renderActualHeader(h.bridge)
  assert.match(header.render(), /127\.0\.0\.1:8080/)
  // The mounted Header retrieves both status and config over its dedicated bridge.
  // Let the initial native status/config invocations settle before applying
  // an independent subsequent CONFIG_CHANGED update.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.subscriptionCount(IpcChannels.CONFIG_CHANGED), 1)
  assert.equal(h.subscriptionCount(IpcChannels.PROXY_STATUS_CHANGED), 1)

  const result = await h.bridge.config.update({ proxyHost: '::1', proxyPort: 9922 })
  assert.equal(result, true)
  assert.deepEqual(JSON.parse(JSON.stringify(h.updates)), [{ proxyHost: '::1', proxyPort: 9922 }])
  assert.equal(h.emissions.filter(item => item.channel === IpcChannels.CONFIG_CHANGED).length, 1)
  assert.match(header.render(), /::1:9922/)

  h.publishStatus({ isRunning: true, port: 9923, host: '127.0.0.1' })
  assert.match(header.render(), /127\.0\.0\.1:9923/)
  header.close()
  assert.equal(h.subscriptionCount(IpcChannels.CONFIG_CHANGED), 0)
  assert.equal(h.subscriptionCount(IpcChannels.PROXY_STATUS_CHANGED), 0)
  assert.equal(h.bridge.invoke, undefined)
  assert.equal(h.bridge.on, undefined)
  assert.equal(h.bridge.send, undefined)
})

test('actual Main IPC gate rejects foreign sender, subframe, navigation change, and destroyed owner before writes', async () => {
  const h = trustedBridgeFixture()
  const channel = IpcChannels.CONFIG_UPDATE
  const update = { proxyPort: 9001 }
  for (const requestEvent of [
    { sender: {}, senderFrame: h.mainFrame },
    { sender: h.ownerContents, senderFrame: { url: h.mainFrame.url } },
    { sender: h.ownerContents, senderFrame: null },
  ]) {
    assert.throws(() => h.rawInvoke(channel, requestEvent, update), /Untrusted renderer IPC request/)
  }
  const oldUrl = h.mainFrame.url
  h.mainFrame.url = 'https://untrusted.invalid/renderer/index.html'
  assert.throws(() => h.rawInvoke(channel, h.event, update), /Untrusted renderer IPC request/)
  h.mainFrame.url = oldUrl
  h.setOwnerDestroyed(true)
  assert.throws(() => h.rawInvoke(channel, h.event, update), /Untrusted renderer IPC request/)
  h.setOwnerDestroyed(false)
  assert.equal(h.updates.length, 0)
  assert.equal(h.emissions.length, 0)
  assert.equal((await h.bridge.config.get()).proxyPort, 8080)
})

test('tool calling smoke runs via one trusted native IPC only, no preload fetch or management HTTP URL', async () => {
  const h = trustedBridgeFixture()
  const initial = await h.bridge.toolCalling.getStatus()
  assert.equal(initial.success, true)
  assert.equal(initial.data.latestSmokeResult, null)
  assert.equal(initial.data.config.clientAdapterId, 'synthetic-tools')

  const denied = { sender: {}, senderFrame: h.mainFrame }
  assert.throws(() => h.rawInvoke(IpcChannels.TOOL_CALLING_RUN_SMOKE,
    denied, { clientAdapterId: 'synthetic-tools' }), /Untrusted renderer IPC request/)
  assert.equal(h.generatedFixtures.length, 0)

  const response = await h.bridge.toolCalling.runSmoke({ clientAdapterId: 'synthetic-tools' })
  assert.equal(response.success, true)
  assert.equal(response.data.result.category, 'pass')
  assert.deepEqual(h.generatedFixtures, ['synthetic-tools'])
  assert.equal(response.data.fixture.messages[0].content, 'synthetic smoke only')
  assert.deepEqual(h.invocations.map(item => item.channel), [
    IpcChannels.TOOL_CALLING_GET_STATUS,
    IpcChannels.TOOL_CALLING_RUN_SMOKE,
  ])
  assert.equal((await h.bridge.toolCalling.getStatus()).data.latestSmokeResult.category, 'pass')
})

test('management settings still shows the actual loopback proxy management URL', () => {
  const source = read('src/renderer/src/components/settings/ManagementApiSettings.tsx')
  // This is a displayed URL contract, separate from the trusted native smoke
  // action above. There must not be a phantom dedicated management port.
  assert.match(source, /const apiEndpoint = `http:\/\/127\.0\.0\.1:\$\{proxyPort\}\/v0\/management`/)
  assert.doesNotMatch(source, /managementApiPort\s*\|\|\s*proxyPort/)
})
