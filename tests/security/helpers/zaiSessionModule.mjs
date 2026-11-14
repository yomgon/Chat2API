import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import crypto from 'node:crypto'
import ts from 'typescript'

// The exact current JWT identity parser; no signature claim or server effect.
const raw = readFileSync(new URL('../../../src/main/oauth/zaiSession.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(raw, { fileName: 'zaiSession.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    esModuleInterop: true },
}).outputText
const mod = { exports: {} }
runInNewContext(code, {
  module: mod, exports: mod.exports, Buffer, URL, Date,
  require(name) {
    if (name === 'crypto' || name === 'node:crypto') return crypto
    throw Error('Unexpected JWT helper dependency: ' + name)
  },
}, { filename: 'zaiSession-production-offline.ts', timeout: 1000,
  codeGeneration: { strings: false, wasm: false },
})
export const ZAI_SESSION_MODULE = Object.freeze(mod.exports)
