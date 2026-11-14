/**
 * Management API - Model Mapping Routes
 * Provides CRUD operations for model mapping management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import ConfigManager from '../../../store/config'
import type {
  ModelMapping,
  CreateModelMappingRequest,
  UpdateModelMappingRequest,
  ManagementApiResponse,
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

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

function getOwnModelMapping(model: string): ModelMapping | undefined {
  const mappings = ConfigManager.getModelMappings()
  return Object.prototype.hasOwnProperty.call(mappings, model) ? mappings[model] : undefined
}

/**
 * GET /v0/management/model-mappings
 * List all model mappings
 */
router.get('/model-mappings', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const mappings = ConfigManager.getModelMappings()
    const mappingList = Object.values(mappings)

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(mappingList)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get model mappings'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/model-mappings
 * Create new model mapping
 */
router.post('/model-mappings', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateModelMappingRequest
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Request body must be an object')
      return
    }

    if (typeof request.requestModel !== 'string' || !request.requestModel.trim()) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: requestModel')
      return
    }

    // ConfigManager currently persists mappings in an ordinary object.
    // Assigning "__proto__" changes that object's prototype instead of
    // storing an own model key; the API used to return 201 for an alias that
    // subsequent GET /v1/models and chat could not resolve. Refuse this one
    // unpersistable key before any config mutation. The valid "constructor"
    // own-key mapping must continue to work for legacy configs.
    if (request.requestModel === '__proto__') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Reserved model mapping name')
      return
    }

    if (typeof request.actualModel !== 'string' || !request.actualModel.trim()) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: actualModel')
      return
    }

    if ((request.preferredProviderId !== undefined &&
          (typeof request.preferredProviderId !== 'string' || !request.preferredProviderId.trim())) ||
        (request.preferredAccountId !== undefined &&
          (typeof request.preferredAccountId !== 'string' || !request.preferredAccountId.trim()))) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Invalid preferred provider or account identifier')
      return
    }

    const existingMapping = getOwnModelMapping(request.requestModel)
    if (existingMapping) {
      ctx.status = 409
      ctx.body = createErrorResponse('mapping_exists', `Model mapping already exists: ${request.requestModel}`)
      return
    }

    const mapping: ModelMapping = {
      requestModel: request.requestModel,
      actualModel: request.actualModel,
      preferredProviderId: request.preferredProviderId,
      preferredAccountId: request.preferredAccountId,
    }

    ConfigManager.setModelMapping(mapping)

    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(mapping)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create model mapping'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * PUT /v0/management/model-mappings/:model
 * Update model mapping
 */
router.put('/model-mappings/:model', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const model = decodeURIComponent(ctx.params.model)
    const request = ctx.request.body as UpdateModelMappingRequest

    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        !['actualModel', 'preferredProviderId', 'preferredAccountId'].some(field =>
          Object.prototype.hasOwnProperty.call(request, field)) ||
        (request.actualModel !== undefined &&
          (typeof request.actualModel !== 'string' || !request.actualModel.trim())) ||
        (request.preferredProviderId !== undefined &&
          (typeof request.preferredProviderId !== 'string' || !request.preferredProviderId.trim())) ||
        (request.preferredAccountId !== undefined &&
          (typeof request.preferredAccountId !== 'string' || !request.preferredAccountId.trim()))) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Invalid model mapping update')
      return
    }

    const existingMapping = getOwnModelMapping(model)
    if (!existingMapping) {
      ctx.status = 404
      ctx.body = createErrorResponse('mapping_not_found', `Model mapping not found: ${model}`)
      return
    }

    const updatedMapping: ModelMapping = {
      requestModel: model,
      actualModel: request.actualModel ?? existingMapping.actualModel,
      preferredProviderId: request.preferredProviderId ?? existingMapping.preferredProviderId,
      preferredAccountId: request.preferredAccountId ?? existingMapping.preferredAccountId,
    }

    ConfigManager.setModelMapping(updatedMapping)

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(updatedMapping)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update model mapping'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/model-mappings/:model
 * Delete model mapping
 */
router.delete('/model-mappings/:model', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const model = decodeURIComponent(ctx.params.model)

    if (!getOwnModelMapping(model)) {
      ctx.status = 404
      ctx.body = createErrorResponse('mapping_not_found', `Model mapping not found: ${model}`)
      return
    }

    const deleted = ConfigManager.removeModelMapping(model)

    if (!deleted) {
      ctx.status = 404
      ctx.body = createErrorResponse('mapping_not_found', `Model mapping not found: ${model}`)
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ model, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete model mapping'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
