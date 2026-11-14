import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Offline synthetic execution of the REAL GET / handler. No Koa listener,
// Electron startup, accounts, credentials or network is involved.
const root = new URL('../../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version
const source = readFileSync(new URL('src/main/proxy/server.ts', root), 'utf8')
const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
let callback
const visit = node => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.getText(tree) === 'this.router.get' &&
    node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === '/') {
    callback = node.arguments[1].getText(tree)
  }
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(callback, 'real GET / router handler must exist')

const compiled = ts.transpileModule('module.exports = ' + callback, {
  fileName: 'root-handler.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

test('the existing API root describes the exact running app version, not a stale embedded version', async () => {
  const module = { exports: {} }
  const electronApp = { getVersion: () => version }
  vm.runInNewContext(compiled, { module, exports: module.exports, electronApp },
    { filename: 'synthetic-root-handler.cjs', timeout: 1500 })
  const ctx = {}
  await module.exports(ctx)
  assert.equal(ctx.body.name, 'Chat2API Proxy')
  assert.equal(ctx.body.version, version)
  assert.deepEqual(Array.from(ctx.body.endpoints), [
    'POST /v1/chat/completions',
    'GET /v1/models',
    'GET /v1/models/:model',
    'POST /v1/completions',
  ])
})
