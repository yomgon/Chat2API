import type { AppConfig } from './types'

const PROTECTED_PREFIX = 'safeStorage:v1:'
const INVALID_DATA = 'Configuration secret data is invalid or unsupported.'

type SecretKind = 'apiKey' | 'management'
type SecretState = 'empty' | 'protected' | 'legacy'
type SecretTransform = (value: string, kind: SecretKind, state: SecretState) => string

function invalidData(): never {
  throw new Error(INVALID_DATA)
}

function copyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidData()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidData()

  // Stored/IPC configuration is data, not executable accessors. Do not invoke
  // getters while reading or copying a secret-bearing object.
  const entries: [string, unknown][] = []
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) invalidData()
    entries.push([key, descriptor.value])
  }
  return Object.fromEntries(entries)
}

function copyConfig(config: AppConfig): AppConfig {
  const source = copyRecord(config)
  const sourceKeys = source.apiKeys
  if (!Array.isArray(sourceKeys)) invalidData()

  const apiKeys: AppConfig['apiKeys'] = []
  for (let index = 0; index < sourceKeys.length; index++) {
    // Reject sparse arrays and accessor entries instead of silently skipping them.
    const descriptor = Object.getOwnPropertyDescriptor(sourceKeys, String(index))
    if (!descriptor || !('value' in descriptor)) invalidData()
    const entry = copyRecord(descriptor.value)
    if (typeof entry.key !== 'string') invalidData()
    apiKeys.push(entry as unknown as AppConfig['apiKeys'][number])
  }

  const managementApi = copyRecord(source.managementApi)
  if (typeof managementApi.managementApiSecret !== 'string') invalidData()

  return {
    ...source,
    apiKeys,
    managementApi,
  } as unknown as AppConfig
}

function isProtectedSecret(value: string): boolean {
  if (!value.startsWith(PROTECTED_PREFIX)) return false
  const encoded = value.slice(PROTECTED_PREFIX.length)
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.length > 0 && bytes.toString('base64') === encoded
}

function isLegacySecret(value: string, kind: SecretKind): boolean {
  if (kind === 'apiKey') {
    // Both local GUI keys and the existing management API's generated keys
    // are authenticated proxy API keys. The latter is sk-mgmt- plus exactly
    // 32 hex characters (128 random bits); rejecting that format caused the
    // *real* OS-protected StoreManager to refuse a committed management CRUD
    // request with HTTP 500 before a new key could be saved.
    return (value.length === 51 && /^sk-[A-Za-z0-9]{48}$/.test(value)) ||
      (value.length === 40 && /^sk-mgmt-[A-Fa-f0-9]{32}$/.test(value))
  }
  return (value.length === 40 && /^sk-mgmt-[A-Fa-f0-9]{32}$/.test(value)) ||
    (value.length === 41 && /^mgmt_[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/.test(value))
}

function classifySecret(value: string, kind: SecretKind): SecretState {
  if (value === '') return 'empty'
  if (isProtectedSecret(value)) return 'protected'
  if (isLegacySecret(value, kind)) return 'legacy'
  return invalidData()
}

function inspectConfig(config: AppConfig) {
  const copy = copyConfig(config)
  // Validate every field before callbacks or the migration predicate can finish.
  const apiKeyStates = copy.apiKeys.map(entry => classifySecret(entry.key, 'apiKey'))
  const managementState = classifySecret(copy.managementApi.managementApiSecret, 'management')
  return { copy, apiKeyStates, managementState }
}

function transformConfig(config: AppConfig, transform: SecretTransform): AppConfig {
  const { copy, apiKeyStates, managementState } = inspectConfig(config)
  return {
    ...copy,
    apiKeys: copy.apiKeys.map((entry, index) => ({
      ...entry,
      key: transform(entry.key, 'apiKey', apiKeyStates[index]),
    })),
    managementApi: {
      ...copy.managementApi,
      managementApiSecret: transform(copy.managementApi.managementApiSecret, 'management', managementState),
    },
  }
}

/**
 * Prepare a complete config for persistence using the caller's OS encryptor.
 * Empty values and structurally valid, already marked ciphertext are preserved.
 * The caller must decode stored ciphertext to verify its OS protection before
 * trusting it; recognizing the envelope alone cannot authenticate ciphertext.
 */
export function encodeConfigSecrets(
  config: AppConfig,
  encrypt: (value: string) => string,
): AppConfig {
  try {
    if (typeof encrypt !== 'function') invalidData()
    return transformConfig(config, (value, _kind, state) => {
      if (state !== 'legacy') return value
      const encrypted = encrypt(value)
      if (typeof encrypted !== 'string' || !isProtectedSecret(encrypted)) invalidData()
      return encrypted
    })
  } catch {
    // Never attach the original error: an OS/backend error may echo a secret.
    throw new Error('Configuration secrets could not be encrypted. No configuration changes were made.')
  }
}

/**
 * Read only marked OS ciphertext, empty values, or recognized legacy UI secrets.
 * Decrypted values must satisfy the same field-specific contract, so every
 * accepted result can be encoded again without accepting arbitrary plaintext.
 */
export function decodeConfigSecrets(
  config: AppConfig,
  decrypt: (value: string) => string,
): AppConfig {
  try {
    if (typeof decrypt !== 'function') invalidData()
    return transformConfig(config, (value, kind, state) => {
      if (state !== 'protected') return value
      const decrypted = decrypt(value)
      if (typeof decrypted !== 'string' ||
        (decrypted !== '' && !isLegacySecret(decrypted, kind))) invalidData()
      return decrypted
    })
  } catch {
    throw new Error('Configuration secrets could not be decrypted. No configuration changes were made.')
  }
}

/**
 * Detect recognized, non-empty legacy secrets that still require migration.
 * This checks every secret's shape, including those after a legacy value; it
 * does not replace decoding to detect corrupt or unavailable OS ciphertext.
 */
export function hasUnprotectedConfigSecrets(config: AppConfig): boolean {
  try {
    const { apiKeyStates, managementState } = inspectConfig(config)
    return apiKeyStates.some(state => state === 'legacy') || managementState === 'legacy'
  } catch {
    throw new Error(INVALID_DATA)
  }
}

/**
 * Export settings with no API keys and an empty management secret.
 * Only the data structure/types are needed: even a damaged secret string is
 * removed without decryption. Other settings and key-source inputs are intact.
 */
export function redactExportConfigSecrets(config: AppConfig): AppConfig {
  try {
    const copy = copyConfig(config)
    return {
      ...copy,
      apiKeys: [],
      managementApi: {
        ...copy.managementApi,
        managementApiSecret: '',
      },
    }
  } catch {
    throw new Error(INVALID_DATA)
  }
}
