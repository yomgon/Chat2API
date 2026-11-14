/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import { Account, Provider } from '../../store/types'
import { readZaiSessionClaims, readZaiTokenIdentity } from '../../oauth/zaiSession'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const ZAI_API_BASE = 'https://chat.z.ai'
const ZAI_AUTH_URL = 'https://chat.z.ai/api/v1/auths/'
const X_FE_VERSION = 'prod-fe-1.1.37'
const ZAI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN',
  'Cache-Control': 'no-cache',
  Origin: ZAI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': ZAI_USER_AGENT,
  'X-Region': 'domestic',
}

const SEARCH_CITATION_PATTERN = '【turn\\d+search\\d+】'
const SEARCH_CITATION_PARTIAL_START_PATTERN = '【turn\\d+search\\d+$'
const SEARCH_CITATION_PARTIAL_END_PATTERN = '^】'
const SEARCH_CITATION_LOOSE_PATTERN = '【[^】]*turn\\d+search\\d+[^】]*】'
const SEARCH_CITATION_BRACKET_START = '【'
const SEARCH_CITATION_BRACKET_END = '】'

function cleanSearchCitations(text: string): string {
  return text.replace(new RegExp(SEARCH_CITATION_PATTERN, 'g'), '')
}

function cleanSearchCitationsWithBuffer(text: string, buffer: { value: string }): string {
  const combined = buffer.value + text
  
  // First try to match complete citations
  let cleaned = combined.replace(new RegExp(SEARCH_CITATION_LOOSE_PATTERN, 'g'), '')
  
  // Check if there's an opening bracket at the end that might start a citation
  const lastOpenBracket = cleaned.lastIndexOf(SEARCH_CITATION_BRACKET_START)
  if (lastOpenBracket !== -1) {
    const afterBracket = cleaned.slice(lastOpenBracket)
    // Check if it looks like a citation pattern
    if (afterBracket.includes('turn') || afterBracket.includes('search')) {
      // Keep the partial citation in buffer
      buffer.value = afterBracket
      cleaned = cleaned.slice(0, lastOpenBracket)
    } else if (!afterBracket.includes(SEARCH_CITATION_BRACKET_END)) {
      // Opening bracket without closing, might be a citation
      buffer.value = afterBracket
      cleaned = cleaned.slice(0, lastOpenBracket)
    } else {
      buffer.value = ''
    }
  } else {
    buffer.value = ''
  }
  
  return cleaned
}

/**
 * Z.ai's web SSE has more than one way to encode assistant text. `delta_content`
 * appends, `content` replaces the current answer, and `edit_content` replaces
 * the suffix from a UTF-16 edit_index (matching JavaScript string indexing).
 * Some compatible responses use OpenAI's `choices[].delta.content` instead.
 * Keep this function pure: it handles text only and never retries a provider
 * call or trusts an error/identity field from the event.
 */
export function applyZaiTextUpdate(previous: string, result: any): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  let next: string | null = null
  if (typeof result.edit_content === 'string') {
    const editIndex = result.edit_index === undefined ? 0 : result.edit_index
    if (!Number.isSafeInteger(editIndex) || editIndex < 0 || editIndex > previous.length) {
      throw new Error('Z.ai upstream text edit index was invalid')
    }
    next = previous.substring(0, editIndex) + result.edit_content
  } else if (typeof result.content === 'string') {
    next = result.content
  } else if (typeof result.delta_content === 'string') {
    next = previous + result.delta_content
  } else if (typeof result.choices?.[0]?.delta?.content === 'string') {
    next = previous + result.choices[0].delta.content
  } else if (typeof result.choices?.[0]?.message?.content === 'string') {
    next = result.choices[0].message.content
  }
  if (next !== null && next.length > 2_000_000) {
    throw new Error('Z.ai upstream answer exceeded the local safety limit')
  }
  return next
}

interface ZaiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

interface ChatCompletionRequest {
  model: string
  /** The load balancer has already selected this exact effective web wire ID. */
  resolvedModelId?: boolean
  /** Original model name before mapping (used for feature detection like web search, thinking mode) */
  originalModel?: string
  messages: ZaiMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | boolean
  chatId?: string
  parentMessageId?: string
}

/**
 * Fixed, non-secret failure provenance for the local proxy. Never carry an
 * Axios error, upstream response body, URL query, token or cookie across this
 * boundary. In particular, a rejected remote create-chat HTTP 4xx must not
 * become an unexplained local HTTP 500.
 */
export type ZaiFailureStage = 'auth-preflight' | 'chat-creation' | 'chat-completion'

export class ZaiProxyFailure extends Error {
  readonly stage: ZaiFailureStage
  readonly upstreamHttpStatus?: number

  constructor(stage: ZaiFailureStage, safeMessage: string, upstreamHttpStatus?: number) {
    super(safeMessage)
    this.name = 'ZaiProxyFailure'
    this.stage = stage
    if (Number.isInteger(upstreamHttpStatus) && upstreamHttpStatus! >= 400 && upstreamHttpStatus! <= 599) {
      this.upstreamHttpStatus = upstreamHttpStatus
    }
  }
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

export class ZaiAdapter {
  private provider: Provider
  private account: Account
  private token: string | null = null

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.jwt || ''
  }

  private getCaptchaVerifyParam(): string | undefined {
    const credentials = this.account.credentials
    return credentials.captcha_verify_param || credentials.captchaVerifyParam || undefined
  }

  private async ensureToken(): Promise<string> {
    const token = this.getToken()
    if (!token) throw new ZaiProxyFailure('auth-preflight', 'Z.ai token not configured; reconnect this account')
    const claims = readZaiSessionClaims(token)
    if (claims) {
      if (!claims.usable) throw new ZaiProxyFailure('auth-preflight', 'Z.ai web session has expired; reconnect this account')
      // Known-expiry metadata is not signature verification; the provider can
      // still refuse the subsequent operation. Never refresh/replay a failure.
      return token
    }
    const identity = readZaiTokenIdentity(token)
    if (!identity || identity.expiryKnown) {
      throw new ZaiProxyFailure('auth-preflight', 'Z.ai credential is invalid; reconnect this account')
    }
    // Current consumer-web auth may issue a JWT with no exp claim. Such a
    // token cannot be declared locally unexpired: prove the *exact identity*
    // by one fixed first-party read-only GET BEFORE any remote chat/delete
    // effect. No retry, fallback account, guessed refresh URL, or storage
    // mutation. This is independent from the earlier GUI authentication.
    try {
      const response = await axios.get(ZAI_AUTH_URL, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: `token=${token}`,
          Origin: ZAI_API_BASE,
          Referer: `${ZAI_API_BASE}/`,
        },
        timeout: 12_000,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
        responseType: 'json',
        validateStatus: () => true,
      })
      const contentType = response.headers?.['content-type']
      const verified = response.data
      if (response.status !== 200 ||
          typeof contentType !== 'string' ||
          !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType) ||
          !verified || typeof verified !== 'object' || Array.isArray(verified) ||
          verified.id !== identity.subject) {
        throw new ZaiProxyFailure('auth-preflight',
          'Z.ai web session was not verified; reconnect this account', response.status)
      }
      // A provider response may contain a rotated web token. Its own subject
      // must match as well; otherwise this attempt is not authorized. Never
      // replace stored credentials as a side effect of proxy forwarding.
      let authorizedToken = token
      if (Object.prototype.hasOwnProperty.call(verified, 'token')) {
        const next = readZaiTokenIdentity(verified.token)
        if (!next || next.subject !== identity.subject ||
            (next.expiryKnown && !readZaiSessionClaims(verified.token)?.usable)) {
          throw new ZaiProxyFailure('auth-preflight',
            'Z.ai web session was not verified; reconnect this account')
        }
        // Use the token that the fixed first-party endpoint has just
        // returned for this single authorized operation, without silently
        // changing the account's OS-protected stored credential.
        authorizedToken = verified.token
      }
      return authorizedToken
    } catch (error) {
      // Raw Axios errors/responses may contain Authorization, cookies and URLs.
      // Only a fixed non-secret failure is allowed past this boundary.
      if (error instanceof ZaiProxyFailure) throw error
      throw new ZaiProxyFailure('auth-preflight', 'Z.ai web session was not verified; reconnect this account')
    }
  }

  private extractLastUserMessage(messages: ZaiMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content
        if (typeof content === 'string') {
          return content
        }
        if (Array.isArray(content)) {
          const textParts: string[] = []
          for (const part of content) {
            if (typeof part === 'object' && part !== null && part.type === 'text' && part.text) {
              textParts.push(part.text)
            }
          }
          if (textParts.length > 0) {
            return textParts.join('\n')
          }
        }
        return ''
      }
    }
    return ''
  }

  private extractUserIDFromToken(token: string): string {
    try {
      const parts = token.split('.')
      if (parts.length < 2) {
        return 'guest'
      }
      let payload = parts[1]
      const padding = payload.length % 4
      if (padding > 0) {
        payload += '='.repeat(4 - padding)
      }
      payload = payload.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(payload, 'base64').toString('utf8')
      const data = JSON.parse(decoded)
      return data.id || data.user_id || data.uid || data.sub || 'guest'
    } catch {
      return 'guest'
    }
  }

  private generateSignature(messageText: string, requestId: string, timestampMs: number, userId: string): string {
    const secret = 'key-@@@@)))()((9))-xxxx&&&%%%%%'
    const r = timestampMs
    const i = String(timestampMs)
    const e = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`
    
    // a = message text UTF-8 bytes
    const a = Buffer.from(messageText, 'utf-8')
    // w = base64 encode of message text
    const w = a.toString('base64')
    // c = canonical string: metadata | base64_message | timestamp_string
    const canonicalString = `${e}|${w}|${i}`

    // E = window index (5 minute window)
    const windowIndex = Math.floor(r / (5 * 60 * 1000))
    
    // Layer1: A = HMAC(secret, window_index) -> hex string
    const derivedKeyHex = crypto.createHmac('sha256', secret).update(String(windowIndex)).digest('hex')
    
    // Layer2: k = HMAC(A_hex, canonical_string) -> hex string
    const signature = crypto.createHmac('sha256', derivedKeyHex).update(canonicalString).digest('hex')

    return signature
  }

  async createChat(model: string = 'glm-5', firstMessageContent: string = ''): Promise<{ chatId: string; messageId: string }> {
    const token = await this.ensureToken()
    return this.createChatWithVerifiedToken(model, firstMessageContent, token)
  }

  // The completion flow has already verified its token. Reusing it is critical:
  // a second auth GET could rotate the web token between chat creation and the
  // completion POST. Public createChat remains independently authenticated.
  private async createChatWithVerifiedToken(model: string, firstMessageContent: string, token: string): Promise<{ chatId: string; messageId: string }> {
    const timestamp = Math.floor(Date.now() / 1000)
    const messageId = uuid()
    
    console.log('[Z.ai] Creating chat')
    
    const requestBody = {
      chat: {
        id: '',
        title: '新聊天',
        models: [model],
        params: {},
        history: {
          messages: firstMessageContent ? {
            [messageId]: {
              id: messageId,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: firstMessageContent,
              timestamp,
              models: [model],
            },
          } : {},
          currentId: firstMessageContent ? messageId : '',
        },
        tags: [],
        flags: [],
        features: [
          {
            type: 'tool_selector',
            server: 'tool_selector_h',
            status: 'hidden',
          },
        ],
        mcp_servers: [],
        enable_thinking: true,
        auto_web_search: false,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
        type: 'default',
      },
    }
    
    let response: AxiosResponse
    try {
      response = await axios.post(
        `${ZAI_API_BASE}/api/v1/chats/new`,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...FAKE_HEADERS,
            'Cookie': `token=${token}`,
            Referer: `${ZAI_API_BASE}/`,
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
    } catch {
      // Axios errors can embed headers, cookies or a URL containing the token.
      // The upstream effect may have happened; never automatically resend it.
      throw new ZaiProxyFailure('chat-creation', 'Z.ai chat creation outcome unknown; no automatic retry')
    }

    if (response.status !== 200 && response.status !== 201) {
      console.error('[Z.ai] Create chat response')
      throw new ZaiProxyFailure('chat-creation', 'Failed to create chat: upstream rejected; no automatic retry', response.status)
    }
    if (!response.data || typeof response.data.id !== 'string' || !response.data.id ||
        response.data.id.length > 256) {
      throw new ZaiProxyFailure('chat-creation', 'Z.ai chat creation response was invalid; no automatic retry')
    }

    console.log('[Z.ai] Chat created')
    return { chatId: response.data.id, messageId }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      const encodedChatId = encodeURIComponent(chatId)
      
      const response = await axios.delete(
        `${ZAI_API_BASE}/api/v1/chats/${encodedChatId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
            Referer: `${ZAI_API_BASE}/`,
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Chat deleted')
      return response.status === 200 || response.status === 204
    } catch (error) {
      console.error('[Z.ai] Failed to delete chat')
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      
      console.log('[Z.ai] Deleting all chats...')
      
      const response = await axios.delete(
        `${ZAI_API_BASE}/api/v1/chats/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
            Referer: `${ZAI_API_BASE}/`,
          },
          timeout: 30000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Delete all chats response')
      
      if (response.status === 200 && response.data === true) {
        console.log('[Z.ai] All chats deleted successfully')
        return true
      }
      
      console.warn('[Z.ai] Delete all chats failed')
      return false
    } catch (error) {
      console.error('[Z.ai] Failed to delete all chats')
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; chatId: string; requestId: string }> {
    console.log('[Z.ai] Chat completion requested')
    
    // Z.ai API requires specific model name casing:
    // - GLM-5.1 and GLM-5-Turbo keep uppercase
    // - GLM-5V-Turbo uses lowercase "v" in the request model id
    // - GLM-5 and GLM-4.7 use lowercase request model ids
    const modelMapping: Record<string, string> = {
      'glm-5.1': 'GLM-5.1',
      'glm-5-turbo': 'GLM-5-Turbo',
      'glm-5v-turbo': 'GLM-5v-Turbo',
      'glm-5': 'glm-5',
      'glm-4.7': 'glm-4.7',
      // Also handle uppercase input
      'GLM-5.1': 'GLM-5.1',
      'GLM-5-Turbo': 'GLM-5-Turbo',
      'GLM-5V-Turbo': 'GLM-5v-Turbo',
      'GLM-5v-Turbo': 'GLM-5v-Turbo',
      'GLM-5': 'glm-5',
      'GLM-4.7': 'glm-4.7',
    }
    // Preserve exact effective-catalog IDs selected by the forwarder. Only
    // direct legacy callers still need the historical display-name mapping.
    const mappedModel = request.resolvedModelId === true
      ? request.model
      : modelMapping[request.model] || modelMapping[request.model.toLowerCase()] || request.model
    
    console.log('[Z.ai] Model mapping resolved')
    
    const rejectMessages = (): never => {
      throw new ZaiProxyFailure('chat-creation', 'Z.ai request messages are not supported')
    }
    const isMessageRecord = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
    const readText = (content: unknown): string => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content) || content.length === 0) return rejectMessages()
      return content.map(part => {
        if (!isMessageRecord(part) || part.type !== 'text' || typeof part.text !== 'string' ||
            Object.keys(part).some(key => key !== 'type' && key !== 'text')) return rejectMessages()
        return part.text
      }).join('')
    }

    // Preserve the existing user/assistant message list and its order. The
    // established system framing can represent only a leading system prefix;
    // unsupported content must fail before either state-changing POST.
    const messages: unknown = request.messages
    if (!Array.isArray(messages) || messages.length === 0) return rejectMessages()
    const systemMessages: string[] = []
    const processedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const msg of messages) {
      if (!isMessageRecord(msg) ||
          Object.keys(msg).some(key => key !== 'role' && key !== 'content')) return rejectMessages()
      const content = readText(msg.content)
      if (msg.role === 'system' && processedMessages.length === 0) {
        systemMessages.push(content)
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        processedMessages.push({ role: msg.role, content })
      } else {
        return rejectMessages()
      }
    }
    if (!processedMessages.some(msg => msg.role === 'user') ||
        (systemMessages.length > 0 && processedMessages[0].role !== 'user')) return rejectMessages()

    const systemContent = systemMessages.join('\n\n')
    if (systemContent) {
      processedMessages[0] = {
        ...processedMessages[0],
        content: `${systemContent}\n\nUser: ${processedMessages[0].content}`,
      }
    }
    
    const signaturePrompt = this.extractLastUserMessage(processedMessages)

    // A no-expiry web JWT requires an authenticated first-party identity GET.
    // Reject unsupported local history and parts BEFORE even that read-only
    // remote operation; the following create/completion still reuse one pin.
    const token = await this.ensureToken()
    const userId = this.extractUserIDFromToken(token)
    
    // Always create a new chat (single-turn mode only)
    const chatResult = await this.createChatWithVerifiedToken(mappedModel, signaturePrompt, token)
    const chatId = chatResult.chatId
    const encodedChatId = encodeURIComponent(chatId)
    const messageId = chatResult.messageId
    const parentMessageId = null
    console.log('[Z.ai] Created new chat')
    
    const requestId = uuid()
    const timestamp = Date.now()
    const signature = this.generateSignature(signaturePrompt, requestId, timestamp, userId)

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    // Missing reasoning retains the existing enabled default. Only a missing
    // search option may use its alias; explicit false must stay false.
    const enableThinking = request.reasoning_effort === undefined
      ? true : request.reasoning_effort !== false
    const enableWebSearch = request.web_search === undefined
      ? modelLower.includes('search') : !!request.web_search

    // Z.ai API uses auto_web_search for web search feature
    // web_search should always be false, use auto_web_search instead
    const features = {
      image_generation: false,
      web_search: false,
      auto_web_search: enableWebSearch,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: enableThinking,
    }

    const requestBody: Record<string, any> = {
      // The consumer-web endpoint produces SSE. We always request upstream
      // SSE, then transform it into the caller's requested OpenAI response
      // type in forwardZai: non-stream callers get JSON only after a genuine
      // assistant answer and upstream done marker. Sending stream:false here
      // while parsing response.data as SSE rejects valid JSON with HTTP 502.
      stream: true,
      model: mappedModel,
      messages: processedMessages,
      signature_prompt: signaturePrompt,
      params: {},
      extra: {},
      features,
      variables: {
        '{{USER_NAME}}': 'User',
        '{{USER_LOCATION}}': 'Unknown',
        '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
        '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
        '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
        '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
        '{{CURRENT_TIMEZONE}}': 'Asia/Shanghai',
        '{{USER_LANGUAGE}}': 'zh-CN',
      },
      chat_id: chatId,
      id: requestId,
      current_user_message_id: messageId,
      current_user_message_parent_id: parentMessageId,
      // Proxy calls are not equivalent to an interactive web UI session.
      // Suppress optional background generation so one request does not ask
      // Z.ai to do additional title/tag work without the caller requesting it.
      background_tasks: {
        title_generation: false,
        tags_generation: false,
      },
    }

    const captchaVerifyParam = this.getCaptchaVerifyParam()
    if (captchaVerifyParam) {
      requestBody.captcha_verify_param = captchaVerifyParam
    }

    console.log('[Z.ai] Sending chat request...')
    console.log('[Z.ai] Model selected')
    console.log('[Z.ai] Chat identifier prepared')
    console.log('[Z.ai] Message identifier prepared')
    console.log('[Z.ai] Parent message context prepared')

    const queryParams = new URLSearchParams({
      timestamp: String(timestamp),
      requestId,
      user_id: userId,
      version: '0.0.1',
      platform: 'web',
      token,
      user_agent: ZAI_USER_AGENT,
      language: 'zh-CN',
      languages: 'zh-CN,zh',
      timezone: 'Asia/Shanghai',
      cookie_enabled: 'true',
      screen_width: '1512',
      screen_height: '982',
      screen_resolution: '1512x982',
      viewport_height: '945',
      viewport_width: '923',
      viewport_size: '923x945',
      color_depth: '30',
      pixel_ratio: '2',
      current_url: `${ZAI_API_BASE}/c/${encodedChatId}`,
      pathname: `/c/${encodedChatId}`,
      search: '',
      hash: '',
      host: 'chat.z.ai',
      hostname: 'chat.z.ai',
      protocol: 'https:',
      referrer: '',
      title: 'Z.ai - Free AI Chatbot & Agent powered by GLM-5 & GLM-4.7',
      timezone_offset: '-480',
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: 'false',
      is_touch: 'false',
      max_touch_points: '0',
      browser_name: 'Chrome',
      os_name: 'Mac OS',
      signature_timestamp: String(timestamp),
    })

    let response: AxiosResponse
    try {
      response = await axios.post(
        `${ZAI_API_BASE}/api/v2/chat/completions?${queryParams.toString()}`,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...FAKE_HEADERS,
            'X-Signature': signature,
            'X-FE-Version': X_FE_VERSION,
            'Cookie': `token=${token}`,
            Referer: `${ZAI_API_BASE}/c/${encodedChatId}`,
            Priority: 'u=1, i',
          },
          responseType: 'stream',
          timeout: 120000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
    } catch {
      // The URL carries a token, so never forward the raw Axios exception.
      // A timeout/ACK loss also makes the completion effect indeterminate.
      throw new ZaiProxyFailure('chat-completion', 'Z.ai chat completion outcome unknown; no automatic retry')
    }

    console.log('[Z.ai] Response received')
    if (response.status !== 200) {
      console.log('[Z.ai] Chat request failed')
      // A failed streaming request may never reach 'end'. Never hold the
      // connection open or collect an unbounded untrusted error body. Keep
      // only the upstream HTTP status for the caller's fail-closed result.
      if (response.data && typeof response.data.destroy === 'function') response.data.destroy()
    }

    return { response, chatId, requestId }
  }

  static isZaiProvider(provider: Provider): boolean {
    if (provider.id === 'zai') return true
    // A substring match can misroute an unrelated custom provider (and its
    // credentials) to the fixed Z.ai web origin. Only the exact first-party
    // chat origin qualifies as an alias; never accept a lookalike hostname.
    try {
      const url = new URL(provider.apiEndpoint)
      return url.origin === ZAI_API_BASE && !url.username && !url.password
    } catch {
      return false
    }
  }
}

export class ZaiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private content: string = ''
  private toolCallsSent: boolean = false
  private lastMessageId: string = ''
  private toolCallState: ToolCallState
  private sentRole: boolean = false
  private sentThinkingRole: boolean = false
  private streamEnded: boolean = false
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }

  constructor(model: string, onEnd?: (chatId: string) => void,
    private readonly allowLegacyToolCalls: boolean = true,
    private readonly normalizeManagedCompletion?: (result: any) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  getLastMessageId(): string {
    return this.lastMessageId
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      // Validate the complete representation before writing any tool delta or
      // triggering cleanup. An empty legacy <arguments> block would otherwise
      // produce an invalid OpenAI tool call followed by a fake normal DONE.
      if (toolCalls.length > 128 || !toolCalls.every(call =>
        call.type === 'function' && typeof call.id === 'string' && !!call.id.trim() &&
        call.id.length <= 256 && typeof call.function?.name === 'string' &&
        !!call.function.name.trim() && call.function.name.length <= 256 &&
        typeof call.function.arguments === 'string' && !!call.function.arguments.trim() &&
        (() => { try { JSON.parse(call.function.arguments); return true } catch { return false } })()
      )) throw new Error('Z.ai legacy tool call completion was not valid')
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd) {
        try {
          this.onEnd(this.chatId)
        } catch (e) {
          console.error('[Z.ai] onEnd callback error')
        }
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    let emittedSuccessfulTerminal = false
    transStream.once('close', () => {
      // The common gate destroys this intermediate stream, not response.data.
      // Cancel a still-unconfirmed original body without claiming remote abort.
      if (!emittedSuccessfulTerminal) {
        try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
      }
    })
    console.log('[Z.ai] Starting stream handler...')

    // The upstream may edit or replace already emitted answer text. OpenAI
    // SSE has no equivalent rollback operation. Therefore defer downstream
    // content until the same strict upstream terminal check used by the
    // non-stream adapter has assembled the final assistant answer.
    // This preserves OpenAI-compatible SSE framing without inventing a
    // successful completion on an upstream transport error or premature EOF.
    const emit = (choice: Record<string, unknown>, usage?: unknown) => {
      if (transStream.destroyed || transStream.writableEnded) return
      transStream.write(`data: ${JSON.stringify({
        id: this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [choice],
        created: this.created,
        ...(usage ? { usage } : {}),
      })}\n\n`)
    }

    const fail = (providerError: boolean) => {
      if (transStream.destroyed || transStream.writableEnded) return
      // The original upstream exception may include URL query credentials.
      // Emit one fixed, content-free diagnostic rather than going silent.
      console.error('[Z.ai] Stream failed')
      transStream.write(`data: ${JSON.stringify({
        error: {
          message: providerError
            ? 'Z.ai upstream returned a model error'
            : 'Z.ai upstream stream did not complete',
          type: 'api_error',
        },
      })}\n\n`)
      // An error event MUST NOT be followed by the normal [DONE] sentinel.
      transStream.end()
    }

    void this.handleNonStream(stream).then(result => {
      if (transStream.destroyed || transStream.writableEnded) return
      // Both API modes must run the same selected managed-tool parser after
      // the real provider terminal and clean EOF. The nonstream result is
      // already complete here; never publish raw tool XML as a stopped SSE.
      if (this.normalizeManagedCompletion) {
        try {
          this.normalizeManagedCompletion(result)
        } catch {
          fail(false)
          return
        }
        const choice = result?.choices?.[0]
        const calls: unknown = choice?.message?.tool_calls
        if (calls !== undefined) {
          if (!Array.isArray(calls) || !calls.length || calls.length > 128 ||
              !calls.every(call => call?.type === 'function' &&
                typeof call.id === 'string' && !!call.id.trim() &&
                typeof call.function?.name === 'string' && !!call.function.name.trim() &&
                typeof call.function.arguments === 'string' &&
                (() => { try { JSON.parse(call.function.arguments); return true } catch { return false } })())) {
            fail(false)
            return
          }
          const safeContent = choice.message.content
          if (safeContent !== null && typeof safeContent !== 'string') {
            fail(false)
            return
          }
          emit({ index: 0, delta: { role: 'assistant',
            ...(typeof safeContent === 'string' && safeContent ? { content: safeContent } : {}) },
          finish_reason: null })
          for (let i = 0; i < calls.length; i++) {
            emit({ index: 0, delta: { tool_calls: [{ index: i, ...calls[i] }] },
              finish_reason: null })
          }
          emit({ index: 0, delta: {}, finish_reason: 'tool_calls' }, result?.usage)
          emittedSuccessfulTerminal = true
          transStream.end('data: [DONE]\n\n')
          if (this.onEnd && this.chatId) {
            try { this.onEnd(this.chatId) } catch { console.error('[Z.ai] onEnd callback error') }
          }
          return
        }
      }
      const answer = result?.choices?.[0]?.message?.content
      if (typeof answer !== 'string' || !answer.trim()) {
        fail(false)
        return
      }
      this.content = answer

      // Preserve explicit tool-call output support without emitting partial
      // tool arguments or triggering an independent model/tool request.
      // An upstream length finish means the answer was truncated. An XML-like
      // fragment must never be promoted to a completed tool call after EOF.
      if (this.allowLegacyToolCalls && result.choices[0].finish_reason !== 'length') {
        this.sendToolCalls(transStream)
      }
      if (this.toolCallsSent) {
        emittedSuccessfulTerminal = true
        return
      }

      const reasoning = result?.choices?.[0]?.message?.reasoning_content
      if (typeof reasoning === 'string' && reasoning) {
        emit({ index: 0, delta: { role: 'assistant', reasoning_content: reasoning }, finish_reason: null })
      }
      emit({ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null })
      emit({ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }, result?.usage)
      emittedSuccessfulTerminal = true
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        try {
          this.onEnd(this.chatId)
        } catch {
          console.error('[Z.ai] onEnd callback error')
        }
      }
    }).catch((error: unknown) => {
      // Compare against a fixed in-module message only, never reveal the
      // exception, response body, URL, cookie or authorization header.
      const knownModelError = !!error && typeof error === 'object' &&
        (error as { message?: unknown }).message === 'Z.ai upstream returned a model error'
      fail(knownModelError)
    })

    return transStream
  }
  async handleNonStream(response: any): Promise<any> {
    console.log('[Z.ai] Starting non-stream handler...')
    
    return new Promise((resolve, reject) => {
      const data = {
        id: this.chatId,
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        created: this.created,
        // Optional usage is populated only if actually reported upstream.
        ...({} as { usage?: unknown }),
      }

      let resolved = false
      let reasoningContent = ''
      let deadline: ReturnType<typeof setTimeout> | null = null
      const resolveOnce = (result: any) => {
        if (resolved) return
        // A transport close, HTTP 200, synthetic usage, or a default
        // finish_reason must not masquerade as a completed model answer.
        if (typeof result?.choices?.[0]?.message?.content !== 'string' ||
            !result.choices[0].message.content.trim()) {
          rejectOnce(new Error('Z.ai completed without a usable assistant answer'))
          return
        }
        resolved = true
        if (deadline) clearTimeout(deadline)
        if (reasoningContent) {
          result.choices[0].message.reasoning_content = reasoningContent
        }
        resolve(result)
      }

      const rejectOnce = (err: Error) => {
        if (resolved) return
        resolved = true
        if (deadline) clearTimeout(deadline)
        reject(err)
        // No retry or DELETE follows a parse failure. Reclaim only the local
        // unread upstream transport, preserving remote-effect UNKNOWN.
        try { if (typeof response?.destroy === 'function' && !response.destroyed) response.destroy() } catch { /* local only */ }
      }

      deadline = setTimeout(() => {
        if (!resolved) {
          console.log('[Z.ai] Non-stream response timeout')
          rejectOnce(new Error('Z.ai upstream completion timed out; outcome unconfirmed'))
        }
      }, 60000)

      // Parameter is already response.data from forwarder.ts
      const streamData = response

      // Check if streamData is a stream or JSON
      console.log('[Z.ai] Inspecting non-stream response')
      console.log('[Z.ai] Inspecting non-stream transport')
      console.log('[Z.ai] Selecting non-stream response handler')
      if (typeof streamData === 'string' || (streamData && typeof streamData.on === 'function')) {
        console.log('[Z.ai] Non-stream: taking stream path')
        // Assemble the complete upstream text before projecting it to JSON.
        // Keeping raw text until done correctly handles edit_content and
        // content replacement events, including UTF-16 edit offsets.
        let rawThinking = ''
        let rawAnswer = ''
        let sawTerminal = false
        let sawSentinel = false
        let finishReason: 'stop' | 'length' | 'tool_calls' = 'stop'
        let pendingFrame = ''
        const MAX_FRAME_CHARS = 1_048_576
        // A UTF-8 code point can span several transport buffers. Fatal decoding
        // also prevents corrupt bytes from becoming a seemingly valid answer.
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const invalidCompletion = () => {
          console.error('[Z.ai] Non-stream parse error')
          rejectOnce(new Error('Z.ai upstream response is not valid completion data'))
        }
        const isRecord = (value: unknown): value is Record<string, any> =>
          value !== null && typeof value === 'object' && !Array.isArray(value)
        const complete = () => {
          data.choices[0].message.content = cleanSearchCitations(rawAnswer)
          data.choices[0].finish_reason = finishReason
          reasoningContent = cleanSearchCitations(rawThinking)
          resolveOnce(data)
        }
        const parser = createParser({
          onError: () => invalidCompletion(),
          onEvent: (event: any) => {
            // A provider terminal is provisional. The stream may still deliver
            // a model error, malformed frame or invalid UTF-8 before clean EOF.
            if (resolved) return
            try {
              if (event.event === 'error') {
                rejectOnce(new Error('Z.ai upstream returned a model error'))
                return
              }
              if (sawTerminal) {
                // Some versions emit native done/finish followed by [DONE].
                // Neither that marker nor any other event proves clean EOF.
                if (event.data === '[DONE]' && !sawSentinel) {
                  sawSentinel = true
                  return
                }
                invalidCompletion()
                return
              }
              if (event.data === '[DONE]') {
                sawTerminal = true
                sawSentinel = true
                return
              }

              const eventData = JSON.parse(event.data)
              if (!isRecord(eventData)) {
                invalidCompletion()
                return
              }
              if (eventData.error != null || (isRecord(eventData.data) && eventData.data.error != null)) {
                rejectOnce(new Error('Z.ai upstream returned a model error'))
                return
              }

              // Keep the two existing completion envelopes, but never promote
              // unrelated data, primitives or a user/system role to an answer.
              const result = eventData.type === 'chat:completion' ? eventData.data
                : eventData.type === undefined && Array.isArray(eventData.choices) ? eventData : null
              if (!isRecord(result) ||
                  (result.role !== undefined && result.role !== 'assistant') ||
                  (result.phase !== undefined && typeof result.phase !== 'string') ||
                  (result.done !== undefined && typeof result.done !== 'boolean')) {
                invalidCompletion()
                return
              }
              for (const field of ['content', 'delta_content', 'edit_content']) {
                if (result[field] !== undefined && typeof result[field] !== 'string') {
                  invalidCompletion()
                  return
                }
              }
              if (result.edit_index !== undefined && typeof result.edit_content !== 'string') {
                invalidCompletion()
                return
              }
              if (result.choices !== undefined) {
                const choice = Array.isArray(result.choices) && result.choices.length === 1
                  ? result.choices[0] : null
                if (!isRecord(choice) || choice.error != null ||
                    (choice.index !== undefined && choice.index !== 0) ||
                    (choice.finish_reason != null && !['stop', 'length', 'tool_calls'].includes(choice.finish_reason))) {
                  invalidCompletion()
                  return
                }
                for (const field of ['delta', 'message']) {
                  const message = choice[field]
                  if (message !== undefined && (!isRecord(message) || message.error != null ||
                      (message.role !== undefined && message.role !== 'assistant') ||
                      (message.content != null && typeof message.content !== 'string'))) {
                    invalidCompletion()
                    return
                  }
                }
              }

              const openAiFinished = result.phase === undefined &&
                ['stop', 'length', 'tool_calls'].includes(result.choices?.[0]?.finish_reason)
              if ((result.phase === 'done' && result.done === true) || openAiFinished) {
                const finalAnswer = applyZaiTextUpdate(rawAnswer, result)
                if (finalAnswer !== null) rawAnswer = finalAnswer
                if (result.usage) {
                  data.usage = result.usage
                }
                if (openAiFinished) {
                  finishReason = result.choices[0].finish_reason
                }
                sawTerminal = true
              } else if (result.phase === 'thinking') {
                const next = applyZaiTextUpdate(rawThinking, result)
                if (next !== null) rawThinking = next
              } else if (result.phase === 'answer' || result.phase === undefined) {
                const next = applyZaiTextUpdate(rawAnswer, result)
                if (next !== null) rawAnswer = next
              }
            } catch {
              invalidCompletion()
            }
          },
        })

        const feed = (chunk: unknown) => {
          if (resolved) return
          try {
            if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
              invalidCompletion()
              return
            }
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
            const text = decoder.decode(bytes, { stream: true })
            pendingFrame += text
            // Bound individual SSE frames, not a coalesced chunk of frames.
            while (!resolved) {
              const separator = /\r?\n\r?\n/.exec(pendingFrame)
              if (!separator) break
              if (separator.index > MAX_FRAME_CHARS) {
                invalidCompletion()
                return
              }
              pendingFrame = pendingFrame.slice(separator.index + separator[0].length)
            }
            if (pendingFrame.length > MAX_FRAME_CHARS) {
              invalidCompletion()
              return
            }
            parser.feed(text)
          } catch {
            invalidCompletion()
          }
        }
        const end = () => {
          if (resolved) return
          try {
            const tail = decoder.decode()
            if (tail) {
              pendingFrame += tail
              parser.feed(tail)
            }
          } catch {
            invalidCompletion()
            return
          }
          // Neither a partial SSE event nor a dangling UTF-8 sequence may be
          // silently discarded merely because an earlier DONE was received.
          // A complete empty LF/CRLF line carries no event data. The parser
          // already consumed it, although the two-newline frame tracker can
          // retain an odd blank line. Ignore only those fully terminated empty
          // lines, never partial data, spaces, tabs or a dangling CR.
          const hasIncompleteFrame = pendingFrame !== '' && !/^(?:\r?\n)*$/.test(pendingFrame)
          if (hasIncompleteFrame || !sawTerminal) {
            rejectOnce(new Error('Z.ai transport ended before upstream completion; outcome unconfirmed'))
            return
          }
          complete()
        }

        if (typeof streamData === 'string') {
          // A buffered SSE body uses exactly the same envelope/terminal checks.
          feed(streamData)
          end()
        } else {
          streamData.on('data', feed)
          streamData.once('end', end)
          streamData.once('error', () => rejectOnce(new Error('Z.ai upstream stream failed')))
          streamData.once('close', () => {
            rejectOnce(new Error('Z.ai transport closed before upstream completion; outcome unconfirmed'))
          })
        }
      } else if (streamData) {
        // JSON response - parse directly
        try {
          const choice = Array.isArray(streamData.choices) && streamData.choices.length === 1
            ? streamData.choices[0] : null
          if (typeof streamData !== 'object' || Array.isArray(streamData) ||
              streamData.error !== undefined ||
              !choice || typeof choice !== 'object' || Array.isArray(choice) ||
              !['stop', 'length'].includes(choice.finish_reason) ||
              choice.error !== undefined ||
              !choice.message || choice.message.role !== 'assistant' ||
              choice.message.error !== undefined ||
              typeof choice.message.content !== 'string' ||
              !choice.message.content.trim()) {
            rejectOnce(new Error('Z.ai upstream response is not valid completion data'))
            return
          }
          data.choices[0].message.content = choice.message.content
          data.choices[0].finish_reason = choice.finish_reason
          if (streamData.usage && typeof streamData.usage === 'object' &&
              !Array.isArray(streamData.usage)) data.usage = streamData.usage
          console.log('[Z.ai] Non-stream JSON response finished')
          resolveOnce(data)
        } catch (err) {
          console.error('[Z.ai] Non-stream JSON parse error')
          rejectOnce(new Error('Z.ai upstream response is not valid completion data'))
        }
      } else {
        console.log('[Z.ai] Non-stream: streamData is falsy, taking empty path')
        rejectOnce(new Error('Z.ai upstream returned no completion data'))
      }
    })
  }

  getChatId(): string {
    return this.chatId
  }
}

export const zaiAdapter = {
  ZaiAdapter,
  ZaiStreamHandler,
}
