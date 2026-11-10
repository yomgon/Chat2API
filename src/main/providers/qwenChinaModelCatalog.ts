import type { ProviderModelCatalog } from './modelCatalog'

const ERROR_MESSAGE = 'Qwen China website model catalog is invalid or unsupported.'
const MAX_MODELS = 200
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

function invalid(): never {
  throw new Error(ERROR_MESSAGE)
}

function record(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid()
  for (const key of RESERVED) {
    if (Object.getOwnPropertyDescriptor(value, key)) invalid()
  }
  return value
}

function own(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid()
  return descriptor.value
}

function readModelName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160 || UNSAFE_TEXT.test(value)) invalid()
  // The live site currently returns "Qwen-快速 " with a trailing space.
  // Trim only UI labels; never normalize/invent a wire-level modelCode.
  const name = value.trim()
  if (!name || RESERVED.has(name.toLowerCase())) invalid()
  return name
}

function readWireCode(value: unknown): string {
  if (typeof value !== 'string' || !VALID_ID.test(value) || RESERVED.has(value.toLowerCase())) invalid()
  return value
}

/**
 * Actual 2026 consumer Qwen China web API:
 * GET https://chat2-api.qianwen.com/api/v1/model/list?<web common params>
 * -> {code:0, success:true, data:[{displayModelName, modelCode, show,...}]}
 *
 * modelCode, not legacyModelCode or marketing name, is the chat wire ID.
 * A web listing is not a confirmed inference result or account entitlement.
 */
export function parseQwenChinaWebModelCatalog(payload: unknown): ProviderModelCatalog {
  try {
    const root = record(payload)
    if (own(root, 'code') !== 0 || own(root, 'success') !== true) invalid()
    const entries = own(root, 'data')
    if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) invalid()
    const n = Object.getOwnPropertyDescriptor(entries, 'length')?.value
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_MODELS || Reflect.ownKeys(entries).length !== n + 1) invalid()

    const supportedModels: string[] = []
    const bindings: Array<[string, string]> = []
    const names = new Set<string>()
    const codes = new Set<string>()
    for (let i = 0; i < n; i++) {
      const model = record(own(entries, String(i)))
      const name = readModelName(own(model, 'displayModelName'))
      const code = readWireCode(own(model, 'modelCode'))
      const visible = own(model, 'show')
      if (typeof visible !== 'boolean') invalid()
      if (!visible) continue
      if (names.has(name) || codes.has(code) ||
        (codes.has(name) && name !== code) || (names.has(code) && name !== code)) invalid()
      names.add(name)
      codes.add(code)
      supportedModels.push(name)
      bindings.push([name, code])
    }
    if (!supportedModels.length) invalid()
    return { supportedModels, modelMappings: Object.fromEntries(bindings) }
  } catch {
    // No raw response, exception cause, server message or credentials escape.
    throw new Error(ERROR_MESSAGE)
  }
}
