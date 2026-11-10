/**
 * Renderer navigation remains on the exact bundled application page.
 * HashRouter routes may change only the hash part of that URL.
 */
export function isTrustedRendererNavigation(
  destination: string,
  expectedPage: string,
): boolean {
  try {
    const target = new URL(destination)
    const expected = new URL(expectedPage)
    return target.protocol === expected.protocol &&
      target.origin === expected.origin &&
      target.pathname === expected.pathname &&
      target.search === expected.search
  } catch {
    return false
  }
}

/** The desktop app may open external web pages, never custom/file schemes. */
export function isSafeExternalLink(destination: string): boolean {
  try {
    const parsed = new URL(destination)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
  } catch {
    return false
  }
}
