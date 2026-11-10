import { isIP } from 'node:net'

type EndpointTrustErrorCode =
  | 'invalid_endpoint'
  | 'invalid_provider_update'
  | 'endpoint_origin_change_requires_reconnect'

export class ProviderEndpointTrustError extends Error {
  readonly code: EndpointTrustErrorCode

  constructor(code: EndpointTrustErrorCode, message: string) {
    super(message)
    this.name = 'ProviderEndpointTrustError'
    this.code = code
  }
}

function invalidEndpoint(message: string): never {
  throw new ProviderEndpointTrustError('invalid_endpoint', message)
}

function isPublicIPv4(host: string): boolean {
  const [a, b, c] = host.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113))
}

function isPublicIPv6(host: string): boolean {
  const [first, second] = host.split(':').map(part => parseInt(part || '0', 16))
  // Only global unicast, excluding special-purpose/transition/documentation
  // prefixes. This also excludes mapped IPv4, ULA, link-local and multicast.
  return first >= 0x2000 && first <= 0x3fff &&
    first !== 0x2002 && first !== 0x3ffe && first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
}

function isPublicHostname(host: string): boolean {
  const labels = host.split('.')
  const suffix = labels[labels.length - 1]
  const localSuffixes = new Set([
    'localhost', 'local', 'localdomain', 'lan', 'internal', 'intranet',
    'corp', 'home', 'private', 'arpa', 'onion', 'alt', 'test', 'invalid', 'example',
  ])
  return host.length <= 253 && labels.length >= 2 &&
    labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    (/^[a-z]{2,63}$/.test(suffix) || /^xn--[a-z0-9-]+$/.test(suffix)) &&
    !localSuffixes.has(suffix)
}

/**
 * Validate configuration without DNS or network access. The transport must
 * separately enforce DNS/redirect policy; a public name can resolve privately.
 * Keep accepted paths unchanged because provider callers append their own paths.
 */
export function validateProviderEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    invalidEndpoint('API endpoint must be a non-empty URL of at most 4096 characters.')
  }
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) {
    invalidEndpoint('API endpoint must not contain whitespace, control characters or backslashes.')
  }
  if (value.includes('?') || value.includes('#')) {
    invalidEndpoint('API endpoint must not include a query or fragment.')
  }

  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority) {
    invalidEndpoint('API endpoint must use HTTPS, or HTTP with literal 127.0.0.1 or [::1].')
  }
  if (authority.includes('@')) {
    invalidEndpoint('API endpoint must not include a username or password.')
  }
  const hostAndPort = authority.startsWith('[')
    ? /^\[([0-9a-f:.]+)\](?::([0-9]+))?$/i.exec(authority)
    : /^([a-z0-9.-]+)(?::([0-9]+))?$/i.exec(authority)
  if (!hostAndPort) {
    invalidEndpoint('API endpoint must use an unambiguous ASCII hostname or IP literal.')
  }
  const rawHost = hostAndPort[1].toLowerCase()
  const port = hostAndPort[2]
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    invalidEndpoint('API endpoint port must be between 1 and 65535.')
  }

  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    invalidEndpoint('Invalid API endpoint URL.')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    invalidEndpoint('API endpoint must not include credentials, a query or a fragment.')
  }
  const host = endpoint.hostname.startsWith('[')
    ? endpoint.hostname.slice(1, -1)
    : endpoint.hostname
  const version = isIP(host)
  if ((version === 4 && (isIP(rawHost) !== 4 || rawHost !== host)) ||
      (version === 6 && isIP(rawHost) !== 6) ||
      (version === 0 && rawHost !== host)) {
    invalidEndpoint('API endpoint must not use an encoded or non-canonical IP address.')
  }

  const loopback = rawHost === '127.0.0.1' || rawHost === '::1'
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    invalidEndpoint('External API endpoints must use HTTPS. HTTP is allowed only for literal 127.0.0.1 or [::1].')
  }
  if (!loopback && !(version === 4 ? isPublicIPv4(host) :
    version === 6 ? isPublicIPv6(host) : isPublicHostname(host))) {
    invalidEndpoint('API endpoint must use a public hostname or public IP address, or literal 127.0.0.1 or [::1].')
  }
  return value
}

function hasSavedCredentials(accounts: readonly { credentials?: unknown }[]): boolean {
  return accounts.some(({ credentials }) => {
    if (credentials === undefined || credentials === null) return false
    if (typeof credentials !== 'object' || Array.isArray(credentials)) return true
    return Object.values(credentials).some(value =>
      value !== '' && value !== undefined && value !== null &&
      (typeof value !== 'object' || Object.keys(value).length > 0),
    )
  })
}

/** Existing custom authorization headers also bind the current origin. */
function hasCredentialHeader(headers: unknown): boolean {
  if (headers === undefined || headers === null) return false
  if (typeof headers !== 'object' || Array.isArray(headers)) return true
  return Object.entries(headers).some(([name, value]) =>
    /(authorization|cookie|token|key|secret|session|credential|authentication|bearer)/i.test(name) &&
    value !== null && value !== undefined && String(value).length > 0,
  )
}

/** Inspect stored credential presence only; never decrypt or include it in errors. */
export function assertProviderEndpointChangeAllowed(
  previousEndpoint: unknown,
  nextEndpoint: unknown,
  accounts: readonly { credentials?: unknown }[],
  existingHeaders?: unknown,
): string {
  const validated = validateProviderEndpoint(nextEndpoint)
  if (!hasSavedCredentials(accounts) && !hasCredentialHeader(existingHeaders)) return validated

  let previousOrigin: string | undefined
  try {
    previousOrigin = new URL(validateProviderEndpoint(previousEndpoint)).origin
  } catch {
    // A malformed or unsafe old endpoint cannot establish credential trust.
  }
  if (previousOrigin !== new URL(validated).origin) {
    throw new ProviderEndpointTrustError(
      'endpoint_origin_change_requires_reconnect',
      'Delete this provider\'s saved accounts before changing its API endpoint origin, then reconnect the accounts.',
    )
  }
  return validated
}

/** Preserve account-to-provider binding even when IPC bypasses TypeScript types. */
export function assertProviderIdentityUnchanged(
  existing: { id: string; type: string },
  updates: unknown,
): void {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new ProviderEndpointTrustError('invalid_provider_update', 'Provider updates must be an object.')
  }
  const values = updates as Record<string, unknown>
  if (('id' in values && values.id !== existing.id) ||
      ('type' in values && values.type !== existing.type)) {
    throw new ProviderEndpointTrustError('invalid_provider_update', 'Provider ID and type cannot be changed.')
  }
}
