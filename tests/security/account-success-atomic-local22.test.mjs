import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the production route, terminal gate and selected StoreManager methods.
// Only source files are read: every account, credential, transport and persistent
// write is synthetic and in memory. The real StoreManager is never initialized.
const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
const requireNode = createRequire(import.meta.url)
function compile(text, fileName) {
  const compiled = ts.transpileModule(text, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  })
  assert.deepEqual((compiled.diagnostics || [])
    .filter(item => item.category === ts.DiagnosticCategory.Error)
    .map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
  return compiled.outputText
}
const storeSource = ts.createSourceFile('store.ts', source('src/main/store/store.ts'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const storeClass = storeSource.statements.find(node =>
  ts.isClassDeclaration(node) && node.name?.text === 'StoreManager')
assert.ok(storeClass, 'Extract the actual StoreManager class')
const methodNames = [
  'ensureInitialized', 'getLocalUsageDay', 'getEffectiveAccountUsage',
  'getAccountForCurrentDay', 'getAccountsByProviderId',
  'updateAccount', 'recordAccountSuccess',
]
const selectedMethods = methodNames.flatMap(name => {
  const method = storeClass.members.find(node =>
    ts.isMethodDeclaration(node) && node.name.getText(storeSource) === name)
  // The optional new method permits a real stale-update RED on the old route;
  // the direct contract tests below still fail until that method is implemented.
  if (name !== 'recordAccountSuccess') assert.ok(method, 'Missing production method: ' + name)
  return method ? [method.getText(storeSource)] : []
})
const storeCode = compile('export class OfflineStore {\n' + selectedMethods.join('\n') + '\n}', 'store-methods.ts')
const routeCode = compile(source('src/main/proxy/routes/chat.ts'), 'routes/chat.ts')
const gateModule = { exports: {} }
vm.runInNewContext(compile(source('src/main/proxy/streamTerminalGate.ts'), 'streamTerminalGate.ts'), {
  module: gateModule,
  exports: gateModule.exports,
  require: name => {
    assert.equal(name, 'stream', 'No network, application or filesystem dependency in the gate')
    return requireNode('node:stream')
  },
  Buffer, TextDecoder, Date, Error,
}, { timeout: 1500 })

const ACCOUNT_ID = 'synthetic-local22-account'
const PROVIDER_ID = 'kimi'
const PRIVATE = 'SYNTHETIC_LOCAL22_CREDENTIAL_ONLY'
const NOW = 2_000
const credentials = Object.freeze({ token: 'safeStorage:v1:' + Buffer.from(PRIVATE).toString('base64') })
const account = overrides => Object.freeze({
  id: ACCOUNT_ID, providerId: PROVIDER_ID, name: 'Synthetic account',
  credentials, status: 'active', createdAt: 10, updatedAt: 20,
  requestCount: 7, todayUsed: 3, lastUsed: 30, dailyLimit: 100,
  ...overrides,
})
const withoutUsage = row => {
  const { requestCount, todayUsed, lastUsed, usageDay, ...metadata } = row
  return metadata
}

function memoryStore(initialRows = [account()]) {
  const clock = { now: NOW }
  class FixtureDate extends Date {
    static now() { return clock.now }
  }
  const module = { exports: {} }
  vm.runInNewContext(storeCode, {
    module, exports: module.exports, Date: FixtureDate, Error,
    require: name => { throw new Error('Unexpected store dependency: ' + name) },
  }, { timeout: 1500 })
  const manager = new module.exports.OfflineStore()
  const events = []
  const writes = []
  const crypto = { decrypt: 0, encrypt: 0 }
  let rows = Object.freeze([...initialRows])
  let writeError
  manager.isInitialized = true
  manager.store = {
    get(key) {
      assert.equal(key, 'accounts')
      events.push('get')
      return rows
    },
    set(key, value) {
      assert.equal(key, 'accounts')
      events.push('set')
      if (writeError) throw writeError
      assert.notEqual(value, rows, 'Never mutate the stored accounts array')
      rows = Object.freeze(value.map(row => Object.freeze(row)))
      writes.push(rows)
    },
  }
  // Selection still executes the real method and returns independent snapshots.
  // Old updateAccount uses these synthetic crypto functions during the RED.
  manager.decryptCredentials = value => { crypto.decrypt++; return value }
  manager.encryptCredentials = value => { crypto.encrypt++; return value }
  return {
    manager, clock, FixtureDate, events, writes, crypto,
    get rows() { return rows },
    replaceRows(value) { rows = Object.freeze(value.map(row => Object.freeze(row))) },
    failWrites(error) { writeError = error },
    resetObservations() { events.length = 0; crypto.decrypt = 0; crypto.encrypt = 0 },
  }
}

function routeHarness(t, initialRows) {
  const memory = memoryStore(initialRows)
  const routes = {}
  const pending = []
  const streams = []
  const usage = { start: 0, success: 0, failure: 0, stats: [], receipts: [], updates: [], logs: [] }
  const provider = Object.freeze({
    id: PROVIDER_ID, name: 'Synthetic provider', enabled: true, apiEndpoint: 'https://example.invalid',
  })
  class Router {
    post(path, callback) { routes[path] = callback }
  }
  const manager = memory.manager
  manager.getConfig = () => ({ retryCount: 3, loadBalanceStrategy: 'round-robin' })
  manager.addLog = (...args) => usage.logs.push(args)
  manager.addRequestLog = entry => {
    usage.receipts.push(entry)
    return { id: 'synthetic-receipt-' + usage.receipts.length }
  }
  manager.updateRequestLog = (id, updates) => { usage.updates.push({ id, updates }); return true }
  manager.recordRequestInStats = success => usage.stats.push(success)
  const mocks = {
    '@koa/router': { __esModule: true, default: Router },
    '../loadbalancer': { loadBalancer: {
      selectAccount: () => {
        const selected = manager.getAccountsByProviderId(PROVIDER_ID, true)
          .find(row => row.id === ACCOUNT_ID)
        return selected ? { account: Object.freeze(selected), provider, actualModel: 'synthetic-model' } : null
      },
      clearAccountFailure() {},
      markAccountFailed() {},
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => PROVIDER_ID,
      getPreferredAccount: () => ACCOUNT_ID,
    } },
    '../forwarder': { requestForwarder: {
      forwardChatCompletion: (request, selected) => new Promise(resolve => {
        pending.push({ selected, stream: request.stream === true, resolve })
      }),
    } },
    '../stream': { streamHandler: { createTransformStream: () => new PassThrough() } },
    '../streamTerminalGate': gateModule.exports,
    '../status': { proxyStatusManager: {
      recordRequestStart: () => usage.start++,
      recordRequestSuccess: () => usage.success++,
      recordRequestFailure: () => usage.failure++,
    } },
    '../../store/store': { storeManager: manager },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: () => { throw new Error('Unexpected Anthropic conversion') },
      transformChunkToAnthropic: () => { throw new Error('Unexpected Anthropic conversion') },
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(routeCode, {
    module, exports: module.exports,
    require: name => {
      assert.ok(Object.hasOwn(mocks, name), 'Blocked route dependency: ' + name)
      return mocks[name]
    },
    Date: memory.FixtureDate, Math, JSON, Error,
    console: { log() {}, warn() {}, error() {} },
  }, { timeout: 2000 })
  assert.equal(typeof routes['/completions'], 'function')
  t.after(() => streams.forEach(stream => stream.destroy()))
  return {
    memory, usage, pending,
    start(stream) {
      const ctx = {
        status: 200, headers: {}, ip: '127.0.0.1', res: { headersSent: false },
        request: { body: { model: 'synthetic-alias', messages: [{ role: 'user', content: 'Fixture only' }], stream } },
        set() {},
      }
      const index = pending.length
      const route = routes['/completions'](ctx)
      assert.equal(pending.length, index + 1, 'The request reaches only the synthetic forwarder')
      return { ...pending[index], ctx, route }
    },
    async openStream(operation) {
      assert.equal(operation.stream, true)
      const upstream = new PassThrough()
      streams.push(upstream)
      operation.resolve({ success: true, status: 200, stream: upstream, skipTransform: true })
      await operation.route
      assert.equal(typeof operation.ctx.body?.on, 'function')
      streams.push(operation.ctx.body)
      return { upstream, received: collect(operation.ctx.body) }
    },
    async complete(operation, valid = true) {
      if (!operation.stream) {
        operation.resolve({ success: true, status: 200, body: reply(valid ? 'Confirmed synthetic answer' : '') })
        await operation.route
        return JSON.stringify(operation.ctx.body)
      }
      const { upstream, received } = await this.openStream(operation)
      upstream.end(valid ? validStream : delta('Unconfirmed partial') + done)
      return received
    },
  }
}

const data = value => 'data: ' + JSON.stringify(value) + '\n\n'
const delta = content => data({
  id: 'synthetic', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
})
const finish = data({
  id: 'synthetic', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
})
const done = 'data: [DONE]\n\n'
const validStream = delta('Confirmed synthetic answer') + finish + done
const reply = content => ({
  id: 'synthetic', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
})
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk.toString())
  return chunks.join('')
}
const turn = () => new Promise(resolve => setImmediate(resolve))
const modeName = stream => stream ? 'stream' : 'nonstream'

for (const modes of [[false, false], [true, true], [false, true], [true, false]]) {
  for (const order of [[0, 1], [1, 0]]) {
    test('overlapping ' + modes.map(modeName).join('/') + ' completes ' + order.join('->') + ': N becomes N+2',
      async t => {
        const h = routeHarness(t)
        const operations = modes.map(mode => h.start(mode))
        assert.notEqual(operations[0].selected, operations[1].selected)
        for (const operation of operations) {
          assert.equal(operation.selected.requestCount, 7)
          assert.equal(operation.selected.todayUsed, 3)
        }
        assert.equal(h.memory.writes.length, 0)
        h.memory.resetObservations()
        await h.complete(operations[order[0]])
        assert.equal(h.memory.rows[0].requestCount, 8)
        assert.equal(h.memory.rows[0].todayUsed, 4)
        h.memory.clock.now++
        await h.complete(operations[order[1]])
        assert.equal(h.memory.rows[0].requestCount, 9, 'Both confirmed answers must be charged')
        assert.equal(h.memory.rows[0].todayUsed, 5)
        assert.equal(h.memory.rows[0].lastUsed, NOW + 1)
        assert.equal(h.memory.writes.length, 2)
        assert.deepEqual(h.memory.events, ['get', 'set', 'get', 'set'])
        assert.deepEqual(h.usage.stats, [true, true])
        assert.equal(h.usage.success, 2)
        assert.equal(h.usage.failure, 0)
        assert.equal(h.pending.length, 2, 'No retries or fallback requests')
        assert.deepEqual(h.memory.crypto, { decrypt: 0, encrypt: 0 })
      })
  }
}

test('stream finish and DONE do not charge before clean EOF; settlement charges once', async t => {
  const h = routeHarness(t)
  const operation = h.start(true)
  h.memory.resetObservations()
  const { upstream, received } = await h.openStream(operation)
  upstream.write(validStream)
  await turn()
  assert.equal(h.memory.rows[0].requestCount, 7)
  assert.equal(h.memory.writes.length, 0)
  assert.deepEqual(h.usage.stats, [])
  upstream.end()
  const wire = await received
  assert.equal((wire.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(h.memory.rows[0].requestCount, 8)
  assert.equal(h.memory.rows[0].todayUsed, 4)
  assert.equal(h.memory.writes.length, 1)
  await turn()
  assert.equal(h.memory.writes.length, 1)
  assert.deepEqual(h.usage.stats, [true])
})

for (const stream of [false, true]) {
  test('invalid ' + modeName(stream) + ' completion never increments an overlapping successful request', async t => {
    const h = routeHarness(t)
    const valid = h.start(!stream)
    const invalid = h.start(stream)
    await h.complete(valid)
    const before = h.memory.rows
    h.memory.resetObservations()
    const wire = await h.complete(invalid, false)
    assert.equal(h.memory.rows, before)
    assert.equal(h.memory.rows[0].requestCount, 8)
    assert.equal(h.memory.rows[0].todayUsed, 4)
    assert.equal(h.memory.writes.length, 1)
    assert.deepEqual(h.memory.events, [])
    assert.deepEqual(h.usage.stats, [true, false])
    assert.equal(h.usage.success, 1)
    assert.equal(h.usage.failure, 1)
    assert.equal(invalid.ctx.status, 502)
    assert.equal(wire.includes('data: [DONE]'), false)
  })

  test('deleted account stays deleted after confirmed ' + modeName(stream) + ' answer', async t => {
    const other = account({ id: 'synthetic-unrelated-account', providerId: 'synthetic-other-provider' })
    const h = routeHarness(t, [account(), other])
    const operation = h.start(stream)
    h.memory.replaceRows([other])
    const before = h.memory.rows
    h.memory.resetObservations()
    await h.complete(operation)
    assert.equal(h.memory.rows, before)
    assert.equal(h.memory.rows[0], other)
    assert.equal(h.memory.writes.length, 0)
    assert.deepEqual(h.memory.events, ['get'])
    // A removed account cannot be settled. The completed upstream operation
    // remains unconfirmed locally: never manufacture a successful API reply.
    assert.deepEqual(h.usage.stats, [false])
    assert.equal(h.usage.success, 0)
    assert.equal(h.usage.failure, 1)
    assert.equal(operation.ctx.status, stream ? 502 : 500)
  })

  test('same account ID moved to another provider is not charged by old ' + modeName(stream) + ' request', async t => {
    const h = routeHarness(t)
    const operation = h.start(stream)
    const replacement = account({ providerId: 'synthetic-new-provider' })
    h.memory.replaceRows([replacement])
    h.memory.resetObservations()
    await h.complete(operation)
    assert.equal(h.memory.rows[0], replacement)
    assert.equal(h.memory.writes.length, 0)
    assert.deepEqual(h.memory.events, ['get'])
    assert.deepEqual(h.usage.stats, [false])
    assert.equal(h.usage.success, 0)
    assert.equal(h.usage.failure, 1)
    assert.equal(operation.ctx.status, stream ? 502 : 500)
  })
}

test('late stream error after finish/DONE leaves latest account untouched and emits no false DONE', async t => {
  const h = routeHarness(t)
  const operation = h.start(true)
  const before = h.memory.rows
  h.memory.resetObservations()
  const { upstream, received } = await h.openStream(operation)
  upstream.end(validStream + data({ error: { private: PRIVATE } }))
  const wire = await received
  assert.equal(h.memory.rows, before)
  assert.equal(h.memory.writes.length, 0)
  assert.deepEqual(h.memory.events, [])
  assert.deepEqual(h.usage.stats, [false])
  assert.equal(h.usage.success, 0)
  assert.equal(wire.includes(PRIVATE), false)
  assert.equal(wire.includes('data: [DONE]'), false)
  assert.equal(JSON.stringify(h.usage).includes(PRIVATE), false)
})

for (const modes of [[false, false], [true, true], [false, true]]) {
  test('overlapping ' + modes.map(modeName).join('/') + ' preserves latest counters, credentials and metadata', async t => {
    const other = account({ id: 'synthetic-unrelated-account', providerId: 'synthetic-other-provider' })
    const h = routeHarness(t, [account(), other])
    const operations = modes.map(mode => h.start(mode))
    const changedCredentials = Object.freeze({
      token: 'safeStorage:v1:' + Buffer.from(PRIVATE + '_ROTATED').toString('base64'),
      cookies: 'safeStorage:cookies:v1:' + Buffer.from('SYNTHETIC_COOKIE_BLOB').toString('base64'),
    })
    const changed = account({
      name: 'Changed during both requests', status: 'inactive', credentials: changedCredentials,
      requestCount: 20, todayUsed: 0, lastUsed: 40, updatedAt: 50, dailyLimit: 75,
      errorMessage: 'Synthetic account metadata',
    })
    h.memory.replaceRows([changed, other])
    h.memory.resetObservations()
    await h.complete(operations[0])
    await h.complete(operations[1])
    const current = h.memory.rows[0]
    assert.equal(current.requestCount, 22)
    assert.equal(current.todayUsed, 2, 'Use the latest daily counter, including a reset')
    assert.equal(current.lastUsed, NOW)
    assert.deepEqual(withoutUsage(current), withoutUsage(changed))
    assert.equal(current.credentials, changedCredentials, 'Copy opaque stored credentials without decryption')
    assert.equal(h.memory.rows[1], other)
    assert.equal(changed.requestCount, 20, 'Do not mutate the latest row returned by get')
    assert.equal(operations[0].selected.requestCount, 7, 'Do not mutate selected snapshots')
    assert.deepEqual(h.memory.crypto, { decrypt: 0, encrypt: 0 })
    assert.deepEqual(h.memory.events, ['get', 'set', 'get', 'set'])
    assert.equal(JSON.stringify(h.usage).includes(PRIVATE), false)
  })
}

test('actual StoreManager success method is synchronous, reads latest once and writes accounts once without crypto', () => {
  const original = account()
  const other = account({ id: 'synthetic-unrelated-account' })
  const h = memoryStore([original, other])
  assert.equal(typeof h.manager.recordAccountSuccess, 'function')
  h.manager.decryptCredentials = () => { throw new Error('Success accounting must not decrypt credentials') }
  h.manager.encryptCredentials = () => { throw new Error('Success accounting must not replace credentials') }
  const before = h.rows
  const result = h.manager.recordAccountSuccess(ACCOUNT_ID, PROVIDER_ID)
  assert.equal(result, true, 'Return a synchronous result, never a Promise')
  assert.deepEqual(h.events, ['get', 'set'])
  assert.equal(h.writes.length, 1)
  assert.notEqual(h.rows, before)
  assert.notEqual(h.rows[0], original)
  assert.equal(h.rows[0].requestCount, 8)
  assert.equal(h.rows[0].todayUsed, 4)
  assert.equal(h.rows[0].lastUsed, NOW)
  assert.deepEqual(withoutUsage(h.rows[0]), withoutUsage(original))
  assert.equal(h.rows[0].credentials, credentials)
  assert.equal(h.rows[1], other)
  assert.equal(original.requestCount, 7)
})

test('actual StoreManager success method initializes absent counters from the current stored row', () => {
  const h = memoryStore([account({ requestCount: undefined, todayUsed: undefined, lastUsed: undefined })])
  assert.equal(typeof h.manager.recordAccountSuccess, 'function')
  assert.equal(h.manager.recordAccountSuccess(ACCOUNT_ID, PROVIDER_ID), true)
  assert.equal(h.rows[0].requestCount, 1)
  assert.equal(h.rows[0].todayUsed, 1)
  assert.equal(h.rows[0].lastUsed, NOW)
  assert.deepEqual(h.events, ['get', 'set'])
})

for (const [id, providerId] of [
  ['synthetic-missing-account', PROVIDER_ID],
  [ACCOUNT_ID, 'synthetic-wrong-provider'],
]) {
  test('actual StoreManager missing/mismatched row returns false without write: ' + id + '/' + providerId, () => {
    const h = memoryStore()
    assert.equal(typeof h.manager.recordAccountSuccess, 'function')
    const before = h.rows
    assert.equal(h.manager.recordAccountSuccess(id, providerId), false)
    assert.equal(h.rows, before)
    assert.deepEqual(h.events, ['get'])
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.crypto, { decrypt: 0, encrypt: 0 })
  })
}

test('actual StoreManager write refusal cannot mutate the original array or metadata', () => {
  const h = memoryStore()
  assert.equal(typeof h.manager.recordAccountSuccess, 'function')
  const before = h.rows
  const refusal = new Error('Synthetic accounts write refusal')
  h.failWrites(refusal)
  assert.throws(() => h.manager.recordAccountSuccess(ACCOUNT_ID, PROVIDER_ID), error => error === refusal)
  assert.equal(h.rows, before)
  assert.equal(h.rows[0].requestCount, 7)
  assert.equal(h.rows[0].todayUsed, 3)
  assert.equal(h.rows[0].credentials, credentials)
  assert.deepEqual(h.events, ['get', 'set'])
  assert.equal(h.writes.length, 0)
})
