/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import type { Readable } from 'stream'
import { ChatCompletionRequest, ChatCompletionResponse, ProxyContext } from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { createOpenAIStreamTerminalGate, hasCompletedNonStreamAnswer } from '../streamTerminalGate'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import { 
  isAnthropicToolFormat,
  transformResponseToAnthropic,
  transformChunkToAnthropic
} from '../utils/toolFormatConverter'

const router = new Router({ prefix: '/v1/chat' })

// Local-safe diagnostics only. A stage is not proof that a remote write did or
// did not happen. Never copy untrusted provider exception details to a caller.
const ZAI_FAILURE_CODES: Record<NonNullable<import('../types').ForwardResult['failureStage']>, string> = {
  'auth-preflight': 'zai_auth_preflight_failed',
  'chat-creation': 'zai_chat_creation_failed',
  'chat-completion': 'zai_chat_completion_failed',
  'response-decoding': 'zai_response_decoding_failed',
  'unclassified': 'zai_provider_failure_unclassified',
}

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
}

/**
 * Handle Chat Completions Request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let request: ChatCompletionRequest
  try {
    request = ctx.request.body as ChatCompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
        code: null,
      },
    }
    return
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const webSearchFromHeader = ctx.headers['x-web-search'] === 'true'
  const reasoningEffortFromHeader = ctx.headers['x-reasoning-effort'] as 'low' | 'medium' | 'high' | undefined
  const deepResearchFromHeader = ctx.headers['x-deep-research'] === 'true'

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort && !request.reasoning_effort) {
    request.reasoning_effort = requestAny.reasoningEffort
    console.log('[Chat] Reasoning effort set via reasoningEffort (camelCase):', requestAny.reasoningEffort)
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (webSearchFromHeader && request.web_search === undefined) {
    request.web_search = true
    console.log('[Chat] Web search enabled via X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (deepResearchFromHeader && request.deep_research === undefined) {
    request.deep_research = true
    console.log('[Chat] Deep research enabled via X-Deep-Research header')
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  const context: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const forwarded = await requestForwarder.forwardChatCompletion(
      request,
      account,
      provider,
      actualModel,
      context
    )

    // A stream handshake, HTTP 200 or a fabricated empty choice is not proof
    // of a completed model answer. Refuse success before changing user state.
    const missingCompletion = forwarded.success && (
      request.stream === true ? !forwarded.stream : !hasCompletedNonStreamAnswer(forwarded.body)
    )
    const result = missingCompletion ? {
      ...forwarded,
      success: false,
      status: 502,
      failureStage: 'response-decoding' as const,
      failureCode: 'provider_completion_unconfirmed' as const,
      error: 'Provider completion was not confirmed',
      body: undefined,
      stream: undefined,
    } : forwarded

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      const safeFailureCode = result.failureCode ??
        (provider.id === 'zai' && result.failureStage ? ZAI_FAILURE_CODES[result.failureStage] : null)

      if (result.status && result.status >= 400 && result.status !== 429) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: 'Provider request failed',
          type: 'api_error',
          param: null,
          code: safeFailureCode,
        },
      }

      storeManager.addLog('error', 'Provider request failed', {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
        data: safeFailureCode ? {
          failureStage: result.failureStage ?? 'unclassified',
          failureCode: safeFailureCode,
          upstreamStatus: result.status ?? null,
        } : undefined,
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: 'Provider request failed',
          type: 'api_error',
          param: null,
          code: safeFailureCode,
        },
      })
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: 'Provider request failed',
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)

      return
    }

    // Streaming success must be decided after the final verified terminal,
    // not when forwarder returns a Readable before the provider has answered.
    if (request.stream !== true) {
      loadBalancer.clearAccountFailure(account.id)
      proxyStatusManager.recordRequestSuccess(latency)
      storeManager.recordAccountSuccess(account.id, provider.id)
      storeManager.addLog('debug', 'Request succeeded', {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        latency,
        isStream: false,
      })
    }

    const userInput = extractUserInput(request.messages)
    // Store only fixed provenance, never the raw provider/model response body.
    const responseBodyForLog: string | undefined = undefined

    // For streaming requests, we'll collect content and update the log later
    let logEntryId: string | undefined

    if (!request.stream) {
      // Non-streaming: record log with response body now
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      // Streaming: provisional fail-closed receipt until terminal is proven.
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: 502,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 502,
        latency,
        isStream: true,
        errorMessage: 'Stream completion not yet confirmed',
      })
      logEntryId = logEntry.id
    }

    if (request.stream !== true) {
      storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id)
    }

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      // Adapters produce OpenAI SSE; a generic provider may first need the
      // legacy normalization transform. Only the verified terminal gate may
      // emit a downstream [DONE] and declare this operation successful.
      let normalizedStream: Readable = result.stream as Readable
      if (!result.skipTransform) {
        const transformStream = streamHandler.createTransformStream(actualModel, requestId)
        const rawStream = normalizedStream
        rawStream.once('error', () => {
          transformStream.destroy(new Error('Provider stream transform aborted'))
        })
        // A raw transport can close without emitting 'end' or 'error'. If
        // the normalization Transform stays writable, neither the terminal
        // gate nor the HTTP response would ever settle.
        rawStream.once('close', () => {
          if (!rawStream.readableEnded) {
            transformStream.destroy(new Error('Provider stream transport closed prematurely'))
          }
        })
        normalizedStream = rawStream.pipe(transformStream)
      }

      ctx.body = createOpenAIStreamTerminalGate(normalizedStream, completed => {
        const finalLatency = Date.now() - startTime
        if (completed) {
          // A complete, nonempty answer and a valid normal stream terminal
          // have now been observed. Account usage must not change earlier.
          loadBalancer.clearAccountFailure(account.id)
          proxyStatusManager.recordRequestSuccess(finalLatency)
          storeManager.recordRequestInStats(true, finalLatency, request.model, provider.id, account.id)
          storeManager.recordAccountSuccess(account.id, provider.id)
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              status: 'success', statusCode: 200, responseStatus: 200,
              errorMessage: undefined, latency: finalLatency,
            })
          }
          storeManager.addLog('debug', 'Stream response completed', {
            requestId, providerId: provider.id, accountId: account.id,
            model: request.model, actualModel, latency: finalLatency,
          })
        } else {
          // A response may have affected the remote service despite local
          // failure. Preserve UNKNOWN; never replay or switch accounts.
          // Once HTTP headers are committed, status cannot be rewritten; the
          // terminal gate emits a fixed SSE error without a false [DONE].
          // Before commitment, report the same failure as HTTP 502.
          if (!ctx.res?.headersSent && !ctx.headerSent) ctx.status = 502
          proxyStatusManager.recordRequestFailure(finalLatency)
          storeManager.recordRequestInStats(false, finalLatency, request.model, provider.id, account.id)
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              status: 'error', statusCode: 502, responseStatus: 502,
              errorMessage: 'Provider stream completion unconfirmed',
              latency: finalLatency,
            })
          }
          storeManager.addLog('error', 'Provider stream completion unconfirmed', {
            requestId, providerId: provider.id, accountId: account.id,
            model: request.model, latency: finalLatency,
            data: { failureStage: 'response-decoding', failureCode: 'provider_stream_incomplete' },
          })
        }
      })
    } else {
      ctx.set('Content-Type', 'application/json')

      // The preflight above already rejected an absent/uncompleted body.
      if (isAnthropicToolFormat(request.tool_format)) {
        ctx.body = transformResponseToAnthropic(result.body)
        console.log('[Chat] Transformed response to Anthropic tool format')
      } else {
        ctx.body = result.body
      }
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = 'Internal proxy error'
    const errorStack = undefined

    ctx.status = 500
    ctx.body = {
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    }

    storeManager.addLog('error', 'Internal proxy request exception', {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    })
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: 500,
      method: 'POST',
      url: '/v1/chat/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      responseStatus: 500,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage,
      errorStack,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
  }
})

export default router
