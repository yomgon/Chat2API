import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import {
  buildSmokeFixture,
  getLatestToolCallingSmokeResult,
  setLatestToolCallingSmokeResult,
} from '../../toolCalling/diagnostics'
import type { ManagementApiResponse } from '../../../../shared/types'
import type { ToolClientAdapterId } from '../../../../shared/toolCalling'

const router = new Router({ prefix: '/v0/management/tool-calling' })
const SUPPORTED_CLIENT_ADAPTERS = new Set(['standard-openai-tools', 'cherry-studio-mcp'])

router.use(managementAuthMiddleware)

router.get('/status', async (ctx: Context) => {
  const config = ConfigManager.get()

  ctx.body = {
    success: true,
    data: {
      config: config.toolCallingConfig,
      latestSmokeResult: getLatestToolCallingSmokeResult(),
    },
  } as ManagementApiResponse
})

router.post('/smoke', async (ctx: Context) => {
  const body = ctx.request.body as { clientAdapterId?: ToolClientAdapterId }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'invalid_request', message: 'Request body must be an object' },
    } as ManagementApiResponse
    return
  }
  const config = ConfigManager.get()
  const clientAdapterId = body.clientAdapterId ?? config.toolCallingConfig.clientAdapterId
  if (typeof clientAdapterId !== 'string' || !SUPPORTED_CLIENT_ADAPTERS.has(clientAdapterId)) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'invalid_request', message: 'Unsupported tool client adapter' },
    } as ManagementApiResponse
    return
  }
  const fixture = buildSmokeFixture(clientAdapterId)

  const result = setLatestToolCallingSmokeResult({
    success: true,
    category: 'pass',
    message: 'Smoke fixture generated. Send it through /v1/chat/completions with a mapped model to run a live provider smoke.',
    clientAdapterId,
    timestamp: Date.now(),
  })

  ctx.body = {
    success: true,
    data: {
      result,
      fixture,
    },
  } as ManagementApiResponse
})

export default router
