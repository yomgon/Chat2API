import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { parseGLMGuestWebModelCatalog } from '../../src/main/providers/glmGuestWebModelCatalog.ts'

function observedFixture() {
  return {
    status: 0,
    result: {
      default: {
        agent: 'glm-5.3', guest: 'glm-5.3-flash',
        non_vip: 'glm-5.3-flash',
      },
      models: [
        { display_name: 'GLM-5.3', selected_model: 'glm-5.3', chat_switch: true, am_switch: true },
        { display_name: 'GLM-5.3-Flash', selected_model: 'glm-5.3-flash', chat_switch: true, am_switch: true },
      ],
    },
  }
}

function fails(payload) {
  assert.throws(() => parseGLMGuestWebModelCatalog(payload),
    err => err instanceof Error &&
      err.message === 'GLM public guest website model catalog is invalid or unsupported.' &&
      err.cause === undefined)
}

test('Actual 2026-11-08 official guest model-picker keys are used; no marketing or developer API substitutions', () => {
  const fixture = observedFixture()
  const before = structuredClone(fixture)
  assert.deepEqual(parseGLMGuestWebModelCatalog(fixture), {
    supportedModels: ['GLM-5.3', 'GLM-5.3-Flash'],
    modelMappings: { 'GLM-5.3': 'glm-5.3', 'GLM-5.3-Flash': 'glm-5.3-flash' },
  })
  assert.deepEqual(fixture, before)
})

test('First-party chat_switch=false is excluded; all disabled cannot be advertised', () => {
  const f = observedFixture()
  f.result.models[1].chat_switch = false
  assert.deepEqual(parseGLMGuestWebModelCatalog(f).supportedModels, ['GLM-5.3'])
  f.result.models[0].chat_switch = false
  fails(f)
})

test('GLM website response rejects unsupported success envelope, missing fields and prototype pollution', () => {
  for (const f of [null, undefined, [], false, {}, { status: 0 }, { status: 40001 },
    { status: 0, result: { models: [], default: {} } }]) fails(f)
  for (const field of ['display_name', 'selected_model', 'chat_switch']) {
    const f = observedFixture()
    delete f.result.models[0][field]
    fails(f)
  }
  for (const mutate of [
    f => { f.status = '0' },
    f => { f.result.default = [] },
    f => { f.result.models[0].chat_switch = 'true' },
    f => { f.result.models[0].display_name = '\r\nbad' },
    f => { f.result.models[0].display_name = '   ' },
    f => { f.result.models[0].selected_model = 'https://evil.invalid' },
    f => { f.result.models[0].selected_model = '__proto__' },
    f => { f.result.models[1].selected_model = f.result.models[0].selected_model },
    f => { f.result.models[1].display_name = f.result.models[0].display_name },
    f => { Object.defineProperty(f.result.models[0], '__proto__', { enumerable: true, value: {} }) },
    f => { delete f.result.models[1] },
    f => { f.result.models = Array.from({ length: 101 }, (_, i) => ({
      display_name: 'GLM-'+i, selected_model: 'glm-'+i, chat_switch: true,
    })) },
  ]) {
    const f = observedFixture()
    mutate(f)
    fails(f)
  }
})

// The browser-only service is exercised using a fully synthetic, sandboxed
// BrowserWindow. No native browser, provider website, user profile or
// authentication credentials are accessed by this test.
const browserSource = readFileSync(new URL('../../src/main/providers/glmGuestBrowserCatalog.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(browserSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function createHarness({
  websiteResult = observedFixture(),
  currentUrl = 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
  throwGuest = false,
  transientReadyFailures = 0,
} = {}) {
  const calls = { sessions: [], windows: [], scripts: [], destroyed: 0, permissionsDenied: 0 }
  let pendingReadyFailures = transientReadyFailures
  class FakeWindow {
    constructor(opts) {
      calls.windows.push(opts)
      this.closed = false
      this.webContents = {
        getURL: () => currentUrl,
        setWindowOpenHandler: fn => { calls.openHandler = fn },
        on: (name, fn) => { calls[name] = fn },
        executeJavaScript: async text => {
          calls.scripts.push(text)
          if (text.includes('return !!(store')) {
            if (pendingReadyFailures-- > 0) throw new Error('synthetic main frame was replaced')
            return true
          }
          if (throwGuest) throw new Error('synthetic first-party browser failure')
          return JSON.stringify(websiteResult)
        },
      }
    }
    async loadURL(url) { calls.loadedUrl = url }
    isDestroyed() { return this.closed }
    destroy() { this.closed = true; calls.destroyed++ }
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: id => {
      if (id === 'electron') {
        return { BrowserWindow: FakeWindow, session: {
          fromPartition: p => {
            calls.sessions.push(p)
            return { setPermissionRequestHandler: fn => {
              fn({}, 'camera', allowed => { if (allowed === false) calls.permissionsDenied++ })
            } }
          },
        } }
      }
      if (id === 'crypto') return { randomUUID: () => 'd07c8a83-0b8b-4509-82bb-71f024ef54d9' }
      if (id === './glmGuestWebModelCatalog') return { parseGLMGuestWebModelCatalog }
      throw new Error('Unexpected import ' + id)
    },
    URL, setTimeout, clearTimeout, Promise, JSON, console,
  }
  sandbox.exports = sandbox.module.exports
  vm.runInNewContext(compiled, sandbox, { filename: 'offline-glm-guest-browser.js', timeout: 2000 })
  return { run: sandbox.module.exports.fetchGLMGuestBrowserCatalog, calls }
}

test('Synthetic ephemeral GLM browser never shares user sessions, opens popups or exposes credentials', async () => {
  const h = createHarness()
  const result = await h.run()
  assert.deepEqual([...result.supportedModels], ['GLM-5.3', 'GLM-5.3-Flash'])
  assert.equal(h.calls.loadedUrl, 'https://chatglm.cn/main/alltoolsdetail?lang=zh')
  assert.equal(h.calls.windows.length, 1)
  assert.equal(h.calls.windows[0].show, true)
  assert.equal(h.calls.windows[0].webPreferences.sandbox, true)
  assert.equal(h.calls.windows[0].webPreferences.nodeIntegration, false)
  assert.equal(h.calls.windows[0].webPreferences.contextIsolation, true)
  assert.equal(h.calls.windows[0].webPreferences.webSecurity, true)
  assert.equal(h.calls.windows[0].webPreferences.partition, h.calls.sessions[0])
  assert.ok(h.calls.sessions[0].startsWith('glm-public-catalog-'))
  assert.ok(!h.calls.sessions[0].startsWith('persist:'))
  assert.equal(h.calls.openHandler().action, 'deny')
  assert.equal(h.calls.scripts.filter(t => t.includes("store.dispatch('Home/GetAvailableModels')")).length, 1)
  assert.equal(h.calls.destroyed, 1)
  assert.equal(h.calls.permissionsDenied, 1)
  assert.ok(!h.calls.scripts.join(' ').includes('chatglm_refresh_token'))
  assert.ok(!h.calls.scripts.join(' ').includes('document.cookie'))
})

test('GLM guest lookup tolerates transient official SPA frame replacements before its one catalog GET', async () => {
  const h = createHarness({ transientReadyFailures: 2 })
  const result = await h.run()
  assert.deepEqual([...result.supportedModels], ['GLM-5.3', 'GLM-5.3-Flash'])
  assert.equal(h.calls.scripts.filter(t => t.includes("store.dispatch('Home/GetAvailableModels')")).length, 1)
  assert.equal(h.calls.destroyed, 1)
})

test('Off-origin GLM browser navigation and first-party failure both fail closed and destroy ephemeral window', async () => {
  for (const options of [
    { currentUrl: 'https://evil.invalid/data' },
    { throwGuest: true },
  ]) {
    const h = createHarness(options)
    await assert.rejects(h.run())
    assert.equal(h.calls.destroyed, 1)
  }
  const h = createHarness()
  let prevented = false
  await h.run()
  // Only the listener contract is important; this is not a native navigation.
  h.calls['will-navigate']?.({ preventDefault: () => { prevented = true } }, 'https://evil.invalid/')
  assert.equal(prevented, true)
})

test('GLM menu requires an explicit guest-session confirmation and advertises no live inference guarantees', () => {
  const ui = readFileSync(new URL('../../src/renderer/src/pages/Providers.tsx', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../../src/renderer/src/components/providers/ProviderCard.tsx', import.meta.url), 'utf8')
  assert.match(ui, /providerId === 'glm' && !window\.confirm/)
  assert.match(ui, /saved GLM account, refresh token and Chrome cookies will not be used/)
  assert.match(ui, /\['deepseek', 'kimi', 'mimo', 'qwen', 'glm'\]/)
  assert.match(ui, /modelRefreshError=\{modelRefreshErrors\[provider.id\]\}/)
  assert.match(card, /role="alert"/)
  assert.match(card, /Guest website catalog \(not call-tested\)/)
})
