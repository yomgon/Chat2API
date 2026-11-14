import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Actual consumer DeepSeekAdapter auth GET -> session/challenge/completion.
// Axios is fully synthetic: no operational account/credential, browser,
// network, remote POST, retry, fallback, or token refresh is performed.
const file = new URL('../../src/main/proxy/adapters/deepseek.ts', import.meta.url)
const source = readFileSync(file, 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'deepseek.ts',
  compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText
const PRIVATE = 'LOCAL91_SYNTHETIC_USER_REFRESH_SECRET_CANARY'
const ACCESS = 'LOCAL91_SYNTHETIC_VALID_ACCESS'
const rejectUnknown = () => { throw Error('No unapproved upstream effect') }

function fixture({ data, httpStatus = 200, rawCredential = PRIVATE } = {}) {
  const events = { get: 0, create: 0, challenge: 0, completion: 0, logs: [], headers: [] }
  const response = data === undefined
    ? { code: 0, data: { biz_code: 0, biz_data: { token: ACCESS } } }
    : data
  const streams = []
  const axios = {
    async get(url, opts) {
      assert.equal(url, 'https://chat.deepseek.com/api/v0/users/current')
      events.get++
      events.headers.push(opts.headers.Authorization)
      return { status: httpStatus, data: response }
    },
    async post(url, payload, opts) {
      const path = new URL(url).pathname
      if (opts.headers.Authorization !== 'Bearer ' + ACCESS) return rejectUnknown()
      if (path === '/api/v0/chat_session/create') {
        events.create++
        return { status: 200, data: { code: 0, data: {
          biz_data: { chat_session: { id: 'synthetic-auth-session' } },
        } } }
      }
      if (path === '/api/v0/chat/create_pow_challenge') {
        events.challenge++
        return { status: 200, data: { code: 0, data: { biz_data: {
          challenge: { algorithm: 'DeepSeekHashV1', challenge: 'chal', salt: 'salt',
            difficulty: 1, expire_at: 999999999, signature: 'signature' },
        } } } }
      }
      if (path === '/api/v0/chat/completion') {
        events.completion++
        assert.equal(payload.chat_session_id, 'synthetic-auth-session')
        const stream = new PassThrough()
        streams.push(stream)
        return { status: 200, data: stream, headers: {} }
      }
      return rejectUnknown()
    },
  }
  const mod = { exports: {} }
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, Buffer, URL, Math, Map, Date,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level =>
      [level, (...args) => events.logs.push({ level, args })])),
    require(id) {
      if (id === 'axios') return { __esModule: true, default: axios }
      if (id === '../../lib/challenge') return { getDeepSeekHash: async () => ({
        calculateHash: () => 'SYNTHETIC_HASH_LOCAL_ONLY',
      }) }
      if (id === './providerModelOptions') return {
        resolveDeepSeekChatOptions: () => ({ modelType: 'expert',
          searchEnabled: false, thinkingEnabled: false }),
      }
      if (id === '../toolCalling/providerProfiles') return {
        getProviderToolProfile: () => ({
          formatAssistantToolCalls: rejectUnknown,
          formatToolResult: rejectUnknown,
        }),
      }
      throw Error('Forbidden import: ' + id)
    },
  }, { filename: 'deepseek-auth-production-local91', timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  const adapter = new mod.exports.DeepSeekAdapter({
    id: 'deepseek', apiEndpoint: 'https://chat.deepseek.com',
  }, {
    id: 'synthetic-account-' + events.get,
    providerId: 'deepseek',
    credentials: { token: rawCredential },
  })
  const invoke = async () => {
    const result = await adapter.chatCompletion({
      model: 'expert', messages: [{ role: 'user', content: 'LOCAL91 OFFLINE' }],
      stream: false,
    })
    result.response.data.destroy()
    return result
  }
  const assertSanitized = () => {
    assert.equal(JSON.stringify(events.logs).includes(PRIVATE), false)
    assert.equal(JSON.stringify(events.logs).includes(ACCESS), false)
    assert.equal(streams.every(s => s.destroyed), true)
  }
  return { invoke, events, assertSanitized }
}

const invalidBodies = [
  ['outer business error despite embedded access token',
    { code: 40003, data: { biz_code: 0, biz_data: { token: ACCESS } } }],
  ['nested business error despite apparent success',
    { code: 0, data: { biz_code: 40003, biz_data: { token: ACCESS } } }],
  ['flat business error',
    { code: 0, biz_code: 40003, biz_data: { token: ACCESS } }],
  ['missing mandatory overall code',
    { data: { biz_code: 0, biz_data: { token: ACCESS } } }],
  ['missing token',
    { code: 0, data: { biz_code: 0, biz_data: {} } }],
  ['token object instead of bearer string',
    { code: 0, data: { biz_code: 0, biz_data: { token: { secret: ACCESS } } } }],
  ['array token',
    { code: 0, data: { biz_code: 0, biz_data: { token: [ACCESS] } } }],
  ['CRLF embedded in upstream access token',
    { code: 0, data: { biz_code: 0, biz_data: { token: ACCESS + '\r\nAuthorization:bad' } } }],
  ['whitespace-only upstream access token',
    { code: 0, data: { biz_code: 0, biz_data: { token: ' ' } } }],
]

for (const [label, data] of invalidBodies) {
  test('local91 DeepSeek auth fails before ANY remote-state POST: ' + label, async () => {
    const f = fixture({ data })
    await assert.rejects(f.invoke())
    assert.equal(f.events.get, 1, 'one isolated synthetic identity GET')
    assert.deepEqual([f.events.create, f.events.challenge, f.events.completion], [0, 0, 0])
    assert.equal(f.events.headers[0], 'Bearer ' + PRIVATE)
    f.assertSanitized()
  })
}

for (const data of [
  { code: 0, data: { biz_code: 0, biz_data: { token: ACCESS } } },
  { code: 0, biz_data: { token: ACCESS } },
]) {
  test('local91 valid DeepSeek auth envelope reaches one exact completion', async () => {
    const f = fixture({ data })
    const result = await f.invoke()
    assert.equal(result.response.status, 200)
    assert.equal(result.sessionId, 'synthetic-auth-session')
    assert.equal(f.events.get, 1)
    assert.deepEqual([f.events.create, f.events.challenge, f.events.completion], [1, 1, 1])
    f.assertSanitized()
  })
}

for (const rawCredential of [
  {}, ['not-a-token'], '\r\nBearer forged', ' ', null,
]) {
  test('local91 malformed stored credential must never enter request headers or any network GET/POST', async () => {
    const f = fixture({ rawCredential })
    await assert.rejects(f.invoke())
    assert.equal(f.events.get, 0)
    assert.equal(f.events.create, 0)
    assert.equal(f.events.challenge, 0)
    assert.equal(f.events.completion, 0)
    f.assertSanitized()
  })
}
