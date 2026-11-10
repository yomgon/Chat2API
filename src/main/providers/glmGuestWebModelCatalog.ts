import type { ProviderModelCatalog } from './modelCatalog'

const INVALID = 'GLM public guest website model catalog is invalid or unsupported.'
const MAX_MODELS = 100
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])

function fail(): never {
  throw new Error(INVALID)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail()
  for (const key of RESERVED) {
    if (Object.getOwnPropertyDescriptor(value, key)) fail()
  }
  return value as Record<string, unknown>
}

function own(value: object, key: string): unknown {
  const prop = Object.getOwnPropertyDescriptor(value, key)
  if (!prop || !prop.enumerable || !('value' in prop)) fail()
  return prop.value
}

/**
 * Observed on the official 2026-11-08 chatglm.cn first-party Vuex action
 * Home/GetAvailableModels.  Its successful result contains:
 * { default: { guest: 'glm-5.3-flash', ... },
 *   models: [{ display_name:'GLM-5.3', selected_model:'glm-5.3',
 *              chat_switch:true, am_switch:true, ... }, ...] }
 *
 * This is a public GUEST website picker, not user account entitlements.
 * selected_model is the exact WEBSITE selection ID, not a verified
 * Chat2API assistant_id or a successful /v1/chat/completions call.
 */
export function parseGLMGuestWebModelCatalog(payload: unknown): ProviderModelCatalog {
  try {
    const root = record(payload)
    if (own(root, 'status') !== 0) fail()
    const result = record(own(root, 'result'))
    record(own(result, 'default'))
    const entries = own(result, 'models')
    if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) fail()
    const n = Object.getOwnPropertyDescriptor(entries, 'length')?.value
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_MODELS || Reflect.ownKeys(entries).length !== n + 1) fail()

    const supportedModels: string[] = []
    const bindings: Array<[string, string]> = []
    const seenNames = new Set<string>()
    const seenIds = new Set<string>()
    for (let i = 0; i < n; i++) {
      const model = record(own(entries, String(i)))
      const rawName = own(model, 'display_name')
      const rawId = own(model, 'selected_model')
      const chatSwitch = own(model, 'chat_switch')
      if (typeof rawName !== 'string' || rawName.length > 160 || UNSAFE_TEXT.test(rawName)) fail()
      const name = rawName.trim()
      if (!name || RESERVED.has(name.toLowerCase())) fail()
      if (typeof rawId !== 'string' || !SAFE_MODEL_ID.test(rawId) || RESERVED.has(rawId.toLowerCase())) fail()
      if (typeof chatSwitch !== 'boolean') fail()
      if (!chatSwitch) continue
      if (seenNames.has(name) || seenIds.has(rawId) ||
          (seenNames.has(rawId) && name !== rawId) ||
          (seenIds.has(name) && name !== rawId)) fail()
      seenNames.add(name)
      seenIds.add(rawId)
      supportedModels.push(name)
      bindings.push([name, rawId])
    }
    if (supportedModels.length === 0) fail()
    return { supportedModels, modelMappings: Object.fromEntries(bindings) }
  } catch {
    // No raw remote payloads, stack traces, or account information escape.
    throw new Error(INVALID)
  }
}
