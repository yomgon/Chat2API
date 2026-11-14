/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext, type ChatMessage as ContextChatMessage } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMAttachmentInputFailure, GLMAuthPreflightFailure, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiProxyFailure, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import { QwenAiAdapter, QwenAiProxyFailure, QwenAiStreamHandler } from './adapters/qwen-ai'
import { ZaiAdapter, ZaiProxyFailure, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import { hasCompletedNonStreamAnswer } from './streamTerminalGate'
import {
  createContextManagementService,
  SummaryGenerator,
} from './services/contextManagementService'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

/** Only a numeric status is allowed across a rejected web-client boundary. */
function safeWebErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const typed = error as { upstreamStatus?: unknown; response?: { status?: unknown } }
  const status = typed.upstreamStatus ?? typed.response?.status
  return Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599
    ? status as number : undefined
}

/** A failed response decoder cannot establish whether a remote effect ran. */
function unconfirmedProviderCompletion(latency: number): ForwardResult {
  return {
    success: false,
    status: 502,
    error: 'Provider completion was not confirmed',
    failureStage: 'response-decoding',
    failureCode: 'provider_completion_unconfirmed',
    latency,
  }
}

/** A window/token strategy may remove older turns, but it cannot publish an
 * orphan tool result, leave an unanswered tool call, or erase every user turn.
 * Check the *processed* list before a generic/custom upstream POST; the Chat
 * route's original-history validation alone cannot protect a later trim. */
function hasRepresentableTrimmedContext(messages: ChatCompletionRequest['messages']): boolean {
  if (!messages.length || !messages.some(message => message.role === 'user')) return false
  let pending: Set<string> | null = null
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending || !message.tool_call_id || !pending.delete(message.tool_call_id)) return false
      if (pending.size === 0) pending = null
      continue
    }
    if (pending) return false
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) return false
      const ids = message.tool_calls.map(call => call.id)
      if (ids.some(id => typeof id !== 'string' || !id.trim()) ||
          new Set(ids).size !== ids.length) return false
      pending = new Set(ids)
    }
  }
  return pending === null
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardGLM(request, account, provider, actualModel, startTime),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardKimi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen-ai',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwenAi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardZai(request, account, provider, actualModel, startTime),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMimo(request, account, provider, actualModel, startTime),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime),
    },
  ]

  /** The same ordered, real adapter selector used for an eventual remote
   * effect must inform the route's capability preflight. A custom provider
   * pointing at a trusted first-party consumer-web origin can select a web
   * adapter even though its immutable ID is not one of the six builtin IDs.
   * Never promise unsupported sampling or message content for that alias. */
  getConsumerWebProviderId(provider: Provider): string | undefined {
    const selected = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (selected && ['deepseek', 'qwen', 'glm', 'zai', 'qwen-ai', 'kimi'].includes(selected.name)) {
      return selected.name
    }
    return undefined
  }

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /** Preview a configured summary without creating a second provider effect.
   * A summary is an independent upstream model call, not a harmless retry.
   * Signal the caller instead of inventing a completed summary or sending it.
   * The callback never sees credentials and performs no network operation. */
  private createSummaryGenerator(markRequired: () => void): SummaryGenerator {
    return async () => {
      markRequired()
      return ''
    }
  }

  /** Run the actual configured context strategy with an inert summary probe.
   * Chat and Legacy call this before reserving account quota; direct forwarder
   * callers receive the same preflight before any provider request. */
  async requiresAdditionalSummary(
    request: ChatCompletionRequest,
    provider: Provider,
    contextConfig = storeManager.getConfig().contextManagement
  ): Promise<boolean> {
    if (!contextConfig?.enabled || !contextConfig.strategies?.summary?.enabled ||
        !contextConfig.executionOrder?.includes('summary') ||
        !Array.isArray(request.messages) || request.messages.length === 0 ||
        this.providerForwarders.some(forwarder => forwarder.matches(provider))) return false

    let summaryRequired = false
    try {
      const service = createContextManagementService(
        contextConfig, this.createSummaryGenerator(() => { summaryRequired = true })
      )
      await service.process(request.messages.map(msg => ({
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content: msg.content,
        timestamp: Date.now(),
      })))
      return summaryRequired
    } catch {
      // Invalid configured strategy cannot authorize a hidden model call.
      return true
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    // Both consumer-web and generic/custom POSTs can have effects before a
    // timeout, rejected response, lost ACK or a 5xx. The configured retryCount
    // cannot establish idempotency, so do not auto-replay ANY completion.
    // Keep the consumer-web matcher for the separate context summary boundary.
    const consumerWebAdapter = this.providerForwarders.some(forwarder => forwarder.matches(provider))
    const maxRetries = 0

    // Even with retryCount=0, automatic summarization could issue one model
    // POST followed by the caller's POST. Refuse this hidden extra effect.
    if (!consumerWebAdapter && await this.requiresAdditionalSummary(
      request, provider, config.contextManagement
    )) {
      return {
        success: false,
        status: 400,
        failureStage: 'auth-preflight',
        failureCode: 'context_summary_additional_effect_not_allowed',
        error: 'Automatic context summary requires a separate provider operation',
        latency: Date.now() - startTime,
      }
    }

    let lastError: string | undefined
    let lastStatus: number | undefined
    let lastFailureStage: ForwardResult['failureStage']
    let lastFailureCode: ForwardResult['failureCode']

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      // Local window/token trimming is allowed; no provider-backed summary
      // generator is ever passed here. The inert probe prevents a race from
      // turning a newly configured summary into a hidden second POST.
      if (!consumerWebAdapter && config.contextManagement?.enabled &&
          modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          let summaryRequired = false
          const summaryGenerator = this.createSummaryGenerator(() => { summaryRequired = true })

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          // Preserve actual OpenAI history metadata through each local context
          // strategy. Reconstructing role/content alone silently loses the
          // assistant tool_calls and matching tool_call_id before the POST.
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            ...msg,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (summaryRequired) {
            return {
              success: false,
              status: 400,
              failureStage: 'auth-preflight',
              failureCode: 'context_summary_additional_effect_not_allowed',
              error: 'Automatic context summary requires a separate provider operation',
              latency: Date.now() - startTime,
            }
          }

          if (processResult.finalCount !== originalCount) {
            // The existing sliding/token strategies retain original object
            // references. Reject any move of surviving turns (notably a late
            // system message shifted ahead of earlier users); the configured
            // window may remove history, never rearrange its meaning.
            const positions = new Map(contextMessages.map((message, index) => [message, index]))
            let previousPosition = -1
            let orderPreserved = true
            for (const message of processResult.messages) {
              const position = positions.get(message)
              if (position === undefined || position <= previousPosition) {
                orderPreserved = false
                break
              }
              previousPosition = position
            }
            const trimmedMessages = processResult.messages.map(msg => {
              const { timestamp: _timestamp, ...message } = msg as ContextChatMessage & {
                timestamp?: number
              }
              return message
            })
            if (!orderPreserved || !hasRepresentableTrimmedContext(trimmedMessages)) {
              return {
                success: false,
                status: 400,
                failureStage: 'auth-preflight',
                failureCode: 'context_history_unrepresentable',
                error: 'Local context trimming cannot preserve conversation history',
                latency: Date.now() - startTime,
              }
            }
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: trimmedMessages,
            }
          }
        } catch {
          console.error('[Forwarder] Context management failed')
          // An invalid configured local strategy must not secretly bypass
          // trimming and send the full original private conversation instead.
          return {
            success: false,
            status: 400,
            failureStage: 'auth-preflight',
            failureCode: 'context_strategy_failed',
            error: 'Configured local context strategy did not complete',
            latency: Date.now() - startTime,
          }
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success) {
          return result
        }

        lastError = result.error
        lastStatus = result.status
        lastFailureStage = result.failureStage
        lastFailureCode = result.failureCode

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = ZaiAdapter.isZaiProvider(provider)
          ? 'Z.ai provider operation failed' : error instanceof Error ? error.message : 'Unknown error'
        lastStatus = undefined
        lastFailureStage = ZaiAdapter.isZaiProvider(provider) ? 'unclassified' : undefined
        lastFailureCode = undefined
      }
    }

    return {
      success: false,
      status: lastStatus,
      failureStage: lastFailureStage,
      failureCode: lastFailureCode,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        // A redirect must never forward authorization, Cookie or custom
        // provider headers to a different origin without a new trust decision.
        maxRedirects: 0,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 300) {
        return {
          success: false,
          status: response.status,
          error: response.status >= 300 && response.status < 400
            ? 'Provider redirect refused to protect local credentials'
            : this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    let responseAvailable = false
    let originalResponseBody: { destroy?: () => void } | undefined
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new DeepSeekAdapter(provider, account)
      
      const { response, sessionId } = await adapter.chatCompletion({
        // A discovered website model can have a localized display label.
        // The selector already resolved its exact upstream model_type; do
        // not reinterpret the public alias as a wire ID.
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
      })
      responseAvailable = true
      originalResponseBody = response.data

      const latency = Date.now() - startTime

      if (response.status !== 200) {
        // No 3xx/odd 2xx can count as a model answer. A stateful web session
        // may already have had an effect; do not follow redirects or retry.
        try { response.data?.destroy?.() } catch { /* local transport only */ }
        return {
          success: false,
          status: Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
            ? response.status : 502,
          error: 'Provider completion did not return HTTP 200',
          failureStage: 'chat-completion',
          failureCode: 'deepseek_upstream_operation_failed',
          latency,
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = request.stream && shouldDeleteSession()
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session')
            }
          }
        : undefined

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        deleteSessionCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort,
        transformed.plan,
        request.model
      )
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      // Non-streaming requests need to collect stream data and convert
      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      if (!hasCompletedNonStreamAnswer(result)) return unconfirmedProviderCompletion(latency)
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch {
      const latency = Date.now() - startTime
      // A decoder or late local failure must release the original transport;
      // its exception may contain URLs, token material or raw provider data.
      try { originalResponseBody?.destroy?.() } catch { /* local close only */ }
      return {
        success: false,
        status: 502,
        error: 'DeepSeek provider operation failed',
        failureStage: responseAvailable ? 'response-decoding' : 'unclassified',
        failureCode: 'deepseek_upstream_operation_failed',
        latency,
      }
    }
  }

  /**
   * GLM Dedicated Forward
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    let responseAvailable = false
    let originalResponseBody: { destroy?: () => void } | undefined
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new GLMAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        deep_research: transformedRequest.deep_research,
      })
      responseAvailable = true
      originalResponseBody = response.data

      const latency = Date.now() - startTime

      if (response.status !== 200) {
        try { response.data?.destroy?.() } catch { /* local transport only */ }
        return {
          success: false,
          status: Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
            ? response.status : 502,
          error: 'Provider completion did not return HTTP 200',
          // The adapter returned a concrete completion response, not just a
          // preflight exception. Preserve this safe phase without exposing
          // remote headers/body or treating local status as upstream proof.
          failureStage: 'chat-completion',
          failureCode: 'glm_upstream_operation_failed',
          latency,
        }
      }

      // Cleanup is another independent upstream effect. It is permitted only
      // after the adapter confirms its clean model terminal, never whenever a
      // local PassThrough happens to end (which also happens on errors).
      let cleanupScheduled = false
      let handler: GLMStreamHandler
      const onCompletedStream = shouldDeleteSession()
        ? () => {
            if (cleanupScheduled) return
            const convId = handler.getConversationId()
            if (!convId) return
            cleanupScheduled = true
            adapter.deleteConversation(convId).catch(() => {
              console.error('[GLM] Failed to delete session')
            })
          }
        : undefined
      handler = new GLMStreamHandler(actualModel, onCompletedStream, undefined, transformed.plan)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      if (!hasCompletedNonStreamAnswer(result)) return unconfirmedProviderCompletion(latency)
      
      if (shouldDeleteSession()) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      // Axios, refresh/upload failures and downstream decoders may carry an
      // Authorization header, attachment URL or raw provider content in their
      // error text. Keep only fixed provenance and abort the original body.
      try { originalResponseBody?.destroy?.() } catch { /* local transport only */ }
      // Only the adapter's pure, pre-transport attachment validation can
      // distinguish invalid client input. DNS/download/upload failures may
      // have remote effects; never reclassify them as a harmless input error.
      const invalidLocalAttachment = typeof GLMAttachmentInputFailure === 'function' &&
        error instanceof GLMAttachmentInputFailure
      const authPreflightFailure = typeof GLMAuthPreflightFailure === 'function' &&
        error instanceof GLMAuthPreflightFailure
      return {
        success: false,
        status: invalidLocalAttachment ? 400 :
          (authPreflightFailure ? safeWebErrorStatus(error) ?? 502 : 502),
        error: invalidLocalAttachment ? 'GLM attachment input is invalid' : 'GLM provider operation failed',
        failureCode: invalidLocalAttachment ? 'glm_attachment_invalid_input' : 'glm_upstream_operation_failed',
        failureStage: invalidLocalAttachment || authPreflightFailure ? 'auth-preflight' :
          (responseAvailable ? 'response-decoding' : 'unclassified'),
        latency,
      }
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    let responseAvailable = false
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new KimiAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: request.reasoning_effort === undefined ? undefined : !!request.reasoning_effort,
        enableWebSearch: request.web_search === undefined ? undefined : !!request.web_search,
      })
      responseAvailable = true

      const latency = Date.now() - startTime

      if (response.status !== 200) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status >= 400 ? response.status : 502,
          error: errorMessage,
          latency,
        }
      }

      const handler = new KimiStreamHandler(actualModel, conversationId, !!request.reasoning_effort, transformed.plan)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Add delete conversation callback if needed
        if (shouldDeleteSession()) {
          // Delete only after a proven successful terminal frame, exactly
          // once. A premature close or provider error has UNKNOWN remote state.
          transformedStream.once('end', () => {
            if (!handler.hasSuccessfulTerminal()) return
            const realChatId = handler.getConversationId()
            if (realChatId) {
              adapter.deleteConversation(realChatId).catch(err => {
                console.error('[Kimi] Failed to delete conversation')
              })
            }
          })
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: undefined,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
      if (!hasCompletedNonStreamAnswer(result)) return unconfirmedProviderCompletion(latency)

      if (shouldDeleteSession()) {
        const realChatId = handler.getConversationId()
        if (realChatId) {
          await adapter.deleteConversation(realChatId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      const known = typeof KimiProxyFailure === 'function' && error instanceof KimiProxyFailure
        ? error : null
      return {
        success: false,
        status: known?.upstreamStatus ?? safeWebErrorStatus(error) ?? 502,
        error: 'Kimi provider operation failed',
        failureCode: 'kimi_upstream_operation_failed',
        failureStage: known?.stage ?? (responseAvailable ? 'response-decoding' : 'unclassified'),
        latency,
      }
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    let responseAvailable = false
    let originalResponseBody: { destroy?: () => void } | undefined
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        model: actualModel,
        resolvedModelId: true,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: request.reasoning_effort === undefined ? undefined : !!request.reasoning_effort,
        enableWebSearch: request.web_search === undefined ? undefined : !!request.web_search,
      })
      responseAvailable = true
      originalResponseBody = response.data

      const latency = Date.now() - startTime

      if (response.status !== 200) {
        try { response.data?.destroy?.() } catch { /* local transport only */ }
        return {
          success: false,
          status: Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
            ? response.status : 502,
          error: 'Qwen provider operation failed',
          failureStage: 'chat-completion',
          failureCode: 'qwen_upstream_operation_failed',
          latency,
        }
      }

      const deleteSessionCallback = request.stream && shouldDeleteSession()
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session')
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)
      if (!hasCompletedNonStreamAnswer(result)) return unconfirmedProviderCompletion(latency)

      const sid = handler.getSessionId()
      if (shouldDeleteSession() && sid) {
        await adapter.deleteSession(sid)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch {
      const latency = Date.now() - startTime
      // Decoder failures can leave a live SSE transport behind. Never expose
      // a raw Axios exception, token-bearing URL or provider response text.
      try { originalResponseBody?.destroy?.() } catch { /* local close only */ }
      return {
        success: false,
        status: 502,
        error: 'Qwen provider operation failed',
        failureStage: responseAvailable ? 'response-decoding' : 'unclassified',
        failureCode: 'qwen_upstream_operation_failed',
        latency,
      }
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    let responseAvailable = false
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new QwenAiAdapter(provider, account)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        model: actualModel,
        resolvedModelId: true,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: request.reasoning_effort === undefined ? undefined : !!request.reasoning_effort,
      })
      responseAvailable = true

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new QwenAiStreamHandler(actualModel, undefined,
        request.tool_choice !== 'none' && transformed.plan.mode !== 'disabled',
        transformed.plan.shouldParseResponse
          ? result => this.applyToolCallsToResponse(result, transformed)
          : undefined)
      handler.setChatId(chatId)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)

        if (shouldDeleteSession()) {
          transformedStream.once('end', () => {
            if (!handler.hasSuccessfulTerminal()) return
            adapter.deleteChat(chatId).catch(() => {
              console.error('[QwenAI] Failed to delete chat')
            })
          })
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
      if (!hasCompletedNonStreamAnswer(result)) return unconfirmedProviderCompletion(latency)

      if (shouldDeleteSession()) {
        await adapter.deleteChat(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      const known = typeof QwenAiProxyFailure === 'function' && error instanceof QwenAiProxyFailure
        ? error : null
      return {
        success: false,
        status: known?.upstreamStatus ?? safeWebErrorStatus(error) ?? 502,
        error: 'Qwen AI provider operation failed',
        failureCode: 'qwen_ai_upstream_operation_failed',
        failureStage: known?.stage ?? (responseAvailable ? 'response-decoding' : 'unclassified'),
        latency,
      }
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    let responseAvailable = false
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        model: actualModel,
        resolvedModelId: true,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      })
      responseAvailable = true

      const latency = Date.now() - startTime

      // Any non-200 response (including a redirect or unexpected 2xx) is a
      // failed completion, never a successful empty model response. Redirects
      // are not forwarded and must not cause a second upstream POST.
      if (response.status !== 200) {
        return {
          success: false,
          status: Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
            ? response.status : 502,
          error: 'Z.ai completion did not return HTTP 200',
          failureStage: 'chat-completion',
          latency,
        }
      }

      const deleteChatCallback = request.stream && shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat')
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback,
        request.tool_choice !== 'none' && transformed.plan.mode !== 'disabled',
        transformed.plan.shouldParseResponse
          ? result => this.applyToolCallsToResponse(result, transformed)
          : undefined)
      handler.setChatId(chatId)
      
      if (request.stream === true) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
      if (!hasCompletedNonStreamAnswer(result)) return unconfirmedProviderCompletion(latency)
      
      if (shouldDeleteSession()) {
        try {
          await adapter.deleteChat(chatId)
        } catch {
          console.error('[Z.ai] Failed to delete chat')
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      const known = error instanceof ZaiProxyFailure ? error : null
      return {
        success: false,
        // Preserve only a validated numeric upstream HTTP status, never a raw
        // Axios error/URL/body. The downstream API uses fixed error messages.
        status: known?.upstreamHttpStatus ?? 502,
        error: 'Z.ai provider operation failed',
        failureStage: known?.stage ?? (responseAvailable ? 'response-decoding' : 'unclassified'),
        latency,
      }
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat')
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat')
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        this.applyToolCallsToResponse(response.data, transformed)
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: response.data,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session')
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(response.data)

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            await adapter.generateConversationTitle(
              conversationId,
              query,
              handler.getAssistantContentForTitle()
            )
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error')
            transformedStream.end()
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      const result = await handler.handleNonStream(response.data)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      await adapter.generateConversationTitle(
        conversationId,
        query,
        handler.getAssistantContentForTitle()
      )
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      console.error('[Mimo] Forward error')
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session')
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter)
      const result = await handler.handleNonStream(stream)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    // Generic OpenAI-compatible endpoints may offer native function calling.
    // Do not silently drop a caller's tool definitions, forced/disabled
    // choice or parallelism constraint after account selection and a POST.
    // The six dedicated consumer-web adapters use their own prompt/parse
    // strategy and never reach this generic wire constructor.
    if (request.tools !== undefined) {
      body.tools = request.tools
    }
    if (request.tool_choice !== undefined) {
      body.tool_choice = request.tool_choice
    }
    if (request.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = request.parallel_tool_calls
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
