import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual route and completion validator with closed in-memory
// dependencies. No application bootstrap, operating store, account file,
// Electron, provider adapter, network, auth or live request is reachable.
const source = file => readFileSync(new URL('../../src/main/proxy/' + file, import.meta.url), 'utf8')
const compile = file => ts.transpileModule(source(file), {
  fileName: file,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText
const routeSource = compile('routes/chat.ts')
const terminalModule = { exports: {} }
vm.runInNewContext(compile('streamTerminalGate.ts'), {
  module: terminalModule,
  exports: terminalModule.exports,
  Buffer, TextDecoder, Date, Error,
  require: name => {
    if (name === 'stream') return { PassThrough }
    throw new Error('Unexpected completion-validator dependency: ' + name)
  },
}, { filename: 'streamTerminalGate.ts', timeout: 1500 })

const SECRET = 'SYNTHETIC_PRIVATE_CREDENTIAL_AND_UPSTREAM_BODY_LOCAL27'
const privateDetails = {
  error: 'Authorization: Bearer ' + SECRET,
  headers: { authorization: 'Bearer ' + SECRET, 'set-cookie': SECRET },
  body: { error: { message: SECRET, token: SECRET } },
  providerSessionId: SECRET,
  parentMessageId: SECRET,
}

function makeHarness(result, { providerId = 'glm', stream = false } = {}) {
  const observed = {
    selected: 0, forwarded: 0, started: 0, succeeded: 0, failed: 0,
    marked: 0, cleared: 0, accountSuccess: 0, stats: [], logs: [], receipts: [], console: [],
  }
  const account = {
    id: 'synthetic-account-local27', name: 'Synthetic account', providerId,
    credentials: { token: SECRET, refresh_token: SECRET }, status: 'active',
  }
  const provider = { id: providerId, name: 'Synthetic provider', enabled: true }
  const routes = {}
  class Router {
    constructor(options) { assert.equal(options.prefix, '/v1/chat') }
    post(path, callback) { routes[path] = callback }
  }
  const forbidden = operation => () => { throw new Error('Forbidden fixture operation: ' + operation) }
  const modules = {
    '@koa/router': { __esModule: true, default: Router },
    '../loadbalancer': { loadBalancer: {
      selectAccount() {
        observed.selected++
        return { account, provider, actualModel: 'synthetic-wire-local27' }
      },
      markAccountFailed: () => observed.marked++,
      clearAccountFailure: () => observed.cleared++,
    } },
    '../modelMapper': { modelMapper: {
      getPreferredProvider: () => providerId,
      getPreferredAccount: () => account.id,
    } },
    '../forwarder': { requestForwarder: {
      async forwardChatCompletion(_request, selectedAccount, selectedProvider) {
        observed.forwarded++
        assert.equal(selectedAccount, account)
        assert.equal(selectedProvider, provider)
        return result
      },
    } },
    '../stream': { streamHandler: { createTransformStream: forbidden('stream transform') } },
    '../streamTerminalGate': terminalModule.exports,
    '../status': { proxyStatusManager: {
      recordRequestStart: () => observed.started++,
      recordRequestSuccess: () => observed.succeeded++,
      recordRequestFailure: () => observed.failed++,
    } },
    '../../store/store': { storeManager: {
      getConfig: () => ({ retryCount: 0, loadBalanceStrategy: 'round-robin' }),
      addLog: (level, message, metadata) => observed.logs.push({ level, message, ...metadata }),
      addRequestLog: entry => {
        observed.receipts.push(entry)
        return { id: 'synthetic-log-local27' }
      },
      updateRequestLog: forbidden('receipt update'),
      recordRequestInStats: success => observed.stats.push(success),
      recordAccountSuccess: () => { observed.accountSuccess++; return true },
    } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: forbidden('response conversion'),
      transformChunkToAnthropic: forbidden('chunk conversion'),
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(routeSource, {
    module, exports: module.exports,
    Date, Math, JSON, Error,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [
      level, (...args) => observed.console.push({ level, args }),
    ])),
    require: name => {
      if (Object.hasOwn(modules, name)) return modules[name]
      throw new Error('Unexpected route dependency: ' + name)
    },
  }, { filename: 'routes/chat.ts', timeout: 1500 })
  assert.equal(typeof routes['/completions'], 'function')
  const ctx = {
    status: 200, ip: '127.0.0.1',
    headers: { authorization: 'Bearer ' + SECRET },
    res: { headersSent: false },
    request: { body: {
      model: 'synthetic-model-local27',
      messages: [{ role: 'user', content: 'Synthetic provenance fixture' }],
      stream,
    } },
    set() {},
  }
  return { ctx, observed, invoke: () => routes['/completions'](ctx) }
}

function assertFailure(h, { localStatus, code, stage, marked = 1 }) {
  const { ctx, observed } = h
  assert.equal(ctx.status, localStatus, 'client HTTP status must retain existing behavior')
  assert.equal(ctx.body.error.message, 'Provider request failed')
  assert.equal(ctx.body.error.type, 'api_error')
  assert.equal(ctx.body.error.code, code, 'only the fixed diagnostic code is returned')
  assert.equal(observed.selected, 1)
  assert.equal(observed.forwarded, 1, 'a provenance repair must not introduce a retry')
  assert.equal(observed.started, 1)
  assert.equal(observed.failed, 1)
  assert.equal(observed.succeeded, 0)
  assert.equal(observed.accountSuccess, 0)
  assert.equal(observed.marked, marked)
  assert.equal(observed.cleared, 0)
  assert.deepEqual(observed.stats, [false])
  assert.equal(observed.receipts.length, 1)
  assert.equal(observed.receipts[0].statusCode, localStatus)
  assert.equal(observed.receipts[0].responseStatus, localStatus)
  assert.equal(JSON.parse(observed.receipts[0].responseBody).error.code, code)
  assert.equal(observed.logs.length, 1)
  const diagnostic = observed.logs[0].data
  assert.ok(diagnostic)
  assert.equal(diagnostic.failureStage, stage)
  assert.equal(diagnostic.failureCode, code)
  assert.equal(JSON.stringify({ body: ctx.body, records: observed }).includes(SECRET), false,
    'credentials and raw provider errors, bodies, headers and session IDs stay out of records')
  assert.equal(Object.hasOwn(diagnostic, 'upstreamStatus'), false,
    'a local response code is not evidence of an upstream HTTP response')
  assert.equal(diagnostic.localStatus, localStatus)
  assert.equal(diagnostic.upstreamHttpStatus, null,
    'ForwardResult has no verified upstream HTTP provenance; preserve unknown explicitly')
}

for (const stream of [false, true]) {
  const mode = stream ? 'stream request' : 'nonstream request'
  test('real route local400 before remote HTTP keeps upstream unknown: ' + mode, async () => {
    const h = makeHarness({
      ...privateDetails, success: false, status: 400,
      failureStage: 'auth-preflight', failureCode: 'glm_attachment_invalid_input',
    }, { stream })
    await h.invoke()
    assertFailure(h, {
      localStatus: 400, code: 'glm_attachment_invalid_input', stage: 'auth-preflight', marked: 0,
    })
  })

  test('real route local502 without remote HTTP keeps upstream unknown: ' + mode, async () => {
    const h = makeHarness({
      ...privateDetails, success: false, status: 502,
      failureStage: 'unclassified', failureCode: 'qwen_ai_upstream_operation_failed',
    }, { providerId: 'qwen-ai', stream })
    await h.invoke()
    assertFailure(h, { localStatus: 502, code: 'qwen_ai_upstream_operation_failed', stage: 'unclassified' })
  })

  test('real route local completion rejection does not label synthetic status200 as upstream: ' + mode, async () => {
    const h = makeHarness({ ...privateDetails, success: true, status: 200 }, { stream })
    await h.invoke()
    assertFailure(h, { localStatus: 502, code: 'provider_completion_unconfirmed', stage: 'response-decoding' })
  })
}

test('real route records actual local500 fallback when ForwardResult status is absent', async () => {
  const h = makeHarness({
    ...privateDetails, success: false,
    failureStage: 'unclassified', failureCode: 'glm_upstream_operation_failed',
  })
  await h.invoke()
  assertFailure(h, { localStatus: 500, code: 'glm_upstream_operation_failed', stage: 'unclassified', marked: 0 })
})

test('real route preserves local401 and fixed Z.ai stage code without claiming upstream provenance', async () => {
  // An HTTP-like numeric status alone cannot distinguish a remote response
  // from a locally selected error. No typed upstream status reaches this route.
  const h = makeHarness({
    ...privateDetails, success: false, status: 401, failureStage: 'chat-creation',
  }, { providerId: 'zai' })
  await h.invoke()
  assertFailure(h, { localStatus: 401, code: 'zai_chat_creation_failed', stage: 'chat-creation' })
})

test('real route ignores unverified upstream-looking object fields and raw response details', async () => {
  const h = makeHarness({
    ...privateDetails, success: false, status: 502,
    failureStage: 'chat-completion', failureCode: 'kimi_upstream_operation_failed',
    upstreamStatus: 403, upstreamHttpStatus: 429,
    response: { status: 401, data: SECRET },
  }, { providerId: 'kimi' })
  await h.invoke()
  assertFailure(h, { localStatus: 502, code: 'kimi_upstream_operation_failed', stage: 'chat-completion' })
})

test('real route completed answer retains success response and accounting', async () => {
  const body = {
    id: 'synthetic-completion-local27', object: 'chat.completion',
    choices: [{
      index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: 'Synthetic completed answer' },
    }],
  }
  const h = makeHarness({ success: true, status: 200, body })
  await h.invoke()
  assert.equal(h.ctx.status, 200)
  assert.equal(h.ctx.body, body)
  assert.equal(h.observed.forwarded, 1)
  assert.equal(h.observed.succeeded, 1)
  assert.equal(h.observed.failed, 0)
  assert.equal(h.observed.accountSuccess, 1)
  assert.deepEqual(h.observed.stats, [true])
  assert.equal(h.observed.receipts[0].responseBody, undefined)
  assert.equal(JSON.stringify({ body: h.ctx.body, records: h.observed }).includes(SECRET), false)
})
