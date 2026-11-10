import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeRequestLogEntry,
  sanitizeRequestLogUpdates,
} from '../../src/main/requestLogs/sanitizer.ts'

const noBodies = {
  enabled: true,
  maxEntries: 200,
  includeBodies: false,
  maxBodyChars: 2000,
  redactSensitiveData: true,
}

test('default-private log mode keeps only metadata and redacted error', () => {
  const secret = 'sk-synthetic-sensitive-demo-123'
  const result = sanitizeRequestLogEntry({
    timestamp: 123,
    status: 'error',
    method: 'POST',
    userInput: secret,
    responsePreview: secret,
    requestBody: secret,
    responseBody: secret,
    errorMessage: 'Authorization: Bearer ' + secret,
  }, noBodies)
  assert.equal(result.userInput, undefined)
  assert.equal(result.responsePreview, undefined)
  assert.equal(result.status, 'error')
  assert.ok(result.errorMessage?.includes('[REDACTED]'))
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('log updates cannot accidentally restore sensitive prompt or preview fields', () => {
  const result = sanitizeRequestLogUpdates({
    userInput: 'my private message',
    responsePreview: 'private AI output',
    errorMessage: 'apiKey=sk-synthetic-demo',
  }, noBodies)
  assert.equal(result.userInput, undefined)
  assert.equal(result.responsePreview, undefined)
  assert.ok(!JSON.stringify(result).includes('sk-synthetic-demo'))
})

test('body logging explicitly enabled still masks structured tokens', () => {
  const withBodies = { ...noBodies, includeBodies: true }
  const result = sanitizeRequestLogEntry({
    timestamp: 0,
    status: 'success',
    requestBody: '{"authorization":"Bearer sk-synthetic-demo"}',
    responsePreview: 'token=sk-synthetic-demo',
    userInput: 'my api_key=sk-synthetic-demo',
  }, withBodies)
  assert.ok(!JSON.stringify(result).includes('sk-synthetic-demo'))
  assert.ok(JSON.stringify(result).includes('[REDACTED]'))
})
