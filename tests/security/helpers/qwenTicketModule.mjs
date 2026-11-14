import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Run the exact current pure production helper in an isolated VM. Keeping the
// import explicit means old offline tests still block every other new module,
// browser, provider connection or credential store effect.
const source = readFileSync(new URL('../../../src/main/providers/qwenTicket.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: 'qwenTicket.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const module = { exports: {} }
runInNewContext(compiled, { module, exports: module.exports },
  { filename: 'production-qwenTicket-offline.ts', timeout: 1000,
    codeGeneration: { strings: false, wasm: false } })
export const QWEN_TICKET_MODULE = Object.freeze(module.exports)
