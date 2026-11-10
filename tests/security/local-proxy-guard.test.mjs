import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateProxyKey,
  hasUntrustedBrowserOrigin,
  isLocalBindHost,
  isTrustedHostHeader,
} from '../../src/main/proxy/localSecurity.ts'

const usableKey = { id: 'a', key: 'sk-private-synthetic-test-key', enabled: true }
const configWithKey = { enableApiKey: true, apiKeys: [usableKey] }

test('empty key configuration does not bypass an enabled auth policy', () => {
  assert.deepEqual(evaluateProxyKey({ enableApiKey: true, apiKeys: [] }, ''), {
    allowed: false, status: 503, code: 'api_key_not_configured',
  })
  assert.equal(evaluateProxyKey({
    enableApiKey: true, apiKeys: [{ ...usableKey, enabled: false }],
  }, usableKey.key).allowed, false)
})

test('malformed authentication flags and key entries fail closed', () => {
  for (const invalid of [null, undefined, 0, 1, '', 'false', {}, []]) {
    const decision = evaluateProxyKey({ enableApiKey: invalid, apiKeys: [usableKey] }, usableKey.key)
    assert.equal(decision.allowed, false)
    assert.equal(decision.status, 503)
  }
  assert.equal(evaluateProxyKey({ enableApiKey: true, apiKeys: [null] }, usableKey.key).allowed, false)
  assert.equal(evaluateProxyKey({ enableApiKey: true, apiKeys: 'not-an-array' }, usableKey.key).allowed, false)
})

test('the enabled proxy accepts only the actual active key', () => {
  assert.deepEqual(evaluateProxyKey(configWithKey, usableKey.key), {
    allowed: true, matchedKeyId: usableKey.id,
  })
  assert.equal(evaluateProxyKey(configWithKey, 'wrong-secret').allowed, false)
  assert.equal(evaluateProxyKey(configWithKey, '').allowed, false)
  assert.equal(evaluateProxyKey(configWithKey, 'x'.repeat(300)).allowed, false)
  assert.equal(evaluateProxyKey({
    enableApiKey: true, apiKeys: [{ ...usableKey, enabled: false }],
  }, usableKey.key).allowed, false)
})

test('the only permitted bind addresses are IPv4 and IPv6 loopback', () => {
  for (const host of ['127.0.0.1', '::1']) assert.equal(isLocalBindHost(host), true)
  for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.4', '']) {
    assert.equal(isLocalBindHost(host), false)
  }
})

test('browser-origin traffic cannot use the local proxy even with local origin', () => {
  assert.equal(hasUntrustedBrowserOrigin(undefined), false)
  assert.equal(hasUntrustedBrowserOrigin(''), false)
  for (const origin of ['https://evil.example', 'http://127.0.0.1:3000', 'null']) {
    assert.equal(hasUntrustedBrowserOrigin(origin), true)
  }
})

test('local Host authority matches the actual port and numeric loopback literal', () => {
  assert.equal(isTrustedHostHeader('127.0.0.1:8080', 8080), true)
  assert.equal(isTrustedHostHeader('[::1]:8080', 8080), true)
  for (const host of ['localhost:8080', '127.0.0.1:80', '0.0.0.0:8080', 'evil.example:8080', '', '127.0.0.1.evil.example:8080']) {
    assert.equal(isTrustedHostHeader(host, 8080), false)
  }
})
