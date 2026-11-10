import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const filename = fileURLToPath(new URL('../../src/main/index.ts', import.meta.url))
const source = readFileSync(filename, 'utf8')

test('main bootstrap logs never stringify unhandled provider exceptions', () => {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  assert.equal(ast.parseDiagnostics.length, 0)
  const loggedMessages = []
  function scan(node) {
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'console') {
      assert.equal(node.arguments.length, 1,
        'bootstrap must not log exception objects or arbitrary additional args')
      assert.ok(ts.isStringLiteral(node.arguments[0]),
        'bootstrap log messages must be static literals')
      loggedMessages.push(node.arguments[0].text)
    }
    ts.forEachChild(node, scan)
  }
  scan(ast)
  for (const expected of [
    '[App] Uncaught exception (details redacted)',
    '[App] Unhandled rejection (details redacted)',
    '[App] Unable to load development content',
    '[App] Unable to load production content',
  ]) assert.ok(loggedMessages.includes(expected))
  assert.doesNotMatch(source, /console\.error\('Uncaught Exception:',\s*error\)/)
  assert.doesNotMatch(source, /console\.error\('Unhandled Rejection:',\s*reason\)/)
})
