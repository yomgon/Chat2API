export interface ProviderModelCatalog {
  supportedModels: string[]
  modelMappings: Record<string, string>
}

const PROVIDER_IDS = new Set([
  'deepseek', 'glm', 'kimi', 'minimax', 'mimo',
  'perplexity', 'qwen', 'qwen-ai', 'zai',
])
const MAX_MODELS = 200
const MAX_TEXT_LENGTH = 160
const ERROR_MESSAGE = 'Provider model catalog is invalid or unsupported.'
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface DataProperty {
  value: unknown
}

interface CatalogEntry {
  displayName: string
  id: string
}

function invalidCatalog(): never {
  throw new Error(ERROR_MESSAGE)
}

function readOwnData(record: object, key: string): DataProperty | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor) return undefined
  if (!('value' in descriptor) || !descriptor.enumerable) invalidCatalog()
  return { value: descriptor.value }
}

function plainRecord(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCatalog()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidCatalog()
  for (const key of RESERVED_KEYS) {
    if (Object.getOwnPropertyDescriptor(value, key)) invalidCatalog()
  }
  return value
}

function checkedText(value: unknown): string {
  if (typeof value !== 'string' ||
    value.length === 0 || value.length > MAX_TEXT_LENGTH ||
    value.trim() !== value || UNSAFE_TEXT.test(value) ||
    RESERVED_KEYS.has(value.toLowerCase())) invalidCatalog()
  return value
}

function checkedId(value: unknown): string {
  const id = checkedText(value)
  // Web IDs in the current built-ins use this alphabet. Do not silently
  // normalize names or accept schemes, URL paths, queries, or fragments.
  if (!MODEL_ID.test(id) || /^www\./i.test(id)) invalidCatalog()
  return id
}

function catalogArray(payload: unknown): unknown[] {
  let candidate: unknown = payload
  if (!Array.isArray(payload)) {
    const envelope = plainRecord(payload)
    const data = readOwnData(envelope, 'data')
    const models = readOwnData(envelope, 'models')
    // A malformed or competing envelope must not fall through to another one.
    if (Boolean(data) === Boolean(models)) invalidCatalog()
    candidate = (data || models)?.value
  }

  if (!Array.isArray(candidate)) invalidCatalog()
  const prototype = Object.getPrototypeOf(candidate)
  if (prototype !== Array.prototype && prototype !== null) invalidCatalog()
  const length = Object.getOwnPropertyDescriptor(candidate, 'length')?.value
  if (!Number.isInteger(length) || length < 1 || length > MAX_MODELS) invalidCatalog()
  // HTTP JSON arrays have exactly their own dense indexes and length.
  if (Reflect.ownKeys(candidate).length !== length + 1) invalidCatalog()

  const entries: unknown[] = []
  for (let index = 0; index < length; index++) {
    const item = readOwnData(candidate, String(index))
    if (!item) invalidCatalog()
    entries.push(item.value)
  }
  return entries
}

function parseEntry(value: unknown): CatalogEntry {
  if (typeof value === 'string') {
    const id = checkedId(value)
    return { displayName: id, id }
  }

  const record = plainRecord(value)
  const idField = readOwnData(record, 'id')
  const modelIdField = readOwnData(record, 'model_id')
  if (!idField && !modelIdField) invalidCatalog()
  const id = checkedId((idField || modelIdField)?.value)
  if (modelIdField && checkedId(modelIdField.value) !== id) invalidCatalog()

  const nameField = readOwnData(record, 'name')
  const displayField = readOwnData(record, 'display_name')
  const name = nameField ? checkedText(nameField.value) : undefined
  const displayName = displayField ? checkedText(displayField.value) : name
  return { displayName: displayName ?? id, id }
}

/**
 * Parse an already decoded website response body, without network or storage.
 *
 * Accepted bodies are a non-empty array, { data: [...] }, or { models: [...] }.
 * A string entry is an explicit ID. Objects require id/model_id; display_name
 * takes precedence over name, then the ID itself. Names never invent an ID.
 * Unused metadata (for example Qwen's info object) is neither read nor copied.
 * All entries must be valid and unambiguous; no partial catalog is returned.
 */
export function parseProviderModelCatalog(
  providerId: string,
  payload: unknown,
): ProviderModelCatalog {
  try {
    if (typeof providerId !== 'string' || !PROVIDER_IDS.has(providerId)) invalidCatalog()

    const supportedModels: string[] = []
    const mappings: [string, string][] = []
    const ids = new Set<string>()
    const names = new Set<string>()
    const bindings = new Map<string, string>()

    for (const value of catalogArray(payload)) {
      const { displayName, id } = parseEntry(value)
      if (ids.has(id) || names.has(displayName)) invalidCatalog()
      // A display alias cannot shadow another model's actual ID in either order.
      const displayBinding = bindings.get(displayName)
      const idBinding = bindings.get(id)
      if ((displayBinding !== undefined && displayBinding !== id) ||
        (idBinding !== undefined && idBinding !== id)) invalidCatalog()

      ids.add(id)
      names.add(displayName)
      bindings.set(id, id)
      bindings.set(displayName, id)
      supportedModels.push(displayName)
      mappings.push([displayName, id])
    }

    return { supportedModels, modelMappings: Object.fromEntries(mappings) }
  } catch {
    // Never include provider/response text, an original error, or its cause.
    throw new Error(ERROR_MESSAGE)
  }
}
