import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { inspect } from 'node:util'
import ts from 'typescript'

// Actual product modules, closed imports, synthetic Electron/fs/WebAssembly and
// Axios only. No WASM binary, application, profile or network is opened.
// The completion spy throws after capture; no provider success is fabricated.
const PRIVATE = 'SYNTHETIC_LOCAL26_PRIVATE_INIT_DETAIL'
const WASM_FILE = 'sha3_wasm_bg.7b9ca65ddd.wasm'
const APP_PATH = 'C:\\synthetic-local26\\application'
const RESOURCES_PATH = 'C:\\synthetic-local26\\resources'
const BYTES = Buffer.from('synthetic-wasm-bytes-only')
const CHALLENGE = Object.freeze({
  algorithm: 'DeepSeekHashV1', challenge: 'synthetic-challenge',
  salt: 'synthetic-salt', difficulty: 7, expire_at: 1700000000,
  signature: 'synthetic-signature',
})
function compile(relative) {
  return ts.transpileModule(readFileSync(new URL('../../src/main/' + relative, import.meta.url), 'utf8'), {
    fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    },
  }).outputText
}
const hashCode = compile('lib/challenge.ts')
const adapterCode = compile('proxy/adapters/deepseek.ts')
const optionsCode = compile('proxy/adapters/providerModelOptions.ts')

function evaluate(code, dependencies, globals = {}, filename = 'offline-local26.ts') {
  const mod = { exports: {} }
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, TextEncoder, TextDecoder,
    ...globals,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Forbidden local26 import: ' + name)
    },
  }, { filename, timeout: 2000 })
  return mod.exports
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function observe(promise) {
  const state = { status: 'pending' }
  state.done = promise.then(value => {
    Object.assign(state, { status: 'fulfilled', value })
    return state
  }, reason => {
    Object.assign(state, { status: 'rejected', reason })
    return state
  })
  return state
}
async function drain() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
function wasmExports(solves, serial) {
  const buffer = new ArrayBuffer(65536)
  const memory = { buffer }
  let stack = 1024, heap = 4096
  const allocate = size => {
    const ptr = heap
    heap += size + 16
    return ptr
  }
  return {
    memory,
    __wbindgen_add_to_stack_pointer(delta) { stack += delta; return stack },
    __wbindgen_export_0: allocate,
    __wbindgen_export_1(ptr, oldSize, newSize) {
      const next = allocate(newSize)
      new Uint8Array(buffer).copyWithin(next, ptr, ptr + Math.min(oldSize, newSize))
      return next
    },
    wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty) {
      const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(buffer, ptr, len))
      solves.push({ serial, challenge: text(challengePtr, challengeLen),
        prefix: text(prefixPtr, prefixLen), difficulty })
      const view = new DataView(buffer)
      view.setInt32(retptr, 1, true)
      view.setFloat64(retptr + 8, 42, true)
    },
  }
}
function harness({ packaged = false, failureStage = '' } = {}) {
  const failure = Object.assign(new Error(PRIVATE), { privateContext: { token: PRIVATE } })
  const reads = [], instantiations = [], paths = [], logs = [], solves = []
  let appPathCalls = 0, failureEnabled = true
  const faults = stage => failureEnabled && failureStage === stage
  const console = Object.fromEntries(['log', 'error', 'warn'].map(level => [
    level, (...args) => logs.push({ level, args }),
  ]))
  const fs = {
    existsSync(file) {
      paths.push(file)
      if (faults('exists')) throw failure
      return true
    },
    promises: {
      readFile(file) {
        const gate = deferred()
        reads.push({ file, ...gate })
        if (faults('read-sync')) throw failure
        if (faults('read-async')) return Promise.reject(failure)
        return gate.promise
      },
    },
  }
  const api = evaluate(hashCode, {
    fs,
    path: { join: path.win32.join },
    electron: { app: {
      isPackaged: packaged,
      getAppPath() {
        appPathCalls++
        if (faults('app-path')) throw failure
        return APP_PATH
      },
    } },
  }, {
    console, process: { resourcesPath: RESOURCES_PATH },
    WebAssembly: { instantiate(bytes, imports) {
      const gate = deferred()
      const exports = wasmExports(solves, instantiations.length + 1)
      instantiations.push({ bytes, imports, exports, ...gate })
      if (faults('wasm-sync')) throw failure
      if (faults('wasm-async')) return Promise.reject(failure)
      return gate.promise
    } },
  }, 'challenge.ts')
  const releaseReads = () => { for (const read of reads) read.resolve(BYTES) }
  const releaseWasm = () => {
    for (const item of instantiations) item.resolve({ instance: { exports: item.exports } })
  }
  return {
    api, reads, instantiations, paths, logs, solves, console, failure,
    appPathCalls: () => appPathCalls,
    disableFailure() { failureEnabled = false },
    releaseReads, releaseWasm,
    async finishInit() {
      await drain()
      releaseReads()
      await drain()
      releaseWasm()
      await drain()
    },
  }
}
function calculate(instance) {
  return instance.calculateHash(CHALLENGE.algorithm, CHALLENGE.challenge,
    CHALLENGE.salt, CHALLENGE.difficulty, CHALLENGE.expire_at)
}
function assertPrivateLogs(h) {
  const rendered = inspect(h.logs, { depth: 20, customInspect: false, getters: false })
  assert.equal(rendered.includes(PRIVATE), false, 'raw initialization errors must not reach console')
  const errors = h.logs.filter(entry => entry.level === 'error')
  assert.equal(errors.length, 1, 'one diagnostic per failed initialization, not per waiter')
  assert.deepEqual(errors[0].args, ['[DeepSeekHash] WASM initialization failed'])
}

for (const packaged of [false, true]) {
  test((packaged ? 'packaged' : 'development') + ': all callers wait through file read and WASM init', async () => {
    const h = harness({ packaged })
    const waiting = Array.from({ length: 5 }, () => observe(h.api.getDeepSeekHash()))
    await drain()
    const readStage = waiting.map(item => item.status)
    const readCount = h.reads.length
    const wasmBeforeRead = h.instantiations.length
    h.releaseReads()
    await drain()
    waiting.push(observe(h.api.getDeepSeekHash()))
    await drain()
    const wasmStage = waiting.map(item => item.status)
    const wasmCount = h.instantiations.length
    h.releaseWasm()
    await Promise.all(waiting.map(item => item.done))

    assert.deepEqual(readStage, Array(5).fill('pending'))
    assert.deepEqual(wasmStage, Array(6).fill('pending'))
    assert.equal(readCount, 1)
    assert.equal(wasmBeforeRead, 0)
    assert.equal(wasmCount, 1)
    assert.ok(waiting.every(item => item.status === 'fulfilled'))
    const instance = waiting[0].value
    assert.ok(instance instanceof h.api.DeepSeekHash)
    assert.ok(waiting.every(item => item.value === instance))
    assert.equal(await h.api.getDeepSeekHash(), instance)
    assert.equal(calculate(instance), 42)
    assert.equal(h.reads.length, 1)
    assert.equal(h.instantiations.length, 1)
    assert.deepEqual(h.paths, [path.win32.join(packaged ? RESOURCES_PATH : APP_PATH, WASM_FILE)])
    assert.equal(h.reads[0].file, h.paths[0])
    assert.equal(h.appPathCalls(), packaged ? 0 : 1)
    assert.equal(h.instantiations[0].bytes, BYTES)
    assert.equal(JSON.stringify(h.instantiations[0].imports), '{"wbg":{}}')
    assert.deepEqual(h.solves, [{ serial: 1, challenge: CHALLENGE.challenge,
      prefix: CHALLENGE.salt + '_' + CHALLENGE.expire_at + '_', difficulty: CHALLENGE.difficulty }])
    assert.equal(h.logs.filter(entry => entry.level === 'error').length, 0)
  })
}

for (const failureStage of ['app-path', 'exists', 'read-sync', 'read-async', 'wasm-sync', 'wasm-async']) {
  test(failureStage + ': every waiter rejects; only a new explicit call retries initialization', async () => {
    const h = harness({ failureStage })
    const first = Array.from({ length: 4 }, () => observe(h.api.getDeepSeekHash()))
    await h.finishInit()
    await Promise.all(first.map(item => item.done))
    const idleCounts = [h.appPathCalls(), h.reads.length, h.instantiations.length]
    await drain()
    const noAutomaticRetry = [h.appPathCalls(), h.reads.length, h.instantiations.length]

    h.disableFailure()
    const retried = Array.from({ length: 3 }, () => observe(h.api.getDeepSeekHash()))
    await drain()
    const retryWaiting = retried.map(item => item.status)
    await h.finishInit()
    await Promise.all(retried.map(item => item.done))

    assert.deepEqual(noAutomaticRetry, idleCounts)
    assert.deepEqual(retryWaiting, Array(3).fill('pending'), 'a rejected candidate cannot remain cached')
    assert.ok(first.every(item => item.status === 'rejected' && item.reason === h.failure),
      'all original callers must receive the failed initialization')
    assert.ok(retried.every(item => item.status === 'fulfilled'))
    const recovered = retried[0].value
    assert.ok(retried.every(item => item.value === recovered))
    assert.equal(await h.api.getDeepSeekHash(), recovered)
    assert.equal(calculate(recovered), 42)
    assert.equal(h.appPathCalls(), 2, 'exactly one new initialization attempt')
    assert.equal(h.reads.length, ['app-path', 'exists'].includes(failureStage) ? 1 : 2)
    assert.equal(h.instantiations.length, failureStage.startsWith('wasm') ? 2 : 1)
    assertPrivateLogs(h)
  })
}

for (const failureStage of ['read-async', 'wasm-async']) {
  test(failureStage + ': preserve rejection while logging only the fixed failure diagnostic', async () => {
    const h = harness({ failureStage })
    const call = observe(h.api.getDeepSeekHash())
    await h.finishInit()
    await call.done
    assert.equal(call.status, 'rejected')
    assert.equal(call.reason, h.failure)
    assertPrivateLogs(h)
  })
}

function productHarness(options = {}) {
  const h = harness(options)
  const effects = []
  const completionFailure = new Error('Synthetic completion capture only; no response')
  const base = 'https://chat.deepseek.com/api'
  const verifiedToken = 'synthetic-local26-verified-token'
  const axios = {
    async get(url, config) {
      assert.equal(url, base + '/v0/users/current')
      effects.push({ stage: 'auth', config })
      return { status: 200, data: { code: 0, data: { biz_code: 0, biz_data: { token: verifiedToken } } } }
    },
    async post(url, body, config) {
      if (url === base + '/v0/chat_session/create') {
        effects.push({ stage: 'session', body, config })
        return { status: 200, data: { data: { biz_data: {
          chat_session: { id: 'synthetic-session-' + effects.length },
        } } } }
      }
      if (url === base + '/v0/chat/create_pow_challenge') {
        effects.push({ stage: 'challenge', body, config })
        return { status: 200, data: { data: { biz_data: { challenge: CHALLENGE } } } }
      }
      if (url === base + '/v0/chat/completion') {
        effects.push({ stage: 'completion', body, config })
        throw completionFailure
      }
      throw new Error('Forbidden synthetic POST: ' + url)
    },
  }
  const models = evaluate(optionsCode, {}, {}, 'providerModelOptions.ts')
  const { DeepSeekAdapter } = evaluate(adapterCode, {
    axios,
    '../../lib/challenge': h.api,
    './providerModelOptions': models,
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  }, { console: h.console }, 'deepseek.ts')
  const adapters = ['a', 'b'].map(id => new DeepSeekAdapter(
    { id: 'deepseek', apiEndpoint: 'https://chat.deepseek.com' },
    { id: 'synthetic-account-' + id, credentials: { token: 'synthetic-token-' + id } },
  ))
  const request = () => ({
    model: 'default', stream: false, messages: [{ role: 'user', content: 'synthetic input' }],
  })
  return { ...h, effects, completionFailure,
    dispatch(index = 0) { return adapters[index].chatCompletion(request()) },
    counts() {
      return ['auth', 'session', 'challenge', 'completion'].map(
        stage => effects.filter(item => item.stage === stage).length)
    },
  }
}

test('actual DeepSeek chatCompletion callers cannot send completion before shared WASM initialization', async () => {
  const h = productHarness()
  const calls = [observe(h.dispatch(0)), observe(h.dispatch(1))]
  await drain()
  const beforeRead = { counts: h.counts(), states: calls.map(item => item.status) }
  h.releaseReads()
  await drain()
  const beforeWasm = { counts: h.counts(), states: calls.map(item => item.status) }
  h.releaseWasm()
  await Promise.all(calls.map(item => item.done))

  assert.deepEqual(beforeRead, { counts: [2, 2, 2, 0], states: ['pending', 'pending'] })
  assert.deepEqual(beforeWasm, { counts: [2, 2, 2, 0], states: ['pending', 'pending'] })
  assert.ok(calls.every(item => item.status === 'rejected' && item.reason === h.completionFailure))
  assert.deepEqual(h.counts(), [2, 2, 2, 2])
  assert.equal(h.reads.length, 1)
  assert.equal(h.instantiations.length, 1)
  assert.equal(h.solves.length, 2)
  for (const effect of h.effects) assert.equal(effect.config.maxRedirects, 0)
  for (const effect of h.effects.filter(item => item.stage === 'completion')) {
    const proof = JSON.parse(Buffer.from(effect.config.headers['X-Ds-Pow-Response'], 'base64').toString())
    assert.deepEqual(proof, {
      algorithm: CHALLENGE.algorithm, challenge: CHALLENGE.challenge,
      salt: CHALLENGE.salt, answer: 42, signature: CHALLENGE.signature,
      target_path: '/api/v0/chat/completion',
    })
    assert.equal(effect.body.model_type, 'default')
    assert.equal(effect.config.headers.Authorization, 'Bearer synthetic-local26-verified-token')
  }
})

test('actual DeepSeek init failure causes no completion or automatic resend; a later request initializes anew', async () => {
  const h = productHarness({ failureStage: 'wasm-async' })
  const first = [observe(h.dispatch(0)), observe(h.dispatch(1))]
  await h.finishInit()
  await Promise.all(first.map(item => item.done))
  const failedCounts = h.counts()
  await drain()
  const idleCounts = h.counts()
  h.disableFailure()
  const next = observe(h.dispatch(0))
  await h.finishInit()
  await next.done

  assert.ok(first.every(item => item.status === 'rejected' && item.reason === h.failure))
  assert.deepEqual(failedCounts, [2, 2, 2, 0])
  assert.deepEqual(idleCounts, failedCounts)
  assert.equal(next.status, 'rejected')
  assert.equal(next.reason, h.completionFailure)
  assert.deepEqual(h.counts(), [2, 2, 3, 1])
  assert.equal(h.reads.length, 2)
  assert.equal(h.instantiations.length, 2)
  assert.equal(h.solves.length, 1)
  assertPrivateLogs(h)
})
