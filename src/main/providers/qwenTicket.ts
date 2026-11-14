/**
 * Shared first-party Qwen China SSO ticket selector.
 * The OAuth form, persisted-account checker and consumer-web proxy must use
 * one credential contract; otherwise a locally 'valid' account may forward an
 * object, CRLF, a second cookie, or a different legacy alias as its identity.
 *
 * A missing/null/blank legacy alias is an unused placeholder. A supplied
 * nonempty alias must be an opaque cookie-octet value; conflicting aliases
 * never authorize a first-party network effect. The original record is not
 * normalized, logged or mutated.
 */
const TICKET_COOKIE_OCTETS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/

export function selectQwenChinaTicket(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null
  const record = credentials as Record<string, unknown>
  let selected: string | undefined
  for (const key of ['ticket', 'tongyi_sso_ticket']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    const value = record[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' || !TICKET_COOKIE_OCTETS.test(value) ||
        (selected !== undefined && selected !== value)) return null
    selected = value
  }
  return selected ?? null
}
