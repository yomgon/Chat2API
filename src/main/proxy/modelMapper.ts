/**
 * Proxy Service Module - Model Mapper
 * Supports mapping request models to actual models
 */

import { storeManager } from '../store/store'
import { ModelMapping, Provider } from '../store/types'

/**
 * Model mapper
 */
export class ModelMapper {
  /** Resolve the same exact/wildcard mapping for model lookup and dispatch.
   * An exact public alias takes precedence over a broader wildcard pattern. */
  getMatchingMapping(requestedModel: string, provider?: Provider): ModelMapping | undefined {
    const mappings = storeManager.getConfig().modelMappings
    const direct = Object.prototype.hasOwnProperty.call(mappings, requestedModel)
      ? mappings[requestedModel] : undefined
    if (direct && (!provider || !direct.preferredProviderId ||
        direct.preferredProviderId === provider.id)) return direct
    const wildcard = this.findWildcardMapping(requestedModel, mappings, provider)
    return wildcard.ambiguous ? undefined : wildcard.mapping ?? undefined
  }

  /** A case-insensitive wildcard tie with distinct wire/provider/account
   * identities is not a valid routing instruction. The caller must refuse
   * the request before selection instead of interpreting undefined as an
   * unconfigured raw-model passthrough. An own exact alias wins over wildcards. */
  hasAmbiguousMatchingMapping(requestedModel: string): boolean {
    const mappings = storeManager.getConfig().modelMappings
    if (Object.prototype.hasOwnProperty.call(mappings, requestedModel)) return false
    return this.findWildcardMapping(requestedModel, mappings).ambiguous
  }

  /**
   * Map model name
   * @param requestedModel Requested model name
   * @param provider Provider (optional, for provider-specific mapping)
   */
  mapModel(requestedModel: string, provider?: Provider): string {
    return this.getMatchingMapping(requestedModel, provider)?.actualModel ?? requestedModel
  }

  /**
   * Find wildcard mapping
   */
  private findWildcardMapping(
    requestedModel: string,
    mappings: Record<string, ModelMapping>,
    provider?: Provider
  ): { mapping: ModelMapping | null; ambiguous: boolean } {
    const normalizedRequested = requestedModel.toLowerCase()
    let best: { pattern: string; mapping: ModelMapping; literalLength: number; wildcardCount: number } | null = null
    let ambiguous = false
    for (const [pattern, mapping] of Object.entries(mappings)) {
      if (pattern.includes('*')) {
        const normalizedPattern = pattern.toLowerCase()
        if (this.matchesPattern(normalizedRequested, normalizedPattern)) {
          const wildcardCount = [...pattern].filter(char => char === '*').length
          const literalLength = pattern.length - wildcardCount
          if (!best || literalLength > best.literalLength ||
              (literalLength === best.literalLength && wildcardCount < best.wildcardCount)) {
            best = { pattern, mapping, literalLength, wildcardCount }
            ambiguous = false
          } else if (literalLength === best.literalLength && wildcardCount === best.wildcardCount &&
              (mapping.actualModel !== best.mapping.actualModel ||
                (mapping.preferredProviderId ?? null) !== (best.mapping.preferredProviderId ?? null) ||
                (mapping.preferredAccountId ?? null) !== (best.mapping.preferredAccountId ?? null))) {
            ambiguous = true
          }
        }
      }
    }

    if (!best) return { mapping: null, ambiguous: false }
    if (ambiguous) return { mapping: null, ambiguous: true }
    if (provider && best.mapping.preferredProviderId && best.mapping.preferredProviderId !== provider.id) {
      return { mapping: null, ambiguous: false }
    }
    return { mapping: best.mapping, ambiguous: false }
  }

  /**
   * Check if model name matches wildcard pattern
   */
  private matchesPattern(modelName: string, pattern: string): boolean {
    if (pattern === '*') {
      return true
    }

    if (pattern.startsWith('*')) {
      return modelName.endsWith(pattern.slice(1))
    }

    if (pattern.endsWith('*')) {
      return modelName.startsWith(pattern.slice(0, -1))
    }

    const parts = pattern.split('*')
    if (parts.length === 2) {
      return modelName.startsWith(parts[0]) && modelName.endsWith(parts[1])
    }

    return false
  }

  /**
   * Get actual model name for a model
   */
  getActualModel(requestedModel: string, providerId?: string): string {
    const mapping = this.getMatchingMapping(requestedModel)
    return mapping && (!providerId || !mapping.preferredProviderId ||
      mapping.preferredProviderId === providerId) ? mapping.actualModel : requestedModel
  }

  /**
   * Get preferred provider for a model
   */
  getPreferredProvider(requestedModel: string): string | undefined {
    return this.getMatchingMapping(requestedModel)?.preferredProviderId
  }

  /**
   * Get preferred account for a model
   */
  getPreferredAccount(requestedModel: string): string | undefined {
    return this.getMatchingMapping(requestedModel)?.preferredAccountId
  }

  /**
   * Add model mapping
   */
  addMapping(requestModel: string, actualModel: string, preferredProviderId?: string, preferredAccountId?: string): void {
    const config = storeManager.getConfig()
    const mappings = { ...config.modelMappings }
    mappings[requestModel] = {
      requestModel,
      actualModel,
      preferredProviderId,
      preferredAccountId,
    }
    storeManager.updateConfig({ modelMappings: mappings })
  }

  /**
   * Remove model mapping
   */
  removeMapping(requestModel: string): boolean {
    const config = storeManager.getConfig()
    if (config.modelMappings[requestModel]) {
      const mappings = { ...config.modelMappings }
      delete mappings[requestModel]
      storeManager.updateConfig({ modelMappings: mappings })
      return true
    }
    return false
  }

  /**
   * Get all mappings
   */
  getAllMappings(): Record<string, ModelMapping> {
    const config = storeManager.getConfig()
    return { ...config.modelMappings }
  }

  /**
   * Get list of providers supporting specified model
   */
  getProvidersForModel(model: string): Provider[] {
    if (this.hasAmbiguousMatchingMapping(model)) return []
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const preferredProviderId = this.getPreferredProvider(model)

    if (preferredProviderId) {
      const preferred = providers.find(p => p.id === preferredProviderId)
      if (preferred) {
        return [preferred]
      }
    }

    return providers.filter(provider => {
      const effectiveModels = storeManager.getEffectiveModels(provider.id)
      if (effectiveModels.length === 0) {
        return true
      }

      const normalizedModel = model.toLowerCase()
      return effectiveModels.some(m => {
        const normalizedSupported = m.displayName.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedModel
      })
    })
  }
}

export const modelMapper = new ModelMapper()
export default modelMapper
