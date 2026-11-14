import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Actual /v1/chat/completions production route, no application import or
// network. A second SDK spelling or header must not override explicit false.
const source = readFileSync(new URL('../../src/main/proxy/routes/chat.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'chat.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const fixedAccount = { id: 'synthetic-account-local25', providerId: 'kimi', status: 'active' }
const fixedProvider = { id: 'kimi', name: 'Synthetic Kimi', enabled: true }
const calls = []
const routes = {}
class Router {
  post(path, callback) { routes[path] = callback }
}
const mods = {
  '@koa/router': { __esModule: true, default: Router },
  '../loadbalancer': { loadBalancer: {
    selectAccount: () => ({ account: fixedAccount, provider: fixedProvider, actualModel: 'synthetic-wire' }),
    markAccountFailed() {},
    clearAccountFailure() { throw Error('No success permitted in this fixture') },
  } },
  '../modelMapper': { modelMapper: {
    getPreferredProvider: () => 'kimi', getPreferredAccount: () => fixedAccount.id,
  } },
  '../forwarder': { requestForwarder: {
    forwardChatCompletion: async request => {
      calls.push({
        snake: request.reasoning_effort,
        camel: request.reasoningEffort,
        web: request.web_search,
      })
      return { success: false, status: 502, error: 'Synthetic reject only' }
    },
  } },
  '../stream': { streamHandler: {} },
  '../streamTerminalGate': { hasCompletedNonStreamAnswer: () => false },
  '../status': { proxyStatusManager: {
    recordRequestStart() {}, recordRequestFailure() {}, recordRequestSuccess() {},
  } },
  '../../store/store': { storeManager: {
    getConfig: () => ({ retryCount: 0, loadBalanceStrategy: 'round-robin' }),
    addLog() {}, addRequestLog: () => ({ id: 'synthetic-log' }),
    recordRequestInStats() {},
  } },
  '../utils/toolFormatConverter': {
    isAnthropicToolFormat: () => false,
    transformResponseToAnthropic: () => { throw Error('No response conversion') },
    transformChunkToAnthropic: () => { throw Error('No chunk conversion') },
  },
}
const mod = { exports: {} }
vm.runInNewContext(compiled, {
  module: mod, exports: mod.exports,
  Date, Math, JSON, Error, console: { log() {}, warn() {}, error() {} },
  require: name => {
    if (!Object.hasOwn(mods, name)) throw Error('Unexpected module ' + name)
    return mods[name]
  },
}, { filename: 'chat.ts', timeout: 2000 })
assert.equal(typeof routes['/completions'], 'function')

async function invoke(body, headers = {}) {
  const ctx = {
    status: 200, headers, ip: '127.0.0.1', res: { headersSent: false },
    request: { body: {
      model: 'synthetic-model', messages: [{ role: 'user', content: 'Synthetic only' }],
      stream: false, ...body,
    } },
    set() {},
  }
  const index = calls.length
  await routes['/completions'](ctx)
  assert.equal(calls.length, index + 1, 'single request, no retry or fallback')
  assert.equal(ctx.status, 502, 'fixture never succeeds')
  return calls[index]
}

test('explicit snake-case false survives a contradictory camelCase high option', async () => {
  const observed = await invoke({ reasoning_effort: false, reasoningEffort: 'high' })
  assert.equal(observed.snake, false)
  assert.equal(observed.camel, undefined)
})
test('omitted snake-case option accepts supported camelCase high', async () => {
  const observed = await invoke({ reasoningEffort: 'high' })
  assert.equal(observed.snake, 'high')
  assert.equal(observed.camel, undefined)
})
test('explicit camelCase false remains false when snake-case is omitted', async () => {
  const observed = await invoke({ reasoningEffort: false })
  assert.equal(observed.snake, false)
  assert.equal(observed.camel, undefined)
})
test('explicit false dominates X-Reasoning-Effort header and survives web false', async () => {
  const observed = await invoke({ reasoning_effort: false, web_search: false },
    { 'x-reasoning-effort': 'high', 'x-web-search': 'true' })
  assert.equal(observed.snake, false)
  assert.equal(observed.web, false)
})
