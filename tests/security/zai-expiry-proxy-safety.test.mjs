import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const requireNode = createRequire(import.meta.url)
const source = (relative) => readFileSync(path.join(root, relative), 'utf8')
const claimsPath = 'src/main/oauth/zaiSession.ts'
const proxyPath = 'src/main/proxy/adapters/zai.ts'
const silent = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} }

function loadTypescript(relative, dependencies, extra = {}) {
  const result = ts.transpileModule(source(relative), {
    fileName: relative,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  })
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error('Unexpected test dependency: ' + name)
    },
    console: silent, Buffer, TextDecoder, URL, URLSearchParams, Date, Error,
    setTimeout: extra.setTimeout || setTimeout,
    clearTimeout: extra.clearTimeout || clearTimeout,
  }, { filename: relative, timeout: 1000 })
  return module.exports
}

const sessions = loadTypescript(claimsPath, { crypto })

function syntheticToken(fields = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    id: 'fixed-zai-subject', email: 'user@example.invalid',
    exp: Math.floor(Date.now() / 1000) + 3600, ...fields,
  })).toString('base64url')
  return header + '.' + payload + '.synthetic-signature'
}

test('strict session metadata, account partition and exact Z.ai web origin', () => {
  const now = Date.now()
  const token = syntheticToken()
  const good = sessions.readZaiSessionClaims(token, now)
  assert.equal(good.subject, 'fixed-zai-subject')
  assert.equal(good.usable, true)
  assert.equal(sessions.readZaiSessionClaims(syntheticToken({ exp: Math.floor(now / 1000) - 1 }), now).usable, false)
  assert.equal(sessions.readZaiSessionClaims(syntheticToken({ nbf: Math.floor(now / 1000) + 300 }), now), null)
  assert.equal(sessions.readZaiSessionClaims(syntheticToken({ email: 'fake@guest.com' }), now), null)
  assert.equal(sessions.readZaiSessionClaims('not.a.jwt', now), null)
  const a = sessions.zaiPersistentPartition('existing-account-A')
  assert.match(a, /^persist:chat2api-zai-[a-f0-9]{32}$/)
  assert.equal(a, sessions.zaiPersistentPartition('existing-account-A'))
  assert.notEqual(a, sessions.zaiPersistentPartition('existing-account-B'))
  assert.equal(sessions.isZaiWebUrl('https://chat.z.ai/api/v1/auths/'), true)
  for (const invalid of [
    'http://chat.z.ai/', 'https://chat.z.ai.evil.invalid/', 'https://z.ai/',
    'https://evil.invalid@chat.z.ai/', 'https://chat.z.ai:4443/',
  ]) assert.equal(sessions.isZaiWebUrl(invalid), false, invalid)
})

function proxyHarness() {
  const requests = []
  const axios = {
    post: async (...args) => { requests.push(args); throw new Error('Unexpected mock network') },
  }
  const events = []
  const clock = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false }
      events.push(timer)
      return timer
    },
    clearTimeout(timer) { timer.cleared = true },
  }
  const deps = {
    axios: { __esModule: true, default: axios },
    crypto,
    stream: { PassThrough },
    'eventsource-parser': requireNode('eventsource-parser'),
    'form-data': { __esModule: true, default: class FormData {} },
    '../../oauth/zaiSession': sessions,
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => null },
    '../utils/toolParser': { parseToolCallsFromText: () => [] },
    '../utils/streamToolHandler': {
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: () => ({ chunks: [] }),
      flushToolCallBuffer: () => [],
      createBaseChunk: () => ({}),
    },
  }
  return {
    ...loadTypescript(proxyPath, deps, clock),
    requests, timers: events,
  }
}

test('expired, future and malformed Z.ai tokens cannot start an upstream request', async () => {
  const h = proxyHarness()
  const account = (token) => ({ id: 'a', credentials: { token } })
  const provider = { id: 'zai', apiEndpoint: 'https://chat.z.ai' }
  for (const token of [
    syntheticToken({ exp: Math.floor(Date.now() / 1000) - 500 }),
    syntheticToken({ nbf: Math.floor(Date.now() / 1000) + 500 }),
    'malformed',
  ]) {
    const adapter = new h.ZaiAdapter(provider, account(token))
    await assert.rejects(adapter.ensureToken())
  }
  assert.deepEqual(h.requests, [])
  const good = new h.ZaiAdapter(provider, account(syntheticToken()))
  assert.equal(typeof await good.ensureToken(), 'string')
})

function emitSse(stream, event) {
  stream.emit('data', Buffer.from('data: ' + JSON.stringify(event) + '\n\n'))
}

test('non-stream confirms an actual answer and provider done event', async () => {
  const h = proxyHarness()
  const handler = new h.ZaiStreamHandler('glm-test')
  const stream = new EventEmitter()
  const pending = handler.handleNonStream(stream)
  emitSse(stream, { type: 'chat:completion', data: { phase: 'answer', delta_content: 'ZAI_SESSION_OK' } })
  emitSse(stream, { type: 'chat:completion', data: { phase: 'done', done: true } })
  // A model terminal is provisional until genuine upstream transport EOF.
  stream.emit('end')
  const result = await pending
  assert.equal(result.choices[0].message.content, 'ZAI_SESSION_OK')
  assert.equal(h.timers[0].cleared, true)
})

test('Z.ai modern SSE edit_content uses UTF-16 offsets and full replacement without duplicated answer', async () => {
  const h = proxyHarness()
  const handler = new h.ZaiStreamHandler('x-preview-l')
  const stream = new EventEmitter()
  const pending = handler.handleNonStream(stream)
  emitSse(stream,{type:'chat:completion',data:{phase:'answer',delta_content:'Hello danger!'}})
  emitSse(stream,{type:'chat:completion',data:{phase:'answer',edit_index:6,edit_content:'world'}})
  emitSse(stream,{type:'chat:completion',data:{phase:'answer',delta_content:' 😀'}})
  emitSse(stream,{type:'chat:completion',data:{phase:'answer',edit_index:12,edit_content:'!'}})
  emitSse(stream,{type:'chat:completion',data:{phase:'answer',content:'Safe final answer.'}})
  emitSse(stream,{type:'chat:completion',data:{phase:'done',done:true}})
  stream.emit('end')
  const reply = await pending
  assert.equal(reply.choices[0].message.content,'Safe final answer.')
  assert.equal(h.timers[0].cleared,true)
})

test('Z.ai modern answer can finish using OpenAI-style choices without inventing assistant output', async () => {
  const h=proxyHarness()
  const handler=new h.ZaiStreamHandler('glm-5.3')
  const stream=new EventEmitter()
  const pending=handler.handleNonStream(stream)
  emitSse(stream,{choices:[{index:0,delta:{content:'Hi '},finish_reason:null}]})
  emitSse(stream,{choices:[{index:0,delta:{content:'there'},finish_reason:null}]})
  emitSse(stream,{choices:[{index:0,delta:{},finish_reason:'stop'}]})
  stream.emit('end')
  const reply=await pending
  assert.equal(reply.choices[0].message.content,'Hi there')
})

test('Z.ai unsafe edit offset and incomplete answer never resolve as successful output', async () => {
  const h=proxyHarness()
  assert.throws(()=>h.applyZaiTextUpdate('text',{edit_index:-1,edit_content:'x'}), /edit index was invalid/)
  assert.throws(()=>h.applyZaiTextUpdate('text',{edit_index:999,edit_content:'x'}), /edit index was invalid/)
  const handler=new h.ZaiStreamHandler('glm-5.3')
  const stream=new EventEmitter()
  const pending=handler.handleNonStream(stream)
  emitSse(stream,{type:'chat:completion',data:{phase:'answer',edit_index:-1,edit_content:'forged'}})
  await assert.rejects(pending,/not valid completion data/)
})

test('upstream error, early close, completion without answer and timeout do not resolve as success', async () => {
  const h = proxyHarness()
  for (const signal of ['error', 'close', 'empty-done', 'timeout']) {
    const handler = new h.ZaiStreamHandler('glm-test')
    const stream = new EventEmitter()
    const pending = handler.handleNonStream(stream)
    if (signal === 'error') emitSse(stream, { type: 'chat:completion', data: { error: { detail: 'private' } } })
    if (signal === 'close') stream.emit('close')
    if (signal === 'empty-done') {
      emitSse(stream, { type: 'chat:completion', data: { phase: 'done', done: true } })
      stream.emit('end')
    }
    if (signal === 'timeout') h.timers.at(-1).callback()
    await assert.rejects(pending)
  }
})

test('Z.ai replay/failover protections are explicit in production routing', () => {
  assert.match(source('src/main/proxy/forwarder.ts'), /const maxRetries = consumerWebAdapter \? 0 : config\.retryCount/)
  assert.match(source('src/main/proxy/loadbalancer.ts'), /if \(preferredProviderId === 'zai'\) return null/)
  assert.match(source(proxyPath), /title_generation: false/)
  assert.match(source(proxyPath), /readZaiSessionClaims\(token\)/)
  assert.doesNotMatch(source('src/main/ipc/handlers.ts').match(/handleTrusted\(IpcChannels\.OAUTH_RECONNECT_ZAI_ACCOUNT,[\s\S]*?\n  \}\)/)?.[0] || '', /credentials\s*:/)
})
