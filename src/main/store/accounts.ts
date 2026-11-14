/**
 * Credential Storage Module - Account Management API
 * Provides CRUD operations for accounts
 */

import { storeManager } from './store'
import { Account, AccountStatus, ValidationResult } from './types'
import { validateCredentials } from './validator'

/** CRUD persistence is the authority; optional diagnostics are not part of
 * account mutation acceptance. A log error after a committed write must not
 * make HTTP clients retry create/delete or lose track of the new account ID. */
function logCommittedAccountChange(
  message: string, accountId: string, providerId: string
): void {
  try {
    storeManager.addLog('info', message, { accountId, providerId })
  } catch {
    // Do not replay a completed account mutation or leak sensitive errors.
  }
}

/** A provider validation can outlive an Electron/management account edit.
 * Compare the originally checked immutable identity and relevant stored
 * snapshot, not merely updatedAt (two writes can share one millisecond).
 * Never echo the old/new credential values or allow a stale result to
 * reactivate replacement credentials after an async provider response. */
function isSameValidationSnapshot(before: Account, latest: Account | undefined): boolean {
  if (!latest || latest.id !== before.id || latest.providerId !== before.providerId ||
      latest.createdAt !== before.createdAt ||
      latest.updatedAt !== before.updatedAt ||
      latest.name !== before.name || latest.email !== before.email ||
      latest.status !== before.status || latest.errorMessage !== before.errorMessage ||
      latest.dailyLimit !== before.dailyLimit) return false
  const beforeCredentials = before.credentials || {}
  const currentCredentials = latest.credentials || {}
  const keys = Object.keys(beforeCredentials)
  if (keys.length !== Object.keys(currentCredentials).length) return false
  return keys.every(key =>
    Object.prototype.hasOwnProperty.call(currentCredentials, key) &&
    beforeCredentials[key] === currentCredentials[key])
}

/**
 * Account Manager class
 * Provides all operations related to accounts
 */
export class AccountManager {
  // Management/renderer clients can race the same validate action while
  // awaiting provider auth. Reject a second in-flight operation *before*
  // it creates a second remote validation effect. This is process-local and
  // never treats an unconfirmed remote result as successful.
  private static readonly validatingAccountIds = new Set<string>()
  /**
   * Get all accounts
   * @param includeCredentials Whether to include credentials (sensitive data)
   */
  static getAll(includeCredentials: boolean = false): Account[] {
    return storeManager.getAccounts(includeCredentials)
  }

  /**
   * Get account by ID
   * @param id Account ID
   * @param includeCredentials Whether to include credentials
   */
  static getById(id: string, includeCredentials: boolean = false): Account | undefined {
    return storeManager.getAccountById(id, includeCredentials)
  }

  /**
   * Get account list by provider ID
   * @param providerId Provider ID
   * @param includeCredentials Whether to include credentials
   */
  static getByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    return storeManager.getAccountsByProviderId(providerId, includeCredentials)
  }

  /**
   * Get all active accounts
   * @param includeCredentials Whether to include credentials
   */
  static getActive(includeCredentials: boolean = false): Account[] {
    return storeManager.getActiveAccounts(includeCredentials)
  }

  /**
   * Create new account
   * @param data Account data
   * @returns Created account
   */
  static create(data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }): Account {
    // Only OAuthManager's protected, first-party verified Z.ai login owns the
    // account creation commit. Generic IPC/management CRUD cannot impersonate
    // an already-authenticated web session with an arbitrary JWT string.
    if (data?.providerId === 'zai') {
      throw new Error('Use the protected Z.ai account connection flow')
    }
    // Ensure provider exists before creating account
    storeManager.ensureProviderExists(data.providerId)
    
    const provider = storeManager.getProviderById(data.providerId)
    
    if (!provider) {
      throw new Error(`Provider not found: ${data.providerId}`)
    }
    
    const now = Date.now()
    const account: Account = {
      id: storeManager.generateId(),
      providerId: data.providerId,
      name: data.name,
      email: data.email,
      credentials: data.credentials,
      // Saving a token is not proof that the owner or website accepted it.
      // Only validate() or a provider's protected verified-login writer may
      // activate an account. Existing stored active accounts remain untouched.
      status: 'inactive',
      createdAt: now,
      updatedAt: now,
      requestCount: 0,
      todayUsed: 0,
      dailyLimit: data.dailyLimit,
    }
    
    storeManager.addAccount(account)
    
    logCommittedAccountChange(`Created account: ${account.name}`, account.id, account.providerId)
    
    return account
  }

  /**
   * Update account
   * @param id Account ID
   * @param updates Update data
   * @returns Updated account
   */
  static update(
    id: string,
    updates: Partial<Omit<Account, 'id' | 'createdAt'>>
  ): Account | null {
    // TypeScript's Omit does not exist at IPC/runtime. The identity and usage
    // ledger must never be writable through a generic account-edit operation,
    // even if a renderer or old caller supplies extra JSON fields.
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) ||
        Object.keys(updates).some(key => ![
          'name', 'email', 'credentials', 'dailyLimit', 'status',
          'errorMessage', 'lastStatusCheck',
        ].includes(key))) {
      throw new Error('Account update contains unsupported fields')
    }
    const existing = storeManager.getAccountById(id)
    
    if (!existing) {
      throw new Error(`Account not found: ${id}`)
    }
    if (existing.providerId === 'zai' && updates.credentials !== undefined) {
      // Protected reconnection uses the private OAuthManager/store operation;
      // metadata-only edits remain possible and preserve the verified session.
      throw new Error('Use the protected Z.ai account reconnection flow')
    }
    
    const updated = storeManager.updateAccount(id, updates)
    
    if (updated) {
      logCommittedAccountChange(`Updated account: ${existing.name}`, id, existing.providerId)
    }
    
    return updated
  }

  /** Only the display/account-edit fields may cross the trusted renderer IPC.
   * Authentication status belongs exclusively to a completed validation or
   * protected login, and usage is owned by verified response settlement. */
  static updateEditable(id: string, raw: unknown): Account | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid editable account update')
    }
    const values = raw as Record<string, unknown>
    if (Object.keys(values).some(key =>
      !['name', 'email', 'credentials', 'dailyLimit'].includes(key)) ||
        (values.name !== undefined &&
          (typeof values.name !== 'string' || !values.name.trim())) ||
        (values.email !== undefined && typeof values.email !== 'string') ||
        (values.dailyLimit !== undefined &&
          (!Number.isSafeInteger(values.dailyLimit) || (values.dailyLimit as number) < 0)) ||
        (values.credentials !== undefined && (
          !values.credentials || typeof values.credentials !== 'object' ||
          Array.isArray(values.credentials) ||
          Object.keys(values.credentials).length === 0 ||
          Object.values(values.credentials).some(value =>
            typeof value !== 'string' || !value || value === '***')
        ))) {
      throw new Error('Invalid editable account update')
    }

    // The user can replace *individual* credential fields in the account edit
    // form. The other OS-protected fields (cookies, refresh alias, session
    // identifier) must survive that edit; never replace the full stored object
    // with just the single field supplied by the renderer. An unreadable
    // original must fail closed rather than silently discarding unknown fields.
    const editedCredentials = values.credentials as Record<string, string> | undefined
    let mergedCredentials: Record<string, string> | undefined
    if (editedCredentials !== undefined) {
      const metadata = storeManager.getAccountById(id, false)
      if (metadata?.providerId === 'zai') {
        throw new Error('Use the protected Z.ai account reconnection flow')
      }
      const original = storeManager.getAccountById(id, true)
      if (!original) return null
      mergedCredentials = { ...original.credentials, ...editedCredentials }
    }
    return this.update(id, {
      ...(values.name !== undefined ? { name: (values.name as string).trim() } : {}),
      ...(values.email !== undefined ? { email: values.email as string } : {}),
      ...(values.dailyLimit !== undefined ? { dailyLimit: values.dailyLimit as number } : {}),
      // New credential material has not been verified by the provider. Keep
      // successful usage counters but take the account out of the active pool
      // until the owner explicitly validates/reconnects it. Metadata-only
      // edits do not change authentication state.
      ...(mergedCredentials !== undefined
        ? { credentials: mergedCredentials, status: 'inactive' as const,
            errorMessage: undefined } : {}),
    })
  }

  /**
   * Delete account
   * @param id Account ID
   * @returns Whether deletion was successful
   */
  static delete(id: string): boolean {
    const account = storeManager.getAccountById(id)
    
    if (!account) {
      return false
    }
    
    const result = storeManager.deleteAccount(id)
    
    if (result) {
      logCommittedAccountChange(`Deleted account: ${account.name}`, id, account.providerId)
    }
    
    return result
  }

  /**
   * Update account status
   * @param id Account ID
   * @param status New status
   * @param errorMessage Error message (optional)
   */
  static updateStatus(
    id: string,
    status: AccountStatus,
    errorMessage?: string
  ): Account | null {
    return this.update(id, { status, errorMessage })
  }

  /**
   * Update last used time
   * @param id Account ID
   */
  static touchLastUsed(id: string): void {
    const account = storeManager.getAccountById(id)
    
    if (account) {
      storeManager.updateAccount(id, {
        lastUsed: Date.now(),
      })
    }
  }

  /**
   * Increment request count
   * @param id Account ID
   */
  static incrementRequestCount(id: string): void {
    const account = storeManager.getAccountById(id)
    
    if (account) {
      storeManager.updateAccount(id, {
        requestCount: (account.requestCount || 0) + 1,
        todayUsed: (account.todayUsed || 0) + 1,
        lastUsed: Date.now(),
      })
    }
  }

  /**
   * Reset daily usage count
   * Should be called at midnight
   */
  static resetDailyUsage(): void {
    const accounts = storeManager.getAccounts()
    
    for (const account of accounts) {
      storeManager.updateAccount(account.id, { todayUsed: 0 })
    }
    
    storeManager.addLog('info', 'Reset daily usage count for all accounts')
  }

  /**
   * Validate account credentials
   * @param id Account ID
   * @returns Validation result
   */
  static async validate(
    id: string,
    isCanceled: () => boolean = () => false,
  ): Promise<ValidationResult> {
    const account = storeManager.getAccountById(id, true)
    
    if (!account) {
      return {
        valid: false,
        error: 'Account not found',
        validatedAt: Date.now(),
      }
    }
    
    const provider = storeManager.getProviderById(account.providerId)
    
    if (!provider) {
      return {
        valid: false,
        error: 'Provider not found',
        validatedAt: Date.now(),
      }
    }
    if (this.validatingAccountIds.has(id)) {
      return {
        valid: false,
        error: 'Account validation already in progress',
        validatedAt: Date.now(),
        inProgress: true,
      }
    }
    this.validatingAccountIds.add(id)
    try {
      const result = await validateCredentials(provider, account.credentials)

      // Validation may have reached an external provider before an HTTP
      // caller disconnects. That effect remains unconfirmed; never replay
      // it or commit a late success/error status for the abandoned caller.
      // The only caller-specific cancellation check is placed immediately
      // before synchronous local snapshot verification and persistence.
      if (isCanceled()) {
        return {
          valid: false,
          error: 'Account validation canceled',
          validatedAt: Date.now(),
          canceled: true,
        }
      }

      // A local edit, credential replacement, provider rebind or deletion may
      // commit during the awaited provider request. The caller must explicitly
      // revalidate the new account; never apply this result to a changed row.
      if (!isSameValidationSnapshot(account, storeManager.getAccountById(id, true))) {
        return {
          valid: false,
          error: 'Account changed during validation',
          validatedAt: Date.now(),
          superseded: true,
        }
      }

      if (result.valid) {
        // Commit status and verified email together; a refused write cannot
        // strand a changed status behind an HTTP 500.
        const committed = this.update(id, {
          status: 'active',
          lastStatusCheck: result.validatedAt,
          ...(result.accountInfo?.email ? { email: result.accountInfo.email } : {}),
        })
        if (!committed) throw new Error('Account validation persistence was refused')
      } else {
        const committed = this.update(id, {
          status: 'error', errorMessage: result.error,
          lastStatusCheck: result.validatedAt,
        })
        if (!committed) throw new Error('Account validation persistence was refused')
      }

      return result
    } finally {
      // Exceptions, stale writes, provider errors and persistence refusals
      // all release only this validation's in-process concurrency guard.
      this.validatingAccountIds.delete(id)
    }
  }

  /**
   * Batch validate all accounts
   * @returns Validation result mapping
   */
  static async validateAll(): Promise<Map<string, ValidationResult>> {
    const accounts = storeManager.getAccounts(true)
    const results = new Map<string, ValidationResult>()
    
    for (const account of accounts) {
      const result = await this.validate(account.id)
      results.set(account.id, result)
    }
    
    return results
  }

  /**
   * Check if account is available
   * @param id Account ID
   * @returns Whether account is available
   */
  static isAvailable(id: string): boolean {
    const account = storeManager.getAccountById(id)
    
    if (!account || account.status !== 'active') {
      return false
    }
    
    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }
    
    return true
  }

  /**
   * Get available account list
   * @param providerId Optional, filter by provider
   * @returns Available account list
   */
  static getAvailable(providerId?: string): Account[] {
    let accounts = storeManager.getActiveAccounts()
    
    if (providerId) {
      accounts = accounts.filter((a) => a.providerId === providerId)
    }
    
    return accounts.filter((account) => {
      if (account.status !== 'active') {
        return false
      }
      
      if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
        return false
      }
      
      return true
    })
  }

  /**
   * Select next available account (load balancing)
   * @param providerId Provider ID
   * @param strategy Load balance strategy
   * @returns Selected account or null
   */
  static selectNext(
    providerId: string,
    strategy: 'round-robin' | 'fill-first' = 'round-robin'
  ): Account | null {
    const available = this.getAvailable(providerId)
    
    if (available.length === 0) {
      return null
    }
    
    if (strategy === 'fill-first') {
      return available.reduce((prev, curr) => {
        const prevUsed = prev.todayUsed || 0
        const currUsed = curr.todayUsed || 0
        return currUsed < prevUsed ? curr : prev
      })
    }
    
    const lastUsed = available.reduce((latest, account) => {
      if (!account.lastUsed) return latest
      if (!latest) return account
      return account.lastUsed > (latest.lastUsed || 0) ? account : latest
    }, null as Account | null)
    
    if (!lastUsed) {
      return available[0]
    }
    
    const lastIndex = available.findIndex((a) => a.id === lastUsed.id)
    const nextIndex = (lastIndex + 1) % available.length
    
    return available[nextIndex]
  }

  /**
   * Get account statistics
   */
  static getStatistics(): {
    total: number
    active: number
    inactive: number
    expired: number
    error: number
  } {
    const accounts = storeManager.getAccounts()
    
    return {
      total: accounts.length,
      active: accounts.filter((a) => a.status === 'active').length,
      inactive: accounts.filter((a) => a.status === 'inactive').length,
      expired: accounts.filter((a) => a.status === 'expired').length,
      error: accounts.filter((a) => a.status === 'error').length,
    }
  }
}

export default AccountManager
