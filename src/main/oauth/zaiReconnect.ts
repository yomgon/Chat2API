/**
 * Explicit, account-bound first-party Z.ai browser reconnection.
 *
 * No guessed refresh endpoint, login submission, CAPTCHA bypass or automatic
 * chat replay. A user opens the official login page in an isolated persistent
 * Electron partition. Only an authenticated first-party session with the
 * SAME Z.ai user identity may replace the existing account's saved token.
 */
import { BrowserWindow, session } from 'electron'
import axios from 'axios'
import { createHash } from 'crypto'
import { AccountManager } from '../store/accounts'
import { storeManager } from '../store/store'
import { isZaiWebUrl, readZaiSessionClaims, zaiPersistentPartition } from './zaiSession'

const ZAI_HOME = 'https://chat.z.ai/'
const CURRENT_USER_URL = 'https://chat.z.ai/api/v1/auths/'
const MAX_LOGIN_MS = 300_000
const REQUEST_TIMEOUT_MS = 12_000
const POLL_MS = 1_400

export interface ZaiReconnectResult {
  success: boolean
  accountId?: string
  expiresAt?: number
  error?: string
}

let currentReconnect = false

function firstPartyUserId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  const values = [root, root.data, root.user]
  for (const entry of values) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const candidate = (entry as Record<string, unknown>).id
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 200) return candidate
  }
  return null
}

async function verifyFirstPartyZaiToken(token: string, expectedSubject: string): Promise<string | null> {
  // Only the official same-origin account endpoint; no client-provided URL.
  const response = await axios.get(CURRENT_USER_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      Cookie: `token=${token}`,
      Origin: 'https://chat.z.ai',
      Referer: ZAI_HOME,
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: 512 * 1024,
    responseType: 'json',
    validateStatus: () => true,
  })
  if (response.status !== 200 || firstPartyUserId(response.data) !== expectedSubject) return null
  const body = response.data as Record<string, unknown>
  const serverToken = typeof body.token === 'string' ? body.token : token
  const claims = readZaiSessionClaims(serverToken)
  if (!claims?.usable || claims.subject !== expectedSubject) return null
  return serverToken
}

export async function reconnectExistingZaiAccount(accountId: string): Promise<ZaiReconnectResult> {
  if (currentReconnect) return { success: false, error: 'A Z.ai reconnection is already in progress' }
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256) {
    return { success: false, error: 'Invalid Z.ai account identifier' }
  }
  const stored = AccountManager.getById(accountId, true)
  if (!stored || stored.providerId !== 'zai') {
    return { success: false, error: 'Existing Z.ai account was not found' }
  }
  const oldClaims = readZaiSessionClaims(stored.credentials?.token)
  if (!oldClaims?.subject) {
    return { success: false, error: 'Existing Z.ai identity cannot be verified; no account was changed' }
  }

  currentReconnect = true
  let browser: BrowserWindow | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let finished = false
  let checking = false
  const seen = new Set<string>()

  return new Promise<ZaiReconnectResult>((resolve) => {
    const complete = (result: ZaiReconnectResult) => {
      if (finished) return
      finished = true
      currentReconnect = false
      if (timer) clearTimeout(timer)
      if (deadline) clearTimeout(deadline)
      timer = null
      deadline = null
      if (browser && !browser.isDestroyed()) browser.destroy()
      resolve(result)
    }

    try {
      const partition = zaiPersistentPartition(accountId)
      const userSession = session.fromPartition(partition)
      userSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browser = new BrowserWindow({
        title: 'Z.ai — reconnect existing account',
        width: 980,
        height: 760,
        show: true,
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      })
      const window = browser
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('https://')) event.preventDefault()
      })
      window.webContents.on('will-redirect', (event, url) => {
        if (!url.startsWith('https://')) event.preventDefault()
      })
      window.once('closed', () => complete({ success: false, error: 'Z.ai reconnection was cancelled; existing account was kept' }))
      deadline = setTimeout(() => complete({ success: false, error: 'Z.ai login timed out; existing account was kept' }), MAX_LOGIN_MS)

      const scan = async () => {
        if (finished || checking || window.isDestroyed() || window.webContents.isDestroyed()) return
        checking = true
        try {
          const candidates: string[] = []
          if (isZaiWebUrl(window.webContents.getURL())) {
            // This code runs only on https://chat.z.ai (not on an IdP).
            const localToken: unknown = await window.webContents.executeJavaScript(
              `(() => location.origin === 'https://chat.z.ai' ? localStorage.getItem('token') : null)()`,
            ).catch(() => null)
            if (typeof localToken === 'string') candidates.push(localToken)
          }
          const cookies = await userSession.cookies.get({ url: ZAI_HOME, name: 'token' })
          for (const cookie of cookies) {
            if (cookie.name === 'token' && cookie.secure && typeof cookie.value === 'string') {
              candidates.push(cookie.value)
            }
          }

          for (const token of candidates) {
            const claims = readZaiSessionClaims(token)
            if (!claims?.usable || claims.subject !== oldClaims.subject) continue
            const fingerprint = createHash('sha256').update(token).digest('hex')
            if (seen.has(fingerprint)) continue
            seen.add(fingerprint)

            // Exactly one read-only authentication check per candidate token.
            let verified: string | null = null
            try {
              verified = await verifyFirstPartyZaiToken(token, oldClaims.subject)
            } catch {
              verified = null
            }
            if (!verified || finished) continue
            const finalClaims = readZaiSessionClaims(verified)
            if (!finalClaims?.usable || finalClaims.subject !== oldClaims.subject) continue

            // Re-fetch the ORIGINAL row before the one durable update. A
            // user deletion or concurrent account replacement must fail closed.
            const current = AccountManager.getById(accountId, true)
            if (!current || current.providerId !== 'zai' ||
                readZaiSessionClaims(current.credentials?.token)?.subject !== oldClaims.subject) {
              complete({ success: false, error: 'Z.ai account changed during reconnection; no credentials were saved' })
              return
            }
            const updated = storeManager.updateAccount(accountId, {
              credentials: { ...current.credentials, token: verified },
              status: 'active',
              errorMessage: undefined,
            })
            if (!updated) {
              complete({ success: false, error: 'Z.ai account could not be saved; previous account was kept' })
              return
            }
            complete({ success: true, accountId, expiresAt: finalClaims.expiresAt })
            return
          }
        } catch {
          // Remote page errors and headers may contain secrets; never log or
          // return the original exception.
        } finally {
          checking = false
          if (!finished) timer = setTimeout(() => { void scan() }, POLL_MS)
        }
      }

      void window.loadURL(ZAI_HOME).then(() => {
        if (!finished) void scan()
      }).catch(() => complete({ success: false, error: 'Unable to open the official Z.ai login; existing account was kept' }))
    } catch {
      complete({ success: false, error: 'Z.ai session setup failed; existing account was kept' })
    }
  })
}
