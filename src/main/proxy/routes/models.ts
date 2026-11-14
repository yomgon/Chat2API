/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types'
import { loadBalancer } from '../loadbalancer'
import { storeManager } from '../../store/store'
import { modelMapper } from '../modelMapper'
import type { Account, Provider, ModelMapping } from '../../store/types'

const router = new Router({ prefix: '/v1' })

function isAccountSelectable(account: Account): boolean {
  if (account.status !== 'active') return false
  if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) return false
  return true
}

/** A model mapping is only advertised if an enabled, configured provider
 * actually lists its target model and has an active account to route through.
 * This still does NOT constitute a successful live inference test. */
function mappingHasConfiguredTarget(mapping: ModelMapping, providers: Provider[], requestedModel: string): boolean {
  if (!mapping || typeof mapping.actualModel !== 'string' || !mapping.actualModel) return false
  const strategy = storeManager.getConfig().loadBalanceStrategy
  if (!loadBalancer.hasSelectableAccount(
    requestedModel, strategy, mapping.preferredProviderId, mapping.preferredAccountId
  )) return false
  for (const provider of providers) {
    if (mapping.preferredProviderId && provider.id !== mapping.preferredProviderId) continue
    const activeAccounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(isAccountSelectable)
    if (!activeAccounts.length) continue
    if (mapping.preferredAccountId
      && !activeAccounts.some(account => account.id === mapping.preferredAccountId)) continue
    const models = storeManager.getEffectiveModels(provider.id)
    const target = mapping.actualModel.toLowerCase()
    if (models.some(model => {
      // Match the LoadBalancer's catalog contract. Wire IDs are exact;
      // public display aliases are case-insensitive and may be wildcard
      // prefixes. Otherwise POST can dispatch a management-created mapping
      // while GET /v1/models and GET /v1/models/:model falsely hide it.
      if (model.actualModelId === mapping.actualModel) return true
      const display = model.displayName.toLowerCase()
      return display.endsWith('*')
        ? target.startsWith(display.slice(0, -1))
        : display === target
    })) {
      return true
    }
  }
  return false
}

/**
 * Get all available models
 */
router.get('/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(p => p.enabled)
  const strategy = storeManager.getConfig().loadBalanceStrategy
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(isAccountSelectable)

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (!addedModels.has(model.displayName)) {
        // An explicit exact/wildcard mapping owns this public name even when
        // a different provider happens to advertise the same display alias.
        // Never list a model whose pinned target cannot actually be selected.
        const candidate = modelMapper.getMatchingMapping(model.displayName)
        const mapping = candidate && typeof candidate === 'object' ? candidate : undefined
        if (mapping
          ? !mappingHasConfiguredTarget(mapping, providers, model.displayName)
          : !loadBalancer.hasSelectableAccount(model.displayName, strategy, provider.id)) continue
        addedModels.add(model.displayName)
        models.push({
          id: model.displayName,
          object: 'model',
          created: Math.floor(provider.createdAt / 1000),
          owned_by: mapping ? 'model-mapping' : provider.name,
        })
      }
    }
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  for (const [requestModel, mapping] of Object.entries(mappings)) {
    if (!addedModels.has(requestModel) && mappingHasConfiguredTarget(mapping, providers, requestModel)) {
      addedModels.add(requestModel)
      models.push({
        id: requestModel,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'model-mapping',
      })
    }
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model

  const enabledProviders = storeManager.getProviders().filter(p => p.enabled)
  const candidate = modelMapper.getMatchingMapping(modelId)
  const selectedMapping = candidate && typeof candidate === 'object' ? candidate : undefined
  if (selectedMapping && mappingHasConfiguredTarget(selectedMapping, enabledProviders, modelId)) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = {
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'model-mapping',
    }
    return
  }

  // A failed explicit pin cannot be replaced by an unrelated raw display
  // alias. Otherwise GET 200 would advertise a model that POST rejects.
  const providers = selectedMapping ? [] : enabledProviders

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(isAccountSelectable)

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const normalizedModelId = modelId.toLowerCase()
    const found = effectiveModels.some(m => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModelId.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModelId
    })

    if (found && loadBalancer.hasSelectableAccount(
      modelId, storeManager.getConfig().loadBalanceStrategy, provider.id
    )) {
      ctx.set('Content-Type', 'application/json')
      ctx.body = {
        id: modelId,
        object: 'model',
        created: Math.floor(provider.createdAt / 1000),
        owned_by: provider.name,
      }
      return
    }
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
