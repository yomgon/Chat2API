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
import {
  createOpenAIStreamTerminalGate, hasCompletedNonStreamAnswer,
  getStopSequences, applyStopSequencesNonStream, createStopSequenceSseStream,
} from '../streamTerminalGate'
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

/** Once a completed answer has been charged to its exact account, a failure
 * in secondary diagnostics must not rewrite the caller's success as HTTP 500
 * or suppress a verified SSE [DONE]. The account write itself remains fatal. */
function recordAfterAccountCommit(write: () => void): void {
  try {
    write()
  } catch {
    // No second persistence attempt, provider resend or error detail leak.
    // Other independent observations still get their own single attempt.
  }
}

/** A confirmed provider failure (or a rejected durable settlement) must keep
 * its original HTTP/SSE outcome. Each optional diagnostic gets one independent
 * attempt; no failed logger can enter the outer route catch or hide a later
 * failure statistic. Unlike recordAccountSuccess, these are not commit gates. */
function recordOptionalFailureDiagnostic(write: () => void): void {
  try {
    write()
  } catch {
    // Never leak a diagnostic exception, resend a provider operation or
    // change the original failure into a second, fabricated HTTP failure.
  }
}

/** Refuse malformed local input before selecting an account or sending upstream. */
function hasValidChatMessageShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as {
    role?: unknown
    content?: unknown
    tool_calls?: unknown
    tool_call_id?: unknown
    files?: unknown
    attachments?: unknown
    name?: unknown
  }
  if (message.role !== 'system' && message.role !== 'user' &&
      message.role !== 'assistant' && message.role !== 'tool') return false
  // These metadata shapes are not part of the supported ChatMessage contract:
  // silently dropping them would consume a remote operation with missing data.
  if (message.files !== undefined || message.attachments !== undefined ||
      (message.name !== undefined && typeof message.name !== 'string')) return false
  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim()) return false
  } else if (message.tool_call_id !== undefined) return false

  let validTools = false
  if (message.tool_calls !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0) return false
    validTools = message.tool_calls.every((call: unknown) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) return false
      const typed = call as { id?: unknown, type?: unknown, function?: unknown }
      if (typeof typed.id !== 'string' || !typed.id.trim() || typed.type !== 'function' ||
          !typed.function || typeof typed.function !== 'object' ||
          Array.isArray(typed.function)) return false
      const fn = typed.function as { name?: unknown, arguments?: unknown }
      // Historic assistant tool calls must obey the same public OpenAI
      // function-name grammar as new tools[] declarations and forced choices.
      // A locally accepted newline or malformed name would otherwise be
      // forwarded as a valid prior tool invocation to a pinned provider.
      return typeof fn.name === 'string' && OPENAI_TOOL_FUNCTION_NAME.test(fn.name) &&
        typeof fn.arguments === 'string'
    })
    if (!validTools) return false
  }
  if (typeof message.content === 'string') return true
  if (message.content === null) return message.role === 'assistant' && validTools
  if (!Array.isArray(message.content) || message.content.length === 0) return false
  return message.content.every((part: unknown) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    const item = part as {
      type?: unknown, text?: unknown, image_url?: unknown, file?: unknown, file_url?: unknown
    }
    if (item.type === 'text') {
      // Every text part is consumed as only its text by the dedicated web
      // adapters. Unknown metadata must not vanish after a paid operation.
      return typeof item.text === 'string' &&
        Object.keys(item).every(key => key === 'type' || key === 'text')
    }
    if (item.type === 'image_url' && message.role === 'user') {
      if (!item.image_url || typeof item.image_url !== 'object' ||
          Array.isArray(item.image_url) || item.text !== undefined ||
        item.file !== undefined || item.file_url !== undefined ||
        !Object.keys(item).every(key => key === 'type' || key === 'image_url')) return false
      const image = item.image_url as { url?: unknown, detail?: unknown }
      return Object.keys(image).every(key => key === 'url' || key === 'detail') &&
        typeof image.url === 'string' && !!image.url.trim() &&
        (image.detail === undefined || image.detail === 'auto' ||
          image.detail === 'low' || image.detail === 'high')
    }
    if (item.type === 'file' && message.role === 'user') {
      if (!item.file_url || typeof item.file_url !== 'object' ||
          Array.isArray(item.file_url) || item.text !== undefined ||
          item.image_url !== undefined || item.file !== undefined ||
          !Object.keys(item).every(key => key === 'type' || key === 'file_url')) return false
      const file = item.file_url as { url?: unknown }
      return Object.keys(file).every(key => key === 'url') &&
        typeof file.url === 'string' && !!file.url.trim()
    }
    return false
  })
}

/** A tool result must consume exactly one pending ID from the immediately
 * preceding assistant tool-call turn. A lone, duplicate, reordered-across-
 * turns, or unresolved result would otherwise be sent to a consumer web
 * provider as an apparently successful but corrupted conversation. Check the
 * entire history before account selection, with no request mutation. */
function hasConsistentChatToolHistory(messages: ChatCompletionRequest['messages']): boolean {
  let pending: Set<string> | null = null
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending || !pending.delete(message.tool_call_id!)) return false
      if (pending.size === 0) pending = null
      continue
    }
    if (pending) return false
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      const ids = message.tool_calls.map(call => call.id)
      if (new Set(ids).size !== ids.length) return false
      pending = new Set(ids)
    }
  }
  return pending === null
}

function hasFileMessagePart(messages: ChatCompletionRequest['messages']): boolean {
  return messages.some(message => Array.isArray(message.content) &&
    message.content.some(part => part.type === 'file'))
}

/** These five dedicated consumer-web adapters currently accept only text
 * message content. In particular Qwen China and DeepSeek text projectors
 * discard image_url parts; the other three reject such parts after dispatch.
 * Never publish a completed answer to a silently shortened multimodal prompt
 * or create remote conversation state for an unsupported client request.
 * GLM is separate: its bounded attachment preflight supports image_url. */
const TEXT_ONLY_CONSUMER_IDS = new Set(['deepseek', 'qwen', 'zai', 'qwen-ai', 'kimi'])

/** Web chat creation is stateful. Qwen International's current wire supports
 * only leading system text and one user message; Z.ai supports ordered
 * user/assistant text history but no tool-role/call metadata or late system.
 * Validate that exact selected adapter contract before reserving quota,
 * verifying a web identity or creating a remote chat. A custom provider ID
 * with the same trusted first-party origin follows the same restriction. */
function hasUnsupportedConsumerMessageHistory(
  messages: ChatCompletionRequest['messages'], selectedConsumerId: string,
): boolean {
  if (selectedConsumerId !== 'qwen-ai' && selectedConsumerId !== 'zai') return false
  let hasUser = false
  let startedConversation = false
  let hadSystemPrefix = false
  for (const message of messages) {
    if (Object.keys(message).some(key => key !== 'role' && key !== 'content')) return true
    if (message.role === 'system') {
      if (startedConversation) return true
      hadSystemPrefix = true
      continue
    }
    if (selectedConsumerId === 'qwen-ai') {
      if (message.role !== 'user' || hasUser) return true
    } else if (message.role !== 'user' && message.role !== 'assistant') {
      return true
    } else if (!startedConversation && hadSystemPrefix && message.role !== 'user') {
      return true
    }
    startedConversation = true
    if (message.role === 'user') hasUser = true
  }
  return !hasUser
}

/** Dedicated web forwarders do not implement client-controlled token limits
 * or sampling. All six adapters currently expose a temperature property, but
 * none consumes it to change its website wire. Their forwarder methods also
 * omit the other options entirely. Refuse meaningful guarantees before the
 * selected account is reserved or a stateful remote operation is started.
 * Harmless OpenAI defaults retain compatibility with existing callers. */
const WEB_CONSUMER_SAMPLING_IDS = new Set(['deepseek', 'qwen', 'glm', 'zai', 'qwen-ai', 'kimi'])

/** Every dedicated consumer transforms an OpenAI message into a narrower
 * website prompt. The four text/history-capable adapters omit role.name and
 * unsupported metadata; Qwen International/Z.ai also cannot represent it.
 * Refuse semantically different requests after exact provider selection but
 * before reserve/auth/session/chat. Generic API providers keep their existing
 * opaque forwarding contract and may support provider-specific extensions. */
function hasUnsupportedWebMessageMetadata(
  messages: ChatCompletionRequest['messages'], selectedConsumerId: string,
): boolean {
  if (!WEB_CONSUMER_SAMPLING_IDS.has(selectedConsumerId)) return false
  const allowedMessageKeys = new Set(['role', 'content', 'tool_calls', 'tool_call_id'])
  for (const message of messages) {
    if (Object.keys(message).some(key => !allowedMessageKeys.has(key))) return true
    if (!Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (Object.keys(call).some(key => key !== 'id' && key !== 'type' && key !== 'function')) {
        return true
      }
      if (Object.keys(call.function).some(key => key !== 'name' && key !== 'arguments')) {
        return true
      }
    }
  }
  return false
}

/** Consumer-web tool calls are generated by prompt/response parsing, not a
 * schema-enforcing native function API. In particular strict:true cannot
 * guarantee the declared JSON schema and extra tool/choice attributes would
 * be silently lost. Inspect the *selected* adapter (including trusted origin
 * aliases) before quota reservation or any remote auth/chat operation.
 * Generic custom endpoints retain their opaque tool extension contract;
 * strict:false is an explicit non-guarantee and remains compatible. */
function getUnsupportedWebToolMetadata(
  request: ChatCompletionRequest, selectedConsumerId: string,
): 'tools' | 'tool_choice' | null {
  if (!WEB_CONSUMER_SAMPLING_IDS.has(selectedConsumerId)) return null
  for (const tool of request.tools ?? []) {
    if (Object.keys(tool).some(key => key !== 'type' && key !== 'function')) return 'tools'
    const fn = tool.function as Record<string, unknown>
    if (Object.keys(fn).some(key =>
      key !== 'name' && key !== 'description' && key !== 'parameters' && key !== 'strict')) {
      return 'tools'
    }
    if (Object.prototype.hasOwnProperty.call(fn, 'strict') && fn.strict !== false) {
      return 'tools'
    }
  }
  const choice = request.tool_choice
  if (choice && typeof choice === 'object') {
    if (Object.keys(choice).some(key => key !== 'type' && key !== 'function') ||
        Object.keys(choice.function).some(key => key !== 'name')) {
      return 'tool_choice'
    }
  }
  return null
}

function getUnsupportedWebSamplingOption(
  request: ChatCompletionRequest, providerId: string,
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

function hasImageMessagePart(messages: ChatCompletionRequest['messages']): boolean {
  return messages.some(message => Array.isArray(message.content) &&
    message.content.some(part => part.type === 'image_url'))
}

/** Tool declarations are forwarded as a consumer-visible contract. Do not
 * silently ignore invalid tools/choices after starting a provider operation. */
const OPENAI_TOOL_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/

function hasValidChatToolDeclaration(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tool = value as { type?: unknown, function?: unknown }
  if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object' ||
      Array.isArray(tool.function)) return false
  const fn = tool.function as { name?: unknown, description?: unknown, parameters?: unknown }
  return typeof fn.name === 'string' && OPENAI_TOOL_FUNCTION_NAME.test(fn.name) &&
    (fn.description === undefined || typeof fn.description === 'string') &&
    (fn.parameters === undefined || (!!fn.parameters && typeof fn.parameters === 'object' &&
      !Array.isArray(fn.parameters)))
}

function getInvalidChatToolOption(request: ChatCompletionRequest):
  'tools' | 'tool_choice' | 'tool_format' | 'parallel_tool_calls' | null {
  if (request.tools !== undefined &&
      (!Array.isArray(request.tools) || !request.tools.every(hasValidChatToolDeclaration) ||
        // Identical names with different schemas have no unique tool-result
        // target. Refuse the ambiguous declaration before any provider effect.
        new Set(request.tools.map(tool => tool.function.name)).size !== request.tools.length)) {
    return 'tools'
  }
  const choice = request.tool_choice
  if (choice !== undefined) {
    if (typeof choice === 'string') {
      if (choice !== 'none' && choice !== 'auto' && choice !== 'required') return 'tool_choice'
      if (choice === 'required' && (!Array.isArray(request.tools) || !request.tools.length)) {
        return 'tool_choice'
      }
    } else {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice) ||
          choice.type !== 'function' || !choice.function ||
          typeof choice.function !== 'object' || Array.isArray(choice.function) ||
          typeof choice.function.name !== 'string' ||
          !OPENAI_TOOL_FUNCTION_NAME.test(choice.function.name) ||
          !Array.isArray(request.tools) ||
          !request.tools.some(tool => tool.function.name === choice.function.name)) {
        return 'tool_choice'
      }
    }
  }
  if (request.tool_format !== undefined && request.tool_format !== 'native' &&
      request.tool_format !== 'json' && request.tool_format !== 'auto') return 'tool_format'
  if (request.parallel_tool_calls !== undefined &&
      typeof request.parallel_tool_calls !== 'boolean') return 'parallel_tool_calls'
  return null
}

/** An upstream web consumer may return a syntactically valid function call
 * without honoring the client's declared/forced selection. Do not count that
 * response as a completed API answer merely because its finish_reason says
 * tool_calls. These constraints apply only when the client actually supplied
 * a tool declaration or tool_choice, preserving legacy no-tools responses. */
function getRequestedToolContract(request: ChatCompletionRequest): {
  allowedNames: string[]
  requireCall: boolean
  disallowCalls: boolean
  maxToolCalls?: number
} | null {
  if (request.tools === undefined && request.tool_choice === undefined &&
      request.parallel_tool_calls !== false) return null
  const forcedName = typeof request.tool_choice === 'object' && request.tool_choice !== null
    ? request.tool_choice.function.name : undefined
  return {
    allowedNames: forcedName
      ? [forcedName]
      : (request.tools ?? []).map(tool => tool.function.name),
    requireCall: request.tool_choice === 'required' || forcedName !== undefined,
    disallowCalls: request.tool_choice === 'none',
    maxToolCalls: request.parallel_tool_calls === false ? 1 : undefined,
  }
}

/** Verify the *completed* body before the indispensable account-success write.
 * Model output is untrusted even when supplied by a selected/pinned provider. */
function hasHonoredNonStreamToolContract(
  body: unknown,
  contract: NonNullable<ReturnType<typeof getRequestedToolContract>>,
): boolean {
  if (!body || typeof body !== 'object') return false
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length !== 1) return false
  const calls = choices[0]?.message?.tool_calls as unknown
  if (!Array.isArray(calls) || calls.length === 0) return !contract.requireCall
  if (contract.disallowCalls) return false
  if (contract.maxToolCalls !== undefined && calls.length > contract.maxToolCalls) return false
  const allowed = new Set(contract.allowedNames)
  return calls.every((call: unknown) => {
    if (!call || typeof call !== 'object') return false
    const typed = call as { function?: { name?: unknown } }
    return typeof typed.function?.name === 'string' && allowed.has(typed.function.name)
  })
}

function getInvalidChatFeatureOption(
  request: ChatCompletionRequest,
): 'web_search' | 'deep_research' | 'reasoning_effort' | 'reasoningEffort' | null {
  // A truthy string such as "false" is NOT an explicit opt-out: downstream
  // consumer adapters would activate web search, deep research or thinking.
  const validEffort = (value: unknown): boolean =>
    value === true || value === false ||
    value === 'low' || value === 'medium' || value === 'high'
  if (request.web_search !== undefined && typeof request.web_search !== 'boolean') {
    return 'web_search'
  }
  if (request.deep_research !== undefined && typeof request.deep_research !== 'boolean') {
    return 'deep_research'
  }
  if (request.reasoning_effort !== undefined && !validEffort(request.reasoning_effort)) {
    return 'reasoning_effort'
  }
  if (request.reasoningEffort !== undefined && !validEffort(request.reasoningEffort)) {
    return 'reasoningEffort'
  }
  return null
}

/** OpenAI-compatible options are untrusted JSON, even though the TypeScript
 * request interface describes numbers and nested objects. Reject impossible
 * ranges and malformed nested values BEFORE forwarding or charging an account.
 * Previously a malformed penalty or bias could be sent unchanged to a custom
 * endpoint, while malformed search options were accepted and silently ignored.
 * Keep valid existing options and explicit false untouched. */
function getInvalidChatSamplingOption(
  request: ChatCompletionRequest,
): 'presence_penalty' | 'frequency_penalty' | 'logit_bias' | 'web_search_options' | null {
  const validPenalty = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= -2 && value <= 2
  if (request.presence_penalty != null && !validPenalty(request.presence_penalty)) {
    return 'presence_penalty'
  }
  if (request.frequency_penalty != null && !validPenalty(request.frequency_penalty)) {
    return 'frequency_penalty'
  }
  if (request.logit_bias != null) {
    if (typeof request.logit_bias !== 'object' || Array.isArray(request.logit_bias) ||
        Object.values(request.logit_bias).some(value =>
          typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100)) {
      return 'logit_bias'
    }
  }
  const options = request.web_search_options
  if (options != null) {
    if (typeof options !== 'object' || Array.isArray(options)) return 'web_search_options'
    const size = options.search_context_size
    if (size !== undefined && size !== 'low' && size !== 'medium' && size !== 'high') {
      return 'web_search_options'
    }
    const location = options.user_location
    if (location !== undefined) {
      if (!location || typeof location !== 'object' || Array.isArray(location) ||
          location.type !== 'approximate') return 'web_search_options'
      if (location.approximate !== undefined) {
        const approximate = location.approximate
        if (!approximate || typeof approximate !== 'object' || Array.isArray(approximate) ||
            [approximate.country, approximate.city, approximate.region].some(value =>
              value !== undefined && typeof value !== 'string')) return 'web_search_options'
      }
    }
  }
  return null
}

/** A 200 answer must not claim output guarantees the selected web adapters
 * cannot enforce. The generic forwarder currently omits these fields too.
 * Explicit text and logprobs:false are harmless defaults; other values must
 * fail before any account reservation or remote consumer effect. */
function getUnsupportedChatOutputGuarantee(
  request: ChatCompletionRequest,
): 'response_format' | 'logprobs' | 'top_logprobs' | 'seed' | 'max_completion_tokens' | null {
  const raw = request as unknown as Record<string, unknown>
  // A modern completion-token cap includes non-visible reasoning tokens.
  // Dedicated web consumers cannot prove that cap; silently dropping it can
  // exceed a caller's explicit cost/length limit. Refuse it before dispatch.
  if (raw.max_completion_tokens != null) return 'max_completion_tokens'
  const format = raw.response_format
  if (format != null) {
    if (typeof format !== 'object' || Array.isArray(format) ||
        (format as Record<string, unknown>).type !== 'text' ||
        Object.keys(format).some(key => key !== 'type')) return 'response_format'
  }
  if (raw.logprobs != null && raw.logprobs !== false) return 'logprobs'
  if (raw.top_logprobs != null) return 'top_logprobs'
  if (raw.seed != null) return 'seed'
  return null
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
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Invalid chat request body')
    }
  } catch {
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

  if (typeof request.model !== 'string' || !request.model.trim()) {
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

  if (!Array.isArray(request.messages) || request.messages.length === 0 ||
      !request.messages.every(hasValidChatMessageShape) ||
      !hasConsistentChatToolHistory(request.messages)) {
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

  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid field: stream must be a boolean',
        type: 'invalid_request_error',
        param: 'stream',
        code: null,
      },
    }
    return
  }

  // Core OpenAI options must be validated before account selection and the
  // first irreversible provider effect. A single forwarded answer cannot
  // honor n>1; do not silently return one choice after dispatching.
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
            ? 'stop'
            : (request.n != null && request.n !== 1) ? 'n' : null
  if (invalidCoreOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid chat completion parameter',
        type: 'invalid_request_error',
        param: invalidCoreOption,
        code: 'invalid_completion_parameter',
      },
    }
    return
  }

  const invalidSamplingOption = getInvalidChatSamplingOption(request)
  if (invalidSamplingOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid chat completion parameter',
        type: 'invalid_request_error',
        param: invalidSamplingOption,
        code: 'invalid_completion_parameter',
      },
    }
    return
  }

  const unsupportedOutput = getUnsupportedChatOutputGuarantee(request)
  if (unsupportedOutput) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Requested chat output guarantee is not supported',
        type: 'invalid_request_error',
        param: unsupportedOutput,
        code: 'unsupported_completion_parameter',
      },
    }
    return
  }

  const invalidToolOption = getInvalidChatToolOption(request)
  if (invalidToolOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid tool completion parameter',
        type: 'invalid_request_error',
        param: invalidToolOption,
        code: 'invalid_completion_parameter',
      },
    }
    return
  }

  const invalidFeatureOption = getInvalidChatFeatureOption(request)
  if (invalidFeatureOption) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid chat feature parameter',
        type: 'invalid_request_error',
        param: invalidFeatureOption,
        code: 'invalid_completion_parameter',
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const rawWebSearchHeader = ctx.headers['x-web-search']
  const rawDeepResearchHeader = ctx.headers['x-deep-research']
  // Explicit body boolean values always win. Otherwise a non-boolean header
  // cannot silently become a missing feature setting (or unexpectedly activate
  // a provider-specific inferred feature based on its display model alias).
  for (const [rawValue, suppliedBodyValue, parameter] of [
    [rawWebSearchHeader, request.web_search, 'web_search'],
    [rawDeepResearchHeader, request.deep_research, 'deep_research'],
  ] as const) {
    if (suppliedBodyValue === undefined && rawValue !== undefined &&
        rawValue !== 'true' && rawValue !== 'false') {
      ctx.status = 400
      ctx.body = {
        error: {
          message: 'Unsupported or invalid chat completion parameter',
          type: 'invalid_request_error',
          param: parameter,
          code: 'invalid_completion_parameter',
        },
      }
      return
    }
  }
  const rawReasoningEffortHeader = ctx.headers['x-reasoning-effort']
  // Untrusted HTTP headers are strings, not already validated model options.
  // Only consult this fallback if neither supported body spelling supplied a
  // value. An invalid header must not reach a provider with an undefined
  // reasoning setting or create an unexpected paid model operation.
  if (request.reasoning_effort === undefined && request.reasoningEffort === undefined &&
      rawReasoningEffortHeader !== undefined &&
      rawReasoningEffortHeader !== 'low' &&
      rawReasoningEffortHeader !== 'medium' &&
      rawReasoningEffortHeader !== 'high') {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Unsupported or invalid chat completion parameter',
        type: 'invalid_request_error',
        param: 'reasoning_effort',
        code: 'invalid_completion_parameter',
      },
    }
    return
  }
  const reasoningEffortFromHeader = rawReasoningEffortHeader as
    'low' | 'medium' | 'high' | undefined

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort !== undefined) {
    // A supplied snake-case false is a deliberate opt-out. Do not replace it
    // with a truthy SDK camel-case alias, or keep a contradictory second field
    // after normalization.
    if (request.reasoning_effort === undefined) {
      request.reasoning_effort = requestAny.reasoningEffort
      console.log('[Chat] Reasoning effort normalized from camelCase')
    }
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (rawWebSearchHeader !== undefined && request.web_search === undefined) {
    request.web_search = rawWebSearchHeader === 'true'
    console.log('[Chat] Web search setting normalized from X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (rawDeepResearchHeader !== undefined && request.deep_research === undefined) {
    request.deep_research = rawDeepResearchHeader === 'true'
    console.log('[Chat] Deep research setting normalized from X-Deep-Research header')
  }
  // OpenAI search options also opt into web search. Without this bridge a
  // valid web_search_options object reached the selected provider with the
  // actual enableWebSearch flag missing, silently returning a non-search
  // answer. An explicit body or header false must always remain authoritative.
  if (request.web_search === undefined && request.web_search_options != null) {
    request.web_search = true
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
  // Resolve capability checks from the exact adapter that will receive this
  // request. A custom ID with an exact first-party web origin is a web
  // consumer, not a generic API passthrough. Older isolated test doubles may
  // expose only forwardChatCompletion; preserve their ID-based contract.
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
  // GLM validates and bounds file_url/image_url attachments locally.
  // The dedicated text-only web adapters cannot represent image_url, and
  // non-GLM consumers cannot represent file_url. Refuse unsupported content
  // after exact pinned selection, but BEFORE quota reservation, remote auth,
  // session creation, dispatch or account settlement. Unknown custom provider
  // capabilities retain their existing generic forwarding contract.
  if ((selectedConsumerId !== 'glm' && hasFileMessagePart(request.messages)) ||
      (TEXT_ONLY_CONSUMER_IDS.has(selectedConsumerId) && hasImageMessagePart(request.messages))) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Selected provider does not support the supplied message content',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'unsupported_message_content',
      },
    }
    return
  }
  if (hasUnsupportedWebMessageMetadata(request.messages, selectedConsumerId)) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Selected provider cannot represent the supplied message metadata',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'unsupported_message_metadata',
      },
    }
    return
  }
  const unsupportedWebToolMetadata = getUnsupportedWebToolMetadata(request, selectedConsumerId)
  if (unsupportedWebToolMetadata) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Selected web provider cannot honor the supplied tool metadata or strict schema guarantee',
        type: 'invalid_request_error',
        param: unsupportedWebToolMetadata,
        code: 'unsupported_tool_metadata',
      },
    }
    return
  }
  if (hasUnsupportedConsumerMessageHistory(request.messages, selectedConsumerId)) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Selected provider cannot represent the supplied message history',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'unsupported_message_history',
      },
    }
    return
  }
  // Generic context auto-summary can silently create a second model POST.
  // Check the exact configured strategy with an inert probe before account
  // quota reservation or any provider request. Local-only trimming is fine.
  if (typeof requestForwarder.requiresAdditionalSummary === 'function' &&
      await requestForwarder.requiresAdditionalSummary(request, provider)) {
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
  // Older isolated contract fakes expose selection only; the production
  // LoadBalancer always owns the process-local in-flight quota reservation.
  const releaseReservation = typeof loadBalancer.reserveSelectedAccount === 'function'
    ? loadBalancer.reserveSelectedAccount(selection)
    : () => {}
  if (!releaseReservation) {
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
  let streamOwnsReservation = false

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

  try {
    // Koa's authenticated-admission ledger is for local refusals before the
    // first provider dispatch only; all downstream outcomes settle here.
    if (ctx.state) ctx.state.providerDispatchStarted = true
    proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)
    const forwarded = await requestForwarder.forwardChatCompletion(
      request,
      account,
      provider,
      actualModel,
      context
    )

    // Verify that the *requested* consumer format can actually be delivered
    // before the irreversible account-success write. Valid OpenAI tool-call
    // argument strings may still be unparseable as native tool-use JSON.
    // Converting after settlement would falsely count a successful answer,
    // then report a local 500 when JSON.parse rejects the provider arguments.
    const completedNonStreamAnswer = request.stream !== true &&
      hasCompletedNonStreamAnswer(forwarded.body)
    const toolContract = getRequestedToolContract(request)
    const unconfirmedToolSelection = forwarded.success && completedNonStreamAnswer &&
      toolContract !== null && !hasHonoredNonStreamToolContract(forwarded.body, toolContract)
    // Do not invoke the optional normalization helper on ordinary requests;
    // existing no-stop semantics and deliberately minimal route consumers stay
    // byte-for-byte compatible.
    const stops = request.stop == null ||
      (Array.isArray(request.stop) && request.stop.length === 0)
      ? [] : getStopSequences(request.stop)
    let preparedNonStreamBody = forwarded.success && completedNonStreamAnswer && stops.length
      ? applyStopSequencesNonStream(forwarded.body, stops) : forwarded.body
    let conversionUnconfirmed = false
    if (forwarded.success && completedNonStreamAnswer &&
        isAnthropicToolFormat(request.tool_format)) {
      try {
        preparedNonStreamBody = transformResponseToAnthropic(preparedNonStreamBody)
      } catch {
        conversionUnconfirmed = true
      }
    }

    // A stream handshake, HTTP 200 or a fabricated empty choice is not proof
    // of a completed *deliverable* model answer. Refuse success before state.
    const missingCompletion = forwarded.success && (
      request.stream === true ? !forwarded.stream
        : !completedNonStreamAnswer || conversionUnconfirmed || unconfirmedToolSelection
    )
    const result = missingCompletion ? {
      ...forwarded,
      success: false,
      status: 502,
      failureStage: 'response-decoding' as const,
      failureCode: unconfirmedToolSelection
        ? 'provider_tool_contract_unconfirmed' as const
        : 'provider_completion_unconfirmed' as const,
      error: 'Provider completion was not confirmed',
      body: undefined,
      stream: undefined,
    } : forwarded

    const latency = Date.now() - startTime

    // The HTTP peer can disconnect while an upstream operation is still
    // awaiting its first reply. A later successful provider result is not
    // proof that the canceled local caller received a completed answer.
    // Do not retry or imply that the remote provider did no work.
    if (ctx.res?.destroyed) {
      const orphanedStream = result.stream as Readable | undefined
      if (orphanedStream && typeof orphanedStream.destroy === 'function') {
        orphanedStream.destroy()
      }
      proxyStatusManager.recordRequestFailure(latency)
      recordOptionalFailureDiagnostic(() =>
        storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id))
      recordOptionalFailureDiagnostic(() => storeManager.addLog('warn', 'Local client disconnected before provider response settlement', {
        requestId, providerId: provider.id, accountId: account.id,
        model: request.model, latency,
      }))
      return
    }

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      const safeFailureCode = result.failureCode ??
        (provider.id === 'zai' && result.failureStage ? ZAI_FAILURE_CODES[result.failureStage] : null)
      // The same local Kimi 401 can come from an upstream Chat HTTP rejection
      // or an unauthenticated Connect terminal inside HTTP 200. Qwen AI 502
      // can be creation, completion or decoding. Keep a fixed *observed phase*
      // in the public failure and retained request-log detail so the client
      // does not need another provider operation to distinguish them.
      // Never copy raw exception text or arbitrary stage values.
      const knownFailureStages: readonly string[] = [
        'auth-preflight', 'chat-creation', 'chat-completion',
        'response-decoding', 'unclassified',
      ]
      const safeFailureStage = result.failureStage &&
        knownFailureStages.includes(result.failureStage)
        ? result.failureStage : 'unclassified'

      // A pure local attachment input error happened before any provider
      // auth, download or completion. It is a client validation failure, not
      // evidence that the selected account has stopped working.
      if (result.failureCode !== 'glm_attachment_invalid_input' &&
          result.failureCode !== 'context_summary_additional_effect_not_allowed' &&
          result.failureCode !== 'context_history_unrepresentable' &&
          result.failureCode !== 'context_strategy_failed' &&
          result.status && result.status >= 400 && result.status !== 429) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: 'Provider request failed',
          type: 'api_error',
          param: null,
          code: safeFailureCode,
          stage: safeFailureStage,
        },
      }

      recordOptionalFailureDiagnostic(() => storeManager.addLog('error', 'Provider request failed', {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
        data: safeFailureCode ? {
          failureStage: safeFailureStage,
          failureCode: safeFailureCode,
          localStatus: ctx.status,
          // ForwardResult does not separately prove a provider HTTP response.
          upstreamHttpStatus: null,
        } : undefined,
      }))

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: 'Provider request failed',
          type: 'api_error',
          param: null,
          code: safeFailureCode,
          stage: safeFailureStage,
        },
      })
      recordOptionalFailureDiagnostic(() => storeManager.addRequestLog({
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
        errorMessage: 'Provider request failed (' + safeFailureStage + ')',
      }))

      recordOptionalFailureDiagnostic(() =>
        storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id))

      return
    }

    // Streaming success must be decided after the final verified terminal,
    // not when forwarder returns a Readable before the provider has answered.
    if (request.stream !== true) {
      // A failed durable account write must not first publish a success and
      // then also publish a failure from the catch boundary below.
      // The store returns false if this exact account/provider is no longer
      // present (for example, it was deleted while the upstream was running).
      // That is a rejected settlement, not a successful local completion.
      if (storeManager.recordAccountSuccess(account.id, provider.id) !== true) {
        throw new Error('Local account settlement unconfirmed')
      }
      recordAfterAccountCommit(() => loadBalancer.clearAccountFailure(account.id))
      recordAfterAccountCommit(() => proxyStatusManager.recordRequestSuccess(latency))
      recordAfterAccountCommit(() => storeManager.addLog('debug', 'Request succeeded', {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        latency,
        isStream: false,
      }))
    }

    const userInput = extractUserInput(request.messages)
    // Store only fixed provenance, never the raw provider/model response body.
    const responseBodyForLog: string | undefined = undefined

    // For streaming requests, we'll collect content and update the log later
    let logEntryId: string | undefined

    if (!request.stream) {
      // Non-streaming: record log with response body now
      recordAfterAccountCommit(() => {
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
      })
    } else {
      // Streaming: provisional fail-closed receipt until terminal is proven.
      // A disabled/unavailable diagnostics sink is not a failed provider
      // terminal. Keep the provisional receipt fail-closed when it can be
      // stored, but never abandon a live upstream reader just because this
      // optional pre-terminal log write is refused.
      try {
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
      } catch {
        // Do not replay the provider effect or expose diagnostics errors.
      }
    }

    if (request.stream !== true) {
      recordAfterAccountCommit(() =>
        storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id))
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
        // A failed terminal gate or disconnected consumer destroys the
        // normalizer. Its original provider reader must also be canceled;
        // pipe() alone only unpipes and can leave the remote socket running.
        transformStream.once('close', () => {
          if (!rawStream.readableEnded) {
            rawStream.unpipe(transformStream)
            if (!rawStream.destroyed) rawStream.destroy()
          }
        })
        normalizedStream = rawStream.pipe(transformStream)
      }

      const stopped = stops.length ? createStopSequenceSseStream(normalizedStream, stops) : null
      const verifiedStream = createOpenAIStreamTerminalGate(stopped?.stream ?? normalizedStream, completed => {
        const finalLatency = Date.now() - startTime
        if (completed) {
          // A complete, nonempty answer and a valid normal stream terminal
          // have now been observed. Its final DONE remains private until this
          // synchronous account settlement returns. If durable storage refuses
          // the charge, count a local failure and refuse the DONE without
          // assuming the remote provider did not complete its operation.
          try {
            if (storeManager.recordAccountSuccess(account.id, provider.id) !== true) {
              throw new Error('Local account settlement unconfirmed')
            }
          } catch {
            // Before HTTP commitment a declined durable settlement should
            // also carry an error status; after commitment the gate emits a
            // fixed SSE error and suppresses finish/usage/[DONE].
            if (!ctx.res?.headersSent && !ctx.headerSent) ctx.status = 502
            proxyStatusManager.recordRequestFailure(finalLatency)
            recordOptionalFailureDiagnostic(() =>
              storeManager.recordRequestInStats(false, finalLatency, request.model, provider.id, account.id))
            if (logEntryId) {
              const failedLogEntryId = logEntryId
              recordOptionalFailureDiagnostic(() => storeManager.updateRequestLog(failedLogEntryId, {
                status: 'error', statusCode: 502, responseStatus: 502,
                errorMessage: 'Local stream settlement unconfirmed', latency: finalLatency,
              }))
            }
            recordOptionalFailureDiagnostic(() => storeManager.addLog('error', 'Local stream settlement unconfirmed', {
              requestId, providerId: provider.id, accountId: account.id,
              model: request.model, latency: finalLatency,
            }))
            // The stream terminal gate deliberately suppresses finish/usage
            // and DONE when its confirmation callback rejects persistence.
            throw new Error('Local stream settlement unconfirmed')
          }
          recordAfterAccountCommit(() =>
            storeManager.recordRequestInStats(true, finalLatency, request.model, provider.id, account.id))
          recordAfterAccountCommit(() => loadBalancer.clearAccountFailure(account.id))
          recordAfterAccountCommit(() => proxyStatusManager.recordRequestSuccess(finalLatency))
          if (logEntryId) {
            const completedLogEntryId = logEntryId
            recordAfterAccountCommit(() => storeManager.updateRequestLog(completedLogEntryId, {
              status: 'success', statusCode: 200, responseStatus: 200,
              errorMessage: undefined, latency: finalLatency,
            }))
          }
          recordAfterAccountCommit(() => storeManager.addLog('debug', 'Stream response completed', {
            requestId, providerId: provider.id, accountId: account.id,
            model: request.model, actualModel, latency: finalLatency,
          }))
        } else {
          // A response may have affected the remote service despite local
          // failure. Preserve UNKNOWN; never replay or switch accounts.
          // Once HTTP headers are committed, status cannot be rewritten; the
          // terminal gate emits a fixed SSE error without a false [DONE].
          // Before commitment, report the same failure as HTTP 502.
          if (!ctx.res?.headersSent && !ctx.headerSent) ctx.status = 502
          proxyStatusManager.recordRequestFailure(finalLatency)
          recordOptionalFailureDiagnostic(() =>
            storeManager.recordRequestInStats(false, finalLatency, request.model, provider.id, account.id))
          if (logEntryId) {
            const failedLogEntryId = logEntryId
            recordOptionalFailureDiagnostic(() => storeManager.updateRequestLog(failedLogEntryId, {
              status: 'error', statusCode: 502, responseStatus: 502,
              errorMessage: 'Provider stream completion unconfirmed',
              latency: finalLatency,
            }))
          }
          recordOptionalFailureDiagnostic(() => storeManager.addLog('error', 'Provider stream completion unconfirmed', {
            requestId, providerId: provider.id, accountId: account.id,
            model: request.model, latency: finalLatency,
            data: { failureStage: 'response-decoding', failureCode: 'provider_stream_incomplete' },
          }))
        }
      }, stopped || isAnthropicToolFormat(request.tool_format) || toolContract ? {
        ...(stopped ? { allowVerifiedEmptyStopAnswer: stopped.hasVerifiedEmptyAnswer } : {}),
        ...(isAnthropicToolFormat(request.tool_format)
          ? { formatNativeToolChunk: transformChunkToAnthropic } : {}),
        ...(toolContract ? {
          acceptedToolNames: toolContract.allowedNames,
          requireToolCalls: toolContract.requireCall,
          allowToolCalls: !toolContract.disallowCalls,
          ...(toolContract.maxToolCalls !== undefined
            ? { maxToolCalls: toolContract.maxToolCalls } : {}),
        } : {}),
      } : undefined)
      // A streaming route returns before the reader finishes. Keep the slot
      // until verified terminal, failed terminal or cancellation closes it.
      verifiedStream.once('close', releaseReservation)
      ctx.res?.once?.('close', () => {
        if (!verifiedStream.destroyed && !verifiedStream.readableEnded) verifiedStream.destroy()
        releaseReservation()
      })
      ctx.body = verifiedStream
      streamOwnsReservation = true
    } else {
      ctx.set('Content-Type', 'application/json')

      // The fully prepared consumer response passed preflight *before* local
      // account success was persisted; do not reparse after settlement.
      ctx.body = preparedNonStreamBody
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

    recordOptionalFailureDiagnostic(() => storeManager.addLog('error', 'Internal proxy request exception', {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
    }))

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    })
    recordOptionalFailureDiagnostic(() => storeManager.addRequestLog({
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
    }))

    recordOptionalFailureDiagnostic(() =>
      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id))
  } finally {
    if (!streamOwnsReservation) releaseReservation()
  }
})

export default router
