import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireNode = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const compile = path => ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
  fileName: path,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
function load(path, deps) {
  const module = { exports: {} }
  runInNewContext(compile(path), {
    module, exports: module.exports, Buffer, Date, Math, JSON, Error,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    require(name) { if (Object.hasOwn(deps, name)) return deps[name]; return requireNode(name) },
  }, { filename: path, timeout: 2000 })
  return module.exports
}

const SECRET = 'SYNTHETIC_MANAGEMENT_MODEL_LOCAL44'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

async function fixture({ failWrites = false } = {}) {
  let config = {
    managementApi: { enableManagementApi: true, managementApiSecret: SECRET },
    modelMappings: {
      stable: { requestModel: 'stable', actualModel: 'wire-stable', preferredProviderId: 'p1', preferredAccountId: 'a1' },
    },
  }
  const effects = { writes: 0, logs: 0 }
  const storeManager = {
    getConfig: () => clone(config),
    updateConfig: updates => {
      effects.writes++
      if (failWrites) throw Error('SYNTHETIC_MODEL_MAPPING_WRITE_REFUSAL')
      config = { ...config, ...clone(updates) }
      return clone(config)
    },
    addLog: () => { effects.logs++ },
  }
  const ConfigManager = load('src/main/store/config.ts', {
    './store': { storeManager }, './configSecrets': { redactExportConfigSecrets: x => x },
    './types': { DEFAULT_CONFIG: clone(config) }, '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
  }).default
  const auth = load('src/main/proxy/middleware/managementAuth.ts', { '../../store/store': { storeManager } }).managementAuthMiddleware
  const router = load('src/main/proxy/routes/management/modelMappings.ts', {
    '@koa/router': requireNode('@koa/router'), '../../middleware/managementAuth': { managementAuthMiddleware: auth },
    '../../../store/config': { __esModule: true, default: ConfigManager },
  }).default
  const Koa = requireNode('koa'); const app = new Koa(); app.use(requireNode('koa-bodyparser')())
  app.use(router.routes()); app.use(router.allowedMethods())
  const server = createServer(app.callback()); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const request = (path, { method = 'GET', body, authorized = true } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` }; if (authorized) headers.Authorization = `Bearer ${SECRET}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let json; try { json = raw ? JSON.parse(raw) : undefined } catch {}
        resolve({ status: res.statusCode, raw, json })
      })
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
  })
  return { request, effects, state: () => clone(config), close: () => new Promise(resolve => server.close(resolve)) }
}

test('inherited object names are not treated as pre-existing or deletable model mappings', async t => {
  const f = await fixture(); t.after(f.close)
  const created = await f.request('/v0/management/model-mappings', { method: 'POST', body: {
    requestModel: 'constructor', actualModel: 'wire-constructor', preferredProviderId: 'p2', preferredAccountId: 'a2',
  } })
  assert.equal(created.status, 201)
  assert.equal(Object.hasOwn(f.state().modelMappings, 'constructor'), true)
  assert.equal(f.state().modelMappings.constructor.actualModel, 'wire-constructor')

  const beforeWrites = f.effects.writes
  const missing = await f.request('/v0/management/model-mappings/toString', { method: 'DELETE' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'mapping_not_found')
  assert.equal(f.effects.writes, beforeWrites)
})

test('create update and delete write refusal never report success or mutate persisted mappings', async t => {
  const f = await fixture({ failWrites: true }); t.after(f.close); const before = f.state()
  const create = await f.request('/v0/management/model-mappings', { method: 'POST', body: { requestModel: 'new', actualModel: 'wire-new' } })
  assert.equal(create.status, 500); assert.deepEqual(f.state(), before)
  const update = await f.request('/v0/management/model-mappings/stable', { method: 'PUT', body: { actualModel: 'wire-updated' } })
  assert.equal(update.status, 500); assert.deepEqual(f.state(), before)
  const del = await f.request('/v0/management/model-mappings/stable', { method: 'DELETE' })
  assert.equal(del.status, 500); assert.deepEqual(f.state(), before)
  assert.equal(f.effects.logs, 0)
})

test('sequential mapping mutations preserve unrelated mappings and pins', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.request('/v0/management/model-mappings', { method: 'POST', body: {
    requestModel: 'second', actualModel: 'wire-second', preferredProviderId: 'p2', preferredAccountId: 'a2',
  } })).status, 201)
  assert.equal((await f.request('/v0/management/model-mappings/stable', { method: 'PUT', body: { actualModel: 'wire-stable-v2' } })).status, 200)
  assert.equal(f.state().modelMappings.stable.preferredProviderId, 'p1')
  assert.equal(f.state().modelMappings.second.preferredAccountId, 'a2')
  assert.equal((await f.request('/v0/management/model-mappings/second', { method: 'DELETE' })).status, 200)
  assert.equal(f.state().modelMappings.stable.actualModel, 'wire-stable-v2')
  assert.equal(Object.hasOwn(f.state().modelMappings, 'second'), false)
})
