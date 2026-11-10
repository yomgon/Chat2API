import { ipcMain, app, BrowserWindow, dialog, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { IpcChannels } from './channels'
import { storeManager } from '../store/store'
import { ProviderManager } from '../store/providers'
import { AccountManager } from '../store/accounts'
import { ProviderChecker } from '../providers/checker'
import { CustomProviderManager } from '../providers/custom'
import { parseProviderModelCatalog } from '../providers/modelCatalog'
import { parseDeepSeekWebModelCatalog } from '../providers/deepseekWebModelCatalog'
import { parseQwenChinaWebModelCatalog } from '../providers/qwenChinaModelCatalog'
import { fetchGLMGuestBrowserCatalog } from '../providers/glmGuestBrowserCatalog'
import { parseKimiWebChatCatalog, parseMimoWebChatCatalog } from '../providers/webModelSourceParsers'
import { getBuiltinProviders, getBuiltinProvider } from '../providers/builtin'
import { oauthManager } from '../oauth/manager'
import { isTrustedIpcSender } from './trustedSender'
import { isSafeExternalLink } from '../window/navigationGuard'
import { proxyServer } from '../proxy/server'
import { proxyStatusManager } from '../proxy/status'
import { sessionManager } from '../proxy/sessionManager'
import { TrayManager } from '../tray/TrayManager'
import { ConfigManager } from '../store/config'
import { generateManagementSecret } from '../proxy/middleware/managementAuth'
import { buildSmokeFixture, getLatestToolCallingSmokeResult, setLatestToolCallingSmokeResult } from '../proxy/toolCalling/diagnostics'
import type { ToolClientAdapterId } from '../../shared/toolCalling'
import { UpdaterManager } from '../updater'
import { DeepSeekAdapter } from '../proxy/adapters/deepseek'
import { GLMAdapter } from '../proxy/adapters/glm'
import { KimiAdapter } from '../proxy/adapters/kimi'
import { MimoAdapter } from '../proxy/adapters/mimo'
import { MiniMaxAdapter } from '../proxy/adapters/minimax'
import { PerplexityAdapter } from '../proxy/adapters/perplexity'
import { QwenAdapter } from '../proxy/adapters/qwen'
import { QwenAiAdapter } from '../proxy/adapters/qwen-ai'
import { ZaiAdapter } from '../proxy/adapters/zai'
import type { Provider, Account, ProxyStatus, ProviderCheckResult, OAuthResult, AuthType, CredentialField, LogLevel, LogEntry, ProviderVendor, AppConfig } from '../../shared/types'
import type { SystemPrompt, SessionConfig, SessionRecord, ManagementApiConfig } from '../store/types'
import type { AppConfig as StoreAppConfig } from '../store/types'
import type { ProviderType } from '../oauth/types'

const updaterManager = UpdaterManager.getInstance()

type TrustedInvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

function makeTrustedHandler(owner: BrowserWindow | null) {
  const expectedPage = process.env.NODE_ENV === 'development'
    ? (process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173')
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  return (channel: string, listener: TrustedInvokeHandler): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event, owner, expectedPage)) {
        throw new Error('Untrusted renderer IPC request')
      }
      return listener(event, ...args)
    })
  }
}

const clearChatsHandlers: Record<string, (provider: Provider, account: Account) => Promise<boolean>> = {
  kimi: async (provider, account) => new KimiAdapter(provider, account).deleteAllChats(),
  qwen: async (provider, account) => new QwenAdapter(provider, account).deleteAllChats(),
  'qwen-ai': async (provider, account) => new QwenAiAdapter(provider, account).deleteAllChats(),
  minimax: async (provider, account) => new MiniMaxAdapter(provider, account).deleteAllChats(),
  zai: async (provider, account) => new ZaiAdapter(provider, account).deleteAllChats(),
  perplexity: async (provider, account) => new PerplexityAdapter(provider, account).deleteAllChats(),
  deepseek: async (provider, account) => new DeepSeekAdapter(provider, account).deleteAllChats(),
  glm: async (provider, account) => new GLMAdapter(provider, account).deleteAllChats(),
  mimo: async (provider, account) => new MimoAdapter(provider, account).deleteAllChats(),
}

/**
 * Explicit, read-only discovery against a trusted BUILT-IN web-chat catalog.
 * Never query a caller-controlled provider URL or mix a developer API catalog
 * into a web-login account. Preserve the prior list on every failure.
 */
async function refreshBuiltinWebModelCatalog(providerId: string): Promise<{
  success: boolean
  modelsCount?: number
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  error?: string
}> {
  if (typeof providerId !== 'string') {
    return { success: false, error: 'Invalid provider identifier' }
  }
  // Every destination, HTTP method, and credential rule is hard-coded here,
  // independently of user-edited provider data. A web-login credential must
  // NEVER be sent to the similarly named paid developer API.
  const sources: Record<string, {
    url: string
    method: 'GET' | 'POST'
    sendCredentials: boolean
    parser: 'standard' | 'kimi-chat' | 'mimo-chat' | 'deepseek-modes' | 'qwen-china' | 'glm-guest'
  }> = {
    'qwen-ai': {
      url: 'https://chat.qwen.ai/api/models',
      method: 'GET', sendCredentials: true, parser: 'standard',
    },
    qwen: {
      url: 'https://chat2-api.qianwen.com/api/v1/model/list',
      method: 'GET', sendCredentials: false, parser: 'qwen-china',
    },
    zai: {
      url: 'https://chat.z.ai/api/models',
      method: 'GET', sendCredentials: true, parser: 'standard',
    },
    kimi: {
      url: 'https://www.kimi.com/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels',
      method: 'POST', sendCredentials: false, parser: 'kimi-chat',
    },
    mimo: {
      url: 'https://aistudio.xiaomimimo.com/open-apis/bot/config',
      method: 'GET', sendCredentials: false, parser: 'mimo-chat',
    },
    deepseek: {
      url: 'https://chat.deepseek.com/api/v0/client/settings?scope=model',
      method: 'GET', sendCredentials: false, parser: 'deepseek-modes',
    },
    glm: {
      url: 'https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models',
      method: 'GET', sendCredentials: false, parser: 'glm-guest',
    },
  }
  const source = Object.prototype.hasOwnProperty.call(sources, providerId)
    ? sources[providerId] : undefined
  const provider = ProviderManager.getById(providerId)
  if (!provider) {
    return { success: false, error: 'Provider not found' }
  }
  const builtin = provider.type === 'builtin' ? getBuiltinProvider(providerId) : undefined
  if (!source || !builtin?.modelsApiEndpoint) {
    return {
      success: false,
      error: 'No verified web-chat model catalog for this provider. Use Manage Models for manual entries.',
    }
  }

  // The endpoint is shipped in trusted built-in metadata, not the saved
  // provider. Exact equality also pins an optional source-defined query.
  let endpoint: URL
  try {
    endpoint = new URL(builtin.modelsApiEndpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.hash || endpoint.port
      || builtin.modelsApiEndpoint !== source.url
      || (builtin.modelsApiMethod || 'GET') !== source.method) {
      return { success: false, error: 'Model catalog endpoint is not trusted' }
    }
  } catch {
    return { success: false, error: 'Model catalog endpoint is not trusted' }
  }

  try {
    if (source.parser === 'glm-guest') {
      // GLM requires a signed first-party web session; a simple anonymous
      // GET is rejected. ONLY the first-party guest site's public picker is
      // read, using an isolated ephemeral browser. Never decrypt, refresh,
      // rotate, read or send the existing GLM account credentials here.
      const catalog = await fetchGLMGuestBrowserCatalog()
      const updated = ProviderManager.update(providerId, {
        supportedModels: catalog.supportedModels,
        modelMappings: catalog.modelMappings,
        modelCatalog: { source: 'provider-web', syncedAt: Date.now() },
      })
      if (!updated) {
        return { success: false, error: 'GLM guest website catalog update was not saved' }
      }
      return { success: true, modelsCount: catalog.supportedModels.length, ...catalog }
    }

    // A public website catalog does not require any local account or secret.
    // Only the explicitly credentialed first-party sources look up/decrypt an
    // active account; never touch credentials for Kimi, MiMo or DeepSeek.
    const activeAccount = source.sendCredentials
      ? AccountManager.getByProviderId(providerId, true).find(account => account.status === 'active')
      : undefined
    if (source.sendCredentials && !activeAccount) {
      return { success: false, error: 'Connect an active provider account before refreshing models' }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...builtin.modelsApiHeaders,
    }
    if (source.sendCredentials) {
      if (typeof activeAccount?.credentials?.token === 'string' && activeAccount.credentials.token) {
        headers.Authorization = `Bearer ${activeAccount.credentials.token}`
      }
      if (typeof activeAccount?.credentials?.cookies === 'string' && activeAccount.credentials.cookies) {
        headers.Cookie = activeAccount.credentials.cookies
      }
      if (providerId === 'zai') {
        // The current first-party Z.ai picker includes browser credentials
        // and a conditional Bearer token on GET /api/models. The saved web
        // JWT is our only known account token, so provide its same-origin
        // token cookie as well. Neither header alone proves authorization.
        const token = activeAccount?.credentials?.token
        const segments = typeof token === 'string' ? token.split('.') : []
        if (typeof token !== 'string' || token.length > 8192 ||
          !token.startsWith('eyJ') || segments.length !== 3 ||
          !segments.every(segment => segment.length > 0 && /^[A-Za-z0-9_=-]+$/.test(segment))) {
          return { success: false, error: 'Z.ai web session credential format is invalid; reconnect this account' }
        }
        // Local account registration checked the JWT shape but not expiry.
        // Reject a clearly expired self-described session before a needless
        // remote GET. This is not cryptographic signature validation.
        try {
          const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return { success: false, error: 'Z.ai web session credential format is invalid; reconnect this account' }
          }
          if (Object.prototype.hasOwnProperty.call(payload, 'exp')) {
            if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
              return { success: false, error: 'Z.ai web session expiry is invalid; reconnect this account' }
            }
            if (payload.exp <= Math.floor(Date.now() / 1000)) {
              return { success: false, error: 'Z.ai web session has expired; reconnect this account' }
            }
          }
        } catch {
          return { success: false, error: 'Z.ai web session credential format is invalid; reconnect this account' }
        }
        headers.Cookie = `token=${token}`
      }
    }

    const requestOptions = {
      headers,
      timeout: 15_000,
      maxRedirects: 0,
      maxContentLength: 512 * 1024,
      responseType: 'json',
      validateStatus: () => true,
    } as const
    // Kimi's GetAvailableModels is a read-only config RPC that uses POST.
    // It receives {}, never a conversation or saved account secrets.
    let requestUrl = source.url
    if (source.parser === 'deepseek-modes') {
      requestUrl += `&did=${encodeURIComponent(randomUUID())}`
    } else if (source.parser === 'qwen-china') {
      // Current first-party Qwen China frontend uses these public common
      // parameters for CHAT_NA. Anonymous GET succeeds with a fresh synthetic
      // per-request ut; never send the saved SSO ticket for discovery.
      const params = new URLSearchParams({
        biz_id: 'ai_qwen', chat_client: 'h5', device: 'pc',
        fr: 'pc', pr: 'qwen', ut: randomUUID(),
        la: 'zh_CN', tz: 'Asia/Shanghai', wv: '1', ve: '1',
      })
      requestUrl += `?${params.toString()}`
    }
    const response = source.method === 'POST'
      ? await axios.post(source.url, {}, requestOptions)
      : await axios.get(requestUrl, requestOptions)
    if (response.status !== 200) {
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: `Web-chat model catalog rejected account access (HTTP ${response.status}); check the web login session. Existing list kept`,
        }
      }
      if (response.status === 429) {
        return { success: false, error: 'Web-chat model catalog rate-limited (HTTP 429); existing list kept' }
      }
      return {
        success: false,
        error: `Web-chat model catalog returned HTTP ${Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 'error'}; existing list kept`,
      }
    }
    let catalog: { supportedModels: string[]; modelMappings: Record<string, string> }
    try {
      catalog = source.parser === 'deepseek-modes'
        ? parseDeepSeekWebModelCatalog(response.data)
        : source.parser === 'qwen-china'
          ? parseQwenChinaWebModelCatalog(response.data)
        : source.parser === 'kimi-chat'
        ? parseKimiWebChatCatalog(response.data)
        : source.parser === 'mimo-chat'
          ? parseMimoWebChatCatalog(response.data)
          : parseProviderModelCatalog(providerId, response.data)
    } catch {
      return { success: false, error: 'Web-chat model catalog response format is unsupported; existing list kept' }
    }
    const updated = ProviderManager.update(providerId, {
      supportedModels: catalog.supportedModels,
      modelMappings: catalog.modelMappings,
      modelCatalog: { source: 'provider-web', syncedAt: Date.now() },
    })
    if (!updated) {
      return { success: false, error: 'Model catalog update was not saved' }
    }
    return { success: true, modelsCount: catalog.supportedModels.length, ...catalog }
  } catch (error) {
    if (source?.parser === 'glm-guest') {
      // Authored, fixed stage code only; never surface first-party JS errors,
      // request objects, headers, account or response payload.
      const stage = error instanceof Error
        ? /^GLM_GUEST_CATALOG_(page-load|same-origin|first-party-action|first-party-response|model-schema|no-app-root|no-vue-mount|no-store|no-action|evaluate-failed)$/.exec(error.message)?.[1]
        : undefined
      return {
        success: false,
        error: `GLM public guest website catalog unavailable (${stage || 'internal'}). Existing models were kept; account credentials were not used.`,
      }
    }
    // AxiosError contains headers and authorization; never log or return it.
    return { success: false, error: 'Web-chat model refresh failed; existing models were not changed' }
  }
}

export async function registerIpcHandlers(mainWindow: BrowserWindow | null): Promise<void> {
  const handleTrusted = makeTrustedHandler(mainWindow)
  try {
    await storeManager.initialize()
  } catch (error) {
    console.error('[IPC] Failed to initialize storage:')
    
    // Notify renderer about the initialization error
    mainWindow?.webContents.send(IpcChannels.STORE_INIT_ERROR, {
      message: error instanceof Error ? error.message : 'Failed to initialize storage',
    })
    
    // Still set mainWindow for potential recovery
    storeManager.setMainWindow(mainWindow)
    
    if (mainWindow) {
      oauthManager.setMainWindow(mainWindow)
    }
    
    // Register minimal IPC handlers for error recovery
    registerErrorRecoveryHandlers(mainWindow)
    return
  }
  
  storeManager.setMainWindow(mainWindow)
  
  if (mainWindow) {
    oauthManager.setMainWindow(mainWindow)
    updaterManager.initialize(mainWindow)
  }

  // Check if auto-start proxy is needed
  const config = storeManager.getConfig()
  if (config.autoStartProxy) {
    console.log('[App] Auto-starting proxy service...')
    const proxyPort = config.proxyPort
    const proxyHost = config.proxyHost || '127.0.0.1'
    try {
      const success = await proxyServer.start(proxyPort, proxyHost)
      if (success) {
        console.log('[App] Proxy service auto-started successfully, port:')
        const status: ProxyStatus = {
          isRunning: true,
          port: proxyPort,
          host: proxyHost,
          uptime: 0,
          connections: 0,
        }
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
      } else {
        console.log('[App] Proxy service auto-start failed')
      }
    } catch (error) {
      console.error('[App] Proxy service auto-start failed:')
    }
  }

  handleTrusted(IpcChannels.PROXY_START, async (_, port?: number): Promise<boolean> => {
    try {
      if (proxyServer.isRunning()) {
        console.log('Proxy server is already running')
        return true
      }

      const config = storeManager.getConfig()
      const proxyPort = port || config.proxyPort
      const proxyHost = config.proxyHost || '127.0.0.1'

      const success = await proxyServer.start(proxyPort, proxyHost)
      
      if (success) {
        const status: ProxyStatus = {
          isRunning: true,
          port: proxyPort,
          host: proxyHost,
          uptime: 0,
          connections: 0,
        }
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
        TrayManager.getInstance().updateProxyStatus(true)
      }
      
      return success
    } catch (error) {
      console.error('Failed to start proxy:')
      return false
    }
  })

  handleTrusted(IpcChannels.PROXY_STOP, async (): Promise<boolean> => {
    try {
      if (!proxyServer.isRunning()) {
        return true
      }

      const success = await proxyServer.stop()
      
      if (success) {
        const status: ProxyStatus = {
          isRunning: false,
          port: proxyStatusManager.getPort(),
          host: storeManager.getConfig().proxyHost || proxyStatusManager.getHost(),
          uptime: 0,
          connections: 0,
        }
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
        TrayManager.getInstance().updateProxyStatus(false)
      }
      
      return success
    } catch (error) {
      console.error('Failed to stop proxy:')
      return false
    }
  })

  handleTrusted(IpcChannels.PROXY_GET_STATUS, async (): Promise<ProxyStatus> => {
    const isRunning = proxyServer.isRunning()
    const port = proxyStatusManager.getPort()
    const host = isRunning
      ? proxyStatusManager.getHost()
      : storeManager.getConfig().proxyHost || proxyStatusManager.getHost()
    return {
      isRunning,
      port,
      host,
      uptime: proxyStatusManager.getRunningStatus().uptime,
      connections: proxyStatusManager.getStatistics().activeConnections,
    }
  })

  handleTrusted(IpcChannels.PROXY_GET_STATISTICS, async () => {
    const stats = proxyStatusManager.getStatistics()
    return {
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      avgLatency: stats.avgLatency,
      requestsPerMinute: stats.requestsPerMinute,
      activeConnections: stats.activeConnections,
      modelUsage: stats.modelUsage,
      providerUsage: stats.providerUsage,
      accountUsage: stats.accountUsage,
    }
  })

  handleTrusted(IpcChannels.PROXY_RESET_STATISTICS, async (): Promise<void> => {
    proxyStatusManager.resetStatistics()
  })

  handleTrusted(IpcChannels.CONFIG_GET, async () => {
    return storeManager.getConfig()
  })

  handleTrusted(IpcChannels.CONFIG_UPDATE, async (_, updates: Partial<AppConfig>) => {
    const newConfig = storeManager.updateConfig(updates as Partial<StoreAppConfig>)
    
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.CONFIG_CHANGED, newConfig)
      }
    })
    
    return true
  })

  handleTrusted(IpcChannels.STORE_CLEAR_ALL, async (): Promise<boolean> => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete local Chat2API data'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete private local Chat2API data?',
      message: 'Delete locally stored accounts, keys and settings for this private fork?',
      detail: 'Existing upstream Chat2API app data will not be affected.',
    })
    if (response.response !== 1) return false
    storeManager.clearAll()
    return true
  })

  handleTrusted(IpcChannels.PROVIDERS_GET_ALL, async (): Promise<Provider[]> => {
    return ProviderManager.getAll()
  })

  handleTrusted(IpcChannels.PROVIDERS_GET_BUILTIN, async () => {
    return getBuiltinProviders()
  })

  handleTrusted(IpcChannels.PROVIDERS_ADD, async (_, data: {
    id?: string
    name: string
    type?: 'builtin' | 'custom'
    authType: AuthType
    apiEndpoint: string
    headers?: Record<string, string>
    description?: string
    supportedModels?: string[]
    credentialFields?: CredentialField[]
  }): Promise<Provider> => {
    if (data?.type === 'builtin') {
      // A built-in provider must come from the shipped, trusted registry.
      // The previous creation path accepted renderer-supplied partial fields,
      // leaving chatPath and modelMappings unset for new accounts.
      const builtin = typeof data.id === 'string' ? getBuiltinProvider(data.id) : undefined
      if (!builtin || data.name !== builtin.name
        || data.authType !== builtin.authType || data.apiEndpoint !== builtin.apiEndpoint) {
        throw new Error('Invalid built-in provider configuration')
      }
      storeManager.ensureProviderExists(builtin.id)
      const created = ProviderManager.getById(builtin.id)
      if (!created || created.type !== 'builtin') {
        throw new Error('Built-in provider could not be initialized')
      }
      return created
    }
    if (data?.id && getBuiltinProvider(data.id)) {
      throw new Error('Built-in provider identity is reserved')
    }
    return CustomProviderManager.create(data)
  })

  handleTrusted(IpcChannels.PROVIDERS_UPDATE, async (_, id: string, updates: Partial<Provider>): Promise<Provider | null> => {
    return ProviderManager.update(id, updates)
  })

  handleTrusted(IpcChannels.PROVIDERS_DELETE, async (_, id: string): Promise<boolean> => {
    return CustomProviderManager.delete(id)
  })

  handleTrusted(IpcChannels.PROVIDERS_CHECK_STATUS, async (_, providerId: string): Promise<ProviderCheckResult> => {
    const provider = ProviderManager.getById(providerId)

    if (!provider) {
      return {
        providerId,
        status: 'unknown',
        error: 'Provider not found',
      }
    }

    const result = await ProviderChecker.checkProviderStatus(provider)
    
    // Save status to provider
    ProviderManager.update(providerId, {
      status: result.status,
      lastStatusCheck: Date.now(),
    })
    
    return result
  })

  handleTrusted(IpcChannels.PROVIDERS_CHECK_ALL_STATUS, async (): Promise<Record<string, ProviderCheckResult>> => {
    const providers = ProviderManager.getAll()
    const results: Record<string, ProviderCheckResult> = {}
    
    await Promise.all(
      providers.map(async (provider) => {
        const result = await ProviderChecker.checkProviderStatus(provider)
        results[provider.id] = result
        
        // Save status to provider
        ProviderManager.update(provider.id, {
          status: result.status,
          lastStatusCheck: Date.now(),
        })
      })
    )
    
    return results
  })

  handleTrusted(IpcChannels.PROVIDERS_DUPLICATE, async (_, id: string): Promise<Provider> => {
    return CustomProviderManager.duplicate(id)
  })

  handleTrusted(IpcChannels.PROVIDERS_EXPORT, async (_, id: string): Promise<string> => {
    return CustomProviderManager.exportProvider(id)
  })

  handleTrusted(IpcChannels.PROVIDERS_IMPORT, async (_, jsonData: string): Promise<Provider> => {
    return CustomProviderManager.importProvider(jsonData)
  })

  handleTrusted(IpcChannels.PROVIDERS_SYNC_MODELS, async (_, providerId: string) => {
    // Legacy private channel uses exactly the same guarded discovery contract.
    return refreshBuiltinWebModelCatalog(providerId)
  })

  handleTrusted(IpcChannels.PROVIDERS_UPDATE_MODELS, async (_, providerId: string) => {
    return refreshBuiltinWebModelCatalog(providerId)
  })

  handleTrusted(IpcChannels.PROVIDERS_GET_EFFECTIVE_MODELS, async (_, providerId: string) => {
    try {
      return storeManager.getEffectiveModels(providerId)
    } catch (error) {
      console.error('[IPC] Failed to get effective models:')
      return []
    }
  })

  handleTrusted(IpcChannels.PROVIDERS_ADD_CUSTOM_MODEL, async (_, providerId: string, model: { displayName: string; actualModelId: string }) => {
    try {
      return {
        success: true,
        models: storeManager.addCustomModel(providerId, model),
      }
    } catch (error) {
      console.error('[IPC] Failed to add custom model:')
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add custom model',
        models: [],
      }
    }
  })

  handleTrusted(IpcChannels.PROVIDERS_REMOVE_MODEL, async (_, providerId: string, modelName: string) => {
    try {
      return {
        success: true,
        models: storeManager.removeModel(providerId, modelName),
      }
    } catch (error) {
      console.error('[IPC] Failed to remove model:')
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove model',
        models: [],
      }
    }
  })

  handleTrusted(IpcChannels.PROVIDERS_RESET_MODELS, async (_, providerId: string) => {
    try {
      return {
        success: true,
        models: storeManager.resetModels(providerId),
      }
    } catch (error) {
      console.error('[IPC] Failed to reset models:')
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset models',
        models: [],
      }
    }
  })

  handleTrusted(IpcChannels.ACCOUNTS_GET_ALL, async (_, includeCredentials?: boolean): Promise<Account[]> => {
    return AccountManager.getAll(includeCredentials)
  })

  handleTrusted(IpcChannels.ACCOUNTS_GET_BY_ID, async (_, id: string, includeCredentials?: boolean): Promise<Account | null> => {
    return storeManager.getAccountById(id, includeCredentials) || null
  })

  handleTrusted(IpcChannels.ACCOUNTS_GET_BY_PROVIDER, async (_, providerId: string): Promise<Account[]> => {
    return storeManager.getAccountsByProviderId(providerId)
  })

  handleTrusted(IpcChannels.ACCOUNTS_ADD, async (_, data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }): Promise<Account> => {
    return AccountManager.create(data)
  })

  handleTrusted(IpcChannels.ACCOUNTS_UPDATE, async (_, id: string, updates: Partial<Account>): Promise<Account | null> => {
    return AccountManager.update(id, updates)
  })

  handleTrusted(IpcChannels.ACCOUNTS_DELETE, async (_, id: string): Promise<boolean> => {
    return AccountManager.delete(id)
  })

  handleTrusted(IpcChannels.ACCOUNTS_VALIDATE, async (_, accountId: string): Promise<boolean> => {
    const result = await AccountManager.validate(accountId)
    return result.valid
  })

  handleTrusted(IpcChannels.ACCOUNTS_VALIDATE_TOKEN, async (_, providerId: string, credentials: Record<string, string>) => {
    let provider = ProviderManager.getById(providerId)
    
    // If provider not in store, check builtin providers
    if (!provider) {
      const builtinConfig = getBuiltinProvider(providerId)
      if (builtinConfig) {
        provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          headers: builtinConfig.headers,
          enabled: true,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels || [],
          modelMappings: builtinConfig.modelMappings || {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
    }
    
    if (!provider) {
      return { valid: false, error: 'Provider not found' }
    }
    
    const tempAccount: Account = {
      id: 'temp',
      providerId,
      name: 'temp',
      credentials,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    return ProviderChecker.checkAccountToken(provider, tempAccount)
  })

  handleTrusted(IpcChannels.ACCOUNTS_GET_CREDITS, async (_, accountId: string): Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
  } | null> => {
    const account = AccountManager.getById(accountId, true)
    if (!account) {
      return null
    }
    
    const provider = ProviderManager.getById(account.providerId)
    if (!provider) {
      return null
    }

    if (provider.id !== 'minimax') {
      return null
    }

    try {
      const adapter = new MiniMaxAdapter(provider, account)
      return await adapter.getCredits()
    } catch (error) {
      console.error('[IPC] Failed to get credits:')
      return null
    }
  })

  handleTrusted(IpcChannels.ACCOUNTS_CLEAR_CHATS, async (_, accountId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const account = AccountManager.getById(accountId, true)
      if (!account) {
        return { success: false, error: 'Account not found' }
      }
      
      const provider = ProviderManager.getById(account.providerId)
      if (!provider) {
        return { success: false, error: 'Provider not found' }
      }

      const clearChats = clearChatsHandlers[provider.id]
      if (!clearChats) {
        return { success: false, error: 'This feature is not available for this provider' }
      }

      const success = await clearChats(provider, account)
      return { success }
    } catch (error) {
      console.error('[IPC] Failed to clear chats:')
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to clear chats' 
      }
    }
  })

  handleTrusted(IpcChannels.OAUTH_START_LOGIN, async (_, providerId: string, providerType: ProviderVendor): Promise<OAuthResult> => {
    console.log('Starting OAuth login:')
    return await oauthManager.startLogin({
      providerId,
      providerType: providerType as ProviderType,
    })
  })

  handleTrusted(IpcChannels.OAUTH_CANCEL_LOGIN, async (): Promise<void> => {
    console.log('Cancel OAuth login')
    await oauthManager.cancelLogin()
  })

  handleTrusted(IpcChannels.OAUTH_LOGIN_WITH_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, token: string, realUserID?: string, mimoUserId?: string, mimoPhToken?: string }): Promise<OAuthResult> => {
    return await oauthManager.loginWithToken(data.providerId, data.providerType as ProviderType, data.token, data.realUserID, data.mimoUserId, data.mimoPhToken)
  })

  handleTrusted(IpcChannels.OAUTH_START_IN_APP_LOGIN, async (_, data: { providerId: string, providerType: ProviderVendor, timeout?: number }): Promise<OAuthResult> => {
    console.log('Starting in-app OAuth login:')
    // The new-account and existing-account Z.ai flows own their credential
    // handling in main. Do not expose a Z.ai web token through the legacy
    // renderer-returning OAuth result after the protected routes ship.
    if (data?.providerId === 'zai' || data?.providerType === 'zai') {
      return {
        success: false,
        providerId: 'zai',
        providerType: 'zai',
        error: 'Use the protected Z.ai account connection flow',
      }
    }
    const config = storeManager.getConfig()
    const proxyMode = (config as any).oauthProxyMode || 'system'
    return await oauthManager.startInAppLogin(data.providerId, data.providerType as ProviderType, data.timeout, proxyMode)
  })

  // Narrow, trusted, existing-account-only re-authentication. Never accept
  // credentials, arbitrary URLs, partition names, or provider selection from UI.
  // The manager owns validation, storage, and secret handling entirely in main.
  handleTrusted(IpcChannels.OAUTH_RECONNECT_ZAI_ACCOUNT, async (_, accountId: unknown): Promise<{
    success: boolean
    accountId?: string
    reason?: string
  }> => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 256) {
      return { success: false, reason: 'INVALID_ACCOUNT' }
    }
    return oauthManager.reconnectZaiAccount(accountId)
  })

  // An explicitly initiated Z.ai *new-account* login. Main chooses the ID
  // before opening an account-scoped persistent browser, verifies the
  // first-party identity and performs the only OS-protected credential write.
  // Renderer supplies a display name only and receives no auth material.
  handleTrusted(IpcChannels.OAUTH_CREATE_ZAI_ACCOUNT, async (_, accountName: unknown): Promise<{
    success: boolean
    accountId?: string
    reason?: string
  }> => {
    if (typeof accountName !== 'string' || accountName.trim().length < 1 ||
        accountName.trim().length > 100 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(accountName)) {
      return { success: false, reason: 'invalid_account_name' }
    }
    return oauthManager.createZaiAccount(accountName.trim())
  })

  handleTrusted(IpcChannels.OAUTH_CANCEL_IN_APP_LOGIN, async (): Promise<void> => {
    console.log('Cancel in-app OAuth login')
    oauthManager.cancelInAppLogin()
  })

  handleTrusted(IpcChannels.OAUTH_IN_APP_LOGIN_STATUS, async (): Promise<boolean> => {
    return oauthManager.isInAppLoginOpen()
  })

  handleTrusted(IpcChannels.OAUTH_VALIDATE_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, credentials: Record<string, string> }) => {
    return await oauthManager.validateToken(data.providerId, data.providerType as ProviderType, data.credentials)
  })

  handleTrusted(IpcChannels.OAUTH_REFRESH_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, credentials: Record<string, string> }) => {
    return await oauthManager.refreshToken(data.providerId, data.providerType as ProviderType, data.credentials)
  })

  handleTrusted(IpcChannels.OAUTH_GET_STATUS, async (): Promise<string> => {
    return oauthManager.getStatus()
  })

  handleTrusted(IpcChannels.LOGS_GET, async (_, filter?: {
    level?: LogLevel | 'all'
    keyword?: string
    startTime?: number
    endTime?: number
    limit?: number
    offset?: number
  }): Promise<LogEntry[]> => {
    return storeManager.getLogs(filter)
  })

  handleTrusted(IpcChannels.LOGS_GET_STATS, async () => {
    return storeManager.getLogStats()
  })

  handleTrusted(IpcChannels.LOGS_GET_TREND, async (_, days?: number) => {
    return storeManager.getLogTrend(days)
  })

  handleTrusted(IpcChannels.LOGS_GET_ACCOUNT_TREND, async (_, accountId: string, days?: number) => {
    return storeManager.getAccountLogTrend(accountId, days)
  })

  handleTrusted(IpcChannels.LOGS_CLEAR, async (): Promise<void> => {
    storeManager.clearLogs()
  })

  handleTrusted(IpcChannels.LOGS_EXPORT, async (_, format?: 'json' | 'txt'): Promise<string> => {
    return storeManager.exportLogs(format)
  })

  handleTrusted(IpcChannels.LOGS_GET_BY_ID, async (_, id: string): Promise<LogEntry | undefined> => {
    return storeManager.getLogById(id)
  })

  // ==================== Request Logs Handlers ====================

  handleTrusted(IpcChannels.REQUEST_LOGS_GET, async (_, filter?: {
    status?: 'success' | 'error'
    providerId?: string
    limit?: number
  }) => {
    return storeManager.getRequestLogs(filter?.limit, filter)
  })

  handleTrusted(IpcChannels.REQUEST_LOGS_GET_BY_ID, async (_, id: string) => {
    return storeManager.getRequestLogById(id)
  })

  handleTrusted(IpcChannels.REQUEST_LOGS_GET_STATS, async () => {
    return storeManager.getRequestLogStats()
  })

  handleTrusted(IpcChannels.REQUEST_LOGS_GET_TREND, async (_, days?: number) => {
    return storeManager.getRequestLogTrend(days)
  })

  handleTrusted(IpcChannels.REQUEST_LOGS_CLEAR, async (): Promise<void> => {
    storeManager.clearRequestLogs()
  })

  // ==================== Statistics Handlers ====================

  handleTrusted(IpcChannels.STATISTICS_GET, async () => {
    return storeManager.getStatistics()
  })

  handleTrusted(IpcChannels.STATISTICS_GET_TODAY, async () => {
    return storeManager.getTodayStatistics()
  })

  handleTrusted(IpcChannels.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion()
  })

  handleTrusted(IpcChannels.APP_CHECK_UPDATE, async () => {
    try {
      await updaterManager.checkForUpdates()
      return updaterManager.getStatus()
    } catch (error) {
      console.error('[App] Check update error:')
      return {
        ...updaterManager.getStatus(),
        checking: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  handleTrusted(IpcChannels.APP_DOWNLOAD_UPDATE, async (): Promise<void> => {
    await updaterManager.downloadUpdate()
  })

  handleTrusted(IpcChannels.APP_INSTALL_UPDATE, async (): Promise<void> => {
    updaterManager.quitAndInstall()
  })

  handleTrusted(IpcChannels.APP_GET_UPDATE_STATUS, async () => {
    return updaterManager.getStatus()
  })

  handleTrusted(IpcChannels.APP_MINIMIZE, async (): Promise<void> => {
    mainWindow?.minimize()
  })

  handleTrusted(IpcChannels.APP_MAXIMIZE, async (): Promise<void> => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  handleTrusted(IpcChannels.APP_CLOSE, async (): Promise<void> => {
    const config = storeManager.getConfig()
    if (config.minimizeToTray) {
      mainWindow?.hide()
    } else {
      ;(app as typeof app & { isQuitting?: boolean }).isQuitting = true
      mainWindow?.close()
    }
  })

  handleTrusted(IpcChannels.APP_SHOW_WINDOW, async (): Promise<void> => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  handleTrusted(IpcChannels.APP_HIDE_WINDOW, async (): Promise<void> => {
    mainWindow?.hide()
  })

  handleTrusted(IpcChannels.APP_OPEN_EXTERNAL, async (_, url: string): Promise<void> => {
    if (!isSafeExternalLink(url)) throw new Error('External URL is not allowed')
    try {
      await shell.openExternal(url)
    } catch {
      console.error('[APP_OPEN_EXTERNAL] External browser launch failed')
      throw new Error('Unable to open external browser')
    }
  })

  // ==================== System Prompts Handlers ====================

  handleTrusted(IpcChannels.PROMPTS_GET_ALL, async (): Promise<SystemPrompt[]> => {
    return storeManager.getSystemPrompts()
  })

  handleTrusted(IpcChannels.PROMPTS_GET_BUILTIN, async (): Promise<SystemPrompt[]> => {
    return storeManager.getBuiltinPrompts()
  })

  handleTrusted(IpcChannels.PROMPTS_GET_CUSTOM, async (): Promise<SystemPrompt[]> => {
    return storeManager.getCustomPrompts()
  })

  handleTrusted(IpcChannels.PROMPTS_GET_BY_ID, async (_, id: string): Promise<SystemPrompt | undefined> => {
    return storeManager.getSystemPromptById(id)
  })

  handleTrusted(IpcChannels.PROMPTS_ADD, async (_, prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): Promise<SystemPrompt> => {
    return storeManager.addSystemPrompt(prompt)
  })

  handleTrusted(IpcChannels.PROMPTS_UPDATE, async (_, id: string, updates: Partial<SystemPrompt>): Promise<SystemPrompt | null> => {
    return storeManager.updateSystemPrompt(id, updates)
  })

  handleTrusted(IpcChannels.PROMPTS_DELETE, async (_, id: string): Promise<boolean> => {
    return storeManager.deleteSystemPrompt(id)
  })

  handleTrusted(IpcChannels.PROMPTS_GET_BY_TYPE, async (_, type: SystemPrompt['type']): Promise<SystemPrompt[]> => {
    return storeManager.getSystemPromptsByType(type)
  })

  // ==================== Session Management Handlers ====================

  handleTrusted(IpcChannels.SESSION_GET_CONFIG, async (): Promise<SessionConfig> => {
    return sessionManager.getSessionConfig()
  })

  handleTrusted(IpcChannels.SESSION_UPDATE_CONFIG, async (_, updates: Partial<SessionConfig>): Promise<SessionConfig> => {
    return sessionManager.updateSessionConfig(updates)
  })

  handleTrusted(IpcChannels.SESSION_GET_ALL, async (): Promise<SessionRecord[]> => {
    return sessionManager.getAllSessions()
  })

  handleTrusted(IpcChannels.SESSION_GET_ACTIVE, async (): Promise<SessionRecord[]> => {
    return sessionManager.getAllActiveSessions()
  })

  handleTrusted(IpcChannels.SESSION_GET_BY_ID, async (_, id: string): Promise<SessionRecord | undefined> => {
    return sessionManager.getSession(id)
  })

  handleTrusted(IpcChannels.SESSION_GET_BY_ACCOUNT, async (_, accountId: string): Promise<SessionRecord[]> => {
    return sessionManager.getSessionsByAccount(accountId)
  })

  handleTrusted(IpcChannels.SESSION_GET_BY_PROVIDER, async (_, providerId: string): Promise<SessionRecord[]> => {
    return sessionManager.getSessionsByProvider(providerId)
  })

  handleTrusted(IpcChannels.SESSION_DELETE, async (_, id: string): Promise<boolean> => {
    return sessionManager.deleteSession(id)
  })

  handleTrusted(IpcChannels.SESSION_CLEAR_ALL, async (): Promise<void> => {
    return sessionManager.clearAllSessions()
  })

  handleTrusted(IpcChannels.SESSION_CLEAN_EXPIRED, async (): Promise<number> => {
    return sessionManager.cleanExpiredSessions()
  })

  // ==================== Management API Handlers ====================

  handleTrusted(IpcChannels.MANAGEMENT_API_GET_CONFIG, async (): Promise<ManagementApiConfig> => {
    const config = ConfigManager.get()
    return config.managementApi
  })

  handleTrusted(IpcChannels.MANAGEMENT_API_UPDATE_CONFIG, async (_, updates: Partial<ManagementApiConfig>): Promise<ManagementApiConfig> => {
    const config = ConfigManager.get()
    const currentManagementConfig = config.managementApi
    const newManagementConfig = { ...currentManagementConfig, ...updates }
    
    ConfigManager.update({ managementApi: newManagementConfig })
    
    return newManagementConfig
  })

  handleTrusted(IpcChannels.MANAGEMENT_API_GENERATE_SECRET, async (): Promise<string> => {
    const newSecret = generateManagementSecret()
    
    const config = ConfigManager.get()
    const newManagementConfig = { ...config.managementApi, managementApiSecret: newSecret }
    ConfigManager.update({ managementApi: newManagementConfig })
    
    return newSecret
  })

  // Renderer-only diagnostics use the guarded native bridge directly. Calling
  // the management HTTP server from preload would expose its secret to fetch
  // and conflict with the local proxy's browser Origin protection.
  handleTrusted(IpcChannels.TOOL_CALLING_GET_STATUS, async () => {
    const config = ConfigManager.get()
    return {
      success: true,
      data: {
        config: config.toolCallingConfig,
        latestSmokeResult: getLatestToolCallingSmokeResult(),
      },
    }
  })

  handleTrusted(IpcChannels.TOOL_CALLING_RUN_SMOKE, async (_, input: { clientAdapterId?: ToolClientAdapterId }) => {
    const config = ConfigManager.get()
    const clientAdapterId = input?.clientAdapterId ?? config.toolCallingConfig.clientAdapterId
    const fixture = buildSmokeFixture(clientAdapterId)
    const result = setLatestToolCallingSmokeResult({
      success: true,
      category: 'pass',
      message: 'Smoke fixture generated. Send it through /v1/chat/completions with a mapped model to run a live provider smoke.',
      clientAdapterId,
      timestamp: Date.now(),
    })
    return { success: true, data: { result, fixture } }
  })

  // ==================== Context Management Handlers ====================

  handleTrusted(IpcChannels.CONTEXT_MANAGEMENT_GET_CONFIG, async () => {
    const config = ConfigManager.get()
    return config.contextManagement || {
      enabled: true,
      strategies: {
        slidingWindow: { enabled: true, maxMessages: 20 },
        tokenLimit: { enabled: false, maxTokens: 4000 },
        summary: { enabled: false, keepRecentMessages: 20 },
      },
      executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
    }
  })

  handleTrusted(IpcChannels.CONTEXT_MANAGEMENT_UPDATE_CONFIG, async (_, updates: Partial<any>) => {
    const config = ConfigManager.get()
    const defaultContextConfig = {
      enabled: true,
      strategies: {
        slidingWindow: { enabled: true, maxMessages: 20 },
        tokenLimit: { enabled: false, maxTokens: 4000 },
        summary: { enabled: false, keepRecentMessages: 20 },
      },
      executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
    }
    const currentContextConfig = config.contextManagement || defaultContextConfig
    const newContextConfig = {
      ...currentContextConfig,
      ...updates,
      strategies: {
        ...currentContextConfig.strategies,
        ...(updates.strategies || {}),
      },
    }
    
    ConfigManager.update({ contextManagement: newContextConfig })
    
    return newContextConfig
  })
  
  oauthManager.on('progress', (event) => {
    mainWindow?.webContents.send(IpcChannels.OAUTH_PROGRESS, event)
  })
}

export function getProxyStatus(): ProxyStatus {
  const isRunning = proxyServer.isRunning()
  const port = proxyStatusManager.getPort()
  const host = isRunning
    ? proxyStatusManager.getHost()
    : storeManager.getConfig().proxyHost || proxyStatusManager.getHost()
  return {
    isRunning,
    port,
    host,
    uptime: proxyStatusManager.getRunningStatus().uptime,
    connections: proxyStatusManager.getStatistics().activeConnections,
  }
}

function registerErrorRecoveryHandlers(mainWindow: BrowserWindow | null): void {
  const handleTrusted = makeTrustedHandler(mainWindow)
  let restartPending = false
  let retrying = false
  handleTrusted(IpcChannels.STORE_RETRY_INIT, async (): Promise<{ success: boolean; error?: string }> => {
    if (restartPending) return { success: true }
    if (retrying) return { success: false, error: 'Secure storage retry is already running' }
    retrying = true
    try {
      await storeManager.initialize()
      if (!storeManager.hasInitializationError()) {
        // This process only installed recovery IPC handlers. Reopen the app
        // with the full handler set; do not leave a half-initialized UI live.
        restartPending = true
        setTimeout(() => {
          app.relaunch()
          app.exit(0)
        }, 200)
        return { success: true }
      }
      return { 
        success: false, 
        error: 'Secure storage remains unavailable; existing data was preserved',
      }
    } catch {
      return { 
        success: false, 
        error: 'Secure storage remains unavailable; existing data was preserved',
      }
    } finally {
      retrying = false
    }
  })

  handleTrusted(IpcChannels.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion()
  })

  handleTrusted(IpcChannels.APP_CLOSE, async (): Promise<void> => {
    ;(app as typeof app & { isQuitting?: boolean }).isQuitting = true
    mainWindow?.close()
  })
}
