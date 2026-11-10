import { createHash, timingSafeEqual } from 'node:crypto'

export interface LocalProxyKey {
  id: string
  key: string
  enabled: boolean
}

export type ProxyKeyConfig = {
  enableApiKey: boolean
  apiKeys?: LocalProxyKey[]
}

export type ProxyKeyDecision =
  | { allowed: true; matchedKeyId?: string }
  | { allowed: false; status: 401 | 503; code: string }

/**
 * API key authentication is on by default for the private-local distribution.
 * Explicitly disabled authentication remains supported for legacy settings,
 * but an enabled policy with no usable keys is always fail-closed.
 */
export function evaluateProxyKey(
  config: ProxyKeyConfig,
  providedKey: string,
): ProxyKeyDecision {
  if (config.enableApiKey === false) return { allowed: true }
  if (config.enableApiKey !== true) {
    return { allowed: false, status: 503, code: 'api_key_configuration_invalid' }
  }

  const enabledKeys = (Array.isArray(config.apiKeys) ? config.apiKeys : []).filter(k =>
    k && k.enabled === true && typeof k.key === 'string' && k.key.length > 0 && typeof k.id === 'string'
  )
  if (enabledKeys.length === 0) {
    return { allowed: false, status: 503, code: 'api_key_not_configured' }
  }
  if (!providedKey) {
    return { allowed: false, status: 401, code: 'missing_api_key' }
  }
  if (providedKey.length > 256) {
    return { allowed: false, status: 401, code: 'invalid_api_key' }
  }

  const keyDigest = createHash('sha256').update(providedKey, 'utf8').digest()
  const matched = enabledKeys.find(entry => {
    const savedDigest = createHash('sha256').update(entry.key, 'utf8').digest()
    return timingSafeEqual(savedDigest, keyDigest)
  })
  return matched
    ? { allowed: true, matchedKeyId: matched.id }
    : { allowed: false, status: 401, code: 'invalid_api_key' }
}

/** Reject external browser origins. API clients without Origin are supported. */
export function hasUntrustedBrowserOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && origin.trim().length > 0
}

/** The private-local fork may listen only on the machine's own loopback. */
export function isLocalBindHost(host: string | undefined): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/** Reject DNS rebinding and Host spoofing before public/management routes. */
export function isTrustedHostHeader(authority: string | undefined, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  return authority === `127.0.0.1:${port}` || authority === `[::1]:${port}`
}
