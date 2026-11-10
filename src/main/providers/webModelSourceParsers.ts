import type { ProviderModelCatalog } from './modelCatalog'

const MAX_MODELS = 200
const MAX_TEXT_LENGTH = 160
const ERROR_MESSAGE = 'Web chat model catalog is invalid or unsupported.'
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface DataProperty {
  value: unknown
}

interface WebModel {
  id: string
  name: string
}

type MimoGeneration = readonly [bigint, bigint]

function invalidCatalog(): never {
  throw new Error(ERROR_MESSAGE)
}

function ownData(record: object, key: string): DataProperty | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor) return undefined
  if (!('value' in descriptor) || !descriptor.enumerable) invalidCatalog()
  return { value: descriptor.value }
}

function requiredData(record: object, key: string): unknown {
  const property = ownData(record, key)
  if (!property) invalidCatalog()
  return property.value
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

function modelArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidCatalog()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Array.prototype && prototype !== null) invalidCatalog()
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!Number.isInteger(length) || length < 1 || length > MAX_MODELS) invalidCatalog()
  if (Reflect.ownKeys(value).length !== length + 1) invalidCatalog()
  const entries: unknown[] = []
  for (let index = 0; index < length; index++) {
    entries.push(requiredData(value, String(index)))
  }
  return entries
}

function modelText(value: unknown): string {
  if (typeof value !== 'string' ||
    value.length === 0 || value.length > MAX_TEXT_LENGTH ||
    value.trim() !== value || UNSAFE_TEXT.test(value) ||
    RESERVED_KEYS.has(value.toLowerCase())) invalidCatalog()
  return value
}

function modelId(value: unknown): string {
  const id = modelText(value)
  if (!MODEL_ID.test(id) || /^www\./i.test(id)) invalidCatalog()
  return id
}

function validateUniqueModels(models: readonly WebModel[]): void {
  const ids = new Set<string>()
  const names = new Set<string>()
  const bindings = new Map<string, string>()
  for (const { id, name } of models) {
    if (ids.has(id) || names.has(name)) invalidCatalog()
    const idBinding = bindings.get(id)
    const nameBinding = bindings.get(name)
    if ((idBinding !== undefined && idBinding !== id) ||
      (nameBinding !== undefined && nameBinding !== id)) invalidCatalog()
    ids.add(id)
    names.add(name)
    bindings.set(id, id)
    bindings.set(name, id)
  }
}

function catalogFrom(models: readonly WebModel[]): ProviderModelCatalog {
  if (models.length === 0) invalidCatalog()
  return {
    supportedModels: models.map(model => model.name),
    modelMappings: Object.fromEntries(models.map(model => [model.name, model.id])),
  }
}

function mimoChatGeneration(id: string): MimoGeneration | undefined {
  // Chat families observed in this fork and the supplied website catalog.
  // Unknown suffixes, including TTS/ASR/agent modes, are not chat capabilities.
  const match = /^mimo-v([0-9]+)(?:\.([0-9]+))?(?:-(?:flash|pro|pro-ultraspeed-studio))?$/i.exec(id)
  if (!match) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(match[1]) ||
    (match[2] !== undefined && !/^(0|[1-9][0-9]*)$/.test(match[2]))) invalidCatalog()
  // Version components are integers, not decimal fractions or floating point.
  return [BigInt(match[1]), BigInt(match[2] ?? '0')]
}

function compareGeneration(left: MimoGeneration, right: MimoGeneration): number {
  if (left[0] !== right[0]) return left[0] > right[0] ? 1 : -1
  if (left[1] !== right[1]) return left[1] > right[1] ? 1 : -1
  return 0
}

/**
 * Parse the supplied /open-apis/bot/config response, using data.modelConfigList.
 * modelConfigListNg is a separate, unverified schema and is never merged or
 * used as a fallback. Every primary-list entry is validated before filtering;
 * repeated old display labels do not invalidate the selected chat generation.
 * Only the highest observed chat generation is returned, with its original
 * website IDs/names/order. This does not verify account or adapter availability.
 */
export function parseMimoWebChatCatalog(payload: unknown): ProviderModelCatalog {
  try {
    const root = plainRecord(payload)
    const code = ownData(root, 'code')
    if (code && code.value !== 0) invalidCatalog()
    const data = plainRecord(requiredData(root, 'data'))
    const models = modelArray(requiredData(data, 'modelConfigList')).map(value => {
      const record = plainRecord(value)
      return {
        id: modelId(requiredData(record, 'model')),
        name: modelText(requiredData(record, 'name')),
      }
    })

    const candidates: Array<{ model: WebModel; generation: MimoGeneration }> = []
    let latest: MimoGeneration | undefined
    for (const model of models) {
      const generation = mimoChatGeneration(model.id)
      if (!generation) continue
      candidates.push({ model, generation })
      if (!latest || compareGeneration(generation, latest) > 0) latest = generation
    }
    if (!latest) invalidCatalog()
    const selectedGeneration = latest
    const selected = candidates
      .filter(candidate => compareGeneration(candidate.generation, selectedGeneration) === 0)
      .map(candidate => candidate.model)
    validateUniqueModels(selected)
    return catalogFrom(selected)
  } catch {
    throw new Error(ERROR_MESSAGE)
  }
}

/**
 * Parse availableModels from the supplied GetAvailableModels response.
 * SCENARIO_CHAT is the only supported mode. Agent/other scenarios are excluded.
 * id and displayName are retained exactly; key/defaultChatModel never replace
 * the ID or promote an unsupported mode. A catalog is not a live usability test.
 */
export function parseKimiWebChatCatalog(payload: unknown): ProviderModelCatalog {
  try {
    const root = plainRecord(payload)
    const models = modelArray(requiredData(root, 'availableModels')).map(value => {
      const record = plainRecord(value)
      const id = modelId(requiredData(record, 'id'))
      const name = modelText(requiredData(record, 'displayName'))
      const scenario = modelText(requiredData(record, 'scenario'))
      if (!/^SCENARIO_[A-Z0-9_]+$/.test(scenario)) invalidCatalog()
      const key = ownData(record, 'key')
      if (key) modelId(key.value)
      return { id, name, scenario }
    })
    validateUniqueModels(models)
    return catalogFrom(models.filter(model => model.scenario === 'SCENARIO_CHAT'))
  } catch {
    // Never leak response text, thrown objects, or an original error's cause.
    throw new Error(ERROR_MESSAGE)
  }
}
