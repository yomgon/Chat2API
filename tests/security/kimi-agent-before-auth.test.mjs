import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// The production ChatService/Chat implementation is exercised only up to the
// first authorization operation. A stub throws if any request would continue.
const load = name => readFileSync(new URL('../../src/main/proxy/adapters/' + name, import.meta.url), 'utf8')
const apiAst = ts.createSourceFile('kimi.ts', load('kimi.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const scenarioAst = ts.createSourceFile('options.ts', load('providerModelOptions.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

let sourceMethod
let sourceResolver
const walk = (node, predicate, onFound) => {
  if (predicate(node)) onFound(node)
  ts.forEachChild(node, child => walk(child, predicate, onFound))
}
walk(apiAst, node => ts.isMethodDeclaration(node) && node.name.getText(apiAst) === 'chatCompletion',
  node => { sourceMethod = node.getText(apiAst) })
walk(scenarioAst, node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveKimiScenario',
  node => { sourceResolver = node.getText(scenarioAst) })
assert.ok(sourceMethod && sourceResolver)
assert.match(sourceMethod, /resolveKimiScenario\(request\.model\)[\s\S]*this\.acquireToken\(\)/)

const code = ts.transpileModule(`${sourceResolver}\nclass IsolatedKimiAdapter { ${sourceMethod} }\nglobalThis.Kimi = IsolatedKimiAdapter;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function makeHarness() {
  const logs = []
  const context = {
    exports: {},
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  }
  vm.runInNewContext(code, context, { timeout: 2000 })
  const adapter = new context.Kimi()
  let authAttempts = 0
  adapter.acquireToken = async () => {
    authAttempts++
    throw new Error('Offline test: outgoing provider requests forbidden')
  }
  return { adapter, get authAttempts() { return authAttempts }, logs }
}

test('Explicit Kimi agent IDs are rejected BEFORE token refresh or network preparation', async () => {
  for (const model of ['k3-agent', 'k28-agent-preview', ' K3-AGENT ']) {
    const h = makeHarness()
    await assert.rejects(h.adapter.chatCompletion({ model, messages: [] }),
      error => error?.message === 'Kimi agent models are not supported by the chat adapter.')
    assert.equal(h.authAttempts, 0)
    assert.deepEqual(h.logs, [])
  }
})

test('Ordinary Kimi chat models still pass the model gate to the existing authorization path', async () => {
  for (const model of ['Kimi-K2.6', 'k2d6-chat']) {
    const h = makeHarness()
    await assert.rejects(h.adapter.chatCompletion({ model, messages: [] }),
      /Offline test: outgoing provider requests forbidden/)
    assert.equal(h.authAttempts, 1)
    assert.deepEqual(h.logs, [])
  }
})
