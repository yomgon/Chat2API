/**
 * Proxy Service Module - Proxy Server Core
 * Implements proxy server based on Koa
 */

import Koa, { type Context, type Next } from 'koa'
import { app as electronApp } from 'electron'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { Server as HttpServer } from 'http'
import routes from './routes'
import managementRoutes from './routes/management'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { sessionManager } from './sessionManager'
import { evaluateProxyKey, hasUntrustedBrowserOrigin, isLocalBindHost, isTrustedHostHeader } from './localSecurity'

const SLOW_REQUEST_THRESHOLD_MS = 1500

/** Authenticated API admission failures are real local client failures even
 * if no provider account exists. Count them once without inventing a provider
 * effect, penalizing an account or retaining credentials/message content.
 * Provider-dispatched requests are settled exclusively by the Chat/Legacy
 * routes, including their asynchronous verified SSE terminal. */
function recordRejectedBeforeProviderDispatch(ctx: Context, latency: number): void {
  if (ctx.method !== 'POST' ||
      (ctx.path !== '/v1/chat/completions' && ctx.path !== '/v1/completions') ||
      ctx.status < 400 || ctx.state.providerDispatchStarted ||
      ctx.res?.destroyed) return

  const rawBody = ctx.request.body
  const fields = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
    ? rawBody as Record<string, unknown> : {}
  const rawModel = fields.model
  const model = typeof rawModel === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(rawModel)
    ? rawModel : '[preflight]'
  const rawError = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
    ? (ctx.body as { error?: unknown }).error : undefined
  const rawCode = rawError && typeof rawError === 'object' && !Array.isArray(rawError)
    ? (rawError as { code?: unknown }).code : undefined
  const code = typeof rawCode === 'string' && /^[a-z0-9_]{2,64}$/.test(rawCode)
    ? rawCode : 'preflight_rejected'

  // Admission receipts are a distinct store operation. Provider-attempt
  // fakes and their existing accounting contracts have no such operation;
  // they must never be mistaken for a provider request or charge. The real
  // persistent store owns one local request failure without model/account
  // usage, and its log sink is independent of the original HTTP response.
  if (typeof storeManager.recordClientPreflightRejection !== 'function') return
  try {
    if (typeof proxyStatusManager.recordClientRejection === 'function') {
      proxyStatusManager.recordClientRejection(latency)
    }
  } catch {}
  try {
    storeManager.recordClientPreflightRejection({
      statusCode: ctx.status, method: 'POST', path: ctx.path, model, latency,
      isStream: fields.stream === true, errorCode: code,
    })
  } catch {}
}

/** Listener/session lifetime is authoritative; optional diagnostics must not
 * throw from Node's async listen/close callbacks or leave start/stop pending. */
function logProxyLifecycle(level: 'info' | 'error', message: string): void {
  try {
    storeManager.addLog(level, message)
  } catch {
    // Never alter an already committed listener/close outcome for logging.
  }
}

/**
 * Proxy Server Class
 */
export class ProxyServer {
  private app: Koa
  private router: Router
  private server: HttpServer | null = null
  private port: number = 8080
  private host: string = '127.0.0.1'

  constructor() {
    this.app = new Koa()
    this.router = new Router()

    this.setupMiddleware()
    this.setupRoutes()
    this.setupErrorHandler()
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    this.app.use(async (ctx, next) => {
      if (!isTrustedHostHeader(ctx.get('Host'), this.port)) {
        ctx.status = 403
        ctx.body = { error: { message: 'Invalid local host authority', code: 'host_forbidden' } }
        return
      }
      // This proxy is a native-app service. Requests originating from browser
      // pages can abuse a loopback server even if the listener is not on LAN.
      // API clients (curl, local SDKs) do not send the Origin header.
      if (hasUntrustedBrowserOrigin(ctx.get('Origin'))) {
        ctx.status = 403
        ctx.body = { error: { message: 'Browser origins are not allowed', code: 'browser_origin_forbidden' } }
        return
      }

      await next()
    })

    // API Key validation middleware
    this.app.use(async (ctx, next) => {
      // Low-detail readiness endpoints stay available to local health probes.
      const publicPaths = ['/', '/health']
      if (publicPaths.includes(ctx.path)) {
        await next()
        return
      }

      // Skip management API paths - they have their own authentication
      if (ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      const config = storeManager.getConfig()
      const authHeader = ctx.get('Authorization')
      const providedKey = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : ctx.get('X-API-Key').trim()
      // URL query strings must not carry credentials: they are commonly logged.
      const decision = evaluateProxyKey(config, providedKey)
      if (!decision.allowed) {
        ctx.status = decision.status
        ctx.body = {
          error: {
            message: decision.code === 'api_key_not_configured'
              ? 'Configure an enabled local proxy API key before using the API'
              : 'API key authentication failed',
            type: 'invalid_request_error',
            code: decision.code,
          },
        }
        return
      }

      if (decision.matchedKeyId) {
        const updatedKeys = config.apiKeys.map(k =>
          k.id === decision.matchedKeyId
            ? { ...k, lastUsedAt: Date.now(), usageCount: k.usageCount + 1 }
            : k
        )
        storeManager.updateConfig({ apiKeys: updatedKeys })
      }
      await next()
    })

    // Check authorization before parsing up to 50 MiB of untrusted input.
    this.app.use(bodyParser({
      jsonLimit: '50mb',
      formLimit: '50mb',
      textLimit: '50mb',
    }))

    this.app.use(async (ctx, next) => {
      const started = Date.now()
      await next()
      recordRejectedBeforeProviderDispatch(ctx, Date.now() - started)
    })

    this.app.use(async (ctx, next) => {
      const startTime = Date.now()

      await next()

      const latency = Date.now() - startTime
      const shouldRecordAccessLog =
        !ctx.path.startsWith('/v1/models') &&
        (ctx.status >= 400 || latency >= SLOW_REQUEST_THRESHOLD_MS)

      if (shouldRecordAccessLog) {
        try {
          storeManager.addLog('warn', `${ctx.method} ${ctx.path} ${ctx.status} ${latency}ms`, {
            data: {
              method: ctx.method,
              path: ctx.path,
              status: ctx.status,
              latency,
              clientIP: ctx.ip,
              slowRequest: latency >= SLOW_REQUEST_THRESHOLD_MS,
            },
          })
        } catch {
          // Access diagnostics are best effort. A failed log write after the
          // route has completed must not replace an authenticated API status
          // or turn an already-committed mutation into an apparent HTTP 500.
        }
      }
    })
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    // Register OpenAI API routes
    for (const route of routes) {
      this.router.use(route.routes())
      this.router.use(route.allowedMethods())
    }

    this.router.get('/', async (ctx) => {
      ctx.body = {
        name: 'Chat2API Proxy',
        version: electronApp.getVersion(),
        description: 'OpenAI API compatible proxy service',
        endpoints: [
          'POST /v1/chat/completions',
          'GET /v1/models',
          'GET /v1/models/:model',
          'POST /v1/completions',
        ],
      }
    })

    this.router.get('/health', async (ctx) => {
      const status = proxyStatusManager.getRunningStatus()
      const statistics = proxyStatusManager.getStatistics()

      ctx.body = {
        status: status.isRunning ? 'running' : 'stopped',
        uptime: status.uptime,
        statistics: {
          totalRequests: statistics.totalRequests,
          successRequests: statistics.successRequests,
          failedRequests: statistics.failedRequests,
          activeConnections: statistics.activeConnections,
        },
      }
    })

    this.router.get('/stats', async (ctx) => {
      const statistics = proxyStatusManager.getStatistics()
      ctx.body = statistics
    })

    // Management API enable check middleware
    // This must be registered before management routes
    const managementEnableCheck = async (ctx: Context, next: Next) => {
      if (!ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      try {
        const config = storeManager.getConfig()
        if (!config.managementApi?.enableManagementApi) {
          ctx.status = 404
          ctx.body = {
            success: false,
            error: {
              code: 'management_api_disabled',
              message: 'Management API is not enabled',
            },
          }
          return
        }
        await next()
        // Management route handlers often catch storage/provider exceptions
        // and put error.message directly into their JSON response. Those
        // exception strings can contain credentials, tokens, request URLs or
        // protected store internals. Sanitize at this final Koa response
        // boundary instead of trusting each independent management handler.
        // Keep stable machine-readable error codes and normal 4xx validation.
        const response = ctx.body
        const error = response && typeof response === 'object' && !Array.isArray(response)
          ? (response as { success?: unknown, error?: unknown }).error : undefined
        const code = error && typeof error === 'object' && !Array.isArray(error)
          ? (error as { code?: unknown }).code : undefined
        if (ctx.status >= 500 || code === 'provider_not_found' || code === 'forbidden') {
          if (error && typeof error === 'object' && !Array.isArray(error)) {
            const safeCode = typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)
              ? code : 'internal_error'
            const message = safeCode === 'provider_not_found'
              ? 'Provider not found'
              : safeCode === 'forbidden' ? 'Management operation forbidden'
                : 'Management API operation failed'
            ctx.body = { success: false, error: { code: safeCode, message } }
          }
        }
      } catch {
        ctx.status = 503
        ctx.body = {
          success: false,
          error: {
            code: 'service_unavailable',
            message: 'Service is initializing',
          },
        }
      }
    }

    this.app.use(managementEnableCheck)

    // Register all management routes (they already have /v0/management prefix)
    for (const route of managementRoutes) {
      this.app.use(route.routes())
      this.app.use(route.allowedMethods())
    }

    this.app.use(this.router.routes())
    this.app.use(this.router.allowedMethods())

    this.app.use(async (ctx) => {
      ctx.status = 404
      ctx.body = {
        error: {
          message: `Route not found: ${ctx.method} ${ctx.path}`,
          type: 'not_found_error',
        },
      }
    })
  }

  /**
   * Setup error handler
   */
  private setupErrorHandler(): void {
    this.app.on('error', (err, ctx) => {
      const status = err.status || 500
      // Koa invokes error listeners synchronously while constructing its
      // HTTP error response. If an optional diagnostic writer throws from
      // this event callback, Koa's onerror path itself rejects and the
      // client may hang instead of receiving the original 4xx/5xx.
      // Unlike an account/config write, this log is not a commit boundary.
      try {
        storeManager.addLog('error', 'Local proxy server error', {
          data: {
            status,
            path: ctx.path,
            method: ctx.method,
          },
        })
      } catch {
        // Preserve Koa's original response and never disclose log failures.
      }
    })
  }

  /**
   * Start server
   */
  async start(port?: number, host?: string): Promise<boolean> {
    if (this.server) {
      return false
    }

    const requestedPort = port ?? proxyStatusManager.getPort()
    const requestedHost = host ?? proxyStatusManager.getHost()
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      logProxyLifecycle('error', 'Local proxy rejected invalid port')
      return false
    }
    if (!isLocalBindHost(requestedHost)) {
      logProxyLifecycle('error', 'Local proxy rejected non-loopback bind host')
      return false
    }

    this.port = requestedPort
    this.host = requestedHost
    
    sessionManager.initialize()

    return new Promise((resolve) => {
      try {
        this.server = this.app.listen(this.port, this.host, () => {
          proxyStatusManager.start()
          proxyStatusManager.setPort(this.port)
          proxyStatusManager.setHost(this.host)

          logProxyLifecycle('info', `Proxy server started successfully, listening on ${this.host}:${this.port}`)

          resolve(true)
        })

        this.server.on('error', (err: NodeJS.ErrnoException) => {
          // Session cleanup starts before Koa attempts to bind. A rejected
          // listener never reaches stop(), so release the scheduler here.
          sessionManager.destroy()
          if (err.code === 'EADDRINUSE') {
            logProxyLifecycle('error', `Port ${this.port} is already in use`)
          } else {
            logProxyLifecycle('error', 'Local proxy listener error')
          }
          this.server = null
          resolve(false)
        })

        this.server.on('close', () => {
          this.server = null
        })
      } catch (error) {
        sessionManager.destroy()
        logProxyLifecycle('error', 'Failed to start local proxy server')
        resolve(false)
      }
    })
  }

  /**
   * Stop server
   */
  async stop(): Promise<boolean> {
    if (!this.server) {
      return false
    }
    
    sessionManager.destroy()

    return new Promise((resolve) => {
      this.server!.close((err) => {
        if (err) {
          logProxyLifecycle('error', 'Failed to stop local proxy server')
          resolve(false)
          return
        }

        this.server = null
        proxyStatusManager.stop()

        logProxyLifecycle('info', 'Proxy server stopped')

        resolve(true)
      })
    })
  }

  /**
   * Restart server
   */
  async restart(port?: number, host?: string): Promise<boolean> {
    const requestedHost = host ?? this.host
    const requestedPort = port ?? this.port
    // Reject the replacement before stopping the current listener.
    if (!isLocalBindHost(requestedHost) || !Number.isInteger(requestedPort) ||
        requestedPort < 1 || requestedPort > 65535) {
      return false
    }
    if (this.server && !(await this.stop())) {
      return false
    }
    return this.start(port, host)
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null && proxyStatusManager.getRunningStatus().isRunning
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return proxyStatusManager.getStatistics()
  }

  /**
   * Get running status
   */
  getStatus() {
    return proxyStatusManager.getRunningStatus()
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    proxyStatusManager.resetStatistics()
  }
}

export const proxyServer = new ProxyServer()
export default proxyServer
