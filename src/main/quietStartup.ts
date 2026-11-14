/**
 * Explicit, per-process private test-only startup latch.
 *
 * Launch with CHAT2API_PRIVATE_TEST_QUIET_STARTUP=1 only for an isolated,
 * authorized preflight. No persisted config, account state or secret is read
 * or changed. Normal application startup remains unchanged by default.
 *
 * This flag suppresses automatic proxy startup and provider status checks;
 * it is NOT authorization for a model request or any other remote operation.
 */
const quietStartupSelected = process.env.CHAT2API_PRIVATE_TEST_QUIET_STARTUP === '1'

export function isTestQuietStartup(): boolean {
  return quietStartupSelected
}
