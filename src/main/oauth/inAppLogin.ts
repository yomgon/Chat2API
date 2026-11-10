/**
 * In-App Login Manager
 * Keeps provider credentials inside the main process and the selected session.
 */

import { BrowserWindow, session, Session, Cookie } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { ProviderType } from './types'
import { TokenExtractionConfig, getTokenExtractionConfig } from './tokenExtractionConfig'
import { readZaiSessionClaims, readZaiTokenIdentity, zaiPersistentPartition } from './zaiSession'

export interface InAppLoginResult {
  success: boolean
  credentials?: Record<string, string>
  error?: string
}

export interface TokenFoundEvent {
  key: string
  value: string
  generation: number
  allCookies?: Record<string, string>
}

export interface InAppLoginOptions {
  providerId: string
  providerType: ProviderType
  timeout?: number
  proxyMode?: 'system' | 'none'
  persistentAccountId?: string
}

const DEFAULT_TIMEOUT = 300000
const MIN_LOGIN_TIME = 5000
const TOKEN_CHECK_INTERVAL = 2000
const TOKEN_READ_TIMEOUT = 1500
const FLUSH_TIMEOUT = 5000
const ZAI_ORIGIN = 'https://chat.z.ai'
const ZAI_COOKIE_URL = ZAI_ORIGIN + '/api/v1/auths/'
// webRequest has one listener per event, so a session must have one login owner.
const sessionOwners = new WeakMap<Session, object>()

interface TokenCheckOperation {
  generation: number
  documentGeneration: number
  window: BrowserWindow
  cancelWaiters: Set<() => void>
}

interface TokenReadLease {
  window: BrowserWindow
  kind: 'storage' | 'cookies'
}

function isExactZaiUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === ZAI_ORIGIN && !url.username && !url.password
  } catch {
    return false
  }
}

function isZaiTokenCookie(cookie: Cookie): boolean {
  if (cookie.name !== 'token' || typeof cookie.value !== 'string') return false
  const domain = cookie.domain
  const matchesHost = domain === 'chat.z.ai' ||
    (domain === '.chat.z.ai' && cookie.hostOnly !== true) ||
    ((domain === 'z.ai' || domain === '.z.ai') && cookie.hostOnly === false)
  const path = cookie.path
  const requestPath = '/api/v1/auths/'
  const matchesPath = typeof path === 'string' && path.startsWith('/') &&
    (requestPath === path || (requestPath.startsWith(path) &&
      (path.endsWith('/') || requestPath[path.length] === '/')))
  const unexpired = cookie.expirationDate === undefined ||
    (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > Date.now() / 1000)
  return matchesHost && matchesPath && unexpired
}

export class InAppLoginManager extends EventEmitter {
  private loginWindow: BrowserWindow | null = null
  private loginSession: Session | null = null
  private config: TokenExtractionConfig | null = null
  private options: InAppLoginOptions | null = null
  private isCompleted = false
  private finalizing = false
  private attemptGeneration = 0
  // Public validation ticket: a navigation cannot reuse a previous document's
  // authenticated result, even while the same login window remains open.
  private generation = 0
  private documentGeneration = 0
  private documentReady = false
  private navigationPending = false
  private loginStartTime = 0
  private timeoutId: NodeJS.Timeout | null = null
  private tokenCheckTimer: NodeJS.Timeout | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private cancelFlush: (() => void) | null = null
  private resolvePromise: ((result: InAppLoginResult) => void) | null = null
  private checkingOperation: TokenCheckOperation | null = null
  private readonly pendingTokenReads = new Set<TokenReadLease>()
  private sessionOwner: object = {}
  private cookieChangedHandler: ((event: Electron.Event, cookie: Cookie, cause: string, removed: boolean) => void) | null = null
  private detachWindowHandlers: (() => void) | null = null
  private readonly seenZaiTokens = new Set<string>()
  private zaiStorageSeenInDocument = false

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    if (this.loginWindow || this.resolvePromise) {
      return { success: false, error: 'A login window is already open' }
    }
    if (options.persistentAccountId !== undefined && options.providerType !== 'zai') {
      return { success: false, error: 'Persistent login is only supported for Z.ai' }
    }
    if (options.timeout !== undefined &&
        (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > DEFAULT_TIMEOUT)) {
      return { success: false, error: 'Invalid login timeout' }
    }
    const config = getTokenExtractionConfig(options.providerType)
    if (!config || (options.providerType === 'zai' && !isExactZaiUrl(config.loginUrl))) {
      return { success: false, error: 'No trusted login configuration is available' }
    }
    this.config = config
    this.options = { ...options }
    this.isCompleted = false
    this.finalizing = false
    this.documentReady = false
    this.navigationPending = false
    this.documentGeneration = 0
    this.cancelTokenCheck()
    this.loginStartTime = Date.now()
    this.seenZaiTokens.clear()
    this.zaiStorageSeenInDocument = false
    this.sessionOwner = {}
    const generation = ++this.attemptGeneration
    this.generation++

    return new Promise((resolve) => {
      this.resolvePromise = resolve
      this.timeoutId = setTimeout(() => {
        this.complete({ success: false, error: 'Login timeout' }, generation)
      }, options.timeout ?? DEFAULT_TIMEOUT)
      try {
        this.emit('status', { status: 'starting', message: 'Opening login window...' })
        this.createLoginWindow(generation)
      } catch {
        this.complete({ success: false, error: 'Unable to start login' }, generation)
      }
    })
  }

  private isZai(): boolean {
    return this.options?.providerType === 'zai'
  }

  private isZaiTokenCandidate(value: unknown): boolean {
    if (this.options?.persistentAccountId !== undefined) {
      const identity = readZaiTokenIdentity(value)
      if (!identity) return false
      // Unknown expiry is a candidate only. The persistent account manager must
      // verify it with the official server before calling completeWithSuccess.
      if (!identity.expiryKnown) return true
    }
    return readZaiSessionClaims(value)?.usable === true
  }

  private isCurrent(generation: number, window: BrowserWindow | null = this.loginWindow): boolean {
    return generation === this.attemptGeneration && !this.isCompleted &&
      !!window && window === this.loginWindow && !window.isDestroyed() &&
      !window.webContents.isDestroyed()
  }

  private canCapture(generation: number, window: BrowserWindow, documentGeneration?: number): boolean {
    if (!this.isCurrent(generation, window) || this.finalizing) return false
    if (documentGeneration !== undefined && documentGeneration !== this.documentGeneration) return false
    return !this.isZai() || (!this.navigationPending && this.documentReady &&
      isExactZaiUrl(window.webContents.getURL()))
  }

  private createLoginWindow(generation: number = this.attemptGeneration): void {
    if (!this.config) return
    const partition = this.options?.persistentAccountId !== undefined
      ? zaiPersistentPartition(this.options.persistentAccountId)
      : 'oauth-' + randomUUID()
    const loginSession = session.fromPartition(partition)
    if (sessionOwners.has(loginSession)) throw new Error('Login session is already in use')
    sessionOwners.set(loginSession, this.sessionOwner)
    this.loginSession = loginSession
    const window = new BrowserWindow({
      width: 500,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition,
        webSecurity: true,
        allowRunningInsecureContent: false,
        javascript: true,
      },
      title: this.config.windowTitle || 'Login',
      autoHideMenuBar: true,
    })
    this.loginWindow = window
    const ready = () => {
      if (!this.isCurrent(generation, window)) return
      window.show()
      this.emit('status', { status: 'ready', message: 'Login window ready - please log in' })
    }
    const closed = () => {
      this.complete({ success: false, error: 'Login window was closed' }, generation)
    }
    const loaded = () => {
      if (!this.isCurrent(generation, window) || this.navigationPending) return
      this.documentReady = true
      this.delayedTokenCheck(generation)
    }
    const navigating = (_event: Electron.Event, _url: string, inPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame || inPlace || !this.isCurrent(generation, window)) return
      this.documentGeneration++
      this.generation++
      this.seenZaiTokens.clear()
      this.zaiStorageSeenInDocument = false
      this.navigationPending = true
      this.cancelTokenCheck()
    }
    const committed = () => {
      if (!this.isCurrent(generation, window)) return
      if (!this.navigationPending) {
        this.documentGeneration++
        this.generation++
        this.seenZaiTokens.clear()
        this.zaiStorageSeenInDocument = false
        this.cancelTokenCheck()
      }
      this.navigationPending = false
      this.documentReady = false
    }
    const stopped = () => {
      if (!this.isCurrent(generation, window) || window.webContents.isLoadingMainFrame()) return
      // A cancelled provisional navigation may leave the previously ready
      // document displayed. Never revive its old validation ticket.
      if (this.navigationPending && this.documentReady && isExactZaiUrl(window.webContents.getURL())) {
        this.navigationPending = false
      }
      this.delayedTokenCheck(generation)
    }
    const inPage = (_event: Electron.Event, _url: string, isMainFrame: boolean) => {
      if (isMainFrame === false || !this.isCurrent(generation, window)) return
      this.delayedTokenCheck(generation)
    }
    const navigationGuard = (event: Electron.Event, url: string) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return
      } catch {
        // Navigation errors may contain credentials; do not expose the URL.
      }
      event.preventDefault()
      stopped()
    }
    window.once('ready-to-show', ready)
    window.on('closed', closed)
    window.webContents.on('dom-ready', loaded)
    window.webContents.on('did-finish-load', loaded)
    window.webContents.on('did-start-navigation', navigating)
    window.webContents.on('did-navigate', committed)
    window.webContents.on('did-stop-loading', stopped)
    window.webContents.on('did-navigate-in-page', inPage)
    if (this.isZai()) {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', navigationGuard)
      window.webContents.on('will-redirect', navigationGuard)
    }
    this.detachWindowHandlers = () => {
      window.off('ready-to-show', ready)
      window.off('closed', closed)
      window.webContents.off('dom-ready', loaded)
      window.webContents.off('did-finish-load', loaded)
      window.webContents.off('did-start-navigation', navigating)
      window.webContents.off('did-navigate', committed)
      window.webContents.off('did-stop-loading', stopped)
      window.webContents.off('did-navigate-in-page', inPage)
      window.webContents.off('will-navigate', navigationGuard)
      window.webContents.off('will-redirect', navigationGuard)
    }
    this.setupTokenInterception(generation)
    const loginUrl = this.config.loginUrl
    const navigate = () => {
      if (!this.isCurrent(generation, window)) return
      this.delayedTokenCheck(generation)
      const initialDocument = this.documentGeneration + 1
      void window.loadURL(loginUrl).catch(() => {
        if (this.documentGeneration > initialDocument) return
        this.complete({ success: false, error: 'Failed to load login page' }, generation)
      })
    }
    if (this.isZai() || this.options?.proxyMode === 'none') {
      // A reused persistent session retains its previous proxy mode.
      const mode = this.options?.proxyMode === 'none' ? 'direct' : 'system'
      void loginSession.setProxy({ mode }).then(navigate).catch(() => {
        this.complete({ success: false, error: 'Unable to configure login connection' }, generation)
      })
    } else {
      navigate()
    }
  }

  private setupTokenInterception(generation: number = this.attemptGeneration): void {
    const loginSession = this.loginSession
    const window = this.loginWindow
    const config = this.config
    if (!loginSession || !window || !config) return
    const isZai = this.isZai()
    const requestIsOwned = (details: { url: string; webContentsId?: number }) =>
      !isZai || (isExactZaiUrl(details.url) && details.webContentsId === window.webContents.id)

    loginSession.webRequest.onHeadersReceived((details, callback) => {
      try {
        if (!this.canCapture(generation, window) || !requestIsOwned(details)) return
        if (!this.hasMinTimePassed()) {
          this.delayedTokenCheck(generation)
          return
        }
        const headers = details.responseHeaders?.['set-cookie'] || details.responseHeaders?.['Set-Cookie']
        if (!Array.isArray(headers)) return
        if (isZai) {
          // The browser validates Domain/Path/expiry. Never trust raw Set-Cookie
          // values; read only the current token cookie for the exact auth URL.
          if (headers.some(header => typeof header === 'string' && /^token=/.test(header))) {
            this.delayedTokenCheck(generation)
          }
          return
        }
        for (const header of headers) {
          const nameValue = header.split(';')[0]?.trim()
          const equal = nameValue?.indexOf('=') ?? -1
          if (equal <= 0) continue
          const name = nameValue.substring(0, equal)
          let value = nameValue.substring(equal + 1)
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
          for (const source of config.tokenSources) {
            if (source.type === 'cookie' && source.key === name) {
              this.emitToken(name, value, generation, window)
            }
          }
        }
      } catch {
        console.error('[InAppLogin] Unable to inspect login response')
      } finally {
        callback({})
      }
    })

    loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        if (!this.canCapture(generation, window) || !requestIsOwned(details)) return
        if (!this.hasMinTimePassed()) {
          this.delayedTokenCheck(generation)
          return
        }
        const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
        if (typeof auth !== 'string') return
        if (isZai) {
          const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(auth)
          if (match) this.emitToken('token', match[1], generation, window)
          return
        }
        for (const source of config.tokenSources) {
          if (source.type !== 'networkHeader') continue
          const match = source.extractPattern ? auth.match(new RegExp(source.extractPattern)) : null
          const value = match?.[1] ?? (auth.startsWith('Bearer ') ? auth.substring(7) : auth)
          this.emitToken(source.key, value, generation, window)
        }
      } catch {
        console.error('[InAppLogin] Unable to inspect login request')
      } finally {
        callback({ requestHeaders: details.requestHeaders })
      }
    })

    this.cookieChangedHandler = (_event, cookie, _cause, removed) => {
      try {
        if (removed || !this.canCapture(generation, window)) return
        if (isZai) {
          // Cookie events are session-wide and have no originating window.
          if (isZaiTokenCookie(cookie)) this.delayedTokenCheck(generation)
          return
        }
        if (!this.hasMinTimePassed()) {
          this.delayedTokenCheck(generation)
          return
        }
        for (const source of config.tokenSources) {
          if (source.type === 'cookie' && source.key === cookie.name) {
            this.emitToken(source.key, cookie.value, generation, window)
          }
        }
        void this.checkForTokens(generation)
      } catch {
        console.error('[InAppLogin] Unable to inspect login cookie')
      }
    }
    loginSession.cookies.on('changed', this.cookieChangedHandler)
  }

  private hasMinTimePassed(): boolean {
    return Date.now() - this.loginStartTime >= MIN_LOGIN_TIME
  }

  private delayedTokenCheck(generation: number = this.attemptGeneration, delay = 1000): void {
    if (!this.isCurrent(generation) || this.finalizing || this.tokenCheckTimer) return
    const wait = Math.max(delay, MIN_LOGIN_TIME - (Date.now() - this.loginStartTime))
    const timer = setTimeout(() => {
      if (this.tokenCheckTimer === timer) this.tokenCheckTimer = null
      if (!this.isCurrent(generation) || this.finalizing) return
      void this.checkForTokens(generation).then(() => {
        if (this.isCurrent(generation) && !this.finalizing) {
          this.delayedTokenCheck(generation, TOKEN_CHECK_INTERVAL)
        }
      }).catch(() => {
        console.error('[InAppLogin] Unable to check login storage')
      })
    }, wait)
    this.tokenCheckTimer = timer
  }

  private emitToken(key: string, value: unknown, generation: number, window: BrowserWindow,
    allCookies?: Record<string, string>): void {
    if (!this.canCapture(generation, window) || !this.hasMinTimePassed() || typeof value !== 'string') return
    if (this.isZai()) {
      if (key !== 'token' || !this.isZaiTokenCandidate(value) ||
          this.seenZaiTokens.has(value) || this.seenZaiTokens.size >= 32) return
      this.seenZaiTokens.add(value)
      this.emit('tokenFound', { key: 'token', value, generation: this.generation } satisfies TokenFoundEvent)
    } else if (this.isValidToken(value)) {
      this.emit('tokenFound', { key, value, generation: this.generation, ...(allCookies ? { allCookies } : {}) } satisfies TokenFoundEvent)
    }
  }

  private isValidToken(value: string): boolean {
    console.log('[InAppLogin] Checking token validity')
    
    if (!value || value.length < 5) {
      console.log('[InAppLogin] Token rejected: too short or empty')
      return false
    }
    
    // Check for JWT format (3 parts) or JWE format (5 parts)
    if (value.startsWith('eyJ')) {
      const parts = value.split('.')
      
      // JWE format (5 parts) - used by Perplexity and some other providers
      if (parts.length === 5) {
        console.log('[InAppLogin] Token appears to be JWE format (5 parts)')
        // JWE tokens are encrypted, we can't decode them, but they're valid if properly formatted
        if (value.length >= 100) {
          console.log('[InAppLogin] Token accepted as valid JWE')
          return true
        }
        console.log('[InAppLogin] JWE token rejected: too short')
        return false
      }
      
      // JWT format (3 parts)
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          console.log('[InAppLogin] JWT payload decoded')
          
          // Reject guest accounts
          if (payload.email && payload.email.includes('@guest.com')) {
            console.log('[InAppLogin] Token rejected: guest account')
            return false
          }
          
          if (payload && (payload.app_id || payload.sub || payload.exp || payload.id || payload.user_id || payload.uid || payload.email)) {
            console.log('[InAppLogin] Token accepted as valid JWT')
            return true
          }
        } catch {
          console.log('[InAppLogin] Token rejected: invalid JWT')
          return false
        }
      }
    }
    
    // Accept long tokens (>= 64 chars) - includes base64 chars like / + and *
    if (value.length >= 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as long token')
      return true
    }
    
    // Accept medium tokens (32-63 chars) - includes base64 chars and *
    if (value.length >= 32 && value.length < 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as medium token')
      return true
    }
    
    // Accept Base64-encoded tokens (may contain = padding and /)
    // This handles tokens like "SME5/AEwvmtjSu4XO18SYg=="
    if (value.length >= 20 && /^[a-zA-Z0-9_\-+/]+=*$/.test(value)) {
      console.log('[InAppLogin] Token accepted as Base64 token')
      return true
    }
    
    // Accept any token that looks like a valid string (at least 5 chars, no spaces)
    // This handles short tokens like userId
    if (value.length >= 5 && !/\s/.test(value)) {
      console.log('[InAppLogin] Token accepted as generic token')
      return true
    }
    
    console.log('[InAppLogin] Token rejected: does not match any pattern')
    return false
  }

  private isTokenCheckCurrent(operation: TokenCheckOperation): boolean {
    return this.checkingOperation === operation &&
      this.canCapture(operation.generation, operation.window, operation.documentGeneration)
  }

  private cancelTokenCheck(): void {
    const operation = this.checkingOperation
    this.checkingOperation = null
    if (operation) {
      for (const cancel of [...operation.cancelWaiters]) cancel()
    }
  }

  private async readTokenValue<T>(
    operation: TokenCheckOperation,
    kind: TokenReadLease['kind'],
    read: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.isTokenCheckCurrent(operation) ||
        [...this.pendingTokenReads].some(lease => lease.window === operation.window && lease.kind === kind)) return
    // A timeout stops waiting; Electron cannot cancel executeJavaScript. Keep
    // one physical read per source/window until its promise actually settles.
    const lease: TokenReadLease = { window: operation.window, kind }
    this.pendingTokenReads.add(lease)
    let pending: Promise<T>
    try {
      pending = Promise.resolve(read())
    } catch {
      this.pendingTokenReads.delete(lease)
      console.error('[InAppLogin] Unable to read login storage')
      return
    }
    const observed = pending.then(value => {
      this.pendingTokenReads.delete(lease)
      return value
    }, () => {
      this.pendingTokenReads.delete(lease)
      console.error('[InAppLogin] Unable to read login storage')
      return undefined
    })
    return new Promise<T | undefined>(resolve => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (value: T | undefined) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        operation.cancelWaiters.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish(undefined)
      operation.cancelWaiters.add(cancel)
      timer = setTimeout(cancel, TOKEN_READ_TIMEOUT)
      void observed.then(finish)
      if (!this.isTokenCheckCurrent(operation)) cancel()
    })
  }

  private async checkForTokens(generation: number = this.attemptGeneration): Promise<void> {
    const window = this.loginWindow
    const loginSession = this.loginSession
    const config = this.config
    if (!window || !loginSession || !config || !this.canCapture(generation, window) ||
        !this.hasMinTimePassed() || this.checkingOperation) return
    const operation: TokenCheckOperation = {
      generation, documentGeneration: this.documentGeneration, window, cancelWaiters: new Set(),
    }
    this.checkingOperation = operation
    const isZai = this.isZai()
    const checkStorage = async () => {
      const localSources = isZai ? [{ key: 'token' }] :
        config.tokenSources.filter(source => source.type === 'localStorage')
      for (const source of localSources) {
        if (!this.isTokenCheckCurrent(operation)) return
        const script = [
          '(function() {',
          '  try {',
          isZai ? '    if (location.origin !== "https://chat.z.ai" || new URL(location.href).username || new URL(location.href).password) return null;' : '',
          '    return localStorage.getItem(' + JSON.stringify(source.key) + ') || null;',
          '  } catch { return null; }',
          '})()',
        ].join('\n')
        const value = await this.readTokenValue(operation, 'storage',
          () => window.webContents.executeJavaScript(script))
        if (!this.isTokenCheckCurrent(operation)) return
        if (typeof value !== 'string') continue
        if (!isZai && source.key === 'user_detail_agent') {
          try {
            const parsed = JSON.parse(value)
            const userId = parsed.realUserID || parsed.id
            if (userId) this.emitToken('realUserID', String(userId), generation, window)
          } catch {
            console.error('[InAppLogin] Error parsing user details')
          }
          continue
        }
        let token: unknown = value
        if (!isZai && value.startsWith('{') && value.endsWith('}')) {
          try {
            const parsed = JSON.parse(value)
            if (parsed.value) token = parsed.value
          } catch {
            console.error('[InAppLogin] Error parsing JSON token')
          }
        }
        if (isZai && this.isZaiTokenCandidate(token)) {
          // The official web client reads localStorage.token. After observing
          // one eligible storage token, stale cookie reads must not supersede
          // it in this document even when the two reads settle out of order.
          this.zaiStorageSeenInDocument = true
        }
        this.emitToken(source.key === '_token' ? 'token' : source.key, token, generation, window)
      }
    }
    const checkCookies = async () => {
      if (!this.isTokenCheckCurrent(operation)) return
      if (isZai) {
        const cookies = await this.readTokenValue(operation, 'cookies',
          () => loginSession.cookies.get({ url: ZAI_COOKIE_URL, name: 'token' }))
        if (!this.isTokenCheckCurrent(operation) || !cookies) return
        const values = [...new Set(cookies.filter(isZaiTokenCookie).map(cookie => cookie.value))]
        // Different applicable cookies with the same name are ambiguous.
        if (values.length === 1 && !this.zaiStorageSeenInDocument) {
          this.emitToken('token', values[0], generation, window)
        }
        return
      }
      for (const source of config.tokenSources.filter(entry => entry.type === 'cookie')) {
        if (!this.isTokenCheckCurrent(operation)) return
        const initialCookies = await this.readTokenValue(operation, 'cookies', () => loginSession.cookies.get({}))
        if (!this.isTokenCheckCurrent(operation) || !initialCookies) return
        const cookies = [...initialCookies]
        for (const domain of config.targetDomains || []) {
          const extra = await this.readTokenValue(operation, 'cookies', () => loginSession.cookies.get({ domain }))
          if (!this.isTokenCheckCurrent(operation)) return
          for (const cookie of extra || []) {
            if (!cookies.some(existing => existing.name === cookie.name)) cookies.push(cookie)
          }
        }
        if (!this.isTokenCheckCurrent(operation)) return
        const cookie = cookies.find(entry => entry.name === source.key)
        if (cookie) {
          const allCookies: Record<string, string> = {}
          for (const entry of cookies) {
            if (entry.value) allCookies[entry.name] = entry.value
          }
          this.emitToken(source.key, cookie.value, generation, window, allCookies)
        }
      }
    }
    try {
      // Cookie extraction must work even while Electron suspends renderer code
      // until loading stops, or when either source rejects or never settles.
      if (isZai) await Promise.all([checkCookies(), checkStorage()])
      else {
        await checkStorage()
        await checkCookies()
      }
    } catch {
      console.error('[InAppLogin] Error checking login storage')
    } finally {
      for (const cancel of [...operation.cancelWaiters]) cancel()
      if (this.checkingOperation === operation) this.checkingOperation = null
    }
  }
  completeWithSuccess(credentials: Record<string, string>, expectedGeneration?: number): void {
    const generation = this.attemptGeneration
    const window = this.loginWindow
    if (!window || !this.canCapture(generation, window) || !this.hasMinTimePassed() ||
        (expectedGeneration !== undefined && expectedGeneration !== this.generation)) return
    // An asynchronous Z.ai validation must identify the document that emitted it.
    // Persistent callers must have verified the identity with the official server;
    // structural capture alone (including unknown expiry) never completes login.
    if (this.isZai() && (expectedGeneration === undefined || !this.isZaiTokenCandidate(credentials.token))) return
    const saved = this.isZai() ? { token: credentials.token } : { ...credentials }
    if (this.options?.persistentAccountId !== undefined && this.loginSession) {
      this.finalizing = true
      this.cancelTokenCheck()
      if (this.tokenCheckTimer) clearTimeout(this.tokenCheckTimer)
      this.tokenCheckTimer = null
      void this.flushAndComplete(saved, generation, this.generation, window, this.loginSession)
    } else {
      this.complete({ success: true, credentials: saved }, generation)
    }
  }

  private async flushAndComplete(credentials: Record<string, string>, generation: number, validationGeneration: number,
    window: BrowserWindow, loginSession: Session): Promise<void> {
    const stopped = new Promise<boolean>((resolve) => {
      this.cancelFlush = () => resolve(false)
      this.flushTimer = setTimeout(() => resolve(false), FLUSH_TIMEOUT)
    })
    const flushed = Promise.resolve().then(async () => {
      if (!this.isCurrent(generation, window)) return false
      loginSession.flushStorageData()
      await loginSession.cookies.flushStore()
      return true
    }).catch(() => false)
    const success = await Promise.race([stopped, flushed])
    if (!this.isCurrent(generation, window)) return
    if (validationGeneration !== this.generation || !this.documentReady ||
        !isExactZaiUrl(window.webContents.getURL())) {
      this.complete({ success: false, error: 'Login page changed before completion' }, generation)
      return
    }
    this.complete(success
      ? { success: true, credentials }
      : { success: false, error: 'Unable to preserve the login session' }, generation)
  }

  private complete(result: InAppLoginResult, generation: number = this.attemptGeneration): void {
    if (generation !== this.attemptGeneration || this.isCompleted) return
    this.isCompleted = true
    this.finalizing = false
    const window = this.loginWindow
    const resolve = this.resolvePromise
    this.resolvePromise = null
    this.cleanup()
    if (window && !window.isDestroyed()) {
      try {
        // Do not allow a page's beforeunload handler to retain the old session.
        window.destroy()
      } catch {
        console.error('[InAppLogin] Unable to close login window')
      }
    }
    resolve?.(result)
    try {
      this.emit('complete', result)
    } catch {
      console.error('[InAppLogin] Login completion listener failed')
    }
  }

  private cleanup(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId)
    if (this.tokenCheckTimer) clearTimeout(this.tokenCheckTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.timeoutId = null
    this.tokenCheckTimer = null
    this.flushTimer = null
    const cancelFlush = this.cancelFlush
    this.cancelFlush = null
    cancelFlush?.()
    this.cancelTokenCheck()
    this.pendingTokenReads.clear()
    const loginSession = this.loginSession
    const cookieHandler = this.cookieChangedHandler
    this.loginSession = null
    this.cookieChangedHandler = null
    if (loginSession && sessionOwners.get(loginSession) === this.sessionOwner) {
      try {
        loginSession.webRequest.onBeforeSendHeaders(null)
      } catch {
        console.error('[InAppLogin] Error detaching login request listener')
      }
      try {
        loginSession.webRequest.onHeadersReceived(null)
      } catch {
        console.error('[InAppLogin] Error detaching login response listener')
      }
      try {
        if (cookieHandler) loginSession.cookies.off('changed', cookieHandler)
      } catch {
        console.error('[InAppLogin] Error detaching login cookie listener')
      }
      sessionOwners.delete(loginSession)
    }
    try {
      this.detachWindowHandlers?.()
    } catch {
      console.error('[InAppLogin] Error detaching login window listeners')
    }
    this.detachWindowHandlers = null
    this.loginWindow = null
    this.config = null
    this.options = null
    this.documentReady = false
    this.navigationPending = false
    this.seenZaiTokens.clear()
    this.zaiStorageSeenInDocument = false
  }

  cancel(): void {
    if (!this.isCompleted) this.complete({ success: false, error: 'Login cancelled by user' })
  }

  isWindowOpen(): boolean {
    return this.loginWindow !== null && !this.loginWindow.isDestroyed()
  }

  destroy(): void {
    this.cancel()
    this.removeAllListeners()
  }
}

export const inAppLoginManager = new InAppLoginManager()
export default InAppLoginManager
