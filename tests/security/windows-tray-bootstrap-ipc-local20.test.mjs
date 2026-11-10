import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Run the actual tray source in isolated in-memory platform fixtures.
// No native Electron, GUI, profile, socket, credential or external action.
const filename = 'src/main/tray/TrayManager.ts'
const source = readFileSync(new URL('../../src/main/tray/TrayManager.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
  reportDiagnostics: true,
})
assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)

function isolatedPlatform(platform) {
  const effects = {
    overlayConstructed: 0,
    trayConstructed: 0,
    listeners: new Map(),
    trayEvents: new Map(),
    menu: null,
    displayed: 0,
    focused: 0,
    quit: 0,
    overlayToggle: 0,
  }
  class InertTray {
    constructor() { effects.trayConstructed++ }
    setToolTip() {}
    setContextMenu(menu) { effects.menu = menu }
    on(name, fn) { effects.trayEvents.set(name, fn) }
    getBounds() { return { x: 0, y: 0, width: 16, height: 16 } }
    popUpContextMenu(menu) { effects.menu = menu }
    destroy() {}
  }
  class InertOverlay {
    constructor() { effects.overlayConstructed++ }
    toggle() { effects.overlayToggle++ }
    setHeight() {}
    show() {}
    hide() {}
    isVisible() { return false }
    destroy() {}
  }
  const icon = { isEmpty: () => false, resize() { return this } }
  const electron = {
    Tray: InertTray,
    Menu: {
      buildFromTemplate: template => ({ template }),
    },
    nativeImage: {
      createFromPath: () => icon,
      createFromBuffer: () => icon,
    },
    app: {
      isPackaged: true,
      quit: () => { effects.quit++ },
    },
    ipcMain: {
      on(name, fn) {
        if (effects.listeners.has(name)) throw Error('Duplicate synthetic listener')
        effects.listeners.set(name, fn)
      },
    },
  }
  const dependencies = {
    electron: { __esModule: true, ...electron },
    path: { __esModule: true, default: { join: (...parts) => parts.join('/') } },
    './TrayWindow': { TrayWindow: InertOverlay },
    '../store/config': { ConfigManager: { get: () => ({ language: 'en-US' }) } },
  }
  const mod = { exports: {} }
  vm.runInNewContext(compiled.outputText, {
    module: mod, exports: mod.exports,
    process: { platform, resourcesPath: '/synthetic/resources' },
    Buffer,
    __dirname: '/synthetic/main',
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw Error('Unexpected import: ' + name)
    },
  }, { filename, timeout: 2000 })
  const mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => { effects.displayed++ },
    focus: () => { effects.focused++ },
    webContents: { send: () => {} },
  }
  const manager = mod.exports.createTrayManager(mainWindow)
  return { effects, manager }
}

test('Windows startup creates native tray menu only; never creates a second untrusted renderer', () => {
  const { effects, manager } = isolatedPlatform('win32')
  assert.equal(effects.trayConstructed, 1)
  assert.equal(effects.overlayConstructed, 0)
  assert.deepEqual([...effects.trayEvents.keys()].sort(), ['click', 'right-click'])
  assert.equal(effects.listeners.size, 0,
    'A Windows-only native menu must not leave unauthenticated tray:quit-app IPC registered')
  effects.trayEvents.get('click')()
  assert.equal(effects.displayed, 1)
  assert.equal(effects.focused, 1)
  effects.trayEvents.get('right-click')()
  assert.equal(effects.menu.template.at(-1).label, 'Quit Chat2API')
  manager.destroy()
})

test('Linux native tray remains windowless and has its existing native menu', () => {
  const { effects, manager } = isolatedPlatform('linux')
  assert.equal(effects.trayConstructed, 1)
  assert.equal(effects.overlayConstructed, 0)
  assert.equal(effects.listeners.size, 0)
  assert.ok(effects.menu?.template)
  effects.trayEvents.get('click')()
  assert.equal(effects.displayed, 1)
  manager.destroy()
})

test('macOS retains tray overlay and its existing renderer-specific actions', () => {
  const { effects, manager } = isolatedPlatform('darwin')
  assert.equal(effects.trayConstructed, 1)
  assert.equal(effects.overlayConstructed, 1)
  for (const channel of [
    'tray:open-dashboard', 'tray:resize', 'tray:set-height', 'tray:quit-app',
  ]) assert.equal(typeof effects.listeners.get(channel), 'function')
  effects.trayEvents.get('click')()
  assert.equal(effects.overlayToggle, 1)
  manager.destroy()
})
