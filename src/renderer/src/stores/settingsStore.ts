import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import type { AppConfig } from '@/types/electron'
import i18n from '@/i18n'

export type Theme = 'light' | 'dark' | 'system'
export type Language = 'zh-CN' | 'en-US'
export type CloseBehavior = 'minimize' | 'close' | 'ask'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OAuthProxyMode = 'system' | 'none'

interface SettingsState {
  theme: Theme
  setTheme: (theme: Theme) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  proxyEnabled: boolean
  setProxyEnabled: (enabled: boolean) => void
  oauthProxyMode: OAuthProxyMode
  setOauthProxyMode: (mode: OAuthProxyMode) => void
  language: Language
  setLanguage: (language: Language) => void
  autoStart: boolean
  setAutoStart: (enabled: boolean) => void
  autoStartProxy: boolean
  setAutoStartProxy: (enabled: boolean) => void
  minimizeToTray: boolean
  setMinimizeToTray: (enabled: boolean) => void
  closeBehavior: CloseBehavior
  setCloseBehavior: (behavior: CloseBehavior) => void
  enableNotifications: boolean
  setEnableNotifications: (enabled: boolean) => void
  logLevel: LogLevel
  setLogLevel: (level: LogLevel) => void
  logRetentionDays: number
  setLogRetentionDays: (days: number) => void
  maxLogs: number
  setMaxLogs: (count: number) => void
  credentialEncryption: boolean
  setCredentialEncryption: (enabled: boolean) => void
  logDesensitization: boolean
  setLogDesensitization: (enabled: boolean) => void
  config: AppConfig | null
  setConfig: (config: AppConfig) => void
  updateConfig: (updates: Partial<AppConfig>) => Promise<void>
  fetchConfig: () => Promise<void>
}

export const SETTINGS_STORAGE_KEY = 'chat2api-settings'
const SETTINGS_STORAGE_VERSION = 1

type PersistedSettings = Partial<Pick<SettingsState,
  | 'theme' | 'sidebarCollapsed' | 'proxyEnabled' | 'oauthProxyMode' | 'language'
  | 'autoStart' | 'autoStartProxy' | 'minimizeToTray' | 'closeBehavior'
  | 'enableNotifications' | 'logLevel' | 'logRetentionDays' | 'maxLogs'
  | 'credentialEncryption' | 'logDesensitization'
>>

// Config (including API keys and management credentials) belongs to the main
// process. Only these validated preferences may cross the persistence boundary.
export function pickPersistedSettings(value: unknown): PersistedSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const settings: PersistedSettings = {}

  if (source.theme === 'light' || source.theme === 'dark' || source.theme === 'system') {
    settings.theme = source.theme
  }
  if (source.language === 'zh-CN' || source.language === 'en-US') {
    settings.language = source.language
  }
  if (source.oauthProxyMode === 'system' || source.oauthProxyMode === 'none') {
    settings.oauthProxyMode = source.oauthProxyMode
  }
  if (source.closeBehavior === 'minimize' || source.closeBehavior === 'close' || source.closeBehavior === 'ask') {
    settings.closeBehavior = source.closeBehavior
  }
  if (source.logLevel === 'debug' || source.logLevel === 'info' || source.logLevel === 'warn' || source.logLevel === 'error') {
    settings.logLevel = source.logLevel
  }
  const booleanKeys = [
    'sidebarCollapsed', 'proxyEnabled', 'autoStart', 'autoStartProxy',
    'minimizeToTray', 'enableNotifications', 'credentialEncryption', 'logDesensitization',
  ] as const
  for (const key of booleanKeys) {
    if (typeof source[key] === 'boolean') settings[key] = source[key]
  }
  if (typeof source.logRetentionDays === 'number' && Number.isInteger(source.logRetentionDays)
    && source.logRetentionDays >= 1 && source.logRetentionDays <= 365) {
    settings.logRetentionDays = source.logRetentionDays
  }
  if (typeof source.maxLogs === 'number' && Number.isInteger(source.maxLogs)
    && source.maxLogs >= 100 && source.maxLogs <= 100000) {
    settings.maxLogs = source.maxLogs
  }
  return settings
}

export function serializeSettings(value: unknown): string {
  return JSON.stringify({
    state: pickPersistedSettings(value),
    version: SETTINGS_STORAGE_VERSION,
  })
}

// Keep the legacy envelope/version so Zustand can run its migration. This also
// validates imports before anything is written to the current settings entry.
export function sanitizeStoredSettings(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid settings backup')
  const stored: unknown = JSON.parse(value)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Invalid settings backup')
  }
  const envelope = stored as Record<string, unknown>
  if (!envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state)) {
    throw new Error('Invalid settings backup')
  }
  if (envelope.version !== undefined && envelope.version !== 0 && envelope.version !== SETTINGS_STORAGE_VERSION) {
    throw new Error('Unsupported settings backup version')
  }
  return JSON.stringify({
    state: pickPersistedSettings(envelope.state),
    version: envelope.version ?? 0,
  })
}

function createSettingsStorage(): StateStorage {
  const storage = localStorage
  return {
    getItem: (name) => {
      const stored = storage.getItem(name)
      if (stored === null) return null
      let sanitized: string
      try {
        sanitized = sanitizeStoredSettings(stored)
      } catch {
        storage.removeItem(name)
        console.warn('Discarded invalid saved preferences.')
        return null
      }
      if (sanitized !== stored) {
        try {
          storage.setItem(name, sanitized)
        } catch {
          // A failed rewrite must not fall back to loading the original state.
          storage.removeItem(name)
          console.warn('Removed saved preferences after a storage write failure.')
        }
      }
      return sanitized
    },
    setItem: (name, value) => storage.setItem(name, sanitizeStoredSettings(value)),
    removeItem: (name) => storage.removeItem(name),
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      proxyEnabled: false,
      setProxyEnabled: (enabled) => set({ proxyEnabled: enabled }),
      oauthProxyMode: 'system',
      setOauthProxyMode: async (mode) => {
        set({ oauthProxyMode: mode })
        try {
          await window.electronAPI.config.update({ oauthProxyMode: mode })
        } catch (error) {
          console.error('Failed to update oauthProxyMode:')
        }
      },
      language: 'en-US',
      setLanguage: async (language) => {
        set({ language })
        await i18n.changeLanguage(language)
        try {
          await window.electronAPI.config.update({ language: language })
        } catch (error) {
          console.error('Failed to update language:')
        }
      },
      autoStart: false,
      setAutoStart: async (enabled) => {
        set({ autoStart: enabled })
        try {
          await window.electronAPI.config.update({ autoStart: enabled })
        } catch (error) {
          console.error('Failed to update autoStart:')
        }
      },
      autoStartProxy: false,
      setAutoStartProxy: async (enabled) => {
        set({ autoStartProxy: enabled })
        try {
          await window.electronAPI.config.update({ autoStartProxy: enabled })
        } catch (error) {
          console.error('Failed to update autoStartProxy:')
        }
      },
      minimizeToTray: true,
      setMinimizeToTray: (enabled) => set({ minimizeToTray: enabled }),
      closeBehavior: 'minimize',
      setCloseBehavior: (behavior) => set({ closeBehavior: behavior }),
      enableNotifications: true,
      setEnableNotifications: (enabled) => set({ enableNotifications: enabled }),
      logLevel: 'info',
      setLogLevel: (level) => set({ logLevel: level }),
      logRetentionDays: 30,
      setLogRetentionDays: (days) => set({ logRetentionDays: days }),
      maxLogs: 10000,
      setMaxLogs: (count) => set({ maxLogs: count }),
      credentialEncryption: true,
      setCredentialEncryption: (enabled) => set({ credentialEncryption: enabled }),
      logDesensitization: true,
      setLogDesensitization: (enabled) => set({ logDesensitization: enabled }),
      config: null,
      setConfig: (config) => set({ config }),
      updateConfig: async (updates) => {
        const currentConfig = get().config
        if (!currentConfig) return
        
        const newConfig = {
          ...currentConfig,
          ...updates,
          requestLogConfig: updates.requestLogConfig
            ? {
                ...currentConfig.requestLogConfig,
                ...updates.requestLogConfig,
              }
            : currentConfig.requestLogConfig,
        }
        set({ config: newConfig })
        
        try {
          await window.electronAPI.config.update(updates)
        } catch (error) {
          console.error('Failed to update config:')
          set({ config: currentConfig })
        }
      },
      fetchConfig: async () => {
        try {
          const config = await window.electronAPI.config.get()
          set({ 
            config,
            autoStart: config.autoStart,
            autoStartProxy: config.autoStartProxy,
            oauthProxyMode: config.oauthProxyMode || 'system',
            language: config.language || 'en-US',
          })
        } catch (error) {
          console.error('Failed to fetch config:')
        }
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: SETTINGS_STORAGE_VERSION,
      storage: createJSONStorage<PersistedSettings>(createSettingsStorage),
      partialize: pickPersistedSettings,
      migrate: (persistedState) => pickPersistedSettings(persistedState),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...pickPersistedSettings(persistedState),
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('Failed to restore saved preferences.')
          return
        }
        if (state?.language) {
          i18n.changeLanguage(state.language)
        }
      },
    }
  )
)
