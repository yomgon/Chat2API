import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isTrustedIpcSender } from '../../src/main/ipc/trustedSender.ts'

function fixture() {
  const mainFrame = { url: 'file:///C:/Private/out/renderer/index.html#/dashboard' }
  const webContents = { mainFrame }
  const window = { isDestroyed: () => false, webContents }
  const expectedPage = 'file:///C:/Private/out/renderer/index.html'
  return { mainFrame, webContents, window, expectedPage }
}

test('the bundled main renderer frame may invoke privileged IPC actions', () => {
  const f = fixture()
  assert.equal(isTrustedIpcSender({ sender: f.webContents, senderFrame: f.mainFrame }, f.window, f.expectedPage), true)
})

test('a foreign WebContents or child frame cannot use a privileged handler', () => {
  const f = fixture()
  assert.equal(isTrustedIpcSender({ sender: {}, senderFrame: f.mainFrame }, f.window, f.expectedPage), false)
  assert.equal(isTrustedIpcSender({ sender: f.webContents, senderFrame: { url: f.mainFrame.url } }, f.window, f.expectedPage), false)
  assert.equal(isTrustedIpcSender({ sender: f.webContents, senderFrame: null }, f.window, f.expectedPage), false)
})

test('navigation, destroyed window, and missing owner deny access', () => {
  const f = fixture()
  f.mainFrame.url = 'file:///C:/Users/attacker/evil.html'
  assert.equal(isTrustedIpcSender({ sender: f.webContents, senderFrame: f.mainFrame }, f.window, f.expectedPage), false)
  f.mainFrame.url = f.expectedPage
  assert.equal(isTrustedIpcSender({ sender: f.webContents, senderFrame: f.mainFrame }, { ...f.window, isDestroyed: () => true }, f.expectedPage), false)
  assert.equal(isTrustedIpcSender({ sender: f.webContents, senderFrame: f.mainFrame }, null, f.expectedPage), false)
})

test('privileged IPC handlers are registered through one guarded entry point', () => {
  const file = fileURLToPath(new URL('../../src/main/ipc/handlers.ts', import.meta.url))
  const source = readFileSync(file, 'utf8')
  assert.equal((source.match(/ipcMain\.handle\(/g) || []).length, 1)
  assert.ok((source.match(/handleTrusted\(IpcChannels\./g) || []).length >= 90)
})
