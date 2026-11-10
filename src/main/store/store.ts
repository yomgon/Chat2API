/**
 * Credential Storage Module - Core Storage Implementation
 * Uses electron-store for persistent storage
 * Uses Electron's safeStorage API for sensitive data encryption
 */

import { app, safeStorage, BrowserWindow } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import {
  StoreSchema,
  AppConfig,
  Account,
  Provider,
  LogEntry,
  DEFAULT_CONFIG,
  BUILTIN_PROVIDERS,
  LogLevel,
  SystemPrompt,
  SessionRecord,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  RequestLogEntry,
  RequestLogConfig,
  PersistentStatistics,
  DailyStatistics,
  DEFAULT_STATISTICS,
  EffectiveModel,
  ProviderModelOverrides,
  DEFAULT_USER_MODEL_OVERRIDES,
  UserModelOverrides,
  CustomModel,
  DEFAULT_REQUEST_LOG_CONFIG,
  createDefaultModelMappings,
  normalizeModelMappingsWithDefaults,
  sanitizeDeepSeekModelOverrides,
} from './types'
import { BUILTIN_PROMPTS } from '../data/builtin-prompts'
import { RequestLogManager } from '../requestLogs/manager'
import { normalizeRequestLogConfig } from '../requestLogs/types'
import { normalizeToolCallingConfig } from '../../shared/toolCalling'
import { AppLogManager } from '../appLogs/manager'
import type { AppLogFilter } from '../appLogs/types'
import { encodeConfigSecrets, decodeConfigSecrets, redactExportConfigSecrets } from './configSecrets'

// Dynamically import electron-store (ESM module)
let Store: any = null

/**
 * Storage Instance Type Definition
 */
type StoreType = any

const CREDENTIAL_ENCRYPTION_PREFIX = 'safeStorage:v1:'
const COOKIE_ENCRYPTION_PREFIX = 'safeStorage:cookies:v1:'
const PROVIDER_HEADER_ENCRYPTION_PREFIX = 'safeStorage:provider-header:v1:'

/**
 * An explicitly synced web-chat catalog is allowed to survive startup only
 * when its vendor has a shipped, fixed discovery endpoint and the cached
 * names/IDs are structurally safe. Ordinary built-in lists still follow the
 * bundled defaults. Never infer account entitlement from this metadata.
 */
function hasValidWebModelCatalog(
  provider: Provider,
  builtin: { modelsApiEndpoint?: string },
): boolean {
  const marker = provider.modelCatalog
  const names = provider.supportedModels
  const mapping = provider.modelMappings
  if (!builtin.modelsApiEndpoint || marker?.source !== 'provider-web'
    || !Number.isSafeInteger(marker.syncedAt) || marker.syncedAt <= 0
    || marker.syncedAt > Date.now() + 300_000
    || !Array.isArray(names) || names.length < 1 || names.length > 200
    || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return false
  }

  const keys = Object.keys(mapping)
  if (keys.length !== names.length || new Set(names).size !== names.length) return false
  const unsafeName = /[\u0000-\u001f\u007f]/
  const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/
  const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
  return names.every(name =>
    typeof name === 'string' && name.length > 0 && name.length <= 160
    && !unsafeName.test(name) && !forbidden.has(name)
    && Object.prototype.hasOwnProperty.call(mapping, name)
    && typeof mapping[name] === 'string' && modelId.test(mapping[name])
    && !forbidden.has(mapping[name]),
  )
}

/**
 * Storage Manager Class
 * Responsible for data persistence and encryption
 */
export class StoreManager {
  private store: StoreType | null = null
  private isInitialized: boolean = false
  private mainWindow: BrowserWindow | null = null
  private initializationError: Error | null = null
  private requestLogManager: RequestLogManager | null = null
  private appLogManager: AppLogManager | null = null

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * Check if storage has initialization error
   */
  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  /**
   * Get initialization error
   */
  getInitializationError(): Error | null {
    return this.initializationError
  }

  /**
   * Initialize Storage
   * Create storage instance and initialize default data
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Dynamically import electron-store (ESM module)
    if (!Store) {
      const module = await import('electron-store')
      Store = module.default
    }

    const storagePath = this.getStoragePath()

    try {
      this.store = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: this.getDefaultData(),
        encryptionKey: this.getEncryptionKey(),
      })
      // Before any other startup writer touches config, verify existing OS
      // ciphertext and migrate recognized legacy keys to protected storage.
      const secureConfig = this.readStoredConfig()
      this.writeStoredConfig(secureConfig)
      // Stored custom headers may contain API keys in arbitrary header names.
      // Migrate them before normal startup to avoid leaving raw values on disk.
      this.writeStoredProviders(this.readStoredProviders())

      await this.initializeAppLogManager(storagePath)
      await this.initializeRequestLogManager(storagePath)
      this.initializeDefaultModelMappings()
      await this.initializeDefaultProviders()
      this.isInitialized = true
      this.initializationError = null
    } catch {
      // A locked OS key store or an I/O failure is not evidence of corrupt data.
      // Leave existing files in place instead of resetting accounts automatically.
      this.store = null
      this.initializationError = new Error('Secure storage initialization failed. Existing data was not reset.')
      console.error('[Store] Secure storage initialization failed; automatic reset is disabled')
      throw this.initializationError
    }
  }

  /**
   * Get Storage Path
   * This fork must not read or overwrite the upstream application's data.
   */
  private getStoragePath(): string {
    return join(homedir(), '.chat2api-local-private')
  }

  /**
   * Get Encryption Key
   * Keep the outer electron-store format compatible. This fixed key is only
   * obfuscation; account secrets are protected separately by OS safeStorage.
   */
  private getEncryptionKey(): string {
    this.requireSecureStorage()
    return 'chat2api-fixed-encryption-key-v1'
  }

  private requireSecureStorage(): void {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('unavailable')
      }
      // This API is Linux-only. Windows/macOS rely on isEncryptionAvailable().
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend()
        if (!backend || backend === 'basic_text' || backend === 'unknown') {
          throw new Error('unavailable')
        }
      }
    } catch {
      throw new Error('Secure credential storage is unavailable. Unlock the OS key store and try again.')
    }
  }

  /**
   * Get Default Data Structure
   */
  private getDefaultData(): StoreSchema {
    return {
      providers: [],
      accounts: [],
      config: DEFAULT_CONFIG,
      logs: [],
      requestLogs: [],
      systemPrompts: [],
      sessions: [],
      statistics: DEFAULT_STATISTICS,
      userModelOverrides: DEFAULT_USER_MODEL_OVERRIDES,
    }
  }

  private async initializeRequestLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.requestLogManager = new RequestLogManager({
      storageDir: join(storagePath, 'request-logs'),
      config: config.requestLogConfig,
    })
    await this.requestLogManager.initialize()

    const legacyRequestLogs = this.store?.get('requestLogs') || []
    if (legacyRequestLogs.length > 0) {
      await this.requestLogManager.migrateLegacyLogs(legacyRequestLogs)
      this.store?.set('requestLogs', [])
    }
  }

  private async initializeAppLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.appLogManager = new AppLogManager({
      storageDir: join(storagePath, 'logs'),
      maxEntries: this.getMaxLogEntries(config),
    })
    await this.appLogManager.initialize()

    const legacyLogs = this.store?.get('logs') || []
    if (legacyLogs.length > 0) {
      await this.appLogManager.migrateLegacyLogs(legacyLogs)
      this.appLogManager.flushSync()
      this.store?.set('logs', [])
    }
  }

  private getMaxLogEntries(config: AppConfig): number {
    return config.logRetentionDays * 1000
  }

  private normalizeConfig(config: Partial<AppConfig>): AppConfig {
    const rawConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    }
    const rawToolCallingConfig = rawConfig.toolCallingConfig ?? rawConfig.toolPromptConfig

    return {
      ...rawConfig,
      // Malformed persisted flags must never disable local API authentication.
      enableApiKey: rawConfig.enableApiKey === false ? false : true,
      apiKeys: Array.isArray(rawConfig.apiKeys) ? rawConfig.apiKeys : [],
      modelMappings: normalizeModelMappingsWithDefaults(rawConfig.modelMappings),
      defaultModelMappingsSeeded: config.defaultModelMappingsSeeded,
      requestLogConfig: normalizeRequestLogConfig(
        rawConfig.requestLogConfig || DEFAULT_REQUEST_LOG_CONFIG,
      ),
      toolCallingConfig: normalizeToolCallingConfig(rawToolCallingConfig),
      toolPromptConfig: undefined,
    }
  }

  /** Always keep decrypted secrets in process memory only. */
  private readStoredConfig(): AppConfig {
    const raw = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    return decodeConfigSecrets(raw, value => this.decryptData(value))
  }

  /** Single durable writer for the entire AppConfig including OS-protected keys. */
  private writeStoredConfig(config: AppConfig): AppConfig {
    const normalized = this.normalizeConfig(config)
    const stored = encodeConfigSecrets(normalized, value => this.encryptData(value))
    this.store!.set('config', stored)
    return normalized
  }

  private initializeDefaultModelMappings(): void {
    const config = this.readStoredConfig()
    if (config.defaultModelMappingsSeeded) {
      this.writeStoredConfig(config)
      return
    }
    this.writeStoredConfig({
      ...config,
      modelMappings: {
        ...createDefaultModelMappings(),
        ...(config.modelMappings || {}),
      },
      defaultModelMappingsSeeded: true,
    })
  }

  /**
   * Initialize Default Providers
   * Clear provider list, users create providers by adding accounts
   */
  private async initializeDefaultProviders(): Promise<void> {
    const providers = this.readStoredProviders()
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)
    
    const validProviders = providers.filter((p: Provider) => {
      if (p.type === 'builtin') {
        return builtinIds.includes(p.id)
      }
      return true
    })
    
    const userModelOverrides: UserModelOverrides = {
      ...(this.store?.get('userModelOverrides') || {}),
    }
    let userModelOverridesChanged = false
    
    const updatedProviders = validProviders.map((p: Provider) => {
      if (p.type === 'builtin') {
        const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === p.id)
        if (builtinConfig) {
          if (p.id === 'deepseek') {
            const sanitizedOverrides = sanitizeDeepSeekModelOverrides(userModelOverrides[p.id])
            if (JSON.stringify(sanitizedOverrides) !== JSON.stringify(userModelOverrides[p.id])) {
              userModelOverrides[p.id] = sanitizedOverrides
              userModelOverridesChanged = true
            }
          }

          const keepSyncedModels = hasValidWebModelCatalog(p, builtinConfig)
          const { modelCatalog, ...providerWithoutCatalog } = p
          return {
            ...providerWithoutCatalog,
            apiEndpoint: builtinConfig.apiEndpoint,
            chatPath: builtinConfig.chatPath,
            supportedModels: keepSyncedModels ? [...(p.supportedModels || [])] : builtinConfig.supportedModels,
            modelMappings: keepSyncedModels ? { ...(p.modelMappings || {}) } : builtinConfig.modelMappings,
            ...(keepSyncedModels ? { modelCatalog } : {}),
            headers: builtinConfig.headers,
            credentialFields: builtinConfig.credentialFields,
            description: builtinConfig.description,
          }
        }
      }
      return p
    })
    
    if (userModelOverridesChanged) {
      this.store?.set('userModelOverrides', userModelOverrides)
    }
    this.writeStoredProviders(updatedProviders)
  }

  /**
   * Ensure provider exists, create if not
   */
  ensureProviderExists(providerId: string): void {
    this.ensureInitialized()
    const providers = this.readStoredProviders()
    const exists = providers.some((p: Provider) => p.id === providerId)
    
    if (!exists) {
      const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === providerId)
      if (builtinConfig) {
        const now = Date.now()
        const newProvider: Provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          headers: builtinConfig.headers,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
        }
        this.writeStoredProviders([...providers, newProvider])
        console.log('[Store] Created missing provider:', providerId)
      }
    }
  }

  /**
   * Ensure Storage is Initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.store) {
      const errorMsg = this.initializationError 
        ? `Storage initialization failed: ${this.initializationError.message}`
        : 'Storage not initialized, please call initialize() first'
      throw new Error(errorMsg)
    }
  }

  private getLogPriority(level: LogLevel): number {
    switch (level) {
      case 'debug':
        return 10
      case 'info':
        return 20
      case 'warn':
        return 30
      case 'error':
        return 40
      default:
        return 20
    }
  }

  private shouldRecordLog(level: LogLevel): boolean {
    const config = this.normalizeConfig(this.store!.get('config') || DEFAULT_CONFIG)
    return this.getLogPriority(level) >= this.getLogPriority(config.logLevel)
  }

  private getCombinedLogs(): LogEntry[] {
    return this.getAppLogManager().exportLogs()
  }

  flushPendingWrites(): void {
    this.appLogManager?.flushSync()
    this.requestLogManager?.flushSync()
  }

  /**
   * Encrypt Sensitive Data
   * @param data Data to encrypt
   * @returns Encrypted string
   */
  encryptData(data: string): string {
    if (typeof data !== 'string') {
      throw new Error('Credential values must be strings')
    }
    this.requireSecureStorage()
    // Optional empty credential fields contain no secret and need no ciphertext.
    if (data === '') return ''

    try {
      const encrypted = safeStorage.encryptString(data)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || safeStorage.decryptString(encrypted) !== data) {
        throw new Error('verification failed')
      }
      return CREDENTIAL_ENCRYPTION_PREFIX + encrypted.toString('base64')
    } catch {
      // Do not attach the original error: providers/backends can echo secrets.
      throw new Error('Credential encryption failed. No credential changes were saved.')
    }
  }

  /**
   * Decrypt Sensitive Data
   * @param encryptedData Encrypted data
   * @returns Decrypted string
   */
  decryptData(encryptedData: string): string {
    if (typeof encryptedData !== 'string') {
      throw new Error('Stored credential is invalid. Sign in again to replace it.')
    }
    if (encryptedData === '') return ''

    const tagged = encryptedData.startsWith('safeStorage:')
    if (/^safeStorage/i.test(encryptedData) && !encryptedData.startsWith(CREDENTIAL_ENCRYPTION_PREFIX)) {
      throw new Error('Stored credential format is unsupported. Sign in again to replace it.')
    }

    const encoded = tagged ? encryptedData.slice(CREDENTIAL_ENCRYPTION_PREFIX.length) : encryptedData
    const buffer = Buffer.from(encoded, 'base64')
    const canonicalBase64 = encoded.length > 0 && buffer.toString('base64') === encoded
    // Old versions mixed bare Base64 ciphertext and plaintext. Base64-like data
    // is ambiguous, including unpadded/base64url or damaged OS ciphertext. Never
    // turn a failed decrypt of those values into an upstream credential.
    const base64Like = /^[A-Za-z0-9+/_=\s-]+$/.test(encoded)
    const osCiphertext = /^v\d\d/.test(buffer.subarray(0, 3).toString('ascii')) ||
      buffer.subarray(0, 4).equals(Buffer.from([1, 0, 0, 0]))

    if (!tagged && !canonicalBase64 && !base64Like && !osCiphertext && this.isLegacyPlaintextCredential(encryptedData)) {
      // Only recognizable JWT/JWE or cookie syntax is accepted as old plaintext.
      // Ambiguous opaque tokens need reentry. Account writes re-encrypt all fields.
      return encryptedData
    }
    if (!canonicalBase64) {
      throw new Error('Stored credential is invalid or ambiguous. Sign in again to replace it.')
    }

    this.requireSecureStorage()
    try {
      return safeStorage.decryptString(buffer)
    } catch {
      throw new Error('Stored credential could not be decrypted. Sign in again to replace it.')
    }
  }

  private isLegacyPlaintextCredential(value: string): boolean {
    const parts = value.split('.')
    const isBase64Url = (part: string): boolean => /^[A-Za-z0-9_-]+$/.test(part) &&
      Buffer.from(part, 'base64url').toString('base64url') === part

    if ((parts.length === 3 || parts.length === 5) && isBase64Url(parts[0])) {
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
        if (header && typeof header === 'object' && !Array.isArray(header) && typeof header.alg === 'string') {
          if (parts.length === 3 && parts.slice(1).every(isBase64Url)) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) return true
          }
          if (parts.length === 5 && typeof header.enc === 'string' &&
            (parts[1] === '' || isBase64Url(parts[1])) && parts.slice(2).every(isBase64Url)) return true
        }
      } catch {
        // Format recognition is only for migration; it does not validate a token.
      }
    }

    if (/[\r\n]/.test(value)) return false
    const cookiePairs = value.split(';').map(part => part.trim())
    if (cookiePairs[cookiePairs.length - 1] === '') cookiePairs.pop()
    return cookiePairs.length > 0 && cookiePairs.every(pair =>
      /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+=[^\s;]*$/.test(pair)
    )
  }

  private copyCookieMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error('Cookie credentials must be an object of string values')
    }
    const entries = Object.entries(value)
    if (entries.some(([, cookie]) => typeof cookie !== 'string')) {
      throw new Error('Cookie credentials must be an object of string values')
    }
    return Object.fromEntries(entries)
  }

  /**
   * Encrypt Credentials Object
   * @param credentials Credentials object
   * @returns Encrypted credentials object
   */
  encryptCredentials(credentials: Record<string, unknown>): Record<string, string> {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new Error('Credentials must be an object of string values')
    }
    this.requireSecureStorage()
    return Object.fromEntries(Object.entries(credentials).map(([key, value]) => {
      if (key === 'cookies' && typeof value !== 'string') {
        const encrypted = this.encryptData(JSON.stringify(this.copyCookieMap(value)))
        return [key, COOKIE_ENCRYPTION_PREFIX + encrypted.slice(CREDENTIAL_ENCRYPTION_PREFIX.length)]
      }
      if (typeof value !== 'string') throw new Error('Credential values must be strings')
      return [key, this.encryptData(value)]
    }))
  }

  /**
   * Decrypt Credentials Object
   * @param encryptedCredentials Encrypted credentials object
   * @returns Decrypted credentials object
   */
  decryptCredentials(encryptedCredentials: Record<string, unknown>): Record<string, string> {
    if (!encryptedCredentials || typeof encryptedCredentials !== 'object' || Array.isArray(encryptedCredentials)) {
      throw new Error('Stored credentials are invalid. Sign in again to replace them.')
    }
    const credentials = Object.fromEntries(Object.entries(encryptedCredentials).map(([key, value]) => {
      // Existing Perplexity OAuth/proxy callers exchange a cookie map despite the
      // legacy Account type declaring only strings. Keep that shape at runtime.
      if (key === 'cookies' && typeof value !== 'string') return [key, this.copyCookieMap(value)]
      if (typeof value !== 'string') throw new Error('Stored credential is invalid. Sign in again to replace it.')
      if (key === 'cookies' && value.startsWith(COOKIE_ENCRYPTION_PREFIX)) {
        try {
          const serialized = this.decryptData(CREDENTIAL_ENCRYPTION_PREFIX + value.slice(COOKIE_ENCRYPTION_PREFIX.length))
          return [key, this.copyCookieMap(JSON.parse(serialized))]
        } catch {
          throw new Error('Stored cookie credentials could not be decrypted. Sign in again to replace them.')
        }
      }
      return [key, this.decryptData(value)]
    }))
    return credentials as Record<string, string>
  }

  // ==================== Provider Operations ====================

  /** Custom provider header values are OS-encrypted at rest. */
  private readStoredProviders(): Provider[] {
    const source = (this.store?.get('providers') || []) as Provider[]
    if (!Array.isArray(source)) throw new Error('Stored provider data is invalid')
    return source.map(provider => {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new Error('Stored provider data is invalid')
      }
      const headers = provider.headers || {}
      if (typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error('Stored provider headers are invalid')
      }
      const decrypted = Object.fromEntries(Object.entries(headers).map(([name, value]) => {
        if (typeof value !== 'string') throw new Error('Stored provider headers are invalid')
        if (value.startsWith(PROVIDER_HEADER_ENCRYPTION_PREFIX)) {
          const ciphertext = CREDENTIAL_ENCRYPTION_PREFIX + value.slice(PROVIDER_HEADER_ENCRYPTION_PREFIX.length)
          return [name, this.decryptData(ciphertext)]
        }
        // Legacy plaintext is accepted only for one-way migration into OS
        // protection; this fork does not reuse the upstream data directory.
        return [name, value]
      }))
      return { ...provider, headers: decrypted }
    })
  }

  private writeStoredProviders(providers: Provider[]): void {
    if (!Array.isArray(providers)) throw new Error('Provider data must be a list')
    const encoded = providers.map(provider => {
      const headers = provider.headers || {}
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error('Provider header configuration is invalid')
      }
      const protectedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => {
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || typeof value !== 'string' || /[\r\n\u0000]/.test(value)) {
          throw new Error('Provider header configuration is invalid')
        }
        const stockHeader = provider.type === 'builtin' && BUILTIN_PROVIDERS.some(builtin =>
          builtin.id === provider.id && builtin.headers?.[name] === value,
        )
        if (stockHeader || value === '') return [name, value]
        const encrypted = this.encryptData(value)
        return [name, PROVIDER_HEADER_ENCRYPTION_PREFIX + encrypted.slice(CREDENTIAL_ENCRYPTION_PREFIX.length)]
      }))
      return { ...provider, headers: protectedHeaders }
    })
    this.store!.set('providers', encoded)
  }

  /** Replace the full provider list through the OS-encrypted write boundary. */
  replaceProviders(providers: Provider[]): void {
    this.ensureInitialized()
    this.writeStoredProviders(providers)
  }

  /**
   * Get All Providers
   */
  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.readStoredProviders()
  }

  /**
   * Get Provider By ID
   */
  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    const providers = this.readStoredProviders()
    return providers.find((p: Provider) => p.id === id)
  }

  /**
   * Add Provider
   */
  addProvider(provider: Provider): void {
    this.ensureInitialized()
    const providers = this.readStoredProviders()
    this.writeStoredProviders([...providers, provider])
  }

  /**
   * Update Provider
   */
  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = this.readStoredProviders()
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return null
    }
    
    providers[index] = {
      ...providers[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    this.writeStoredProviders(providers)
    return providers[index]
  }

  /**
   * Delete Provider
   */
  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    const providers = this.readStoredProviders()
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return false
    }
    // Last line of defense even if another caller bypasses a manager guard.
    // Preserving built-ins also preserves their per-account session ownership.
    if (providers[index].type !== 'custom' || BUILTIN_PROVIDERS.some(builtin => builtin.id === id)) {
      throw new Error('Built-in providers cannot be deleted; disable them instead')
    }
    
    const remaining = providers.filter(provider => provider.id !== id)
    this.writeStoredProviders(remaining)
    
    const accounts = this.store!.get('accounts') as Account[] || []
    const filteredAccounts = accounts.filter((a: Account) => a.providerId !== id)
    this.store!.set('accounts', filteredAccounts)
    
    return true
  }

  // ==================== Model Overrides Operations ====================

  /**
   * Get Model Overrides for a Provider
   * Returns user customizations to built-in provider models
   */
  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    return userModelOverrides[providerId]
  }

  /**
   * Check if Provider has Model Overrides
   * Returns true if provider has user-added models or excluded models
   */
  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    if (!overrides) return false
    
    return (
      (overrides.addedModels && overrides.addedModels.length > 0) ||
      (overrides.excludedModels && overrides.excludedModels.length > 0)
    )
  }

  // ==================== Account Operations ====================

  /**
   * Get All Accounts
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    
    if (includeCredentials) {
      return accounts.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return accounts
  }

  /**
   * Get Account By ID
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const account = accounts.find((a: Account) => a.id === id)
    
    if (account && includeCredentials) {
      return {
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }
    }
    
    return account
  }

  /**
   * Get Accounts By Provider ID
   */
  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const filtered = accounts.filter((a: Account) => a.providerId === providerId)
    
    if (includeCredentials) {
      return filtered.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return filtered
  }

  /**
   * Add Account
   * Credentials are automatically encrypted before storage
   */
  addAccount(account: Account): void {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    
    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }
    
    this.store!.set('accounts', [...accounts, encryptedAccount])
  }

  /**
   * Update Account
   */
  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((a: Account) => a.id === id)
    
    if (index === -1) {
      return null
    }
    
    // Resolve the return value and encrypt before the single write. A failed
    // decrypt must not turn a metadata update into a partial successful write.
    // New credentials can replace an unreadable old value without decrypting it.
    const credentials = updates.credentials !== undefined
      ? updates.credentials
      : this.decryptCredentials(accounts[index].credentials)
    const updatedAccount: Account = {
      ...accounts[index],
      ...updates,
      credentials: this.encryptCredentials(credentials),
      updatedAt: Date.now(),
    }

    this.store!.set('accounts', accounts.map((account: Account, accountIndex: number) =>
      accountIndex === index ? updatedAccount : account
    ))
    
    return {
      ...updatedAccount,
      credentials,
    }
  }

  /**
   * Record one confirmed answer against the latest stored account.
   * Keep credentials opaque and preserve all non-usage metadata.
   */
  recordAccountSuccess(id: string, providerId: string): boolean {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((account: Account) =>
      account.id === id && account.providerId === providerId
    )

    if (index === -1) return false

    const current = accounts[index]
    const updatedAccount: Account = {
      ...current,
      requestCount: (current.requestCount || 0) + 1,
      todayUsed: (current.todayUsed || 0) + 1,
      lastUsed: Date.now(),
    }
    this.store!.set('accounts', accounts.map((account: Account, accountIndex: number) =>
      accountIndex === index ? updatedAccount : account
    ))
    return true
  }

  /**
   * Delete Account
   */
  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((a: Account) => a.id === id)
    
    if (index === -1) {
      return false
    }
    
    accounts.splice(index, 1)
    this.store!.set('accounts', accounts)
    return true
  }

  /**
   * Get Active Accounts
   */
  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const active = accounts.filter((a: Account) => a.status === 'active')
    
    if (includeCredentials) {
      return active.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return active
  }

  // ==================== Configuration Operations ====================

  /**
   * Get Application Configuration
   */
  getConfig(): AppConfig {
    this.ensureInitialized()
    return this.readStoredConfig()
  }

  /**
   * Set Application Configuration
   */
  setConfig(config: AppConfig): void {
    this.ensureInitialized()
    const normalized = this.writeStoredConfig(config)
    this.requestLogManager?.setConfig(normalized.requestLogConfig)
  }

  /**
   * Update Application Configuration
   */
  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    if (Object.prototype.hasOwnProperty.call(updates, 'enableApiKey') &&
        typeof updates.enableApiKey !== 'boolean') {
      throw new Error('API key authentication setting must be a boolean')
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'apiKeys') &&
        (!Array.isArray(updates.apiKeys) || updates.apiKeys.some(key =>
          !key || typeof key.id !== 'string' || typeof key.key !== 'string' || typeof key.enabled !== 'boolean'))) {
      throw new Error('API key configuration is invalid')
    }
    const currentConfig = this.getConfig()
    const newConfig = {
      ...currentConfig,
      ...updates,
    }
    
    // Deep merge for nested objects
    if (updates.toolCallingConfig || updates.toolPromptConfig) {
      const incoming = updates.toolCallingConfig ?? updates.toolPromptConfig
      const incomingRecord = incoming && typeof incoming === 'object' ? incoming as Record<string, unknown> : {}
      const incomingAdvanced = incomingRecord.advanced && typeof incomingRecord.advanced === 'object'
        ? incomingRecord.advanced as Record<string, unknown>
        : {}

      newConfig.toolCallingConfig = normalizeToolCallingConfig({
        ...currentConfig.toolCallingConfig,
        ...incomingRecord,
        advanced: {
          ...currentConfig.toolCallingConfig.advanced,
          ...incomingAdvanced,
        },
      })
      newConfig.toolPromptConfig = undefined
    }
    
    if (updates.sessionConfig && currentConfig.sessionConfig) {
      newConfig.sessionConfig = {
        ...currentConfig.sessionConfig,
        ...updates.sessionConfig,
      }
    }

    if (updates.requestLogConfig) {
      newConfig.requestLogConfig = normalizeRequestLogConfig({
        ...currentConfig.requestLogConfig,
        ...updates.requestLogConfig,
      })
    }

    const normalized = this.normalizeConfig(newConfig)
    this.writeStoredConfig(normalized)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(normalized))
    this.requestLogManager?.setConfig(normalized.requestLogConfig)
    return normalized
  }

  /**
   * Reset Configuration to Default Values
   */
  resetConfig(): AppConfig {
    this.ensureInitialized()
    this.writeStoredConfig(DEFAULT_CONFIG)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(DEFAULT_CONFIG))
    this.requestLogManager?.setConfig(DEFAULT_CONFIG.requestLogConfig)
    return DEFAULT_CONFIG
  }

  // ==================== Log Operations ====================

  /**
   * Add Log Entry
   */
  addLog(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      data?: Record<string, unknown>
      model?: string
      actualModel?: string
      latency?: number
      isStream?: boolean
      error?: string
    }
  ): LogEntry {
    this.ensureInitialized()
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }

    if (!this.shouldRecordLog(level)) {
      return entry
    }

    this.getAppLogManager().addLog(entry)

    return entry
  }

  /**
   * Get Logs
   * @param limit Limit count
   * @param level Log level filter
   */
  getLogs(filter?: AppLogFilter): LogEntry[] {
    this.ensureInitialized()
    return this.getAppLogManager().getLogs(filter)
  }

  /**
   * Clear Logs
   */
  clearLogs(): void {
    this.ensureInitialized()
    this.getAppLogManager().clearLogs()
    this.store!.set('logs', [])
  }

  replaceLogs(logs: LogEntry[]): void {
    this.ensureInitialized()
    this.getAppLogManager().replaceLogs(logs)
    this.store!.set('logs', [])
  }

  /**
   * Get Log Statistics
   */
  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    return this.getAppLogManager().getStats()
  }

  /**
   * Get Log Trend
   */
  getLogTrend(days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.getAppLogManager().getTrend(days)
  }

  /**
   * Get Log Trend for specific account
   * Only counts successful API requests (logs with requestId) to match requestCount
   */
  getAccountLogTrend(accountId: string, days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.getAppLogManager().getAccountTrend(accountId, days)
  }

  /**
   * Export Logs
   */
  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()

    if (format === 'json') {
      return JSON.stringify(logs, null, 2)
    }

    return logs
      .map((log: LogEntry) => {
        const time = new Date(log.timestamp).toISOString()
        const level = log.level.toUpperCase().padEnd(5)
        let line = `[${time}] [${level}] ${log.message}`
        
        if (log.providerId) {
          line += ` | Provider: ${log.providerId}`
        }
        if (log.accountId) {
          line += ` | Account: ${log.accountId}`
        }
        if (log.requestId) {
          line += ` | Request: ${log.requestId}`
        }
        if (log.data) {
          line += ` | Data: ${JSON.stringify(log.data)}`
        }
        
        return line
      })
      .join('\n')
  }

  /**
   * Get Log By ID
   */
  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()
    return logs.find((l: LogEntry) => l.id === id)
  }

  /**
   * Clear Expired Logs
   */
  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    const logs = this.getCombinedLogs()
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000
    
    const filtered = logs.filter((l: LogEntry) => l.timestamp >= cutoff)
    this.getAppLogManager().replaceLogs(filtered)
    this.store!.set('logs', [])
  }

  // ==================== Request Log Operations ====================

  /**
   * Add Request Log Entry
   */
  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()
    const newEntry = this.getRequestLogManager().addRequestLog(entry)
    return newEntry
  }

  /**
   * Update Request Log Entry
   */
  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    return this.getRequestLogManager().updateRequestLog(id, updates)
  }

  /**
   * Get Request Logs
   */
  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string }): RequestLogEntry[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogs(limit, filter)
  }

  /**
   * Get Request Log By ID
   */
  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogById(id)
  }

  /**
   * Clear Request Logs
   */
  clearRequestLogs(): void {
    this.ensureInitialized()
    this.getRequestLogManager().clearRequestLogs()
    this.store!.set('statistics', DEFAULT_STATISTICS)
  }

  /**
   * Get Request Log Statistics
   */
  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogStats()
  }

  /**
   * Get Request Log Trend
   */
  getRequestLogTrend(days: number = 7): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogTrend(days)
  }

  // ==================== Statistics Operations ====================

  /**
   * Get Persistent Statistics
   */
  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    return this.store!.get('statistics') || DEFAULT_STATISTICS
  }

  /**
   * Update Statistics
   */
  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    const currentStats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const newStats = {
      ...currentStats,
      ...updates,
      lastUpdated: Date.now(),
    }
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Record Request in Statistics
   */
  recordRequestInStats(
    success: boolean,
    latency: number,
    model?: string,
    providerId?: string,
    accountId?: string
  ): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = new Date().toISOString().split('T')[0]
    
    const newStats: PersistentStatistics = {
      ...stats,
      totalRequests: stats.totalRequests + 1,
      successRequests: success ? stats.successRequests + 1 : stats.successRequests,
      failedRequests: success ? stats.failedRequests : stats.failedRequests + 1,
      totalLatency: success ? stats.totalLatency + latency : stats.totalLatency,
      lastUpdated: Date.now(),
      modelUsage: { ...stats.modelUsage },
      providerUsage: { ...stats.providerUsage },
      accountUsage: { ...stats.accountUsage },
      dailyStats: { ...stats.dailyStats },
    }
    
    if (model) {
      newStats.modelUsage[model] = (newStats.modelUsage[model] || 0) + 1
    }
    
    if (providerId) {
      newStats.providerUsage[providerId] = (newStats.providerUsage[providerId] || 0) + 1
    }
    
    if (accountId) {
      newStats.accountUsage[accountId] = (newStats.accountUsage[accountId] || 0) + 1
    }
    
    if (!newStats.dailyStats[today]) {
      newStats.dailyStats[today] = {
        date: today,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        modelUsage: {},
        providerUsage: {},
      }
    }
    
    newStats.dailyStats[today].totalRequests++
    if (success) {
      newStats.dailyStats[today].successRequests++
      newStats.dailyStats[today].totalLatency += latency
    } else {
      newStats.dailyStats[today].failedRequests++
    }
    
    if (model) {
      newStats.dailyStats[today].modelUsage[model] = (newStats.dailyStats[today].modelUsage[model] || 0) + 1
    }
    
    if (providerId) {
      newStats.dailyStats[today].providerUsage[providerId] = (newStats.dailyStats[today].providerUsage[providerId] || 0) + 1
    }
    
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Get Today Statistics
   */
  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = new Date().toISOString().split('T')[0]
    return stats.dailyStats[today] || {
      date: today,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      modelUsage: {},
      providerUsage: {},
    }
  }

  /**
   * Clean Old Daily Statistics (older than 30 days)
   */
  cleanOldDailyStats(): void {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const cutoffDate = new Date(cutoff).toISOString().split('T')[0]
    
    const filteredDailyStats: Record<string, DailyStatistics> = {}
    for (const [date, dayStats] of Object.entries(stats.dailyStats)) {
      if (date >= cutoffDate) {
        filteredDailyStats[date] = dayStats as DailyStatistics
      }
    }
    
    if (Object.keys(filteredDailyStats).length !== Object.keys(stats.dailyStats).length) {
      stats.dailyStats = filteredDailyStats
      this.store!.set('statistics', stats)
    }
  }

  // ==================== System Prompts Operations ====================

  /**
   * Get All System Prompts
   * Merges built-in prompts with custom prompts
   */
  getSystemPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    const customPrompts = this.store!.get('systemPrompts') || []
    return [...BUILTIN_PROMPTS, ...customPrompts]
  }

  /**
   * Get Built-in System Prompts
   */
  getBuiltinPrompts(): SystemPrompt[] {
    return BUILTIN_PROMPTS
  }

  /**
   * Get Custom System Prompts
   */
  getCustomPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    return this.store!.get('systemPrompts') || []
  }

  /**
   * Get System Prompt By ID
   */
  getSystemPromptById(id: string): SystemPrompt | undefined {
    return this.getSystemPrompts().find(p => p.id === id)
  }

  /**
   * Add Custom System Prompt
   */
  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    this.ensureInitialized()
    const prompts = this.store!.get('systemPrompts') || []
    
    const newPrompt: SystemPrompt = {
      ...prompt,
      id: this.generateId(),
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    prompts.push(newPrompt)
    this.store!.set('systemPrompts', prompts)
    
    return newPrompt
  }

  /**
   * Update Custom System Prompt
   * Cannot update built-in prompts
   */
  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    this.ensureInitialized()
    
    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot update built-in prompt:', id)
      return null
    }
    
    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    
    if (index === -1) {
      return null
    }
    
    prompts[index] = {
      ...prompts[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    this.store!.set('systemPrompts', prompts)
    return prompts[index]
  }

  /**
   * Delete Custom System Prompt
   * Cannot delete built-in prompts
   */
  deleteSystemPrompt(id: string): boolean {
    this.ensureInitialized()
    
    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot delete built-in prompt:', id)
      return false
    }
    
    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    
    if (index === -1) {
      return false
    }
    
    prompts.splice(index, 1)
    this.store!.set('systemPrompts', prompts)
    
    return true
  }

  /**
   * Get System Prompts By Type
   */
  getSystemPromptsByType(type: SystemPrompt['type']): SystemPrompt[] {
    return this.getSystemPrompts().filter(p => p.type === type)
  }

  // ==================== Session Operations ====================

  /**
   * Get Session Configuration
   */
  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.getConfig()
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  /**
   * Update Session Configuration
   */
  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.getConfig()
    const newSessionConfig = {
      ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG),
      ...updates,
    }
    const newConfig = {
      ...currentConfig,
      sessionConfig: newSessionConfig,
    }
    this.writeStoredConfig(newConfig)
    return newSessionConfig
  }

  /**
   * Get All Sessions
   */
  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.store!.get('sessions') || []
  }

  /**
   * Get Session By ID
   */
  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.find((s: SessionRecord) => s.id === id)
  }

  /**
   * Get Active Sessions
   */
  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    return sessions.filter((s: SessionRecord) => 
      s.status === 'active' && 
      (now - s.lastActiveAt) < timeoutMs
    )
  }

  /**
   * Add Session
   */
  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    sessions.push(session)
    this.store!.set('sessions', sessions)
  }

  /**
   * Update Session
   */
  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return null
    }
    
    sessions[index] = {
      ...sessions[index],
      ...updates,
    }
    
    this.store!.set('sessions', sessions)
    return sessions[index]
  }

  /**
   * Add Message to Session
   */
  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === sessionId)
    
    if (index === -1) {
      return null
    }
    
    const config = this.getSessionConfig()
    const session = sessions[index]
    
    if (session.messages.length >= config.maxMessagesPerSession) {
      session.messages = session.messages.slice(-config.maxMessagesPerSession + 1)
    }
    
    session.messages.push(message)
    session.lastActiveAt = Date.now()
    
    sessions[index] = session
    this.store!.set('sessions', sessions)
    return session
  }

  /**
   * Delete Session
   */
  deleteSession(id: string): boolean {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return false
    }
    
    sessions.splice(index, 1)
    this.store!.set('sessions', sessions)
    return true
  }

  /**
   * Mark Session as Expired
   */
  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  /**
   * Clean Expired Sessions
   * Always delete sessions with 'expired' status
   * For timed-out active sessions, behavior depends on deleteAfterTimeout config:
   * - If true: Delete them from storage
   * - If false: Mark them as 'expired' (will be deleted on next clean)
   */
  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    let removedCount = 0
    
    // Always delete sessions that are already expired
    let remainingSessions = sessions.filter((s: SessionRecord) => {
      if (s.status === 'expired') {
        removedCount++
        return false
      }
      return true
    })
    
    // Handle timed-out active sessions based on config
    if (config.deleteAfterTimeout) {
      // Delete timed-out sessions from storage
      remainingSessions = remainingSessions.filter((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return false
        }
        return true
      })
    } else {
      // Mark timed-out sessions as expired (will be deleted on next clean)
      remainingSessions = remainingSessions.map((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return { ...s, status: 'expired' as const }
        }
        return s
      })
    }
    
    this.store!.set('sessions', remainingSessions)
    
    return removedCount
  }

  /**
   * Get Sessions By Account ID
   */
  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.accountId === accountId)
  }

  /**
   * Get Sessions By Provider ID
   */
  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.providerId === providerId)
  }

  /**
   * Clear All Sessions
   */
  clearAllSessions(): void {
    this.ensureInitialized()
    this.store!.set('sessions', [])
  }

  // ==================== Model Management Operations ====================

  /**
   * Get User Model Overrides
   */
  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
  }

  /**
   * Set User Model Overrides
   */
  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.store!.set('userModelOverrides', overrides)
  }

  /**
   * Get Provider Model Overrides
   */
  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return overrides[providerId] || {
      addedModels: [],
      excludedModels: [],
    }
  }

  /**
   * Get Effective Models for a Provider
   * Merges default models with user overrides
   */
  getEffectiveModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const provider = this.getProviderById(providerId)
    if (!provider) {
      return []
    }

    const defaultModels = provider.supportedModels || []
    const modelMappings = provider.modelMappings || {}
    const overrides = this.getProviderModelOverrides(providerId)

    const effectiveModels: EffectiveModel[] = []

    defaultModels.forEach(displayName => {
      if (!overrides.excludedModels.includes(displayName)) {
        const actualModelId = modelMappings[displayName] || displayName
        effectiveModels.push({
          displayName,
          actualModelId,
          isCustom: false,
        })
      }
    })

    overrides.addedModels.forEach(customModel => {
      effectiveModels.push({
        displayName: customModel.displayName,
        actualModelId: customModel.actualModelId,
        isCustom: true,
      })
    })

    return effectiveModels
  }

  /**
   * Add Custom Model to Provider
   */
  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const existingModel = overrides[providerId].addedModels.find(
      m => m.displayName === model.displayName || m.actualModelId === model.actualModelId
    )
    
    if (existingModel) {
      throw new Error(`Model with display name "${model.displayName}" or actual ID "${model.actualModelId}" already exists`)
    }

    overrides[providerId].addedModels.push(model)
    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Remove Model from Provider
   * For default models: add to excludedModels
   * For custom models: remove from addedModels
   */
  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const provider = this.getProviderById(providerId)
    if (!provider) {
      throw new Error('Provider not found')
    }

    const overrides = this.getUserModelOverrides()
    
    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const defaultModels = provider.supportedModels || []
    const isDefaultModel = defaultModels.includes(modelName)

    if (isDefaultModel) {
      if (!overrides[providerId].excludedModels.includes(modelName)) {
        overrides[providerId].excludedModels.push(modelName)
      }
    } else {
      overrides[providerId].addedModels = overrides[providerId].addedModels.filter(
        m => m.displayName !== modelName
      )
    }

    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Reset Provider Models to Default
   * Removes all user overrides for the provider
   */
  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (overrides[providerId]) {
      delete overrides[providerId]
      this.setUserModelOverrides(overrides)
    }

    const builtinConfig = BUILTIN_PROVIDERS.find(provider => provider.id === providerId)
    if (builtinConfig) {
      const providers = this.readStoredProviders().map(provider => {
        if (provider.id !== providerId || provider.type !== 'builtin') {
          return provider
        }

        const { modelCatalog: _staleCatalog, ...providerWithoutCatalog } = provider
        return {
          ...providerWithoutCatalog,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
          headers: builtinConfig.headers,
          credentialFields: builtinConfig.credentialFields,
          description: builtinConfig.description,
          updatedAt: Date.now(),
        }
      })
      this.writeStoredProviders(providers)
    }

    return this.getEffectiveModels(providerId)
  }

  // ==================== Utility Methods ====================

  /**
   * Generate Unique ID
   */
  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Get Storage Instance (for internal use only)
   */
  getStore(): StoreType | null {
    return this.store
  }

  /**
   * Clear All Data
   */
  clearAll(): void {
    this.ensureInitialized()
    this.appLogManager?.clearLogs()
    this.appLogManager?.flushSync()
    this.store!.clear()
    this.requestLogManager?.clearRequestLogs()
    this.requestLogManager?.flushSync()
  }

  /**
   * Export Data (for backup)
   * Does not include encrypted credential data
   */
  exportData(): Omit<StoreSchema, 'accounts'> & { accounts: Omit<Account, 'credentials'>[] } {
    this.ensureInitialized()
    const providers = this.readStoredProviders().map(provider => ({ ...provider, headers: {} }))
    const accounts = (this.store!.get('accounts') || []).map((a: Account) => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = redactExportConfigSecrets(this.getConfig())
    const logs = this.getAppLogManager().exportLogs()
    const requestLogs = this.getRequestLogManager().exportRequestLogs()
    const systemPrompts = this.store!.get('systemPrompts') || []
    const sessions = this.store!.get('sessions') || []
    const statistics = this.store!.get('statistics') || DEFAULT_STATISTICS
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    
    return {
      providers,
      accounts,
      config,
      logs,
      requestLogs,
      systemPrompts,
      sessions,
      statistics,
      userModelOverrides,
    }
  }

  /**
   * Get Storage Path
   */
  getStorePath(): string {
    return this.getStoragePath()
  }

  private getRequestLogManager(): RequestLogManager {
    if (!this.requestLogManager) {
      throw new Error('Request log manager is not initialized')
    }
    return this.requestLogManager
  }

  private getAppLogManager(): AppLogManager {
    if (!this.appLogManager) {
      throw new Error('App log manager is not initialized')
    }
    return this.appLogManager
  }
}

// Export singleton instance
export const storeManager = new StoreManager()

// Export types
export type { StoreType }
