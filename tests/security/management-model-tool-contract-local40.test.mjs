import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const read = relative => readFileSync(new URL('../../src/main/proxy/' + relative, import.meta.url), 'utf8')
function load(relative, deps) {
  const module = { exports: {} }
  const code = ts.transpileModule(read(relative), { fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  runInNewContext(code, {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    require(name) { if (Object.hasOwn(deps, name)) return deps[name]; return requireNode(name) },
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
  }, { filename: relative, timeout: 2000 })
  return module.exports
}

const SECRET = 'SYNTHETIC_MANAGEMENT_MODEL_TOOL_LOCAL40'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

async function fixture() {
  let mappings = {}
  let latestSmokeResult = { success: false, category: 'not_run', message: 'No smoke test has been run.',
    clientAdapterId: 'standard-openai-tools', timestamp: 0 }
  const effects = { writes: 0, fixtures: 0, smokeWrites: 0 }
  const storeManager = { getConfig: () => ({ managementApi: { enableManagementApi: true, managementApiSecret: SECRET } }) }
  const ConfigManager = {
    getModelMappings: () => clone(mappings), getModelMapping: model => clone(mappings[model]),
    setModelMapping: mapping => { effects.writes++; mappings = { ...mappings, [mapping.requestModel]: clone(mapping) } },
    removeModelMapping: model => { if (!Object.hasOwn(mappings, model)) return false; effects.writes++; const next = { ...mappings }; delete next[model]; mappings = next; return true },
    get: () => ({ toolCallingConfig: { enabled: true, mode: 'auto', clientAdapterId: 'standard-openai-tools', diagnosticsEnabled: false, advanced: { promptPreviewEnabled: false } } }),
  }
  const diagnostics = {
    buildSmokeFixture: clientAdapterId => { effects.fixtures++; return { model: 'tool-smoke-test', clientAdapterId } },
    getLatestToolCallingSmokeResult: () => clone(latestSmokeResult),
    setLatestToolCallingSmokeResult: result => { effects.smokeWrites++; latestSmokeResult = clone(result); return clone(latestSmokeResult) },
  }
  const auth = load('middleware/managementAuth.ts', { '../../store/store': { storeManager } }).managementAuthMiddleware
  const mappingsRouter = load('routes/management/modelMappings.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const toolRouter = load('routes/management/toolCalling.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager }, '../../toolCalling/diagnostics': diagnostics,
  }).default
  const Koa = requireNode('koa'); const app = new Koa(); app.use(requireNode('koa-bodyparser')())
  app.use(mappingsRouter.routes()); app.use(mappingsRouter.allowedMethods())
  app.use(toolRouter.routes()); app.use(toolRouter.allowedMethods())
  const server = createServer(app.callback()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` }; if (authorized) headers.Authorization = `Bearer ${SECRET}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let json
        try { json = raw ? JSON.parse(raw) : undefined } catch { json = undefined }
        resolve({ status: res.statusCode, raw, json })
      })
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  return { request, effects, mappings: () => clone(mappings), latest: () => clone(latestSmokeResult),
    close: () => new Promise(resolve => server.close(resolve)) }
}

test('management auth blocks model/tool reads and mutations before local effects', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.request('/v0/management/model-mappings', { authorized: false })).status, 401)
  assert.equal((await f.request('/v0/management/tool-calling/smoke', { method: 'POST', body: {}, authorized: false })).status, 401)
  assert.deepEqual(f.effects, { writes: 0, fixtures: 0, smokeWrites: 0 })
})

for (const body of [
  { requestModel: 'display', actualModel: 'wire', preferredProviderId: '' },
  { requestModel: 'display', actualModel: 'wire', preferredAccountId: '' },
  { requestModel: 'display', actualModel: 'wire', preferredProviderId: '   ' },
]) {
  test('model mapping refuses empty explicit pin before write: ' + JSON.stringify(body), async t => {
    const f = await fixture(); t.after(f.close)
    const response = await f.request('/v0/management/model-mappings', { method: 'POST', body })
    assert.equal(response.status, 400); assert.equal(response.json.error.code, 'invalid_request')
    assert.equal(f.effects.writes, 0); assert.deepEqual(f.mappings(), {})
  })
}

test('model mapping update refuses an empty pin without mutating the existing mapping', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.request('/v0/management/model-mappings', { method: 'POST', body: {
    requestModel: 'display', actualModel: 'wire', preferredProviderId: 'p1', preferredAccountId: 'a1',
  } })).status, 201)
  const writes = f.effects.writes
  const response = await f.request('/v0/management/model-mappings/display', { method: 'PUT', body: { preferredAccountId: '' } })
  assert.equal(response.status, 400); assert.equal(f.effects.writes, writes)
  assert.equal(f.mappings().display.preferredAccountId, 'a1')
})

for (const [label, body] of [
  ['array body', []],
  ['unknown adapter', { clientAdapterId: 'unsupported-local40-adapter' }],
  ['non-string adapter', { clientAdapterId: { id: 'standard-openai-tools' } }],
]) {
  test('tool smoke refuses ' + label + ' without generating fixture or changing status', async t => {
    const f = await fixture(); t.after(f.close); const before = f.latest()
    const response = await f.request('/v0/management/tool-calling/smoke', { method: 'POST', body })
    assert.equal(response.status, 400); assert.equal(response.json.error.code, 'invalid_request')
    assert.equal(f.effects.fixtures, 0); assert.equal(f.effects.smokeWrites, 0); assert.deepEqual(f.latest(), before)
  })
}

test('valid tool smoke remains stable and status returns the recorded supported adapter', async t => {
  const f = await fixture(); t.after(f.close)
  const smoke = await f.request('/v0/management/tool-calling/smoke', { method: 'POST', body: { clientAdapterId: 'cherry-studio-mcp' } })
  assert.equal(smoke.status, 200); assert.equal(smoke.json.data.result.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(f.effects.fixtures, 1); assert.equal(f.effects.smokeWrites, 1)
  const status = await f.request('/v0/management/tool-calling/status')
  assert.equal(status.status, 200); assert.equal(status.json.data.latestSmokeResult.clientAdapterId, 'cherry-studio-mcp')
})
