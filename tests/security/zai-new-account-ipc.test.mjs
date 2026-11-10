import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const source = (p) => readFileSync(fileURLToPath(new URL('../../' + p, import.meta.url)), 'utf8')
const files = {
  channels: source('src/main/ipc/channels.ts'),
  handlers: source('src/main/ipc/handlers.ts'),
  preload: source('src/preload/index.ts'),
  dts: source('src/renderer/src/types/electron.d.ts'),
  providers: source('src/renderer/src/pages/Providers.tsx'),
}
const parse = (p, isTsx = false) => {
  const ast = ts.createSourceFile(p, files[p], ts.ScriptTarget.Latest, true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  assert.equal(ast.parseDiagnostics.length, 0, p + ' must parse')
  return ast
}

test('new Z.ai account creation has one narrow trusted typed IPC route', () => {
  parse('channels')
  parse('handlers')
  parse('preload')
  parse('dts')
  assert.match(files.channels, /OAUTH_CREATE_ZAI_ACCOUNT:\s*'oauth:createZaiAccount'/)
  const handler = files.handlers.match(
    /handleTrusted\(IpcChannels\.OAUTH_CREATE_ZAI_ACCOUNT,\s*async \(_, accountName: unknown\)[\s\S]*?\n  \}\)/,
  )?.[0]
  assert.ok(handler, 'exact trusted handler must exist')
  assert.match(handler, /typeof accountName !== 'string'/)
  assert.match(handler, /accountName\.trim\(\)\.length < 1/)
  assert.match(handler, /accountName\.trim\(\)\.length > 100/)
  assert.match(handler, /oauthManager\.createZaiAccount\(accountName\.trim\(\)\)/)
  assert.doesNotMatch(handler, /credentials\s*:|cookies\s*:|token\s*:|providerId\s*:/)
  assert.match(files.preload,
    /createZaiAccount:\s*\(accountName: string\)[\s\S]*?ipcRenderer\.invoke\(IpcChannels\.OAUTH_CREATE_ZAI_ACCOUNT, accountName\)/)
  assert.match(files.dts,
    /createZaiAccount:\s*\(accountName: string\) => Promise<\{ success: boolean; accountId\?: string; reason\?: string \}>/)
  const legacy = files.handlers.match(
    /handleTrusted\(IpcChannels\.OAUTH_START_IN_APP_LOGIN,[\s\S]*?\n  \}\)/,
  )?.[0]
  assert.ok(legacy)
  assert.match(legacy, /data\?\.providerId === 'zai' \|\| data\?\.providerType === 'zai'/)
  assert.match(legacy, /Use the protected Z\.ai account connection flow/)
})

test('provider UI refresh cannot turn a committed new account into a retryable error', () => {
  parse('providers', true)
  const handler = files.providers.match(
    /const handleCreateZaiAccount = async \(accountName: string\)[\s\S]*?\n  \}\r?\n/,
  )?.[0]
  assert.ok(handler)
  assert.match(handler, /selectedProviderId !== 'zai'/)
  assert.match(handler, /window\.electronAPI\.oauth\.createZaiAccount\(accountName\)/)
  assert.match(handler, /if \(result\.success && result\.accountId\)/)
  assert.match(handler, /try \{[\s\S]*?window\.electronAPI\.accounts\.getAll\(\)/)
  assert.match(handler, /void \(async \(\) => \{[\s\S]*?await window\.electronAPI\.accounts\.getAll\(\)[\s\S]*?\}\)\(\)/)
  assert.match(handler, /\}\)\(\)\s*toast\(/)
  assert.match(handler, /return result/)
  assert.doesNotMatch(handler, /credentials\s*:|token\s*:|cookies\s*:|accessToken/)
  assert.match(files.providers, /onCreateZaiAccount=\{handleCreateZaiAccount\}/)
})
