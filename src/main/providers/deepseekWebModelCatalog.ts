import type { ProviderModelCatalog } from './modelCatalog'

const ERROR_MESSAGE = 'DeepSeek web model settings are invalid or unsupported.'
const MAX_MODELS = 100
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
const ALLOWED_WIRE_MODES = new Set(['default', 'expert'])

function reject(): never {
  throw new Error(ERROR_MESSAGE)
}

function record(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) reject()
  for (const key of RESERVED) {
    if (Object.getOwnPropertyDescriptor(value, key)) reject()
  }
  return value
}

function own(obj: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key)
  if (!d || !d.enumerable || !Object.prototype.hasOwnProperty.call(d, 'value')) reject()
  return d.value
}

function label(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 ||
    value.trim() !== value || HIDDEN_CHARACTERS.test(value) || RESERVED.has(value.toLowerCase())) reject()
  return value
}

/**
 * The DeepSeek WEBSITE exposes model_type choices (default/expert/vision),
 * not names of deployable DeepSeek-V4 developer API models. Only currently
 * enabled chat choices are used. The chat adapter actually sends these same
 * default/expert values, so do not invent marketing-version wire IDs.
 *
 * A success means public web settings discovery, not account entitlement or
 * successful inference. Unknown modes (including vision) are not routed.
 */
export function parseDeepSeekWebModelCatalog(payload: unknown): ProviderModelCatalog {
  try {
    const root = record(payload)
    if (own(root, 'code') !== 0) reject()
    const data = record(own(root, 'data'))
    if (own(data, 'biz_code') !== 0) reject()
    const business = record(own(data, 'biz_data'))
    const settings = record(own(business, 'settings'))
    const configuration = record(own(settings, 'model_configs'))
    const values = own(configuration, 'value')
    if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) reject()
    const length = Object.getOwnPropertyDescriptor(values, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MODELS ||
      Reflect.ownKeys(values).length !== length + 1) reject()

    const names: string[] = []
    const pairs: Array<[string, string]> = []
    const seenNames = new Set<string>()
    const seenWireModes = new Set<string>()
    for (let i = 0; i < length; i++) {
      const entry = record(own(values, String(i)))
      const modelType = label(own(entry, 'model_type'))
      const name = label(own(entry, 'name'))
      const enabled = own(entry, 'enabled')
      const switchable = own(entry, 'switchable')
      if (typeof enabled !== 'boolean' || typeof switchable !== 'boolean') reject()
      if (enabled && switchable && ALLOWED_WIRE_MODES.has(modelType)) {
        if (seenNames.has(name) || seenWireModes.has(modelType)) reject()
        seenNames.add(name)
        seenWireModes.add(modelType)
        names.push(name)
        pairs.push([name, modelType])
      }
    }
    if (!names.length) reject()
    return { supportedModels: names, modelMappings: Object.fromEntries(pairs) }
  } catch {
    // The server could include arbitrary private metadata or error content.
    // Never echo, serialize, log, or attach it as a cause.
    throw new Error(ERROR_MESSAGE)
  }
}
