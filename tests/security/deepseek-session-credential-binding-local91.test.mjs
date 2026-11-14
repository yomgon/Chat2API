import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Actual DeepSeekAdapter and module-level session/token caches, in a closed
// VM. The Axios mock has no network implementation; neither real accounts,
// remote endpoint, operating profiles nor credentials are accessed.
const source = readFileSync(new URL('../../src/main/proxy/adapters/deepseek.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'deepseek.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  },
}).outputText
const PRIVATE_A = 'LOCAL91_PRIVATE_SYNTHETIC_TOKEN_A'
const PRIVATE_B = 'LOCAL91_PRIVATE_SYNTHETIC_TOKEN_B'
const fail = () => { throw Error('No unapproved synthetic or external operation') }

function fixture() {
  const effects = { gets: [], creates: [], challenges: [], completions: [], deletes: [] }
  const rawStreams = []
  const axios = {
    async get(url, config) {
      if (url !== 'https://chat.deepseek.com/api/v0/users/current') return fail()
      const credential = config.headers.Authorization?.replace(/^Bearer /, '')
      if (![PRIVATE_A, PRIVATE_B].includes(credential)) return fail()
      effects.gets.push(credential === PRIVATE_A ? 'A' : 'B')
      return { status: 200, data: { code: 0, data: { biz_data: {
        token: 'SYNTHETIC_ACCESS_' + (credential === PRIVATE_A ? 'A' : 'B'),
      } } } }
    },
    async post(url, body, config) {
      const path = new URL(url).pathname
      if (path === '/api/v0/chat_session/create') {
        const identity = config.headers.Authorization?.replace(/^Bearer SYNTHETIC_ACCESS_/, '')
        if (!['A', 'B'].includes(identity)) return fail()
        effects.creates.push(identity)
        return { status: 200, data: { code: 0, data: { biz_data: {
          chat_session: { id: 'synthetic-session-' + identity + '-' +
            effects.creates.filter(x => x === identity).length },
        } } } }
      }
      if (path === '/api/v0/chat/create_pow_challenge') {
        const identity = config.headers.Authorization?.replace(/^Bearer SYNTHETIC_ACCESS_/, '')
        if (!['A', 'B'].includes(identity) || body.target_path !== '/api/v0/chat/completion') return fail()
        effects.challenges.push(identity)
        return { status: 200, data: { code: 0, data: { biz_data: { challenge: {
          algorithm: 'DeepSeekHashV1', challenge: 'synthetic-challenge', salt: 'salt',
          difficulty: 1, expire_at: 9999999999, signature: 'synthetic-signature',
        } } } } }
      }
      if (path === '/api/v0/chat/completion') {
        const identity = config.headers.Authorization?.replace(/^Bearer SYNTHETIC_ACCESS_/, '')
        if (!['A', 'B'].includes(identity) || body.model_type !== 'expert') return fail()
        effects.completions.push({ identity, sessionId: body.chat_session_id,
          prompt: body.prompt, modelType: body.model_type })
        const stream = new PassThrough()
        rawStreams.push(stream)
        return { status: 200, data: stream, headers: {} }
      }
      if (path === '/api/v0/chat_session/delete') {
        const identity = config.headers.Authorization?.replace(/^Bearer SYNTHETIC_ACCESS_/, '')
        if (!['A', 'B'].includes(identity)) return fail()
        effects.deletes.push({ identity, sessionId: body.chat_session_id })
        return { status: 200, data: { code: 0 } }
      }
      return fail()
    },
  }
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports, Buffer, URL, Date, Math, Map,
    console: { log() {}, error() {}, warn() {} },
    require(id) {
      if (id === 'axios') return { __esModule: true, default: axios }
      if (id === '../../lib/challenge') return { getDeepSeekHash: async () => ({
        calculateHash: () => 'SYNTHETIC_POW_NO_COMPUTATION',
      }) }
      if (id === './providerModelOptions') return { resolveDeepSeekChatOptions: () => ({
        modelType: 'expert', searchEnabled: false, thinkingEnabled: false,
      }) }
      if (id === '../toolCalling/providerProfiles') return {
        getProviderToolProfile: () => ({
          formatAssistantToolCalls: fail, formatToolResult: fail,
        }),
      }
      throw Error('Forbidden DeepSeek source import: ' + id)
    },
  }, { filename: 'actual-deepseek-adapter-local91.ts', timeout: 2000,
    codeGeneration: { strings: false, wasm: false } })
  const Adapter = module.exports.DeepSeekAdapter
  const provider = Object.freeze({
    id: 'deepseek', apiEndpoint: 'https://chat.deepseek.com', type: 'builtin',
  })
  function adapter(token, accountId = 'stable-user-account') {
    return new Adapter(provider, Object.freeze({
      id: accountId, providerId: 'deepseek', credentials: Object.freeze({ token }),
    }))
  }
  async function complete(instance) {
    const { response, sessionId } = await instance.chatCompletion({
      model: 'expert', originalModel: 'Local selected DeepSeek model',
      messages: [{ role: 'user', content: 'SYNTHETIC_ONLY_NO_REMOTE_TEXT' }],
      stream: false,
    })
    response.data.destroy()
    return sessionId
  }
  return { effects, adapter, complete, rawStreams }
}

function assertPrivateNotExposed(f) {
  const recorded = JSON.stringify(f.effects)
  assert.equal(recorded.includes(PRIVATE_A), false)
  assert.equal(recorded.includes(PRIVATE_B), false)
  assert.equal(f.rawStreams.every(x => x.destroyed), true)
}

test('local91: same account id with rotated credential creates independently authorized DeepSeek session', async () => {
  const f = fixture()
  const prior = f.adapter(PRIVATE_A)
  const sessionA = await f.complete(prior)
  const newer = f.adapter(PRIVATE_B)
  const sessionB = await f.complete(newer)
  assert.equal(sessionA, 'synthetic-session-A-1')
  assert.equal(sessionB, 'synthetic-session-B-1',
    'New credential must not inherit an earlier account session even during 5min cache TTL')
  assert.deepEqual(f.effects.gets, ['A', 'B'])
  assert.deepEqual(f.effects.creates, ['A', 'B'])
  assert.equal(f.effects.completions.length, 2)
  assert.deepEqual(f.effects.completions.map(x => [x.identity, x.sessionId]), [
    ['A', sessionA], ['B', sessionB],
  ])
  assert.equal(f.effects.challenges.length, 2)
  assertPrivateNotExposed(f)
})

test('local91: same credential keeps 5min session reuse and pins exact wire', async () => {
  const f = fixture()
  const first = f.adapter(PRIVATE_A)
  const second = f.adapter(PRIVATE_A)
  const one = await f.complete(first)
  const two = await f.complete(second)
  assert.equal(two, one)
  assert.deepEqual(f.effects.creates, ['A'])
  assert.deepEqual(f.effects.gets, ['A'])
  assert.equal(f.effects.completions.length, 2)
  assert.deepEqual(f.effects.completions.map(c => [c.identity, c.sessionId, c.modelType]),
    [['A', one, 'expert'], ['A', one, 'expert']])
  assertPrivateNotExposed(f)
})

test('local91: old credential cleanup cannot evict the newer pinned session', async () => {
  const f = fixture()
  const oldAdapter = f.adapter(PRIVATE_A)
  const newAdapter = f.adapter(PRIVATE_B)
  const sessionA = await f.complete(oldAdapter)
  const sessionB = await f.complete(newAdapter)
  assert.equal(await oldAdapter.deleteSession(sessionA), true)
  const afterOldCleanup = await f.complete(newAdapter)
  assert.equal(afterOldCleanup, sessionB,
    'Old in-flight request cleanup must not discard a new credential session')
  assert.deepEqual(f.effects.creates, ['A', 'B'])
  assert.deepEqual(f.effects.deletes, [{ identity: 'A', sessionId: sessionA }])
  assertPrivateNotExposed(f)
})

test('local91: independent account id cannot share another account session even with same token', async () => {
  const f = fixture()
  const one = await f.complete(f.adapter(PRIVATE_A, 'account-one'))
  const two = await f.complete(f.adapter(PRIVATE_A, 'account-two'))
  assert.notEqual(one, two)
  assert.deepEqual(f.effects.creates, ['A', 'A'])
  assertPrivateNotExposed(f)
})
