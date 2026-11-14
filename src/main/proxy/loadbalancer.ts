/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin and Fill First strategies
 */

import { Account, Provider, LoadBalanceStrategy, type EffectiveModel } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'
import { modelMapper } from './modelMapper'

/**
 * Load Balancer
 */
export class LoadBalancer {
  private roundRobinIndex: Map<string, number> = new Map()
  private failedAccounts: Map<string, { count: number; lastFailTime: number }> = new Map()
  // Account usage is settled only after a confirmed answer. Reserve scarce
  // daily slots synchronously before sending upstream so concurrent HTTP
  // requests cannot both spend the same last available slot. In-flight work
  // remains counted across midnight: a late settlement can land on the new day.
  private inFlightAccountSlots: Map<string, number> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60000 // 1 minute

  private accountSlotKey(account: Account): string {
    return JSON.stringify([account.providerId, account.id])
  }

  /**
   * Acquire exactly one provisional slot for the already selected identity.
   * Called by the HTTP routes synchronously between selection and provider
   * dispatch. The returned idempotent release belongs to this request only.
   * This is process-local concurrency protection, not a durable provider
   * charge or a proof about what an upstream received after a crash.
   */
  reserveSelectedAccount(selection: AccountSelection): (() => void) | null {
    // Use the same provider-scoped account snapshot that account selection
    // already requires, without introducing a second store lookup contract.
    const latest = storeManager.getAccountsByProviderId(selection.provider.id)
      .find(account => account.id === selection.account.id)
    if (!latest || latest.providerId !== selection.provider.id ||
        !this.isAccountAvailable(latest)) return null
    const key = this.accountSlotKey(latest)
    this.inFlightAccountSlots.set(key, (this.inFlightAccountSlots.get(key) || 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.inFlightAccountSlots.get(key) || 0) - 1
      if (remaining > 0) this.inFlightAccountSlots.set(key, remaining)
      else this.inFlightAccountSlots.delete(key)
    }
  }

  /**
   * Mark account as failed
   */
  markAccountFailed(accountId: string): void {
    const current = this.failedAccounts.get(accountId) || { count: 0, lastFailTime: 0 }
    this.failedAccounts.set(accountId, {
      count: current.count + 1,
      lastFailTime: Date.now(),
    })
  }

  /**
   * Clear account failure status
   */
  clearAccountFailure(accountId: string): void {
    this.failedAccounts.delete(accountId)
  }

  /**
   * Check if account is in failure state
   */
  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false

    if (Date.now() - failure.lastFailTime > LoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }

    return failure.count >= LoadBalancer.FAIL_THRESHOLD
  }

  /**
   * Select account
   * @param model Requested model
   * @param strategy Load balance strategy
   * @param preferredProviderId Preferred provider ID
   * @param preferredAccountId Preferred account ID
   */
  selectAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string
  ): AccountSelection | null {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')

    if (candidates.length === 0) {
      return null
    }

    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountInFailure(preferredAccountId)) {
        return preferred
      }
      // Z.ai is a stateful consumer-web session. Never silently substitute
      // another identity for a caller's explicitly bound Z.ai account.
      if (preferredProviderId === 'zai') return null
      // A deleted/unavailable pin may have belonged to a web provider that no
      // longer appears among candidates or configured providers. An explicit
      // identity never authorizes replacement; only unpinned requests balance.
      return null
    }

    if (strategy === 'fill-first') {
      return this.selectFillFirst(candidates)
    }

    if (strategy === 'failover') {
      return this.selectFailover(candidates)
    }

    return this.selectRoundRobin(candidates)
  }

  /** Check whether the same requested model and explicit pins could be
   * selected without advancing round-robin state or dispatching a request.
   * GET /v1/models must not advertise a temporary failover account failure
   * that POST /v1/chat/completions would deterministically reject. */
  hasSelectableAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string
  ): boolean {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')
    if (preferredAccountId) {
      return candidates.some(candidate =>
        candidate.account.id === preferredAccountId && !this.isAccountInFailure(preferredAccountId))
    }
    return candidates.length > 0
  }

  /**
   * Get available accounts list
   */
  private getAvailableAccounts(
    model: string,
    preferredProviderId?: string,
    excludeFailed: boolean = false
  ): AccountSelection[] {
    // Ambiguous management wildcard mappings cannot become an unpinned raw
    // model request when getMatchingMapping returns undefined. Fail before
    // selecting any account or issuing any provider/auth operation.
    if (modelMapper.hasAmbiguousMatchingMapping(model)) return []
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const candidates: AccountSelection[] = []

    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) {
        continue
      }

      if (!this.providerSupportsModel(provider, model)) {
        continue
      }

      const accounts = storeManager.getAccountsByProviderId(provider.id, true)
        .filter(account => this.isAccountAvailable(account))
        .filter(account => !excludeFailed || !this.isAccountInFailure(account.id))

      console.log(`[LoadBalancer] Provider ${provider.name} (${provider.id}) has ${accounts.length} available accounts`)

      for (const account of accounts) {
        candidates.push({
          account,
          provider,
          actualModel: this.mapModel(model, provider),
        })
      }
    }

    return candidates
  }

  /**
   * Check if provider supports model
   */
  private providerSupportsModel(provider: Provider, model: string): boolean {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const mapping = modelMapper.getMatchingMapping(model)
    if (mapping?.preferredProviderId && mapping.preferredProviderId !== provider.id) return false
    // Validate the actual mapped target, not merely the presence of a provider
    // preference or a coincidentally matching public alias.
    const target = modelMapper.mapModel(model, provider)
    if (typeof target !== 'string' || !target.trim()) return false
    if (effectiveModels.length === 0) {
      // Keep the historical raw-model passthrough for providers without a
      // catalog, but an explicit exact/wildcard mapping promises a specific
      // configured wire target. GET /v1/models correctly withholds that alias
      // without catalog evidence; POST must not dispatch it anyway merely
      // because this provider has an active account.
      return mapping === undefined
    }

    // Validate against the same effective catalog wire resolver used for
    // dispatch, not just whether some display wildcard looks plausible.
    // Equally specific conflicting catalog targets must fail closed.
    return this.resolveCatalogWireModel(target, effectiveModels) !== null
  }

  /** Resolve the exact configured wire before any remote effect. A bare
   * wildcard whose actualModelId is itself the display pattern preserves
   * historical dynamic passthrough; an explicitly mapped provider wildcard
   * uses its configured wire ID. Distinct equally specific wire IDs are an
   * ambiguity, not permission to guess or switch providers. */
  private resolveCatalogWireModel(target: string, models: EffectiveModel[]): string | null {
    const exactWire = models.find(model => model.actualModelId === target)
    if (exactWire) return target

    const normalized = target.toLowerCase()
    const exactDisplays = models.filter(model =>
      model.displayName.toLowerCase() === normalized
    )
    if (exactDisplays.length > 0) {
      const wires = new Set(exactDisplays.map(model => model.actualModelId))
      return wires.size === 1 ? exactDisplays[0].actualModelId : null
    }

    const wildcards = models.filter(model => {
      const display = model.displayName.toLowerCase()
      return display.endsWith('*') && normalized.startsWith(display.slice(0, -1))
    })
    if (wildcards.length === 0) return null
    const mostSpecific = Math.max(...wildcards.map(model => model.displayName.length - 1))
    const wires = new Set(wildcards
      .filter(model => model.displayName.length - 1 === mostSpecific)
      .map(model => model.actualModelId === model.displayName ? target : model.actualModelId))
    return wires.size === 1 ? [...wires][0] : null
  }

  /**
   * Check if account is available
   */
  private isAccountAvailable(account: Account): boolean {
    if (account.status !== 'active') {
      return false
    }

    const reserved = this.inFlightAccountSlots.get(this.accountSlotKey(account)) || 0
    if (account.dailyLimit && (account.todayUsed || 0) + reserved >= account.dailyLimit) {
      return false
    }

    return true
  }

  /**
   * Map model name
   */
  private mapModel(model: string, provider: Provider): string {
    console.log(`[LoadBalancer] mapModel called with model="${model}", provider="${provider.name}"`)

    const target = modelMapper.mapModel(model, provider)
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    // Resolve exactly the same catalog target that made this account
    // selectable, including specific wildcard displays and wire conflicts.
    const resolvedWireId = this.resolveCatalogWireModel(target, effectiveModels)
    const effectiveModel = resolvedWireId === null
      ? undefined : { actualModelId: resolvedWireId }

    if (effectiveModel) {
      console.log(`[LoadBalancer] Model mapped from "${model}" to "${effectiveModel.actualModelId}" via effective models`)
      return effectiveModel.actualModelId
    }

    // Only the existing empty-catalog passthrough reaches this path after
    // providerSupportsModel has checked all nonempty catalog conflicts.
    return target
  }

  /**
   * Round Robin strategy
   */
  private selectRoundRobin(candidates: AccountSelection[]): AccountSelection {
    const providerIds = [...new Set(candidates.map(c => c.provider.id))]
    const key = providerIds.join(',')

    const currentIndex = this.roundRobinIndex.get(key) || 0
    const selected = candidates[currentIndex % candidates.length]

    this.roundRobinIndex.set(key, (currentIndex + 1) % candidates.length)

    return selected
  }

  /**
   * Fill First strategy
   * Use current account preferentially until limit is reached
   */
  private selectFillFirst(candidates: AccountSelection[]): AccountSelection {
    return candidates.reduce((best, current) => {
      const bestUsed = best.account.todayUsed || 0
      const currentUsed = current.account.todayUsed || 0

      if (currentUsed < bestUsed) {
        return current
      }

      if (currentUsed === bestUsed) {
        const bestLastUsed = best.account.lastUsed || 0
        const currentLastUsed = current.account.lastUsed || 0

        if (currentLastUsed < bestLastUsed) {
          return current
        }
      }

      return best
    })
  }

  /**
   * Failover strategy
   * Select account with least failures, preferring healthy accounts
   */
  private selectFailover(candidates: AccountSelection[]): AccountSelection {
    const healthyCandidates = candidates.filter(c => !this.isAccountInFailure(c.account.id))
    
    if (healthyCandidates.length > 0) {
      return this.selectRoundRobin(healthyCandidates)
    }

    const sortedCandidates = candidates.sort((a, b) => {
      const failureA = this.failedAccounts.get(a.account.id)
      const failureB = this.failedAccounts.get(b.account.id)

      const countA = failureA ? failureA.count : 0
      const countB = failureB ? failureB.count : 0

      if (countA !== countB) {
        return countA - countB
      }

      const timeA = failureA ? failureA.lastFailTime : 0
      const timeB = failureB ? failureB.lastFailTime : 0

      return timeA - timeB
    })

    return sortedCandidates[0]
  }

  /**
   * Reset Round Robin index
   */
  resetRoundRobinIndex(): void {
    this.roundRobinIndex.clear()
  }

  /**
   * Get available account count
   */
  getAvailableAccountCount(model: string, providerId?: string): number {
    return this.getAvailableAccounts(model, providerId).length
  }

  /**
   * Get all available models
   */
  getAvailableModels(): string[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const models = new Set<string>()

    for (const provider of providers) {
      const accounts = storeManager.getAccountsByProviderId(provider.id)
        .filter(account => this.isAccountAvailable(account))

      if (accounts.length > 0) {
        const effectiveModels = storeManager.getEffectiveModels(provider.id)
        effectiveModels.forEach(m => models.add(m.displayName))
      }
    }

    return [...models]
  }
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
