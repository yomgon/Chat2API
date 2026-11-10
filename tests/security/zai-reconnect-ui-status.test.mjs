import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const providersFile = fileURLToPath(new URL('../../src/renderer/src/pages/Providers.tsx', import.meta.url))
const accountsFile = fileURLToPath(new URL('../../src/renderer/src/components/providers/AccountList.tsx', import.meta.url))
const page = readFileSync(providersFile, 'utf8')
const list = readFileSync(accountsFile, 'utf8')

test('Z.ai reconnect page and AccountList still parse after adding the progress status', () => {
  for (const [source, filename] of [[page, providersFile], [list, accountsFile]]) {
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    assert.deepEqual(ast.parseDiagnostics, [])
  }
})

test('renderer progress is a literal allowlist, not arbitrary provider text or credential material', () => {
  const ast = ts.createSourceFile(providersFile, page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let progress = null
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'safeProgress') {
      progress = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(progress && ts.isObjectLiteralExpression(progress), 'fixed progress table required')
  assert.ok(progress.properties.length >= 4)
  for (const property of progress.properties) {
    assert.ok(ts.isPropertyAssignment(property), 'no computed progress entries')
    assert.ok(ts.isStringLiteral(property.name), 'progress source names must be fixed')
    assert.ok(ts.isStringLiteral(property.initializer), 'progress output must be fixed')
    assert.doesNotMatch(property.initializer.text, /(?:token|cookie|authorization|bearer|secret)=/i)
  }
  assert.match(page, /Object\.prototype\.hasOwnProperty\.call\(safeProgress, message\)/)
  assert.match(page, /finally\s*\{\s*unsubscribe\(\)/)
  assert.doesNotMatch(page.match(/const handleReconnectZaiAccount[\s\S]*?const handleValidateToken/)?.[0] || '',
    /credentials\s*:\s*|accounts\.getById\([^,]+,\s*true\)/)
})

test('only the Z.ai existing-account reconnection displays the bounded status', () => {
  assert.match(list, /\{reconnectingId && reconnectProgress && \(/)
  assert.match(list, /<span className="mt-3 block" role="status">\{reconnectProgress\}<\/span>/)
  assert.match(list, /\{providerId === 'zai' && \(/)
  assert.match(list, /onReconnectZaiAccount\(account\.id\)/)
  assert.match(page, /onReconnectZaiAccount=\{handleReconnectZaiAccount\}/)
  assert.match(page, /reconnectProgress=\{zaiReconnectProgress\}/)
})
