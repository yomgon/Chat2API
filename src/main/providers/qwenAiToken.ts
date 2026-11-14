/** The same opaque Qwen International bearer-token selection is used for
 * account checking and the consumer-web completion transport. Manual OAuth
 * stores `token`; older records may contain `accessToken` or `apiKey`.
 * A malformed first nonempty field never permits silently switching identity.
 * This is shape validation, not proof of server authentication.
 */
export function selectQwenAiToken(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null
  const fields = credentials as Record<string, unknown>
  for (const key of ['token', 'accessToken', 'apiKey']) {
    const value = fields[key]
    if (value === undefined || value === null || value === '') continue
    return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) ? value : null
  }
  return null
}
