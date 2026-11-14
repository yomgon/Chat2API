/**
 * Management API - Proxy Control Routes
 * Provides endpoints for proxy service control (start, stop, restart, status)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { proxyServer } from '../../server'
import { isLocalBindHost } from '../../localSecurity'
import { proxyStatusManager } from '../../status'
import { storeManager } from '../../../store/store'
import type {
  ManagementApiResponse,
  ProxyStatusResponse,
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/proxy' })

router.use(managementAuthMiddleware)

let pendingTransition: 'stop' | 'restart' | null = null

function logFailedTransition(message: string): void {
  try {
    storeManager.addLog('error', message)
  } catch {
    // A response-accepted control transition must not produce an unhandled
    // rejection just because its optional error diagnostics are unavailable.
  }
}

function scheduleAfterResponse(
  ctx: Context,
  transition: 'stop' | 'restart',
  operation: () => Promise<boolean>,
): void {
  // Waiting for server.close() in the same HTTP handler can deadlock because
  // the close callback waits for this response to finish.
  pendingTransition = transition
  let started = false
  const run = () => {
    if (started) return
    started = true
    void operation().then(success => {
      if (!success) logFailedTransition('Management proxy ' + transition + ' failed')
    }).catch(() => {
      logFailedTransition('Management proxy ' + transition + ' encountered an error')
    }).finally(() => {
      pendingTransition = null
    })
  }
  ctx.res.once('finish', run)
  ctx.res.once('close', run)
  ctx.set('Connection', 'close')
}

function isValidRestartTarget(port: unknown, host: unknown): boolean {
  return (port === undefined || (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535)) &&
    (host === undefined || (typeof host === 'string' && isLocalBindHost(host)))
}

interface ProxyStartRequest {
  port?: number
  host?: string
}

interface ProxyRestartRequest {
  port?: number
  host?: string
}

function createErrorResponse(code: string, message: string): ManagementApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

function createSuccessResponse<T>(data: T): ManagementApiResponse<T> {
  return {
    success: true,
    data,
  }
}

function getProxyStatusData(): ProxyStatusResponse {
  const status = proxyStatusManager.getRunningStatus()
  const statistics = proxyStatusManager.getStatistics()
  const port = proxyStatusManager.getPort()
  const host = proxyStatusManager.getHost()

  return {
    isRunning: status.isRunning,
    port,
    host,
    uptime: status.uptime,
    connections: statistics.activeConnections,
  }
}

router.post('/start', async (ctx: Context) => {
  try {
    if (proxyServer.isRunning()) {
      ctx.status = 400
      ctx.body = createErrorResponse('already_running', 'Proxy service is already running')
      return
    }

    const request = (ctx.request.body as ProxyStartRequest) || {}
    const port = request.port
    const host = request.host

    const success = await proxyServer.start(port, host)

    if (!success) {
      ctx.status = 500
      ctx.body = createErrorResponse('start_failed', 'Failed to start proxy service')
      return
    }

    const statusData = getProxyStatusData()

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      isRunning: statusData.isRunning,
      port: statusData.port,
      host: statusData.host,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to start proxy service'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/stop', async (ctx: Context) => {
  try {
    if (pendingTransition) {
      ctx.status = 409
      ctx.body = createErrorResponse('transition_pending', 'Proxy transition already pending')
      return
    }
    if (!proxyServer.isRunning()) {
      ctx.status = 400
      ctx.body = createErrorResponse('not_running', 'Proxy service is not running')
      return
    }

    // HTTP 202 confirms acceptance; GET /status confirms final completion.
    scheduleAfterResponse(ctx, 'stop', () => proxyServer.stop())
    ctx.status = 202
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      state: 'stopping',
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to stop proxy service'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/restart', async (ctx: Context) => {
  try {
    if (pendingTransition) {
      ctx.status = 409
      ctx.body = createErrorResponse('transition_pending', 'Proxy transition already pending')
      return
    }
    const request = (ctx.request.body as ProxyRestartRequest) || {}
    const port = request.port
    const host = request.host
    if (!isValidRestartTarget(port, host)) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_target', 'Proxy restart requires a loopback host and valid port')
      return
    }

    scheduleAfterResponse(ctx, 'restart', () => proxyServer.restart(port, host))
    ctx.status = 202
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      state: 'restarting',
      port: port ?? proxyStatusManager.getPort(),
      host: host ?? proxyStatusManager.getHost(),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to restart proxy service'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.get('/status', async (ctx: Context) => {
  try {
    const statusData = getProxyStatusData()

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(statusData)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get proxy status'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
