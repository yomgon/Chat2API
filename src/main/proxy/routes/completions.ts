/**
 * Proxy Service Module - Completions Route (Optional)
 * Implements /v1/completions route (legacy API)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import type { Readable } from 'stream'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import {
  createOpenAIStreamTerminalGate, hasCompletedNonStreamAnswer,
  getStopSequences, applyStopSequencesNonStream, createStopSequenceSseStream,
} from '../streamTerminalGate'
import { createLegacyCompletionStream, toLegacyCompletion } from '../legacyCompletion'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import type { ChatCompletionRequest } from '../types'

const router = new Router({ prefix: '/v1' })

interface CompletionRequest {
  model: string
  prompt: string | string[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
  logit_bias?: Record<string, number>
  n?: number
  stream?: boolean
  stop?: string | string[]
  echo?: boolean
}

/** Match the chat endpoint's six dedicated consumer-web sampling boundary.
 * These adapters do not honor nondefault sampling or an explicit token cap;
 * unlike the generic/custom provider wire, a successful local HTTP response
 * would otherwise falsely promise that unsupported request contract. */
const WEB_CONSUMER_SAMPLING_IDS = new Set(['deepseek', 'qwen', 'glm', 'zai', 'qwen-ai', 'kimi'])
function getUnsupportedWebSamplingOption(
  request: CompletionRequest, providerId: string,
): 'max_tokens' | 'temperature' | 'top_p' | 'presence_penalty' |
  'frequency_penalty' | 'logit_bias' | null {
  if (!WEB_CONSUMER_SAMPLING_IDS.has(providerId)) return null
  if (request.max_tokens != null) return 'max_tokens'
  if (request.temperature != null && request.temperature !== 1) return 'temperature'
  if (request.top_p != null && request.top_p !== 1) return 'top_p'
  if (request.presence_penalty != null && request.presence_penalty !== 0) return 'presence_penalty'
  if (request.frequency_penalty != null && request.frequency_penalty !== 0) return 'frequency_penalty'
  if (request.logit_bias != null && Object.keys(request.logit_bias).length > 0) return 'logit_bias'
  return null
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `cmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Convert prompt to messages format
 */
function promptToMessages(prompt: string): ChatCompletionRequest['messages'] {
  return [{ role: 'user', content: prompt }]
}

/** A confirmed account-success write is the settlement boundary. Independent
 * diagnostics must not convert its completed legacy answer to HTTP 500, or
 * revoke [DONE] from a valid SSE after the account was already charged. */
function recordAfterLegacyAccountCommit(write: () => void): void {
  try {
    write()
  } catch {
    // Never retry an upstream effect or publish a private diagnostic error.
  }
}

/** Keep provider failure status and a refused account settlement independent
 * from optional stats/log persistence. Each sink gets one attempt, even when
 * another sink is unavailable. The durable account write is never optional. */
function recordLegacyFailureDiagnostic(write: () => void): void {
  try {
    write()
  } catch {
    // Neither override HTTP/SSE outcome nor retry an upstream effect.
  }
}

/**
 * Handle Completions request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()

  let request: CompletionRequest
  try {
    request = ctx.request.body as CompletionRequest
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Invalid JSON object')
    }
  } catch {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }
    return
  }

  if (typeof request.model !== 'string' || !request.model.trim()) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
      },
    }
    return
  }

  if (request.prompt === undefined) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      },
    }
    return
  }

  // A list of independent prompts, multiple choices and prompt echo cannot
  // be faithfully implemented by dispatching a single chat completion. In
  // particular, never treat array items as alternating conversation roles.
  // Reject these forms *before* any provider effect or account reservation.
  const prompt = Array.isArray(request.prompt) && request.prompt.length === 1
    ? request.prompt[0]
    : request.prompt
  if (typeof prompt !== 'string' || (request.n !== undefined && request.n !== 1) ||
      request.echo === true || (request.echo !== undefined && request.echo !== false) ||
      (request.stream !== undefined && typeof request.stream !== 'boolean')) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid legacy completions parameter',
        type: 'invalid_request_error',
        code: 'unsupported_completion_parameter',
      },
    }
    return
  }

  // A malformed sampling/stop option must not reach a model consumer after
  // account selection. Leave genuinely omitted/null defaults untouched.
  const invalidCoreOption =
    (request.max_tokens != null && (!Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1))
      ? 'max_tokens'
      : (request.temperature != null && (typeof request.temperature !== 'number' ||
        !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2))
        ? 'temperature'
        : (request.top_p != null && (typeof request.top_p !== 'number' ||
          !Number.isFinite(request.top_p) || request.top_p < 0 || request.top_p > 1))
          ? 'top_p'
          : (request.stop != null && !(
            (typeof request.stop === 'string' && request.stop.length > 0) ||
            (Array.isArray(request.stop) && request.stop.length <= 4 &&
              request.stop.every(value => typeof value === 'string' && value.length > 0))))
            ? 'stop' : null
  if (invalidCoreOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid legacy completion parameter',
        type: 'invalid_request_error',
        param: invalidCoreOption,
        code: 'invalid_completion_parameter',
      },
    }
    return
  }

  // The legacy endpoint is bridged to one ChatCompletionRequest. Previously
  // these standard options were silently discarded before the adapter saw
  // them, even when invalid. Validate the same bounded values as the chat
  // route and preserve valid values in the single forwarded request. Do not
  // start a remote consumer operation for an impossible sampling request.
  const validPenalty = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= -2 && value <= 2
  const invalidSamplingOption =
    (request.presence_penalty != null && !validPenalty(request.presence_penalty))
      ? 'presence_penalty'
      : (request.frequency_penalty != null && !validPenalty(request.frequency_penalty))
        ? 'frequency_penalty'
        : (request.logit_bias != null && (typeof request.logit_bias !== 'object' ||
          Array.isArray(request.logit_bias) ||
          Object.values(request.logit_bias).some(value =>
            typeof value !== 'number' || !Number.isFinite(value) ||
            value < -100 || value > 100))) ? 'logit_bias' : null
  if (invalidSamplingOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid legacy completion parameter',
        type: 'invalid_request_error',
        param: invalidSamplingOption,
        code: 'invalid_completion_parameter',
      },
    }
    return
  }

  // The legacy bridge always produces one plain chat answer with
  // logprobs:null; it cannot implement best-of sampling, token probability
  // metadata, or suffix/infill output. Refuse these guarantees before account
  // selection or a provider operation, while preserving harmless defaults.
  const extra = request as unknown as Record<string, unknown>
  const unsupportedOutput =
    (extra.best_of != null && extra.best_of !== 1) ? 'best_of'
      : (extra.logprobs != null && extra.logprobs !== 0) ? 'logprobs'
        : (extra.suffix != null && extra.suffix !== '') ? 'suffix' : null
  if (unsupportedOutput) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Requested legacy completion output guarantee is not supported',
        type: 'invalid_request_error',
        param: unsupportedOutput,
        code: 'unsupported_completion_parameter',
      },
    }
    return
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
        code: 'no_available_account',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection
  // The immutable provider ID alone does not define the outgoing wire:
  // exact first-party origin aliases may select one of the six web adapters.
  // Keep validation identical to the RequestForwarder's actual dispatch.
  const selectedConsumerId = typeof requestForwarder.getConsumerWebProviderId === 'function'
    ? requestForwarder.getConsumerWebProviderId(provider) ?? provider.id
    : provider.id
  const unsupportedWebSamplingOption = getUnsupportedWebSamplingOption(request, selectedConsumerId)
  if (unsupportedWebSamplingOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Selected web provider cannot enforce the requested sampling or token limit',
        type: 'invalid_request_error',
        param: unsupportedWebSamplingOption,
        code: 'unsupported_completion_parameter',
      },
    }
    return
  }
  // Legacy must not add an automatic summary POST to the one authorized model
  // completion. Its Chat bridge is a single-user message; preview the actual
  // context strategy before any quota reservation or upstream transport.
  if (typeof requestForwarder.requiresAdditionalSummary === 'function' &&
      await requestForwarder.requiresAdditionalSummary({
        model: actualModel, messages: promptToMessages(prompt), stream: request.stream,
      }, provider)) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Automatic context summary requires an additional model operation',
        type: 'invalid_request_error',
        param: 'contextManagement',
        code: 'context_summary_additional_effect_not_allowed',
      },
    }
    return
  }
  // Real LoadBalancer reserves one in-flight slot; historical test doubles
  // that only implement selection retain their original contract.
  const releaseReservation = typeof loadBalancer.reserveSelectedAccount === 'function'
    ? loadBalancer.reserveSelectedAccount(selection)
    : () => {}
  if (!releaseReservation) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        code: 'no_available_account',
      },
    }
    return
  }
  let streamOwnsReservation = false

  const chatRequest = {
    model: actualModel,
    messages: promptToMessages(prompt),
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    logit_bias: request.logit_bias,
    n: request.n,
    stream: request.stream,
    stop: request.stop,
  }

  // Legacy completions share the Chat route's optional request-log ledger.
  // Keep diagnostics independent from the one authorized provider effect and
  // from mandatory account settlement: a log sink may fail without turning
  // an already committed answer into a false HTTP 500 or dropping [DONE].
  const addLegacyRequestLog = (
    status: 'success' | 'error', statusCode: number, latency: number,
    errorMessage?: string, responseBody?: string,
  ): string | undefined => {
    try {
      return storeManager.addRequestLog({
        timestamp: startTime,
        status, statusCode, method: 'POST', url: '/v1/completions',
        model: request.model, actualModel,
        providerId: provider.id, providerName: provider.name,
        accountId: account.id, accountName: account.name,
        requestBody: JSON.stringify(request), userInput: prompt,
        responseStatus: statusCode, latency,
        isStream: request.stream === true,
        errorMessage, responseBody,
      }).id
    } catch {
      // No log retry, provider retry, account fallback or private exception.
      return undefined
    }
  }
  const updateLegacyRequestLog = (
    id: string | undefined, status: 'success' | 'error', statusCode: number,
    latency: number, errorMessage?: string,
  ): void => {
    if (!id) return
    recordLegacyFailureDiagnostic(() => storeManager.updateRequestLog(id, {
      status, statusCode, responseStatus: statusCode, latency, errorMessage,
    }))
  }

  try {
    // Do not double-count a provider-attempted request as a local admission
    // rejection in ProxyServer's post-response observability middleware.
    if (ctx.state) ctx.state.providerDispatchStarted = true
    proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)
    const result = await requestForwarder.forwardChatCompletion(
      chatRequest,
      account,
      provider,
      actualModel,
      {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        startTime,
        isStream: request.stream || false,
      }
    )

    const latency = Date.now() - startTime

    // An upstream reply arriving after the caller has disconnected cannot
    // establish a completed local legacy response. Keep any remote effect
    // unconfirmed; never charge a delivered success or replay it.
    if (ctx.res?.destroyed) {
      const orphanedStream = result.stream as Readable | undefined
      if (orphanedStream && typeof orphanedStream.destroy === 'function') {
        orphanedStream.destroy()
      }
      proxyStatusManager.recordRequestFailure(latency)
      recordLegacyFailureDiagnostic(() =>
        storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id))
      addLegacyRequestLog('error', 502, latency, 'Legacy client disconnected before settlement')
      recordLegacyFailureDiagnostic(() => storeManager.addLog('warn', 'Legacy client disconnected before provider response settlement', {
        requestId, providerId: provider.id, accountId: account.id,
        model: request.model, latency,
      }))
      return
    }

    // HTTP 200 and a body or stream handshake cannot prove completion. The
    // existing chat route has the same nonstream terminal contract.
    const incompleteNonStream = request.stream !== true &&
      (!hasCompletedNonStreamAnswer(result.body) ||
        (result.body as { choices?: Array<{ finish_reason?: string }> } | undefined)
          ?.choices?.[0]?.finish_reason === 'tool_calls')
    if (!result.success || (request.stream === true ? !result.stream : incompleteNonStream)) {
      proxyStatusManager.recordRequestFailure(latency)
      // Keep the same fixed, non-secret failure phase as the Chat route.
      // A locally incomplete successful forward is known only to have failed
      // terminal verification; it is not proof of an upstream HTTP failure.
      const knownFailureStages: readonly string[] = [
        'auth-preflight', 'chat-creation', 'chat-completion',
        'response-decoding', 'unclassified',
      ]
      const safeFailureStage = result.success ? 'response-decoding'
        : result.failureStage && knownFailureStages.includes(result.failureStage)
          ? result.failureStage : 'unclassified'
      // Preserve the established null Legacy provider-error code contract.
      // Only the two new *purely local*, fixed context preflight failures
      // require actionable codes; never surface a raw upstream exception.
      const localContextCode = result.failureCode === 'context_history_unrepresentable' ||
        result.failureCode === 'context_strategy_failed' ? result.failureCode : null
      ctx.status = result.success ? 502 : result.status || 500
      ctx.body = {
        error: {
          message: 'Provider completion could not be confirmed',
          type: 'api_error',
          code: result.success ? 'provider_completion_unconfirmed' : localContextCode,
          stage: safeFailureStage,
        },
      }
      recordLegacyFailureDiagnostic(() =>
        storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id))
      addLegacyRequestLog('error', ctx.status, latency,
        'Provider completion could not be confirmed (' + safeFailureStage + ')',
        JSON.stringify(ctx.body))
      return
    }

    const stops = request.stop == null ||
      (Array.isArray(request.stop) && request.stop.length === 0)
      ? [] : getStopSequences(request.stop)
    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      let normalizedStream: Readable = result.stream as Readable
      if (!result.skipTransform) {
        const transformStream = streamHandler.createTransformStream(actualModel, requestId)
        const rawStream = normalizedStream
        rawStream.once('error', () => transformStream.destroy(new Error('Legacy provider stream aborted')))
        rawStream.once('close', () => {
          if (!rawStream.readableEnded) {
            transformStream.destroy(new Error('Legacy provider stream closed prematurely'))
          }
        })
        // Cancellation of the normalized client stream also owns the raw
        // upstream reader: do not strand a provider transport after unpipe.
        transformStream.once('close', () => {
          if (!rawStream.readableEnded) {
            rawStream.unpipe(transformStream)
            if (!rawStream.destroyed) rawStream.destroy()
          }
        })
        normalizedStream = rawStream.pipe(transformStream)
      }

      const stopped = stops.length ? createStopSequenceSseStream(normalizedStream, stops) : null
      // Before the stream finishes, only an error/provisional diagnostic is
      // safe to persist. A confirmed success is recorded after durable account
      // settlement and before the gate permits the client's final [DONE].
      const streamLogId = addLegacyRequestLog('error', 502, latency,
        'Legacy stream completion not yet confirmed')
      const verified = createOpenAIStreamTerminalGate(stopped?.stream ?? normalizedStream, completed => {
        const finalLatency = Date.now() - startTime
        if (!completed) {
          // Even a remote partial answer may have used a provider quota. No
          // replay, fallback or UNKNOWN closure is authorized here.
          proxyStatusManager.recordRequestFailure(finalLatency)
          recordLegacyFailureDiagnostic(() =>
            storeManager.recordRequestInStats(false, finalLatency, request.model, provider.id, account.id))
          updateLegacyRequestLog(streamLogId, 'error', 502, finalLatency,
            'Legacy stream completion unconfirmed')
          recordLegacyFailureDiagnostic(() => storeManager.addLog('error', 'Legacy completion stream unconfirmed', {
            requestId, providerId: provider.id, accountId: account.id, model: request.model,
          }))
          if (!ctx.res?.headersSent && !ctx.headerSent) ctx.status = 502
          return
        }

        // The gate will withhold finish/usage/DONE until this durable local
        // account settlement succeeds. A rejected write must not show DONE.
        try {
          if (storeManager.recordAccountSuccess(account.id, provider.id) !== true) {
            throw new Error('Legacy account settlement unconfirmed')
          }
        } catch {
          if (!ctx.res?.headersSent && !ctx.headerSent) ctx.status = 502
          proxyStatusManager.recordRequestFailure(finalLatency)
          recordLegacyFailureDiagnostic(() =>
            storeManager.recordRequestInStats(false, finalLatency, request.model, provider.id, account.id))
          updateLegacyRequestLog(streamLogId, 'error', 502, finalLatency,
            'Legacy account settlement unconfirmed')
          throw new Error('Legacy completion settlement unconfirmed')
        }
        recordAfterLegacyAccountCommit(() =>
          storeManager.recordRequestInStats(true, finalLatency, request.model, provider.id, account.id))
        updateLegacyRequestLog(streamLogId, 'success', 200, finalLatency)
        recordAfterLegacyAccountCommit(() => loadBalancer.clearAccountFailure(account.id))
        recordAfterLegacyAccountCommit(() => proxyStatusManager.recordRequestSuccess(finalLatency))
        recordAfterLegacyAccountCommit(() => storeManager.addLog('debug', 'Legacy completion stream verified', {
          requestId, providerId: provider.id, accountId: account.id, model: request.model,
        }))
      }, {
        allowToolCalls: false,
        ...(stopped ? { allowVerifiedEmptyStopAnswer: stopped.hasVerifiedEmptyAnswer } : {}),
      })
      const completedLegacyStream = createLegacyCompletionStream(verified, requestId, request.model)
      verified.once('close', releaseReservation)
      completedLegacyStream.once('close', releaseReservation)
      ctx.res?.once?.('close', () => {
        if (!completedLegacyStream.destroyed && !completedLegacyStream.readableEnded) {
          completedLegacyStream.destroy()
        }
        if (!verified.destroyed && !verified.readableEnded) verified.destroy()
        releaseReservation()
      })
      ctx.body = completedLegacyStream
      streamOwnsReservation = true
    } else {
      // Prepare the consumer's legacy wire response before the irreversible
      // account write, so no later format-conversion error can hide a charge.
      const completedLegacyBody = toLegacyCompletion(
        applyStopSequencesNonStream(
          result.body as import('../types').ChatCompletionResponse, stops),
        requestId, request.model
      )
      if (storeManager.recordAccountSuccess(account.id, provider.id) !== true) {
        throw new Error('Legacy account settlement unconfirmed')
      }
      recordAfterLegacyAccountCommit(() =>
        storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id))
      addLegacyRequestLog('success', 200, latency)
      recordAfterLegacyAccountCommit(() => loadBalancer.clearAccountFailure(account.id))
      recordAfterLegacyAccountCommit(() => proxyStatusManager.recordRequestSuccess(latency))
      recordAfterLegacyAccountCommit(() => storeManager.addLog('debug', 'Legacy completion verified', {
        requestId, providerId: provider.id, accountId: account.id, model: request.model,
      }))
      ctx.set('Content-Type', 'application/json')
      ctx.body = completedLegacyBody
    }
  } catch {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    ctx.status = 500
    ctx.body = {
      error: {
        message: 'Internal proxy error',
        type: 'internal_error',
      },
    }
    recordLegacyFailureDiagnostic(() =>
      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id))
    addLegacyRequestLog('error', 500, latency, 'Internal legacy proxy error')
  } finally {
    if (!streamOwnsReservation) releaseReservation()
  }
})

export default router
