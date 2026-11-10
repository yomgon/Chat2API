import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Isolated source/runtime checks: no Electron startup, browser, real credentials,
// network, account store or provider requests.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const dialogPath = path.join(repo, 'src/renderer/src/components/providers/AddProviderDialog.tsx')
const dialogSource = readFileSync(dialogPath, 'utf8')
const secret = 'SYNTHETIC_CREDENTIAL_DO_NOT_LOG_987654321'
const errorSecret = 'SYNTHETIC_ERROR_DO_NOT_LOG_123456789'

function sourceFile(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function violations(file, source) {
  const ast = sourceFile(file, source)
  const problems = ast.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  const methods = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace', 'dir', 'table'])
  const line = node => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === 'console') {
      const parent = node.parent
      const isDirectCall = ts.isPropertyAccessExpression(parent)
        && parent.expression === node
        && ts.isCallExpression(parent.parent)
        && parent.parent.expression === parent
        && methods.has(parent.name.text)
      if (!isDirectCall) problems.push(`${line(node)}: Indirect console access needs a privacy review`)
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'console'
      && methods.has(node.expression.name.text)) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        problems.push(`${line(node)}: Console received a dynamic value or raw error object`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return problems
}

function allRendererSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return allRendererSources(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

function extractedDeclaration(name) {
  const ast = sourceFile(dialogPath, dialogSource)
  let value
  const visit = node => {
    if (name === 'mapOAuthCredentials' && ts.isFunctionDeclaration(node) && node.name?.text === name) {
      value = node.getText(ast)
    }
    if (name !== 'mapOAuthCredentials' && ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name) && node.name.text === name) {
      value = `const ${name} = ${node.initializer.getText(ast)}`
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(value, `The real ${name} declaration must remain present`)
  return value
}

function loadDialogLogic({ reply, required = [{ name: 'token', required: true }] } = {}) {
  const calls = []
  const logs = []
  const console = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(level => [level,
    (...args) => logs.push({ level, args })]))
  const state = {}
  const setters = {
    setIsOAuthLoading: v => { state.loading = v },
    setOAuthStatus: v => { state.status = v },
    setCredentials: v => { state.credentials = v },
    setValidationResult: v => { state.validation = v },
  }
  const context = {
    ...setters,
    Error,
    console,
    selectedProviderData: { id: 'deepseek', credentialFields: required },
    // The extracted generic OAuth closure represents DeepSeek only. Z.ai is
    // tested through the separate protected provider/account UI fixture.
    isProtectedZaiSelection: false,
    handleOpenProtectedZaiAccounts: () => assert.fail('Generic OAuth fixture must not invoke protected Z.ai routing'),
    t: key => key,
    window: { electronAPI: { oauth: { startInAppLogin: async (...args) => {
      calls.push(args)
      if (reply instanceof Error) throw reply
      return reply
    } } } },
  }
  const tsCode = `${extractedDeclaration('mapOAuthCredentials')}\n${extractedDeclaration('handleOpenOAuthBrowser')}`
  const js = ts.transpileModule(tsCode, { compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  } }).outputText
  vm.runInNewContext(`${js}\nglobalThis.mapping = mapOAuthCredentials; globalThis.login = handleOpenOAuthBrowser;`, context, {
    filename: 'offline-renderer-provider-logic.js', timeout: 2000,
  })
  return { context, state, calls, logs }
}

function assertSafeLogs(logs) {
  for (const { args } of logs) {
    assert.equal(args.length, 1, 'No secret-bearing second console argument')
    assert.equal(typeof args[0], 'string', 'No object/Error logged to console')
    assert.ok(!args[0].includes(secret))
    assert.ok(!args[0].includes(errorSecret))
  }
}

test('All renderer diagnostics and main IPC console calls are fixed literal only', () => {
  const files = allRendererSources(path.join(repo, 'src/renderer/src'))
  files.push(path.join(repo, 'src/main/ipc/handlers.ts'))
  assert.ok(files.length >= 90, 'Ensure the entire renderer was scanned')
  for (const file of files) {
    assert.deepEqual(violations(file, readFileSync(file, 'utf8')), [], file)
  }
})

test('Diagnostic rule rejects dynamically supplied secrets, errors and aliases', () => {
  const unsafe = `console.error('oauth failed', new Error(secret));
    console.log(JSON.stringify(credentials)); console.warn({ token: secret });
    const log = console; log.error(secret)`
  assert.ok(violations('negative.ts', unsafe).length >= 4)
  assert.deepEqual(violations('safe.ts', "console.error('OAuth failed'); console.info('Credential mapping completed')"), [])
})

test('Real mapping preserves DeepSeek, Perplexity, MiMo and passthrough values without logging them', () => {
  const { context, logs } = loadDialogLogic({ reply: null })
  const plain = v => JSON.parse(JSON.stringify(v))
  const wrapped = `{ "value": "${secret}" }`
  assert.deepEqual(plain(context.mapping('deepseek', { userToken: wrapped })), { token: secret })
  assert.deepEqual(plain(context.mapping('deepseek', { userToken: secret })), { token: secret })
  const malformed = '{not-json}'
  assert.deepEqual(plain(context.mapping('deepseek', { userToken: malformed })), { token: malformed })
  assert.deepEqual(plain(context.mapping('perplexity', { '__Secure-next-auth.session-token': secret })), { sessionToken: secret })
  assert.deepEqual(plain(context.mapping('perplexity', { 'next-auth.session-token': secret })), { sessionToken: secret })
  assert.deepEqual(plain(context.mapping('mimo', { serviceToken: secret, userId: secret, xiaomichatbot_ph: secret })),
    { service_token: secret, user_id: secret, ph_token: secret })
  assert.deepEqual(plain(context.mapping('glm', { chatglm_refresh_token: secret })), { refresh_token: secret })
  assert.deepEqual(plain(context.mapping(undefined, { token: secret })), { token: secret })
  assertSafeLogs(logs)
})

test('Real OAuth handler maps a synthetic success without logging response or tokens', async () => {
  const { context, state, calls, logs } = loadDialogLogic({ reply: {
    success: true, credentials: { userToken: `{ "value": "${secret}" }` },
    accountInfo: { name: secret },
  } })
  await context.login()
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0]], ['deepseek', 'deepseek'])
  assert.equal(state.credentials.token, secret)
  assert.equal(state.validation.valid, true)
  assert.equal(state.loading, false)
  assert.equal(state.status, 'providers.loginSuccess')
  assertSafeLogs(logs)
})

test('Real OAuth handler preserves failure UX but never logs raw upstream errors', async () => {
  const fromReply = loadDialogLogic({ reply: { success: false, error: `Guest account ${errorSecret}` } })
  await fromReply.context.login()
  assert.equal(fromReply.state.status, 'providers.guestAccountNotAllowed')
  assertSafeLogs(fromReply.logs)

  const thrown = loadDialogLogic({ reply: Object.assign(new Error(errorSecret), {
    response: { data: { access_token: secret } },
  }) })
  await thrown.context.login()
  assert.equal(thrown.state.loading, false)
  assert.equal(thrown.state.status, errorSecret) // Existing user-facing error flow is unchanged.
  assertSafeLogs(thrown.logs)

  const missing = loadDialogLogic({ reply: { success: true, credentials: { ignored: secret } } })
  await missing.context.login()
  assertSafeLogs(missing.logs)
  assert.equal(missing.logs.some(x => x.level === 'warn'), true)
})
