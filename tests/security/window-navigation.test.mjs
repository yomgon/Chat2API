import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeExternalLink, isTrustedRendererNavigation } from '../../src/main/window/navigationGuard.ts'

test('only the exact bundled renderer page can navigate inside Electron', () => {
  const page = 'file:///C:/Projects/Chat2API/out/renderer/index.html'
  assert.ok(isTrustedRendererNavigation(page, page))
  assert.ok(isTrustedRendererNavigation(page + '#/settings', page))
  assert.equal(isTrustedRendererNavigation('file:///C:/Users/example/Documents/secrets.txt', page), false)
  assert.equal(isTrustedRendererNavigation('file:///C:/Projects/Chat2API/out/renderer/other.html', page), false)
  assert.equal(isTrustedRendererNavigation('javascript:alert(1)', page), false)
  assert.equal(isTrustedRendererNavigation('https://elsewhere.example/', page), false)
})

test('dev page checks exact origin and path, not string prefixes', () => {
  const dev = 'http://localhost:5173/'
  assert.ok(isTrustedRendererNavigation('http://localhost:5173/#/providers', dev))
  assert.equal(isTrustedRendererNavigation('http://localhost:5173.example.com/', dev), false)
  assert.equal(isTrustedRendererNavigation('http://localhost:5173/evil', dev), false)
  assert.equal(isTrustedRendererNavigation('https://localhost:5173/', dev), false)
})

test('only external HTTP(S) addresses without embedded credentials are opened', () => {
  assert.ok(isSafeExternalLink('https://example.com/docs'))
  assert.ok(isSafeExternalLink('http://example.com'))
  for (const url of [
    'javascript:alert(1)',
    'file:///C:/Users/example/AppData',
    'shell:Downloads',
    'data:text/html,evil',
    'https://user:password@example.com/',
    'not-a-url',
  ]) {
    assert.equal(isSafeExternalLink(url), false)
  }
})
