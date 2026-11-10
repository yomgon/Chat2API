/**
 * Z.ai consumer-web JWT metadata and per-account Electron session partition.
 *
 * Decoding JWT claims DOES NOT verify a signature or prove that the server
 * accepts the session. Strict claims enforce local expiry; structural token
 * identity can also describe an unknown expiry for official server verification.
 */
import { createHash } from 'crypto'

const JWT_PART = /^[A-Za-z0-9_-]+$/
const MAX_JWT_LENGTH = 8192
const MIN_REMAINING_SECONDS = 30

export interface ZaiSessionClaims {
  subject: string
  email?: string
  expiresAt: number
  usable: boolean
}

export type ZaiTokenIdentity = {
  subject: string
  email?: string
} & (
  | { expiryKnown: false; expiresAt?: never }
  | { expiryKnown: true; expiresAt: number }
)

/**
 * Decode an UNVERIFIED identity candidate for first-party server verification.
 * Missing exp means expiry is UNKNOWN, never locally usable or authenticated.
 * This intentionally has no usable/verified flag and does not verify signatures.
 * Keep readZaiSessionClaims for callers that require known local expiry.
 */
export function readZaiTokenIdentity(token: unknown, nowMs: number = Date.now()): ZaiTokenIdentity | null {
  if (typeof token !== 'string' || token.length < 30 || token.length > MAX_JWT_LENGTH ||
      !Number.isFinite(nowMs)) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(part => !JWT_PART.test(part))) return null
  try {
    if (Buffer.from(parts[0], 'base64url').toString('base64url') !== parts[0] ||
        Buffer.from(parts[1], 'base64url').toString('base64url') !== parts[1]) return null
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        typeof header.alg !== 'string' || !header.alg || header.alg.trim() !== header.alg ||
        header.alg.toLowerCase() === 'none' ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 200 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(payload.id)) return null
    const nowSeconds = Math.floor(nowMs / 1000)
    if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) ||
        payload.nbf < 0 || payload.nbf > 32503680000 || payload.nbf > nowSeconds)) return null
    const email = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : undefined
    if (typeof payload.email === 'string' && payload.email.trim().toLowerCase().endsWith('@guest.com')) return null
    if (payload.exp === undefined) return { subject: payload.id, email, expiryKnown: false }
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) ||
        payload.exp <= 0 || payload.exp > 32503680000 || payload.exp <= nowSeconds) return null
    return { subject: payload.id, email, expiryKnown: true, expiresAt: payload.exp * 1000 }
  } catch {
    return null
  }
}

export function readZaiSessionClaims(token: unknown, nowMs: number = Date.now()): ZaiSessionClaims | null {
  if (typeof token !== 'string' || token.length < 30 || token.length > MAX_JWT_LENGTH ||
      !Number.isFinite(nowMs)) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(part => !JWT_PART.test(part))) return null
  try {
    if (Buffer.from(parts[0], 'base64url').toString('base64url') !== parts[0] ||
        Buffer.from(parts[1], 'base64url').toString('base64url') !== parts[1]) return null
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none' ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 200 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(payload.id)) return null
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) ||
        payload.exp <= 0 || payload.exp > 32503680000) return null
    if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > Math.floor(nowMs / 1000) + 30)) return null
    const email = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : undefined
    if (email?.toLowerCase().endsWith('@guest.com')) return null
    return {
      subject: payload.id,
      email,
      expiresAt: payload.exp * 1000,
      usable: payload.exp > Math.floor(nowMs / 1000) + MIN_REMAINING_SECONDS,
    }
  } catch {
    return null
  }
}

/** Separate a user's existing Z.ai account from every other OAuth profile. */
export function zaiPersistentPartition(accountId: string): string {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256) {
    throw new Error('Invalid Z.ai account selection')
  }
  return 'persist:chat2api-zai-' + createHash('sha256').update(accountId).digest('hex').slice(0, 32)
}

/** Only Z.ai's actual chat origin may be a token-capture source. */
export function isZaiWebHost(host: string): boolean {
  return host === 'chat.z.ai'
}

export function isZaiWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://chat.z.ai' && isZaiWebHost(url.hostname) &&
      !url.username && !url.password
  } catch {
    return false
  }
}
