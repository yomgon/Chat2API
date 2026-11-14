/**
 * Management API - API Key Routes
 * Provides CRUD operations for API key management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { randomBytes, randomUUID } from 'node:crypto'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { storeManager } from '../../../store/store'
import type { 
  ApiKey,
  CreateApiKeyRequest,
  UpdateApiKeyRequest,
  ManagementApiResponse 
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

const API_KEY_PREFIX = 'sk-mgmt-'
const KEY_RANDOM_LENGTH = 32

/**
 * Generate a new API key value
 * Format: sk-mgmt-{random-string}
 */
function generateApiKeyValue(): string {
  // Electron's Node main process is not guaranteed to expose global WebCrypto.
  // Use the explicit Node CSPRNG; preserve the existing 32-hex-character key
  // format (128 bits) and fail before persistence if entropy is unavailable.
  return `${API_KEY_PREFIX}${randomBytes(KEY_RANDOM_LENGTH / 2).toString('hex')}`
}

/**
 * Mask API key value for display
 * Shows only the last 8 characters
 */
function maskApiKey(key: ApiKey): ApiKey {
  const maskedKey = key.key.length > 8 
    ? `${API_KEY_PREFIX}...${key.key.slice(-8)}`
    : `${API_KEY_PREFIX}...`
  
  return {
    ...key,
    key: maskedKey,
  }
}

/**
 * Create error response
 */
function createErrorResponse(code: string, message: string): ManagementApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

/**
 * Create success response
 */
function createSuccessResponse<T>(data: T): ManagementApiResponse<T> {
  return {
    success: true,
    data,
  }
}

/** Once the key write is committed, a separate diagnostics-log failure must
 * not convert the response into HTTP 500. A regeneration would otherwise
 * replace the old secret without disclosing the only copy of its replacement
 * to the authorized caller. Persisted config remains the source of truth. */
function logCommittedKeyMutation(action: string, key: ApiKey): void {
  try {
    storeManager.addLog('info', `${action} API key: ${key.name}`, {
      data: { keyId: key.id },
    })
  } catch {
    // Logging is best-effort after the successful config write; never retry
    // the secret mutation, roll it back using stale config, or expose its value.
  }
}

/**
 * GET /v0/management/api-keys
 * List all API keys (key values masked)
 */
router.get('/api-keys', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const config = storeManager.getConfig()
    const apiKeys = config.apiKeys || []
    const maskedKeys = apiKeys.map(maskApiKey)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedKeys)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get API keys'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/api-keys
 * Create new API key
 * Returns the full key value - only shown once!
 */
router.post('/api-keys', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateApiKeyRequest

    if (!request.name || typeof request.name !== 'string' || request.name.trim() === '') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: name')
      return
    }
    if (request.description !== undefined && typeof request.description !== 'string') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Invalid field: description must be a string')
      return
    }
    
    const config = storeManager.getConfig()
    const apiKeys = [...(config.apiKeys || [])]
    
    const newKey: ApiKey = {
      id: randomUUID(),
      name: request.name.trim(),
      key: generateApiKeyValue(),
      enabled: true,
      createdAt: Date.now(),
      usageCount: 0,
      description: request.description?.trim(),
    }
    
    apiKeys.push(newKey)
    
    storeManager.updateConfig({ apiKeys })
    
    logCommittedKeyMutation('Created', newKey)
    
    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(newKey)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * PUT /v0/management/api-keys/:id
 * Update API key metadata (name, description, enabled)
 */
router.put('/api-keys/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const request = ctx.request.body as UpdateApiKeyRequest

    // A missing/array body or a metadata-free update used to return HTTP 200
    // and unnecessarily re-persist the unchanged API-key secret. Reject
    // malformed input before touching the authoritative config, including
    // requests with only unknown fields.
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        !['name', 'description', 'enabled'].some(field =>
          Object.prototype.hasOwnProperty.call(request, field))) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request',
        'Request body must contain valid API key metadata fields')
      return
    }

    if (request.description !== undefined && typeof request.description !== 'string') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Invalid field: description must be a string')
      return
    }
    if (request.enabled !== undefined && typeof request.enabled !== 'boolean') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Invalid field: enabled must be a boolean')
      return
    }
    
    const config = storeManager.getConfig()
    const apiKeys = [...(config.apiKeys || [])]
    const keyIndex = apiKeys.findIndex(k => k.id === id)
    
    if (keyIndex === -1) {
      ctx.status = 404
      ctx.body = createErrorResponse('api_key_not_found', `API key not found: ${id}`)
      return
    }
    
    const existingKey = { ...apiKeys[keyIndex] }
    
    if (request.name !== undefined) {
      if (typeof request.name !== 'string' || request.name.trim() === '') {
        ctx.status = 400
        ctx.body = createErrorResponse('invalid_request', 'Invalid field: name must be a non-empty string')
        return
      }
      existingKey.name = request.name.trim()
    }
    
    if (request.description !== undefined) existingKey.description = request.description.trim()
    
    if (request.enabled !== undefined) {
      existingKey.enabled = request.enabled
    }
    
    apiKeys[keyIndex] = existingKey
    
    storeManager.updateConfig({ apiKeys })
    
    logCommittedKeyMutation('Updated', existingKey)
    
    const maskedKey = maskApiKey(existingKey)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedKey)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/api-keys/:id
 * Delete API key
 */
router.delete('/api-keys/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const config = storeManager.getConfig()
    const apiKeys = [...(config.apiKeys || [])]
    const keyIndex = apiKeys.findIndex(k => k.id === id)
    
    if (keyIndex === -1) {
      ctx.status = 404
      ctx.body = createErrorResponse('api_key_not_found', `API key not found: ${id}`)
      return
    }
    
    const deletedKey = apiKeys[keyIndex]
    apiKeys.splice(keyIndex, 1)
    
    storeManager.updateConfig({ apiKeys })
    
    logCommittedKeyMutation('Deleted', deletedKey)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ id, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/api-keys/:id/regenerate
 * Generate new key value for existing key
 * Returns the new key value - only shown once!
 */
router.post('/api-keys/:id/regenerate', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const config = storeManager.getConfig()
    const apiKeys = [...(config.apiKeys || [])]
    const keyIndex = apiKeys.findIndex(k => k.id === id)
    
    if (keyIndex === -1) {
      ctx.status = 404
      ctx.body = createErrorResponse('api_key_not_found', `API key not found: ${id}`)
      return
    }
    
    const existingKey = { ...apiKeys[keyIndex] }
    const newKeyValue = generateApiKeyValue()
    
    existingKey.key = newKeyValue
    existingKey.usageCount = 0
    
    apiKeys[keyIndex] = existingKey
    
    storeManager.updateConfig({ apiKeys })
    
    logCommittedKeyMutation('Regenerated', existingKey)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(existingKey)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to regenerate API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
