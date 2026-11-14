import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import crypto from 'node:crypto'
import path from 'node:path'
import * as streams from 'node:stream'
import mime from 'mime-types'

// Exercise the real adapter, including extraction, download, upload and prompt
// preparation. Only transports/DNS/agents/store are doubles. No real network,
// Electron, profiles, keys, browser, filesystem writes or provider effects.
const SOURCE = readFileSync(new URL('../../src/main/proxy/adapters/glm.ts', import.meta.url), 'utf8')
const CODE = ts.transpileModule(SOURCE, { fileName: 'glm.ts', compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const LIMIT = 100 * 1024 * 1024
const REFRESH = 'SYNTHETIC_GLM_REFRESH_LOCAL25'
const ACCESS = 'SYNTHETIC_GLM_ACCESS_LOCAL25'
const PRIVATE = 'SYNTHETIC_ATTACHMENT_PRIVATE_LOCAL25'
const PUBLIC = 'https://files.example.com/document.pdf?signature=' + PRIVATE
const INLINE = 'data:text/plain;base64,aGVsbG8='
const denied = () => { throw Error('Unexpected real capability in GLM attachment test') }
const copy = value => JSON.parse(JSON.stringify(value))
const part = (kind, value) => kind === 'image'
  ? { type: 'image_url', image_url: { url: value } }
  : { type: 'file', file_url: { url: value } }
const request = parts => ({ model: 'synthetic-glm-model', messages: [
  { role: 'user', content: [{ type: 'text', text: 'before ' }, ...parts, { type: 'text', text: 'after' }] },
] })

function lookupAtSocket(agent, hostname, options = { all: true, family: 0 }) {
  return new Promise((resolve, reject) => {
    const lookup = agent?.options?.lookup
    if (typeof lookup !== 'function') { reject(Error('Missing guarded socket lookup')); return }
    lookup(hostname, options, (error, address, family) => error ? reject(error) : resolve({ address, family }))
  })
}

function fixture(options = {}) {
  const effects = [], gets = [], posts = [], dnsCalls = [], pins = [], agents = [], logs = [], writes = []
  let dnsAnswer = options.dnsAnswer ?? [{ address: '8.8.8.8', family: 4 }]
  class FakeAgent {
    constructor(agentOptions) { this.options = agentOptions; this.destroyed = false; agents.push(this) }
    destroy() { this.destroyed = true }
  }
  class FakeFormData {
    constructor() { this.fields = [] }
    append(name, data, metadata) { this.fields.push({ name, data, metadata }) }
    getHeaders() { return { 'content-type': 'multipart/form-data; boundary=SYNTHETIC_LOCAL25' } }
  }
  const dns = {
    async lookup(hostname, lookupOptions) {
      dnsCalls.push({ hostname, options: lookupOptions })
      effects.push('dns')
      if (options.dnsError) throw typeof options.dnsError === 'function' ? options.dnsError() : Error(PRIVATE)
      if (options.onDns) return copy(await options.onDns(hostname, lookupOptions, dnsCalls.length))
      return copy(dnsAnswer)
    },
  }
  const axios = {
    async get(url, config) {
      gets.push({ url, config }); effects.push('get')
      options.beforeSocket?.({ setDns: value => { dnsAnswer = value }, config })
      if (config.httpsAgent?.options?.lookup) {
        pins.push(await lookupAtSocket(config.httpsAgent, new URL(url).hostname))
      }
      if (options.getError) throw typeof options.getError === 'function' ? options.getError() : Error(PRIVATE)
      if (options.onGet) return await options.onGet(url, config, gets.length)
      return {
        status: options.getStatus ?? 200,
        data: options.getData ?? Buffer.from('downloaded bytes'),
        headers: options.getHeaders ?? { 'content-type': 'application/pdf' },
      }
    },
    async post(url, body, config) {
      posts.push({ url, body, config })
      if (url.endsWith('/user-api/user/refresh')) {
        effects.push('auth')
        return { status: 200, data: { code: 0, result: { access_token: ACCESS, refresh_token: REFRESH } } }
      }
      if (url.endsWith('/assistant/file_upload')) {
        effects.push('upload')
        if (options.uploadError) throw typeof options.uploadError === 'function' ? options.uploadError() : Error(PRIVATE)
        return { status: options.uploadStatus ?? 200, data: {
          result: Object.hasOwn(options, 'uploadResult') ? options.uploadResult : { source_id: 'synthetic-source' },
        } }
      }
      if (url.endsWith('/assistant/stream')) {
        effects.push('completion')
        return { status: 200, data: new streams.PassThrough(), headers: {} }
      }
      throw Error('Unexpected synthetic endpoint')
    },
  }
  const modules = {
    axios, crypto, path, stream: streams, 'mime-types': mime, 'form-data': FakeFormData,
    'node:dns/promises': dns, 'dns/promises': dns,
    'node:https': { Agent: FakeAgent }, https: { Agent: FakeAgent },
    '../../store/store': { storeManager: { updateAccount(...args) { writes.push(args); denied() } } },
    'eventsource-parser': { createParser: denied },
    '../utils/tools': { toolsToSystemPrompt: denied, TOOL_WRAP_HINT: '', hasToolPromptInjected: () => false },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: denied },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({
      formatAssistantToolCalls: denied, formatToolResult: denied,
    }) },
    '../toolCalling/ToolStreamParser': { ToolStreamParser: class {} },
  }
  const mod = { exports: {} }
  vm.runInNewContext(CODE, {
    module: mod, exports: mod.exports, Buffer, URL, Date, Math, Error,
    TextDecoder, setTimeout, clearTimeout, queueMicrotask,
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    require(name) { if (Object.hasOwn(modules, name)) return modules[name]; throw Error('Blocked import ' + name) },
  }, { filename: 'actual-glm-attachment-local25.js', timeout: 2000 })
  const adapter = new mod.exports.GLMAdapter({ id: 'glm', apiEndpoint: 'https://chatglm.cn/chatglm' }, {
    id: 'synthetic-account', providerId: 'glm', credentials: { refresh_token: REFRESH },
  })
  return { adapter, gets, posts, dnsCalls, pins, agents, logs, writes, effects,
    InputFailure: mod.exports.GLMAttachmentInputFailure }
}

async function rejected(f, input) {
  const error = await f.adapter.chatCompletion(input).then(() => null, error => error)
  assert.ok(error, 'attachment failure must reject the actual adapter request')
  assert.match(error.message, /^GLM attachment /)
  assert.equal(error.message.includes(PRIVATE), false)
  assert.equal(JSON.stringify(f.logs).includes(PRIVATE), false)
  assert.equal(f.effects.includes('completion'), false, 'failed attachment must never become a text-only answer')
  assert.equal(f.writes.length, 0)
  return error
}

const unsafeSources = [
  'http://files.example.com/file', 'https://localhost/file',
  'https://127.0.0.1/file', 'https://127.1/file', 'https://2130706433/file',
  'https://0x7f000001/file', 'https://10.0.0.1/file', 'https://172.16.0.1/file',
  'https://192.168.1.1/file', 'https://169.254.169.254/file', 'https://100.64.0.1/file',
  'https://0.0.0.0/file', 'https://224.0.0.1/file', 'https://192.0.2.1/file',
  'https://[::1]/file', 'https://[::ffff:127.0.0.1]/file', 'https://[fe80::1]/file',
  'https://[fc00::1]/file', 'https://[2002:0808:0808::1]/file', 'https://[2001:db8::1]/file',
  'https://printer.internal/file', 'https://printer/file',
  'https://name:' + PRIVATE + '@files.example.com/file',
  'https://files.example.com\\@127.0.0.1/file', ' https://files.example.com/file',
  'https://files.example.com/file\r\n' + PRIVATE, 'file:///C:/synthetic-only.txt',
  'ftp://files.example.com/file', 'https://files.example.com:0/file', '', 42, {}, null,
]
for (const kind of ['file', 'image']) {
  for (const [index, value] of unsafeSources.entries()) {
    test(kind + ' malformed/private source ' + index + ' is refused before auth or HTTP', async () => {
      const f = fixture()
      await rejected(f, request([part(kind, value)]))
      assert.equal(f.posts.length, 0)
      assert.equal(f.gets.length, 0)
      assert.equal(f.dnsCalls.length, 0)
    })
  }
}

test('all sources are validated before even an earlier valid attachment causes an effect', async () => {
  const f = fixture(), input = request([part('file', INLINE), part('image', 'https://127.0.0.1/file')])
  const before = copy(input)
  await rejected(f, input)
  assert.deepEqual(input, before)
  assert.equal(f.posts.length + f.gets.length + f.dnsCalls.length, 0)
})

test('pure attachment input failures have an exported type before any I/O', async () => {
  for (const input of [request([part('file', 'https://127.0.0.1/file')]),
    request([part('image', 'data:image/png;base64,???')]),
    request(Array.from({ length: 9 }, () => part('file', INLINE)))]) {
    const f = fixture()
    const error = await rejected(f, input)
    assert.equal(error.name, 'GLMAttachmentInputFailure')
    assert.equal(typeof f.InputFailure, 'function')
    assert.equal(error instanceof f.InputFailure, true)
    assert.equal(f.effects.length, 0)
  }
})

for (const stage of ['dnsError', 'getError', 'uploadError']) {
  test('post-DNS/provider failures cannot acquire the pure-input type: ' + stage, async () => {
    let f
    f = fixture({ [stage]: () => new f.InputFailure() })
    assert.equal(typeof f.InputFailure, 'function')
    const error = await rejected(f, request([part('file', stage === 'uploadError' ? INLINE : PUBLIC)]))
    assert.equal(error instanceof f.InputFailure, false)
    assert.notEqual(error.name, 'GLMAttachmentInputFailure')
    assert.ok(f.effects.length > 0)
  })
}

test('attachment count is bounded across files and images before auth', async () => {
  const f = fixture()
  await rejected(f, request(Array.from({ length: 9 }, (_, i) => part(i % 2 ? 'image' : 'file', INLINE))))
  assert.equal(f.posts.length + f.gets.length + f.dnsCalls.length, 0)
})

for (const data of ['data:base64,aA==', 'data:text/plain,hello', 'data:text/plain;base64,',
  'data:text/plain;base64,???', 'data:text/plain;base64,aA=', 'data:text/plain;base64,aB==',
  'data:text/plain\r\nX-Bad:yes;base64,aA==']) {
  test('malformed inline data is refused before any provider effect: ' + data.length, async () => {
    const f = fixture()
    await rejected(f, request([part('file', data)]))
    assert.equal(f.posts.length + f.gets.length + f.dnsCalls.length, 0)
  })
}

for (const dnsAnswer of [[], [{ address: '127.0.0.1', family: 4 }],
  [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
  [{ address: '::ffff:127.0.0.1', family: 6 }], [{ address: 'fe80::1', family: 6 }],
  [{ address: '8.8.8.8', family: 6 }], [{ address: 'not-an-ip', family: 4 }]]) {
  test('all DNS answers must be public, nonempty and correctly typed: ' + JSON.stringify(dnsAnswer), async () => {
    const f = fixture({ dnsAnswer })
    await rejected(f, request([part('file', PUBLIC)]))
    assert.equal(f.posts.length, 0)
    assert.equal(f.gets.length, 0)
  })
}

test('DNS failure is redacted and happens before auth, download and upload', async () => {
  const f = fixture({ dnsError: true })
  await rejected(f, request([part('image', PUBLIC)]))
  assert.equal(f.posts.length + f.gets.length, 0)
})

test('a later private DNS answer prevents downloading an earlier validated public source', async () => {
  const f = fixture({ onDns: hostname => [{
    address: hostname === 'files.example.com' ? '8.8.8.8' : '10.0.0.1', family: 4,
  }] })
  await rejected(f, request([part('file', PUBLIC), part('image', 'https://second.example.com/file')]))
  assert.equal(f.dnsCalls.length, 2)
  assert.equal(f.gets.length + f.posts.length, 0)
})

test('public HTTPS is downloaded with pinned socket lookup, no redirect/proxy/credential inheritance', async () => {
  const f = fixture({ beforeSocket: ({ setDns }) => setDns([{ address: '127.0.0.1', family: 4 }]) })
  const input = request([part('file', PUBLIC)]), before = copy(input)
  await f.adapter.chatCompletion(input)
  assert.deepEqual(input, before)
  assert.deepEqual(f.effects, ['dns', 'get', 'auth', 'upload', 'completion'])
  assert.equal(f.dnsCalls.length, 1, 'socket creation must not repeat DNS after validation')
  assert.equal(f.dnsCalls[0].options.all, true)
  assert.deepEqual(copy(f.pins), [{ address: [{ address: '8.8.8.8', family: 4 }] }])
  const get = f.gets[0]
  assert.equal(get.url, PUBLIC)
  assert.equal(get.config.proxy, false)
  assert.equal(get.config.maxRedirects, 0)
  assert.equal(get.config.responseType, 'arraybuffer')
  assert.ok(get.config.maxContentLength > 0 && get.config.maxContentLength <= LIMIT)
  assert.equal(get.config.validateStatus(200), true)
  for (const status of [201, 204, 206, 301, 302, 307, 308, 403]) assert.equal(get.config.validateStatus(status), false)
  assert.equal(get.config.headers?.Authorization, false)
  assert.equal(get.config.headers?.Cookie, false)
  assert.equal(get.config.headers?.['Proxy-Authorization'], false)
  assert.equal(get.config.httpsAgent.options.keepAlive, false)
  assert.equal(get.config.httpsAgent.options.rejectUnauthorized, true)
  assert.equal(f.agents.every(agent => agent.destroyed), true)
  await assert.rejects(lookupAtSocket(get.config.httpsAgent, 'changed.example.com'))
  await assert.rejects(lookupAtSocket(get.config.httpsAgent, 'files.example.com', { family: 6 }))
  assert.deepEqual(copy(await lookupAtSocket(get.config.httpsAgent, 'files.example.com', { family: 4 })),
    { address: '8.8.8.8', family: 4 })
  const uploads = f.posts.filter(p => p.url.endsWith('/file_upload'))
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].body.fields[0].data.toString(), 'downloaded bytes')
  assert.equal(uploads[0].config.maxRedirects, 0)
  assert.equal(JSON.stringify(f.posts.map(p => p.body)).includes(PRIVATE), false)
  assert.equal(JSON.stringify(f.logs).includes(PRIVATE), false)
})

test('public IP literals and IPv6 DNS records stay pinned without local/transition aliases', async () => {
  for (const url of ['https://8.8.8.8/file', 'https://[2606:4700:4700::1111]/file', PUBLIC]) {
    const f = fixture({ dnsAnswer: [{ address: '2606:4700:4700::1111', family: 6 }] })
    await f.adapter.chatCompletion(request([part('image', url)]))
    assert.equal(f.effects.includes('completion'), true)
    assert.equal(f.gets[0].config.maxRedirects, 0)
    assert.ok(f.pins[0], 'a public literal must still have a guarded agent')
    assert.equal(f.dnsCalls.length, url === PUBLIC ? 1 : 0)
    assert.equal(JSON.stringify(f.posts.map(p => p.body)).includes(url), false)
  }
})

test('the socket lookup honors IPv4/IPv6 family requests without another DNS query', async () => {
  const f = fixture({ dnsAnswer: [
    { address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 },
  ] })
  await f.adapter.chatCompletion(request([part('file', PUBLIC), part('image', PUBLIC)]))
  assert.equal(f.dnsCalls.length, 1)
  const agent = f.gets[0].config.httpsAgent
  assert.deepEqual(copy(await lookupAtSocket(agent, 'files.example.com', { family: 6 })),
    { address: '2606:4700:4700::1111', family: 6 })
  assert.deepEqual(copy(await lookupAtSocket(agent, 'files.example.com', { all: true, family: 4 })),
    { address: [{ address: '8.8.8.8', family: 4 }] })
  assert.equal(f.agents.length, 2)
  assert.notEqual(f.gets[0].config.httpsAgent, f.gets[1].config.httpsAgent)
})

for (const status of [201, 204, 206, 301, 302, 307, 308, 403, 500]) {
  test('download HTTP ' + status + ' cannot become an upload or text-only completion', async () => {
    const f = fixture({ getStatus: status })
    await rejected(f, request([part('image', PUBLIC)]))
    assert.equal(f.gets.length, 1)
    assert.equal(f.posts.length, 0)
    assert.equal(f.agents.every(agent => agent.destroyed), true)
  })
}

test('download exceptions destroy the guarded agent and propagate a fixed failure', async () => {
  const f = fixture({ getError: true })
  await rejected(f, request([part('file', PUBLIC)]))
  assert.equal(f.posts.length, 0)
  assert.equal(f.gets.length, 1)
  assert.equal(f.agents.length, 1)
  assert.equal(f.agents[0].destroyed, true)
})

test('oversized declared length, invalid bytes and unsafe MIME fail before auth', async () => {
  for (const options of [
    { getHeaders: { 'content-length': String(LIMIT + 1) } },
    { getHeaders: { 'content-length': '-1' } },
    { getHeaders: { 'content-type': 'text/plain\r\nX-Bad:' + PRIVATE } },
    { getData: Buffer.alloc(0) }, { getData: 'not an arraybuffer' },
  ]) {
    const f = fixture(options)
    await rejected(f, request([part('file', PUBLIC)]))
    assert.equal(f.posts.length, 0)
  }
})

test('actual oversized download and aggregate attachment bytes are bounded', async () => {
  const over = fixture({ getData: Buffer.alloc(LIMIT + 1) })
  await rejected(over, request([part('file', PUBLIC)]))
  assert.equal(over.posts.length, 0)
  const chunk = Buffer.alloc(60 * 1024 * 1024)
  const total = fixture({ getData: chunk })
  await rejected(total, request([part('file', PUBLIC), part('image', PUBLIC)]))
  assert.equal(total.posts.length, 0)
  assert.ok(total.gets[1].config.maxContentLength <= 40 * 1024 * 1024)
})

test('oversized encoded data is refused before decoding or any provider operation', async () => {
  const f = fixture()
  const data = 'data:application/octet-stream;base64,' + 'A'.repeat(4 * Math.ceil((LIMIT + 1) / 3))
  await rejected(f, request([part('file', data)]))
  assert.equal(f.posts.length + f.gets.length + f.dnsCalls.length, 0)
})

for (const options of [
  { uploadError: true }, { uploadStatus: 201 }, { uploadStatus: 302 }, { uploadStatus: 403 },
  { uploadResult: undefined }, { uploadResult: {} }, { uploadResult: [] },
  { uploadResult: { source_id: '' } }, { uploadResult: { source_id: 9 } },
  { uploadResult: { source_id: 'synthetic-source', file_url: {} } },
]) {
  test('upload failure or missing reference propagates instead of dropping the attachment: ' + JSON.stringify(options), async () => {
    const f = fixture(options)
    await rejected(f, request([part('file', INLINE)]))
    assert.deepEqual(f.effects, ['auth', 'upload'])
    assert.equal(f.gets.length, 0)
  })
}

for (const kind of ['file', 'image']) {
  test(kind + ' reference without file_url never falls back to sensitive input URL', async () => {
    const f = fixture()
    await f.adapter.chatCompletion(request([part(kind, PUBLIC)]))
    const completion = f.posts.find(p => p.url.endsWith('/assistant/stream'))
    assert.ok(completion)
    assert.equal(JSON.stringify(completion.body).includes(PRIVATE), false)
    assert.equal(JSON.stringify(completion.body).includes('files.example.com'), false)
    const reference = completion.body.messages[0].content[0]
    if (kind === 'file') {
      assert.equal(reference.file[0].source_id, 'synthetic-source')
      assert.equal(reference.file[0].file_url, undefined)
    } else assert.equal(reference.image_url.url, 'synthetic-source')
  })
}

test('valid inline files/images preserve exact bytes, text and returned provider references', async () => {
  const f = fixture({ uploadResult: { source_id: 'synthetic-source', file_url: 'https://cdn.example.com/returned' } })
  const input = request([part('file', INLINE), part('image', 'data:image/png;base64,iVBORw==')]), before = copy(input)
  await f.adapter.chatCompletion(input)
  assert.deepEqual(input, before)
  assert.deepEqual(f.effects, ['auth', 'upload', 'upload', 'completion'])
  assert.equal(f.gets.length + f.dnsCalls.length, 0)
  const uploads = f.posts.filter(p => p.url.endsWith('/file_upload'))
  assert.equal(uploads[0].body.fields[0].data.toString(), 'hello')
  assert.equal(uploads[1].body.fields[0].data.toString('hex'), '89504e47')
  assert.equal(uploads[0].body.fields[0].metadata.contentType, 'text/plain')
  assert.equal(uploads[1].body.fields[0].metadata.contentType, 'image/png')
  const wire = f.posts.at(-1).body.messages[0].content
  assert.equal(wire[0].file[0].file_url, 'https://cdn.example.com/returned')
  assert.equal(wire[1].image_url.url, 'https://cdn.example.com/returned')
  assert.equal(wire[2].text.trim(), 'before after')
})

test('supported data MIME parameters and the eight-attachment boundary preserve bytes', async () => {
  const f = fixture()
  const urls = [INLINE, 'DATA:text/plain;base64,aGVsbG8=',
    'data:text/plain;charset=utf-8;base64,aGVsbG8=', 'data:;base64,aGVsbG8=']
  await f.adapter.chatCompletion(request(Array.from({ length: 8 }, (_, i) => part(i % 2 ? 'image' : 'file', urls[i % 4]))))
  const uploads = f.posts.filter(p => p.url.endsWith('/file_upload'))
  assert.equal(uploads.length, 8)
  assert.equal(uploads.every(p => p.body.fields[0].data.toString() === 'hello'), true)
  assert.equal(f.gets.length + f.dnsCalls.length, 0)
})

test('actual GLM forwarder returns a failed operation in both modes without decoding or cleanup', async () => {
  const forwardSource = readFileSync(new URL('../../src/main/proxy/forwarder.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('forwarder.ts', forwardSource, ts.ScriptTarget.Latest, true)
  let method
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'forwardGLM') method = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(method)
  const code = ts.transpileModule('class ActualForwarder {' + method + '} exports.ActualForwarder=ActualForwarder',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  for (const stream of [false, true]) {
    const f = fixture(), mod = { exports: {} }
    vm.runInNewContext(code, {
      module: mod, exports: mod.exports, Date, Error,
      GLMAdapter: class { constructor() { return f.adapter } },
      GLMAttachmentInputFailure: f.InputFailure,
      GLMStreamHandler: class { constructor() { denied() } },
      shouldDeleteSession: () => true,
      hasCompletedNonStreamAnswer: denied, unconfirmedProviderCompletion: denied,
      console: { error: denied },
    }, { filename: 'actual-forwardGLM-local25.js', timeout: 1500 })
    const forwarder = new mod.exports.ActualForwarder()
    forwarder.transformRequestForPromptToolUse = input => ({ messages: input.messages, tools: undefined, plan: {} })
    forwarder.applyToolCallsToResponse = denied
    const result = await forwarder.forwardGLM({ ...request([part('file', 'https://127.0.0.1/file')]), stream },
      {}, { id: 'glm' }, 'synthetic-glm-model', Date.now())
    assert.equal(result.success, false)
    assert.equal(result.body, undefined)
    assert.equal(result.stream, undefined)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
    assert.equal(result.error.includes('127.0.0.1'), false)
    assert.equal(result.error.includes(PRIVATE), false)
    assert.equal(f.effects.length, 0)
    assert.equal(f.writes.length, 0)
  }
})

test('plain text remains one auth and one completion, with no attachment capabilities', async () => {
  const f = fixture()
  await f.adapter.chatCompletion({ model: 'synthetic-glm-model', messages: [{ role: 'user', content: 'plain text' }] })
  assert.deepEqual(f.effects, ['auth', 'completion'])
  assert.equal(f.gets.length + f.dnsCalls.length + f.agents.length, 0)
})
