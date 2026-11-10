/**
 * OAuth Flow Manager
 * Manages authentication flows for providers, including local callback server and browser login
 */

import { BrowserWindow, shell, app } from 'electron'
import * as electron from 'electron'
import http from 'http'
import { EventEmitter } from 'events'
import {
  ProviderType,
  OAuthResult,
  OAuthOptions,
  OAuthStatus,
  OAuthProgressEvent,
  TokenValidationResult,
  CredentialInfo,
} from './types'
import { createAdapter, BaseOAuthAdapter } from './adapters'
import { storeManager } from '../store/store'
import { inAppLoginManager, InAppLoginResult } from './inAppLogin'
import { readZaiSessionClaims, readZaiTokenIdentity, zaiPersistentPartition } from './zaiSession'

const DEFAULT_CALLBACK_PORT = 8311
const DEFAULT_TIMEOUT = 300000 // 5 minutes

const ZAI_AUTH_URL = 'https://chat.z.ai/api/v1/auths/'
const ZAI_AUTH_TIMEOUT = 12_000
const ZAI_AUTH_MAX_BYTES = 64 * 1024

export type ZaiReconnectReason =
  | 'invalid_account_id' | 'busy' | 'account_unavailable' | 'provider_unavailable'
  | 'identity_unavailable' | 'identity_mismatch' | 'invalid_session'
  | 'login_cancelled' | 'login_timeout' | 'login_failed' | 'login_changed'
  | 'authentication_failed' | 'authentication_timeout' | 'invalid_auth_response'
  | 'account_changed' | 'storage_unavailable'

export interface ZaiReconnectResult {
  success: boolean
  accountId?: string
  reason?: ZaiReconnectReason
}

export type ZaiCreateAccountReason = ZaiReconnectReason |
  'invalid_account_name' | 'duplicate_identity' | 'account_id_conflict'

export interface ZaiCreateAccountResult {
  success: boolean
  accountId?: string
  reason?: ZaiCreateAccountReason
}

type ZaiReconnectAttempt = {
  controller: AbortController
  abortReason?: ZaiReconnectReason
}
type ZaiVerificationResult = { token: string } | { reason: ZaiCreateAccountReason }
type InAppZaiReconnect = {
  accountId: string
  attempt: ZaiReconnectAttempt
  verify: (token: string) => Promise<ZaiVerificationResult>
  purpose?: 'create'
}
let zaiReconnectOwner: ZaiReconnectAttempt | null = null

function reconnectFailureReason(error?: string): ZaiReconnectReason {
  if (error === 'Login cancelled by user' || error === 'Login window was closed') return 'login_cancelled'
  if (error === 'Login timeout') return 'login_timeout'
  if (error === 'A login process is already in progress' || error === 'A login window is already open') return 'busy'
  switch (error) {
    case 'invalid_account_id': case 'busy': case 'account_unavailable': case 'provider_unavailable':
    case 'identity_unavailable': case 'identity_mismatch': case 'invalid_session':
    case 'login_cancelled': case 'login_timeout': case 'login_failed': case 'login_changed':
    case 'authentication_failed': case 'authentication_timeout': case 'invalid_auth_response':
    case 'account_changed': case 'storage_unavailable':
      return error
    default:
      return 'login_failed'
  }
}

/** Old expired claims identify a stored row, but never authenticate a login. */
function readZaiStoredIdentity(token: unknown) {
  return readZaiSessionClaims(token) || readZaiTokenIdentity(token)
}

/** Local eligibility for the protected server check, not proof of authentication. */
function readZaiLoginCandidate(token: unknown) {
  const identity = readZaiTokenIdentity(token)
  if (!identity || (identity.expiryKnown && readZaiSessionClaims(token)?.usable !== true)) return null
  return identity
}

/**
 * OAuth Manager class
 */
export class OAuthManager extends EventEmitter {
  private adapters: Map<string, BaseOAuthAdapter> = new Map()
  private mainWindow: BrowserWindow | null = null
  private inAppGeneration = 0
  private activeInAppLogin: { generation: number; cancel: () => void } | null = null
  private activeZaiReconnect: ZaiReconnectAttempt | null = null
  private currentLogin: {
    providerId: string
    adapter: BaseOAuthAdapter
    resolve: (result: OAuthResult) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  } | null = null

  constructor() {
    super()
  }

  /**
   * Set main window reference
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Get or create adapter
   */
  private getAdapter(providerId: string, providerType: ProviderType): BaseOAuthAdapter {
    const key = `${providerId}_${providerType}`
    
    if (!this.adapters.has(key)) {
      const adapter = createAdapter(providerType, {
        providerId,
        providerType,
        authMethods: [],
        callbackPort: DEFAULT_CALLBACK_PORT,
      })
      
      if (this.mainWindow) {
        adapter.setMainWindow(this.mainWindow)
      }
      
      adapter.setProgressCallback((event) => {
        this.emit('progress', event)
        this.sendProgressToRenderer(event)
      })
      
      this.adapters.set(key, adapter)
    }
    
    return this.adapters.get(key)!
  }

  /**
   * Send progress to renderer process
   */
  private sendProgressToRenderer(event: OAuthProgressEvent): void {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('oauth:progress', event)
      }
    } catch {
      // The renderer can close or reload during a login. A diagnostic delivery
      // failure must neither strand the login lock nor expose the exception.
      console.error('[OAuthManager] Login progress notification failed')
    }
  }

  /**
   * Start OAuth login flow
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    if (this.currentLogin || this.activeInAppLogin || zaiReconnectOwner) {
      return {
        success: false,
        providerId: options.providerId,
        providerType: options.providerType,
        error: 'A login process is already in progress',
      }
    }

    return new Promise((resolve, reject) => {
      const adapter = this.getAdapter(options.providerId, options.providerType)
      
      const timeout = setTimeout(() => {
        this.cancelLogin()
        const result: OAuthResult = {
          success: false,
          providerId: options.providerId,
          providerType: options.providerType,
          error: 'Login timeout',
        }
        resolve(result)
      }, options.timeout || DEFAULT_TIMEOUT)

      this.currentLogin = {
        providerId: options.providerId,
        adapter,
        resolve,
        reject,
        timeout,
      }

      this.emit('statusChange', 'pending')

      adapter.startLogin(options)
        .then((result) => {
          this.cleanup()
          resolve(result)
        })
        .catch((error) => {
          this.cleanup()
          reject(error)
        })
    })
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(
    providerId: string,
    providerType: ProviderType,
    token: string,
    realUserID?: string,
    mimoUserId?: string,
    mimoPhToken?: string
  ): Promise<OAuthResult> {
    const adapter = this.getAdapter(providerId, providerType)
    
    if ('loginWithToken' in adapter && typeof (adapter as any).loginWithToken === 'function') {
      return await (adapter as any).loginWithToken(providerId, token, realUserID, mimoUserId, mimoPhToken)
    }
    
    // For Mimo, validate with all three tokens
    if (providerType === 'mimo') {
      if (!mimoUserId || !mimoPhToken) {
        return {
          success: false,
          providerId,
          providerType,
          error: 'Mimo requires userId and phToken in addition to serviceToken',
        }
      }
      const validation = await adapter.validateToken({
        service_token: token,
        user_id: mimoUserId,
        ph_token: mimoPhToken,
      })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType,
          error: validation.error || 'Token validation failed',
        }
      }
      
      return {
        success: true,
        providerId,
        providerType,
        credentials: {
          service_token: token,
          user_id: mimoUserId,
          ph_token: mimoPhToken,
        },
        accountInfo: validation.accountInfo,
      }
    }
    
    const validation = await adapter.validateToken({ token })
    
    if (!validation.valid) {
      return {
        success: false,
        providerId,
        providerType,
        error: validation.error || 'Token validation failed',
      }
    }
    
    return {
      success: true,
      providerId,
      providerType,
      credentials: { token },
      accountInfo: validation.accountInfo,
    }
  }

  /**
   * Cancel current login flow
   */
  async cancelLogin(): Promise<void> {
    if (this.currentLogin) {
      await this.currentLogin.adapter.cancelLogin()
      this.cleanup()
      this.emit('statusChange', 'cancelled')
    }
  }

  /**
   * Clean up current login state
   */
  private cleanup(): void {
    if (this.currentLogin) {
      clearTimeout(this.currentLogin.timeout)
      this.currentLogin = null
    }
  }

  /**
   * Validate Token
   */
  async validateToken(
    providerId: string,
    providerType: ProviderType,
    credentials: Record<string, string>
  ): Promise<TokenValidationResult> {
    const adapter = this.getAdapter(providerId, providerType)
    return adapter.validateToken(credentials)
  }

  /**
   * Refresh Token
   */
  async refreshToken(
    providerId: string,
    providerType: ProviderType,
    credentials: Record<string, string>
  ): Promise<CredentialInfo | null> {
    const adapter = this.getAdapter(providerId, providerType)
    return adapter.refreshToken(credentials)
  }

  /**
   * Open browser
   */
  async openBrowser(url: string): Promise<void> {
    await shell.openExternal(url)
  }

  /**
   * Get current login status
   */
  getStatus(): OAuthStatus {
    return this.currentLogin || this.activeInAppLogin || this.activeZaiReconnect ? 'pending' : 'idle'
  }

  /**
   * Reconnect only the selected existing account. Credentials never leave main.
   * Expired or expiry-unknown old claims may identify the row. New credentials
   * require first-party authentication and valid expiry metadata when present.
   */
  async reconnectZaiAccount(accountId: string): Promise<ZaiReconnectResult> {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 256 ||
        /[\p{Cc}\p{Cf}]/u.test(accountId)) {
      return { success: false, reason: 'invalid_account_id' }
    }
    if (zaiReconnectOwner || this.currentLogin || this.activeInAppLogin ||
        inAppLoginManager.isWindowOpen?.()) {
      return { success: false, reason: 'busy' }
    }

    const attempt: ZaiReconnectAttempt = { controller: new AbortController() }
    zaiReconnectOwner = attempt
    this.activeZaiReconnect = attempt
    try {
      const stored = storeManager.getAccountById(accountId, true)
      if (!stored || stored.id !== accountId || stored.providerId !== 'zai') {
        return { success: false, reason: 'account_unavailable' }
      }
      const provider = storeManager.getProviderById('zai')
      if (!provider || provider.id !== 'zai' || provider.enabled !== true) {
        return { success: false, reason: 'provider_unavailable' }
      }
      const previousToken = stored.credentials?.token || stored.credentials?.accessToken || stored.credentials?.jwt
      const previousClaims = readZaiStoredIdentity(previousToken)
      // No stored server-verified identity field exists in the current schema.
      // Names and email addresses must never substitute for the original subject.
      if (!previousClaims || typeof previousToken !== 'string' ||
          !Number.isSafeInteger(stored.createdAt) || !Number.isSafeInteger(stored.updatedAt)) {
        return { success: false, reason: 'identity_unavailable' }
      }
      const snapshot = Object.freeze({
        id: stored.id,
        providerId: stored.providerId,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        status: stored.status,
        subject: previousClaims.subject,
        token: previousToken,
      })
      const config = storeManager.getConfig()
      const proxyMode = (config as { oauthProxyMode?: string }).oauthProxyMode === 'none' ? 'none' : 'system'
      const result = await this.runInAppLogin('zai', 'zai', DEFAULT_TIMEOUT, proxyMode, {
        accountId,
        attempt,
        verify: token => this.verifyZaiReconnectToken(accountId, token, snapshot.subject, attempt),
      })
      if (attempt.controller.signal.aborted || zaiReconnectOwner !== attempt) {
        return { success: false, reason: attempt.abortReason || 'login_cancelled' }
      }
      if (!result.success || !result.credentials) {
        return { success: false, reason: reconnectFailureReason(result.error) }
      }
      const token = result.credentials.token
      const claims = readZaiLoginCandidate(token)
      if (!claims || claims.subject !== snapshot.subject) {
        return { success: false, reason: 'invalid_session' }
      }

      // No await is allowed between this recheck and the synchronous store write.
      const current = storeManager.getAccountById(accountId, true)
      const currentProvider = storeManager.getProviderById('zai')
      const currentToken = current?.credentials?.token || current?.credentials?.accessToken || current?.credentials?.jwt
      if (attempt.controller.signal.aborted || zaiReconnectOwner !== attempt ||
          !current || current.id !== snapshot.id || current.providerId !== snapshot.providerId ||
          current.createdAt !== snapshot.createdAt || current.updatedAt !== snapshot.updatedAt ||
          current.status !== snapshot.status || currentToken !== snapshot.token ||
          readZaiStoredIdentity(currentToken)?.subject !== snapshot.subject ||
          !currentProvider || currentProvider.id !== 'zai' || currentProvider.enabled !== true) {
        return { success: false, reason: 'account_changed' }
      }
      if (!readZaiLoginCandidate(token)) {
        return { success: false, reason: 'invalid_session' }
      }

      // Retain stored provider-specific options (including CAPTCHA settings).
      // Never merge cookies or arbitrary keys captured from the login page.
      const credentials: Record<string, string> = { ...current.credentials, token }
      for (const alias of ['accessToken', 'jwt']) {
        if (Object.prototype.hasOwnProperty.call(current.credentials, alias)) {
          credentials[alias] = token
        }
      }
      const updated = storeManager.updateAccount(accountId, {
        credentials,
        status: 'active',
        errorMessage: undefined,
      })
      if (!updated || updated.id !== snapshot.id || updated.providerId !== 'zai') {
        return { success: false, reason: 'storage_unavailable' }
      }
      // The reconnect lock remains held through the durable update and receipt.
      try {
        this.emit('statusChange', 'success')
        this.sendProgressToRenderer({ status: 'success', message: 'Z.ai account reconnected' })
      } catch {
        // Notification failure must not turn a committed replacement into a
        // retryable failure. The redacted receipt remains authoritative.
        console.error('[OAuthManager] Reconnection notification failed')
      }
      return { success: true, accountId: snapshot.id }
    } catch {
      return { success: false, reason: 'storage_unavailable' }
    } finally {
      attempt.controller.abort()
      if (this.activeZaiReconnect === attempt) this.activeZaiReconnect = null
      if (zaiReconnectOwner === attempt) zaiReconnectOwner = null
    }
  }

  /**
   * Explicit new-account entry point. No row exists until authenticated login
   * and persistent-session flush succeed; credentials remain inside main.
   */
  async createZaiAccount(name: string): Promise<ZaiCreateAccountResult> {
    if (typeof name !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) {
      return { success: false, reason: 'invalid_account_name' }
    }
    const accountName = name.trim()
    if (!accountName || accountName.length > 100) {
      return { success: false, reason: 'invalid_account_name' }
    }
    if (zaiReconnectOwner || this.currentLogin || this.activeInAppLogin ||
        inAppLoginManager.isWindowOpen?.()) {
      return { success: false, reason: 'busy' }
    }

    const attempt: ZaiReconnectAttempt = { controller: new AbortController() }
    zaiReconnectOwner = attempt
    this.activeZaiReconnect = attempt
    try {
      const provider = storeManager.getProviderById('zai')
      if (!provider || provider.id !== 'zai' || provider.type !== 'builtin' || provider.enabled !== true) {
        return { success: false, reason: 'provider_unavailable' }
      }
      if (!this.readZaiAccountSubjects()) {
        return { success: false, reason: 'identity_unavailable' }
      }
      const accountId = storeManager.generateId()
      if (typeof accountId !== 'string' || !accountId || accountId.length > 256 ||
          accountId !== accountId.trim() || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(accountId)) {
        return { success: false, reason: 'storage_unavailable' }
      }
      // Never open another account's persistent partition on an ID collision.
      if (storeManager.getAccountById(accountId, false)) {
        return { success: false, reason: 'account_id_conflict' }
      }
      const config = storeManager.getConfig()
      const proxyMode = (config as { oauthProxyMode?: string }).oauthProxyMode === 'none' ? 'none' : 'system'
      const result = await this.runInAppLogin('zai', 'zai', DEFAULT_TIMEOUT, proxyMode, {
        accountId,
        attempt,
        purpose: 'create',
        verify: async token => {
          const claims = readZaiLoginCandidate(token)
          if (!claims) return { reason: 'invalid_session' }
          try {
            const subjects = this.readZaiAccountSubjects()
            if (!subjects) return { reason: 'identity_unavailable' }
            if (subjects.has(claims.subject)) return { reason: 'duplicate_identity' }
          } catch {
            return { reason: 'storage_unavailable' }
          }
          return this.verifyZaiReconnectToken(accountId, token, claims.subject, attempt)
        },
      })
      if (attempt.controller.signal.aborted || zaiReconnectOwner !== attempt) {
        return { success: false, reason: attempt.abortReason || 'login_cancelled' }
      }
      if (!result.success || !result.credentials) {
        return { success: false, reason: reconnectFailureReason(result.error) }
      }
      const token = result.credentials.token
      const claims = readZaiLoginCandidate(token)
      if (!claims) return { success: false, reason: 'invalid_session' }

      // Recheck current state after all awaits, including cookie persistence.
      // The synchronous add below is the only commit point and has no retry.
      const subjects = this.readZaiAccountSubjects()
      if (!subjects) return { success: false, reason: 'identity_unavailable' }
      if (subjects.has(claims.subject)) return { success: false, reason: 'duplicate_identity' }
      if (storeManager.getAccountById(accountId, false)) {
        return { success: false, reason: 'account_id_conflict' }
      }
      const currentProvider = storeManager.getProviderById('zai')
      if (!currentProvider || currentProvider.id !== 'zai' ||
          currentProvider.type !== 'builtin' || currentProvider.enabled !== true) {
        return { success: false, reason: 'provider_unavailable' }
      }
      if (attempt.controller.signal.aborted || zaiReconnectOwner !== attempt) {
        return { success: false, reason: attempt.abortReason || 'login_cancelled' }
      }
      if (!readZaiLoginCandidate(token)) return { success: false, reason: 'invalid_session' }
      const now = Date.now()
      storeManager.addAccount({
        id: accountId,
        providerId: 'zai',
        name: accountName,
        credentials: { token },
        status: 'active',
        createdAt: now,
        updatedAt: now,
        requestCount: 0,
        todayUsed: 0,
      })
      try {
        this.emit('statusChange', 'success')
        this.sendProgressToRenderer({ status: 'success', message: 'Z.ai account added' })
      } catch {
        // A notification or reentrant cancellation cannot undo a committed row.
        console.error('[OAuthManager] Account creation notification failed')
      }
      return { success: true, accountId }
    } catch {
      return { success: false, reason: 'storage_unavailable' }
    } finally {
      attempt.controller.abort()
      if (this.activeZaiReconnect === attempt) this.activeZaiReconnect = null
      if (zaiReconnectOwner === attempt) zaiReconnectOwner = null
    }
  }

  /** Read only Z.ai identities, including expired and expiry-unknown stored rows. */
  private readZaiAccountSubjects(): Set<string> | null {
    const subjects = new Set<string>()
    for (const account of storeManager.getAccountsByProviderId('zai', true)) {
      if (!account || account.providerId !== 'zai') return null
      let subject: string | undefined
      for (const key of ['token', 'accessToken', 'jwt']) {
        const token = account.credentials?.[key]
        if (token === undefined || token === '') continue
        const claims = readZaiStoredIdentity(token)
        if (!claims || (subject !== undefined && subject !== claims.subject)) return null
        subject = claims.subject
      }
      if (subject === undefined) return null
      subjects.add(subject)
    }
    return subjects
  }

  private async verifyZaiReconnectToken(
    accountId: string,
    token: string,
    subject: string,
    attempt: ZaiReconnectAttempt,
  ): Promise<ZaiVerificationResult> {
    const claims = readZaiLoginCandidate(token)
    if (!claims) return { reason: 'invalid_session' }
    if (claims.subject !== subject) return { reason: 'identity_mismatch' }
    if (attempt.controller.signal.aborted || zaiReconnectOwner !== attempt) {
      return { reason: attempt.abortReason || 'login_cancelled' }
    }

    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const requestController = new AbortController()
      const finish = (result: ZaiVerificationResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        attempt.controller.signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = () => {
        finish({ reason: attempt.abortReason || 'login_cancelled' })
        requestController.abort()
      }
      attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        // A superseded candidate's timeout must not revoke the whole login.
        finish({ reason: 'authentication_timeout' })
        requestController.abort()
      }, ZAI_AUTH_TIMEOUT)
      if (attempt.controller.signal.aborted) {
        onAbort()
        return
      }

      void (async () => {
        const browserSession = electron.session.fromPartition(zaiPersistentPartition(accountId))
        const response = await browserSession.fetch(ZAI_AUTH_URL, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'include',
          redirect: 'error',
          cache: 'no-store',
          signal: requestController.signal,
        })
        if (settled || requestController.signal.aborted) return
        if (response.status !== 200) {
          finish({ reason: 'authentication_failed' })
          return
        }
        // Electron ses.fetch does not populate Response.url/type reliably.
        // The request destination is fixed above and redirect:'error' forbids redirects.
        if (response.redirected !== false ||
            !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
          finish({ reason: 'invalid_auth_response' })
          return
        }
        const declaredLength = response.headers.get('content-length')
        if ((declaredLength !== null && (!/^\d+$/.test(declaredLength) ||
             Number(declaredLength) > ZAI_AUTH_MAX_BYTES)) || !response.body) {
          finish({ reason: 'invalid_auth_response' })
          return
        }

        const reader = response.body.getReader()
        const chunks: Buffer[] = []
        let bytes = 0
        try {
          while (true) {
            const next = await reader.read()
            if (settled || requestController.signal.aborted) {
              void reader.cancel().catch(() => {})
              return
            }
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > ZAI_AUTH_MAX_BYTES) {
              void reader.cancel().catch(() => {})
              finish({ reason: 'invalid_auth_response' })
              return
            }
            chunks.push(Buffer.from(next.value))
          }
        } finally {
          reader.releaseLock()
        }

        if (settled || requestController.signal.aborted || zaiReconnectOwner !== attempt) return
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          finish({ reason: 'invalid_auth_response' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            typeof (body as Record<string, unknown>).id !== 'string') {
          finish({ reason: 'invalid_auth_response' })
          return
        }
        const user = body as Record<string, unknown>
        if (user.id !== subject) {
          finish({ reason: 'identity_mismatch' })
          return
        }
        // A present but invalid replacement token must not fall back to the candidate.
        const verifiedToken = Object.prototype.hasOwnProperty.call(user, 'token') ? user.token : token
        const verifiedClaims = readZaiLoginCandidate(verifiedToken)
        if (typeof verifiedToken !== 'string' || !verifiedClaims) {
          finish({ reason: 'invalid_session' })
          return
        }
        if (verifiedClaims.subject !== subject) {
          finish({ reason: 'identity_mismatch' })
          return
        }
        finish({ token: verifiedToken })
      })().catch(() => finish({ reason: 'authentication_failed' }))
    })
  }

  /**
   * Public, non-persistent login API. Reconnect credentials stay inside main.
   */
  async startInAppLogin(
    providerId: string,
    providerType: ProviderType,
    timeout?: number,
    proxyMode?: 'system' | 'none',
  ): Promise<OAuthResult> {
    if (zaiReconnectOwner) {
      return { success: false, providerId, providerType, error: 'A login process is already in progress' }
    }
    return this.runInAppLogin(providerId, providerType, timeout, proxyMode)
  }

  private async runInAppLogin(
    providerId: string,
    providerType: ProviderType,
    timeout?: number,
    proxyMode?: 'system' | 'none',
    reconnect?: InAppZaiReconnect,
  ): Promise<OAuthResult> {
    if (this.currentLogin || this.activeInAppLogin || inAppLoginManager.isWindowOpen?.() ||
        (zaiReconnectOwner && zaiReconnectOwner !== reconnect?.attempt)) {
      return { success: false, providerId, providerType, error: 'A login process is already in progress' }
    }
    const adapter = this.getAdapter(providerId, providerType)
    const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? timeout : DEFAULT_TIMEOUT

    return new Promise((resolve) => {
      const collectedTokens: Record<string, string> = {}
      const generation = ++this.inAppGeneration
      let settled = false
      let isValidating = false
      let validationPending = false
      let candidateRevision = 0
      let captureGeneration: number | undefined
      let acceptedCredentials: Record<string, string> | null = null
      let forcedError: string | undefined
      let validationTimeout: ReturnType<typeof setTimeout> | null = null
      let loginTimeout: ReturnType<typeof setTimeout> | null = null
      const attempt = { generation, cancel: () => stop('Login cancelled by user') }
      const isCurrent = () => !settled && this.activeInAppLogin === attempt &&
        this.inAppGeneration === generation
      this.activeInAppLogin = attempt

      const completeHandler = (result: InAppLoginResult & { generation?: number }) => {
        if (!isCurrent() || (result.generation !== undefined && captureGeneration !== undefined &&
            result.generation !== captureGeneration)) return
        settled = true
        if (validationTimeout) clearTimeout(validationTimeout)
        if (loginTimeout) clearTimeout(loginTimeout)
        inAppLoginManager.off('status', statusHandler)
        inAppLoginManager.off('tokenFound', tokenFoundHandler)
        inAppLoginManager.off('complete', completeHandler)
        if (this.activeInAppLogin === attempt) this.activeInAppLogin = null
        const success = !forcedError && result.success && result.credentials &&
          (!reconnect || (acceptedCredentials && result.credentials.token === acceptedCredentials.token))
        if (success) {
          if (!reconnect) {
            this.emit('statusChange', 'success')
            this.sendProgressToRenderer({ status: 'success', message: 'Login successful' })
          }
          resolve({ success: true, providerId, providerType,
            credentials: reconnect ? { token: acceptedCredentials!.token } : result.credentials })
        } else {
          const error = forcedError || result.error || 'Login failed'
          if (reconnect) {
            reconnect.attempt.abortReason = reconnectFailureReason(error)
            reconnect.attempt.controller.abort()
          }
          this.emit('statusChange', 'error')
          resolve({ success: false, providerId, providerType,
            error: reconnect ? reconnectFailureReason(error) : error })
        }
        for (const key of Object.keys(collectedTokens)) delete collectedTokens[key]
      }

      const stop = (error: string) => {
        if (!isCurrent()) return
        forcedError = error
        if (reconnect) {
          reconnect.attempt.abortReason = reconnectFailureReason(error)
          reconnect.attempt.controller.abort()
        }
        // Cancel while this attempt still owns the manager; its completion event
        // may run synchronously. Never cancel after another attempt has started.
        try { inAppLoginManager.cancel() } catch { /* fixed failure below */ }
        completeHandler({ success: false, error })
      }

      const statusHandler = (event: { status: string; message: string }) => {
        if (!isCurrent()) return
        this.sendProgressToRenderer(reconnect
          ? { status: 'pending', message: reconnect.purpose === 'create'
            ? 'Sign in to Z.ai to add a new account'
            : 'Reconnect the existing Z.ai account in the login window' }
          : { status: event.status as OAuthStatus, message: event.message })
      }

      const scheduleValidation = () => {
        if (validationTimeout) clearTimeout(validationTimeout)
        validationTimeout = setTimeout(() => {
          validationTimeout = null
          if (isCurrent()) void validateAndComplete()
        }, 500)
      }

      const tokenFoundHandler = (event: {
        key: string; value: string; allCookies?: Record<string, string>; generation?: number
      }) => {
        if (!isCurrent()) return
        if (typeof event.key !== 'string' || typeof event.value !== 'string' ||
            (reconnect && event.key !== 'token')) return
        let changed = false
        if (event.generation !== undefined) {
          if (!Number.isSafeInteger(event.generation) || event.generation < 1) return
          if (captureGeneration !== undefined && event.generation < captureGeneration) return
          if (captureGeneration !== event.generation) {
            captureGeneration = event.generation
            // A document change invalidates every field of the previous bundle.
            for (const key of Object.keys(collectedTokens)) delete collectedTokens[key]
            changed = true
          }
        } else if (reconnect || captureGeneration !== undefined) {
          return
        }
        if (collectedTokens[event.key] !== event.value) changed = true
        collectedTokens[event.key] = event.value
        if (!reconnect && event.allCookies) {
          const previous = collectedTokens.cookies as unknown as Record<string, string> | undefined
          const keys = Object.keys(event.allCookies)
          if (!previous || keys.length !== Object.keys(previous).length ||
              keys.some(key => previous[key] !== event.allCookies![key])) changed = true
          collectedTokens.cookies = { ...event.allCookies } as any
        }
        // Repeated captures of one failed/in-flight candidate are not retries.
        if (!changed) return
        candidateRevision++
        acceptedCredentials = null
        validationPending = true

        if (providerType === 'minimax') {
          if (!collectedTokens.token) return
          if (event.key === 'token' && !collectedTokens.realUserID) {
            scheduleValidation()
            return
          }
        }
        if (providerType === 'mimo' &&
            (!(collectedTokens.serviceToken || collectedTokens.service_token) ||
             !(collectedTokens.userId || collectedTokens.user_id) ||
             !(collectedTokens.xiaomichatbot_ph || collectedTokens.ph_token))) {
          scheduleValidation()
          return
        }
        if (validationTimeout) {
          clearTimeout(validationTimeout)
          validationTimeout = null
        }
        void validateAndComplete()
      }

      const validateAndComplete = async () => {
        if (!isCurrent() || isValidating || !validationPending) return
        validationPending = false
        isValidating = true
        const candidateGeneration = captureGeneration
        const revision = candidateRevision
        const isLatestCandidate = () => isCurrent() && captureGeneration === candidateGeneration &&
          candidateRevision === revision
        try {
          this.sendProgressToRenderer({ status: 'pending', message: 'Validating token...' })
          let validationCredentials: Record<string, string>
          let finalCredentials: Record<string, string>
          if (providerType === 'minimax') {
            const token = collectedTokens.token
            const realUserID = collectedTokens.realUserID
            validationCredentials = { token: realUserID ? realUserID + '+' + token : token }
            finalCredentials = realUserID ? { token, realUserID } : { token }
          } else if (providerType === 'mimo') {
            const service_token = collectedTokens.serviceToken || collectedTokens.service_token
            const user_id = collectedTokens.userId || collectedTokens.user_id
            const ph_token = collectedTokens.xiaomichatbot_ph || collectedTokens.ph_token
            if (!service_token || !user_id || !ph_token) {
              return
            }
            validationCredentials = { service_token, user_id, ph_token }
            finalCredentials = { ...validationCredentials }
          } else {
            validationCredentials = reconnect ? { token: collectedTokens.token } : { ...collectedTokens }
            finalCredentials = { ...validationCredentials }
          }

          // Only the protected persistent Z.ai flow may pass a structurally
          // valid no-exp candidate to the server. It is not yet authenticated.
          const persistentCandidate = reconnect && providerId === 'zai' && providerType === 'zai'
            ? readZaiLoginCandidate(validationCredentials.token) : null
          if (!persistentCandidate || persistentCandidate.expiryKnown) {
            const validation = await adapter.validateToken(validationCredentials)
            if (!isLatestCandidate()) return
            if (!validation?.valid) {
              this.sendProgressToRenderer({ status: 'pending', message: 'Token invalid, waiting for valid login...' })
              return
            }
          }
          if (!isLatestCandidate()) return
          if (reconnect) {
            const verified = await reconnect.verify(validationCredentials.token)
            if (!isLatestCandidate()) return
            if ('reason' in verified) {
              // Reject this revision, then wait for a fresh capture. The original
              // overall timeout and explicit cancellation still end the login.
              this.sendProgressToRenderer({ status: 'pending', message:
                reconnect.purpose === 'create' && verified.reason === 'duplicate_identity'
                  ? 'This Z.ai account already exists; sign in to a different account'
                  : 'Session verification failed; continue logging in' })
              return
            }
            finalCredentials = { token: verified.token }
          }
          if (!isLatestCandidate()) return
          acceptedCredentials = finalCredentials
          inAppLoginManager.completeWithSuccess(finalCredentials, candidateGeneration)
        } catch {
          if (!isLatestCandidate()) return
          console.error('[OAuthManager] Token validation encountered an error')
          this.sendProgressToRenderer({ status: 'pending', message: 'Validation error, waiting for valid login...' })
        } finally {
          isValidating = false
          // A busy callback only replaces the pending candidate. Always release
          // this attempt's validator and drain its latest unattempted revision.
          if (isCurrent() && validationPending && !validationTimeout) {
            void validateAndComplete()
          }
        }
      }

      inAppLoginManager.on('status', statusHandler)
      inAppLoginManager.on('tokenFound', tokenFoundHandler)
      inAppLoginManager.on('complete', completeHandler)
      loginTimeout = setTimeout(() => stop('Login timeout'), timeoutMs)
      this.emit('statusChange', 'pending')
      this.sendProgressToRenderer({ status: 'pending', message: 'Opening login window...' })
      try {
        void inAppLoginManager.startLogin({
          providerId,
          providerType,
          timeout: timeoutMs,
          proxyMode,
          ...(reconnect ? { persistentAccountId: reconnect.accountId } : {}),
        }).then((result) => {
          if (!result.success) completeHandler(result)
        }).catch(() => stop('Login failed'))
      } catch {
        stop('Login failed')
      }
    })
  }

  /**
   * Cancel in-app login
   */
  cancelInAppLogin(): void {
    if (this.activeZaiReconnect) {
      this.activeZaiReconnect.abortReason = 'login_cancelled'
      this.activeZaiReconnect.controller.abort()
    }
    if (this.activeInAppLogin) this.activeInAppLogin.cancel()
    else if (!zaiReconnectOwner) inAppLoginManager.cancel()
  }

  /**
   * Check if in-app login window is open
   */
  isInAppLoginOpen(): boolean {
    return inAppLoginManager.isWindowOpen()
  }

  /**
   * Destroy manager
   */
  destroy(): void {
    this.cancelInAppLogin()
    this.cancelLogin()
    inAppLoginManager.destroy()
    this.adapters.forEach((adapter) => adapter.destroy())
    this.adapters.clear()
    this.removeAllListeners()
  }
}

/**
 * Singleton instance
 */
export const oauthManager = new OAuthManager()

export default OAuthManager
