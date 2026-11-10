import { isTrustedRendererNavigation } from '../window/navigationGuard.ts'

type WebFrame = { url: string }
type WebContents = { mainFrame: WebFrame }

/** Only the exact main renderer frame may request privileged native actions. */
export function isTrustedIpcSender(
  event: { sender?: unknown; senderFrame?: WebFrame | null },
  window: { isDestroyed(): boolean; webContents: WebContents } | null,
  expectedPage: string,
): boolean {
  if (!window || window.isDestroyed()) return false
  if (event.sender !== window.webContents) return false
  if (!event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false
  return isTrustedRendererNavigation(event.senderFrame.url, expectedPage)
}
