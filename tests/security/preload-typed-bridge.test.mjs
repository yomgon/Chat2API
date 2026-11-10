import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { IpcChannels } from '../../src/main/ipc/channels.ts'

const realRequire = createRequire(import.meta.url)

function loadPreload() {
  const file = fileURLToPath(new URL('../../src/preload/index.ts', import.meta.url))
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const calls = []
  let exposed = null
  const mockedElectron = {
    contextBridge: { exposeInMainWorld: (name, value) => {
      assert.equal(name, 'electronAPI')
      exposed = value
    } },
    ipcRenderer: {
      invoke(channel, ...args) { calls.push({ channel, args }); return Promise.resolve({ success: true }) },
      send(channel, ...args) { calls.push({ channel, args }) },
      on() {}, removeListener() {},
    },
  }
  const mocks = { electron: mockedElectron, '../main/ipc/channels': { IpcChannels } }
  const module = { exports: {} }
  runInNewContext(js, {
    exports: module.exports, module,
    require: name => mocks[name] ?? realRequire(name),
    console,
    fetch: () => { throw new Error('Preload must not issue browser fetch requests') },
  }, { filename: file })
  assert.ok(exposed)
  return { api: exposed, calls }
}

test('renderer receives typed APIs without a generic arbitrary IPC bridge', () => {
  const { api } = loadPreload()
  for (const method of ['on', 'send', 'invoke']) assert.equal(api[method], undefined)
  for (const method of ['get', 'set', 'delete']) assert.equal(api.store[method], undefined)
  assert.equal(typeof api.store.clearAll, 'function')
  assert.equal(typeof api.store.retryInit, 'function')
  assert.equal(typeof api.store.onInitError, 'function')
})

test('tool smoke never fetches the management secret or calls a browser HTTP client', async () => {
  const { api, calls } = loadPreload()
  await api.toolCalling.getStatus()
  await api.toolCalling.runSmoke({ clientAdapterId: 'standard-openai-tools' })
  assert.deepEqual(calls.map(call => call.channel), [
    IpcChannels.TOOL_CALLING_GET_STATUS, IpcChannels.TOOL_CALLING_RUN_SMOKE,
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].args)), [{ clientAdapterId: 'standard-openai-tools' }])
})

test('management settings use dedicated IPC methods', async () => {
  const { api, calls } = loadPreload()
  await api.managementApi.getConfig()
  await api.managementApi.updateConfig({ enableManagementApi: false })
  await api.managementApi.generateSecret()
  assert.deepEqual(calls.map(call => call.channel), [
    IpcChannels.MANAGEMENT_API_GET_CONFIG,
    IpcChannels.MANAGEMENT_API_UPDATE_CONFIG,
    IpcChannels.MANAGEMENT_API_GENERATE_SECRET,
  ])
})
