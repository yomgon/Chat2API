import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Load the unmodified production opaque-token selector into a closed VM.
// Historical security fixtures still forbid all other surprise imports.
const raw = readFileSync(new URL('../../../src/main/providers/qwenAiToken.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(raw, { fileName: 'qwenAiToken.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const mod = { exports: {} }
runInNewContext(code, { module: mod, exports: mod.exports }, {
  filename: 'qwenAiToken-production-offline.ts', timeout: 1000,
  codeGeneration: { strings: false, wasm: false },
})
export const QWEN_AI_TOKEN_MODULE = Object.freeze(mod.exports)
