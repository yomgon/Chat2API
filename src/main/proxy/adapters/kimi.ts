/**
 * Kimi K2.6 Adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'
import { PassThrough } from 'stream'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { createKimiChatPayload, encodeKimiGrpcFrame, resolveKimiScenario } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'

const KIMI_API_BASE = 'https://www.kimi.com'

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
}

export type KimiFailureStage = 'auth-preflight' | 'chat-completion' | 'response-decoding'

/** Only fixed local provenance may cross the provider boundary. */
export class KimiProxyFailure extends Error {
  readonly stage: KimiFailureStage
  readonly upstreamStatus?: number

  constructor(stage: KimiFailureStage, upstreamStatus?: number) {
    const messages: Record<KimiFailureStage, string> = {
      'auth-preflight': 'Kimi authentication preflight failed',
      'chat-completion': 'Kimi completion was rejected',
      'response-decoding': 'Kimi response decoding failed',
    }
    super(messages[stage])
    this.name = 'KimiProxyFailure'
    this.stage = stage
    if (Number.isInteger(upstreamStatus) && upstreamStatus! >= 400 && upstreamStatus! <= 599) {
      this.upstreamStatus = upstreamStatus
    }
  }
}

function isKimiApiEndpoint(endpoint: unknown): boolean {
  // The existing provider/OAuth contract is www.kimi.com. Do not infer a
  // different login realm (including .ai) from a token, model, or HTTP 401.
  return endpoint === KIMI_API_BASE || endpoint === `${KIMI_API_BASE}/`
}

interface KimiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

function readKimiMessageText(message: KimiMessage): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    const parts: string[] = []
    for (const part of message.content) {
      if (!part || typeof part !== 'object' || Array.isArray(part) ||
          part.type !== 'text' || typeof part.text !== 'string') {
        throw new Error('Kimi message content is not supported')
      }
      parts.push(part.text)
    }
    return parts.join('')
  }
  // Tool-only assistant messages have no text. Other unsupported content must
  // fail locally rather than disappear or become an object-coerced prompt.
  if ((message.content === null || message.content === undefined) && message.role === 'assistant' &&
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return ''
  throw new Error('Kimi message content is not supported')
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: KimiMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
  enableWebSearch?: boolean
  tools?: any[]
  tool_choice?: any
  conversationId?: string
  parentId?: string
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export function detectTokenType(token: string): 'jwt' | 'refresh' {
  if (token.startsWith('eyJ') && token.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
      if (payload.app_id === 'kimi' && payload.typ === 'access') {
        return 'jwt'
      }
    } catch (e) {
      // Parse failed, treat as refresh token
    }
  }
  return 'refresh'
}

function extractUserIdFromJWT(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    return typeof payload.sub === 'string' ? payload.sub : undefined
  } catch (e) {
    return undefined
  }
}

function checkResult(result: AxiosResponse): any {
  if (result.status !== 200) {
    throw new Error('Kimi API request was rejected')
  }
  if (!result.data) {
    return null
  }
  const { error_type } = result.data
  if (typeof error_type !== 'string') {
    return result.data
  }
  throw new Error('Kimi API request was rejected')
}

export class KimiAdapter {
  private readonly apiBase: string
  private readonly token: string

  constructor(provider: Provider, account: Account) {
    // Bind the selected account before reading its credentials. Keep only
    // immutable request values, never a mutable provider/account reference.
    if (typeof provider?.id !== 'string' || !provider.id.trim() ||
        typeof account?.id !== 'string' || !account.id.trim() ||
        account.providerId !== provider.id || !isKimiApiEndpoint(provider.apiEndpoint)) {
      throw new KimiProxyFailure('auth-preflight')
    }
    this.apiBase = KIMI_API_BASE

    try {
      // OAuth loginWithToken stores accessToken; keep legacy field priority.
      const credentials = account.credentials
      let token = ''
      for (const field of ['token', 'refreshToken', 'accessToken']) {
        const candidate = credentials?.[field]
        if (candidate === undefined || candidate === '') continue
        if (typeof candidate !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/.test(candidate)) {
          throw new KimiProxyFailure('auth-preflight')
        }
        token = candidate
        break
      }
      if (!token) throw new KimiProxyFailure('auth-preflight')
      this.token = token
    } catch {
      throw new KimiProxyFailure('auth-preflight')
    }
  }

  private async acquireToken(): Promise<{ accessToken: string; userId: string }> {
    // Classification is not verification or a refresh contract. Preserve
    // direct use without a cross-account cache, fallback host, or retry.
    const userId = detectTokenType(this.token) === 'jwt' ? extractUserIdFromJWT(this.token) || '' : ''
    return { accessToken: this.token, userId }
  }

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string, isMultiTurn: boolean = false): string {
    const toolProfile = getProviderToolProfile('kimi')
    // Process messages including tool calls and tool responses
    const processedMessages = messages.map(msg => {
      const text = readKimiMessageText(msg)
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const callsText = toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })))
        return {
          ...msg,
          content: text ? `${text}\n${callsText}` : callsText,
        }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return { 
          ...msg, 
          role: 'user' as const,
          content: toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: text,
          }),
        }
      }
      return { ...msg, content: text }
    })

    // Preserve every system message in order using the existing text framing.
    let content = ''
    const otherMessages = processedMessages.filter(msg => {
      if (msg.role === 'system') {
        if (msg.content) content += `system:${msg.content}\n`
        return false
      }
      return true
    })

    // For multi-turn with existing session, only send the last user message
    if (isMultiTurn) {
      // Find last user message index manually (ES2021 compatible)
      let lastUserIdx = -1
      for (let i = otherMessages.length - 1; i >= 0; i--) {
        if (otherMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = otherMessages[lastUserIdx]
        const text = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''
        content += `user:${this.wrapUrlsToTags(text)}\n`
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < otherMessages.length; i++) {
          if (otherMessages[i].role === 'user') {
            const toolText = typeof otherMessages[i].content === 'string' ? otherMessages[i].content : ''
            content += `user:${toolText}\n`
          }
        }
        
        if (toolsPrompt) {
          content = content.trim() + "\n\n" + toolsPrompt
        }
        return content
      }
    }

    if (otherMessages.length < 2) {
      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    } else {
      otherMessages.splice(otherMessages.length - 1, 0, {
        content: 'Focus on the latest message from user',
        role: 'system' as const,
      })

      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role}:${msg.role === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    }

    // Inject tools prompt at the VERY END of the content to maximize attention
    if (toolsPrompt) {
      content = content.trim() + "\n\n" + toolsPrompt
    }

    return content
  }

  private wrapUrlsToTags(content: string): string {
    return content.replace(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi,
      url => `<url id="" type="url" status="" title="" wc="">${url}</url>`
    )
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    // Deny web-only agent scenarios before preparing a request or contacting
    // the provider. This adapter speaks ChatService/Chat, not the Kimi Agent RPC.
    resolveKimiScenario(request.model)
    const { accessToken } = await this.acquireToken()

    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      toolsPrompt = toolsToSystemPrompt(request.tools, true)

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    const content = this.messagesPrepare(messages, toolsPrompt, false)

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    let enableThinking = request.enableThinking ?? false
    let enableWebSearch = request.enableWebSearch ?? false
    
    // Auto-enable based on model name (if not explicitly set)
    if (request.enableThinking === undefined && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Kimi] Thinking mode enabled (from model name)')
    }
    if (request.enableWebSearch === undefined && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Kimi] Web search enabled (from model name)')
    }

    const payload = createKimiChatPayload({
      model: request.model,
      content,
      enableWebSearch,
      enableThinking,
    })
    const frameBuffer = encodeKimiGrpcFrame(payload)

    console.log('[Kimi] Request body prepared')

    let response: AxiosResponse
    try {
      response = await axios.post(
        `${this.apiBase}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
        frameBuffer,
        {
          headers: {
            ...FAKE_HEADERS,
            Origin: this.apiBase,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/connect+json',
          },
          timeout: 120000,
          maxRedirects: 0,
          validateStatus: () => true,
          responseType: 'stream',
        }
      )
    } catch {
      // A transport failure has no confirmed HTTP status. Never retain the
      // Axios error, which can contain Authorization and provider payloads.
      throw new KimiProxyFailure('chat-completion')
    }

    console.log('[Kimi] Completion response received')

    if (response.status !== 200) {
      // A fixed error and numeric status permit safe local diagnosis. Do not
      // forward the provider body (which may contain account/session details).
      try {
        if (typeof response.data?.destroy === 'function') response.data.destroy()
      } catch {
        // Body cleanup must not replace the fixed provider failure.
      }
      throw new KimiProxyFailure('chat-completion', response.status)
    }

    return { response, conversationId: '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const { accessToken } = await this.acquireToken()
      
      const response = await axios.post(
        `${this.apiBase}/apiv2/kimi.chat.v1.ChatService/DeleteChat`,
        { chat_id: conversationId },
        {
          headers: {
            ...FAKE_HEADERS,
            Origin: this.apiBase,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      console.log('[Kimi] Chat deleted')
      return response.status === 200
    } catch (error) {
      console.error('[Kimi] Failed to delete conversation')
      return false
    }
  }

  private async listChats(pageToken?: string): Promise<{ chatIds: string[]; nextPageToken: string }> {
    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${this.apiBase}/apiv2/kimi.chat.v1.ChatService/ListChats`,
      {
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
        query: '',
      },
      {
        headers: {
          ...FAKE_HEADERS,
          Origin: this.apiBase,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    const data = checkResult(response)
    const chats = Array.isArray(data?.chats) ? data.chats : []
    const chatIds = chats
      .map((chat: any) => typeof chat?.id === 'string' ? chat.id : '')
      .filter(Boolean)

    return {
      chatIds,
      nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : '',
    }
  }

  private async batchDeleteChats(chatIds: string[]): Promise<boolean> {
    if (chatIds.length === 0) {
      return true
    }

    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${this.apiBase}/apiv2/kimi.chat.v1.ChatService/BatchDeleteChats`,
      { chat_ids: chatIds },
      {
        headers: {
          ...FAKE_HEADERS,
          Origin: this.apiBase,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    checkResult(response)
    return response.status === 200
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allChatIds: string[] = []
      let pageToken = ''

      for (let page = 0; page < 100; page++) {
        const result = await this.listChats(pageToken || undefined)
        allChatIds = [...allChatIds, ...result.chatIds]

        if (!result.nextPageToken || result.chatIds.length === 0) {
          break
        }

        pageToken = result.nextPageToken
      }

      if (allChatIds.length === 0) {
        console.log('[Kimi] No chats to delete')
        return true
      }

      console.log('[Kimi] Chats found for deletion')

      for (let i = 0; i < allChatIds.length; i += 100) {
        const batch = allChatIds.slice(i, i + 100)
        const success = await this.batchDeleteChats(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Kimi] All chats deleted successfully')
      return true
    } catch (error) {
      console.error('[Kimi] Failed to delete all chats')
      return false
    }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || isKimiApiEndpoint(provider.apiEndpoint)
  }
}

const STAGE_NAME_THINKING = 'STAGE_NAME_THINKING'
const KIMI_MAX_CONNECT_FRAME = 1024 * 1024

/** Connect streaming terminal errors use a fixed, bounded public status map. */
function kimiConnectFailure(error: unknown): KimiProxyFailure {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code : undefined
  const statusByCode: Record<string, number> = {
    unauthenticated: 401,
    permission_denied: 403,
    invalid_argument: 400,
    failed_precondition: 409,
    resource_exhausted: 429,
    deadline_exceeded: 504,
    unavailable: 503,
  }
  const status = typeof code === 'string' && Object.prototype.hasOwnProperty.call(statusByCode, code)
    ? statusByCode[code] : 502
  return new KimiProxyFailure('response-decoding', status)
}

function isKimiConnectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate only the envelope and message fields consumed by this adapter. */
function validateKimiConnectEnvelope(data: unknown, terminal: boolean): void {
  const invalid = () => { throw new KimiProxyFailure('response-decoding') }
  if (!isKimiConnectRecord(data)) return invalid()

  // Presence matters: null/false/0/empty-string are malformed errors, not
  // evidence of success. Keep the existing bounded map for valid errors.
  if (Object.prototype.hasOwnProperty.call(data, 'error')) {
    if (!isKimiConnectRecord(data.error) || typeof data.error.code !== 'string' || !data.error.code) {
      return invalid()
    }
    throw kimiConnectFailure(data.error)
  }

  if (terminal) {
    // EndStreamResponse is not a chat message. Only its optional metadata
    // belongs in a successful terminal; unknown shapes fail closed.
    if (Object.keys(data).some(key => key !== 'metadata')) return invalid()
    if (Object.prototype.hasOwnProperty.call(data, 'metadata')) {
      if (!isKimiConnectRecord(data.metadata) || Object.values(data.metadata).some(values =>
        !Array.isArray(values) || values.some(value => typeof value !== 'string'))) {
        return invalid()
      }
    }
    return
  }

  // These optional fields become public identifiers and cleanup targets.
  // Validate presence before either consumer can adopt IDs or emit an answer.
  for (const key of ['chat', 'message']) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue
    const metadata = data[key]
    if (!isKimiConnectRecord(metadata)) return invalid()
    if (Object.prototype.hasOwnProperty.call(metadata, 'id')) {
      const id = metadata.id
      if (typeof id !== 'string' || !id || id.trim() !== id || /[\u0000-\u001f\u007f-\u009f]/.test(id)) {
        return invalid()
      }
    }
    if (key === 'message' && Object.prototype.hasOwnProperty.call(metadata, 'role') &&
        metadata.role !== 'assistant') return invalid()
  }

  if (Object.prototype.hasOwnProperty.call(data, 'mask') && typeof data.mask !== 'string') {
    return invalid()
  }
  if (Object.prototype.hasOwnProperty.call(data, 'block')) {
    if (!isKimiConnectRecord(data.block)) return invalid()
    for (const key of ['text', 'think']) {
      if (!Object.prototype.hasOwnProperty.call(data.block, key)) continue
      const part = data.block[key]
      if (!isKimiConnectRecord(part) ||
          (Object.prototype.hasOwnProperty.call(part, 'content') && typeof part.content !== 'string')) {
        return invalid()
      }
    }
  }
}

/** Decode one bounded frame at a time, independently of transport chunking. */
class KimiConnectDecoder {
  private header: Buffer = Buffer.alloc(5)
  private headerBytes = 0
  private payload: Buffer | null = null
  private payloadBytes = 0
  private terminalSeen = false
  private chatId?: string

  push(chunk: Buffer, onMessage: (data: any) => void): void {
    if (!Buffer.isBuffer(chunk)) throw new KimiProxyFailure('response-decoding')
    if (chunk.length === 0) return
    if (this.terminalSeen) throw new KimiProxyFailure('response-decoding')

    let offset = 0
    while (offset < chunk.length) {
      if (this.headerBytes < this.header.length) {
        const count = Math.min(this.header.length - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        this.headerBytes += count
        offset += count
        if (this.headerBytes < this.header.length) return

        const flag = this.header.readUInt8(0)
        const length = this.header.readUInt32BE(1)
        if ((flag !== 0 && flag !== 2) || length > KIMI_MAX_CONNECT_FRAME) {
          throw new KimiProxyFailure('response-decoding')
        }
        // Validate the declared length before allocation. A large input chunk
        // may contain many valid frames; retain only this frame's payload.
        this.payload = Buffer.alloc(length)
        this.payloadBytes = 0
      }

      const payload = this.payload!
      const count = Math.min(payload.length - this.payloadBytes, chunk.length - offset)
      chunk.copy(payload, this.payloadBytes, offset, offset + count)
      this.payloadBytes += count
      offset += count
      if (this.payloadBytes < payload.length) return

      const terminal = this.header.readUInt8(0) === 2
      this.headerBytes = 0
      this.payload = null
      this.payloadBytes = 0

      const text = payload.toString('utf8')
      // Buffer decoding replaces malformed bytes. Require an exact roundtrip
      // for fatal UTF-8 validation, while permitting a real U+FFFD character.
      // Decode only complete payloads so split multibyte sequences stay valid.
      if (!Buffer.from(text, 'utf8').equals(payload)) throw new KimiProxyFailure('response-decoding')
      let data: unknown
      try { data = JSON.parse(text) } catch { throw new KimiProxyFailure('response-decoding') }
      validateKimiConnectEnvelope(data, terminal)
      if (isKimiConnectRecord(data) && isKimiConnectRecord(data.chat) && typeof data.chat.id === 'string') {
        // Local cleanup requires one unambiguous target for this response;
        // this is not an assertion about the provider's identifier format.
        if (this.chatId !== undefined && this.chatId !== data.chat.id) {
          throw new KimiProxyFailure('response-decoding')
        }
        this.chatId = data.chat.id
      }
      if (terminal) {
        if (offset !== chunk.length) throw new KimiProxyFailure('response-decoding')
        this.terminalSeen = true
        return
      }
      onMessage(data)
    }
  }

  isComplete(): boolean {
    return this.terminalSeen && this.headerBytes === 0 && this.payload === null
  }
}

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private enableThinking: boolean
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private realChatId: string | null = null
  private lastMessageId: string | null = null
  private hasError: boolean = false
  private streamFinished: boolean = false
  private streamTerminalSuccess: boolean = false
  private streamHasAnswer: boolean = false
  private currentPhase: 'thinking' | 'answer' | undefined = undefined
  private reasoningBuffer: string | null = ''
  private answerBuffer: string | null = ''

  constructor(model: string, conversationId: string, enableThinking: boolean = false, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.conversationId = conversationId
    this.enableThinking = enableThinking
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  getConversationId(): string | null {
    // Return realChatId if available, otherwise return null (not empty string)
    // to prevent saving invalid session IDs
    if (this.realChatId) {
      return this.realChatId
    }
    // Only return conversationId if it's a valid ID (not empty and not a temporary ID)
    if (this.conversationId && this.conversationId.length > 0 && !this.conversationId.startsWith('kimi-')) {
      return this.conversationId
    }
    return null
  }

  getLastMessageId(): string | null {
    return this.lastMessageId
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  hasSuccessfulTerminal(): boolean {
    return this.streamTerminalSuccess && !this.hasError
  }

  private detectMultiStage(data: any): 'thinking' | 'answer' | undefined {
    if (!data.block?.multiStage?.stages || !Array.isArray(data.block.multiStage.stages)) {
      return undefined
    }
    
    const stages = data.block.multiStage.stages
    if (stages.length === 0) {
      return undefined
    }
    
    const firstStage = stages[0]
    if (firstStage?.name === STAGE_NAME_THINKING) {
      return firstStage.status === 'completed' ? 'answer' : 'thinking'
    }
    
    return undefined
  }

  private isThinkingMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.think')
  }

  private isAnswerMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.text')
  }

  private extractThinkContent(data: any): string | null {
    return typeof data.block?.think?.content === 'string' ? data.block.think.content : null
  }

  private extractTextContent(data: any): string | null {
    return typeof data.block?.text?.content === 'string' ? data.block.text.content : null
  }

  private streamTextDelta(content: string, replace: boolean, thinking: boolean): string {
    const previous = thinking ? this.reasoningBuffer : this.answerBuffer
    if (replace && (previous === null || !content.startsWith(previous))) {
      // OpenAI SSE deltas cannot retract published text. Reject a conflicting
      // snapshot instead of appending it and reporting a fabricated success.
      throw new KimiProxyFailure('response-decoding')
    }
    const delta = replace ? content.slice(previous!.length) : content
    // A set string cannot exceed its bounded frame payload. Once accumulated
    // text is larger, no future set can extend it; keep a sentinel so append
    // streaming remains supported without retaining an unbounded snapshot.
    const snapshot = replace ? content
      : previous !== null && previous.length + content.length <= KIMI_MAX_CONNECT_FRAME
        ? previous + content : null
    if (thinking) this.reasoningBuffer = snapshot
    else this.answerBuffer = snapshot
    return delta
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const created = unixTimestamp()
    const decoder = new KimiConnectDecoder()
    let sentRole = false

    const fail = () => {
      if (this.streamFinished) return
      this.hasError = true
      this.streamTerminalSuccess = false
      this.streamFinished = true
      // Once SSE headers are written, an upstream rejection must be an error
      // event, never a fabricated assistant answer followed by normal [DONE].
      try {
        transStream.write('data: ' + JSON.stringify({
          error: { message: 'Kimi upstream stream did not complete', type: 'api_error' },
        }) + '\n\n')
        transStream.end()
      } catch {
        // Failure reporting must not throw from an upstream event callback.
        transStream.destroy()
      }
      // The consumer only owns transStream. End an unfinished original Axios
      // body as well, without treating local cancellation as remote no-effect.
      try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
    }

    const finish = () => {
      if (this.streamFinished) return
      if (!this.streamHasAnswer && !this.toolStreamParser?.hasEmittedToolCall()) {
        fail()
        return
      }
      const chatId = this.getConversationId() || this.conversationId
      const baseChunk = createBaseChunk(chatId, this.model, created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }
      transStream.write('data: ' + JSON.stringify({
        id: chatId, model: this.model, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {},
          finish_reason: this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop' }],
        created,
      }) + '\n\n')
      this.streamTerminalSuccess = true
      transStream.end('data: [DONE]\n\n')
      this.streamFinished = true
    }

    stream.on('data', (chunk: Buffer) => {
      if (this.streamFinished) return
      try {
        decoder.push(chunk, data => this.handleMessage(data, transStream, created,
          () => sentRole, (v) => { sentRole = v }))
      } catch {
        // JSON can contain valid syntax but invalid masks/content. Include
        // all message consumers in this asynchronous failure boundary.
        fail()
      }
    })

    stream.once('error', () => {
      console.error('[Kimi] Stream error')
      fail()
    })

    stream.once('end', () => {
      if (this.streamFinished) return
      try {
        // Await clean EOF so a later chunk cannot invalidate an already
        // published success or authorize cleanup after a premature terminal.
        if (!decoder.isComplete()) fail()
        else finish()
      } catch {
        fail()
      }
    })
    stream.once('aborted', fail)
    stream.once('close', () => {
      console.log('[Kimi] Stream closed')
      fail()
    })

    transStream.once('close', () => {
      // A closed downstream gate can destroy the intermediate stream before
      // EOF. Do not leave the provider body alive or authorize a late cleanup.
      if (!this.streamFinished) {
        this.hasError = true
        this.streamTerminalSuccess = false
        this.streamFinished = true
        try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
      }
    })

    return transStream
  }

  private handleMessage(
    data: any,
    transStream: PassThrough,
    created: number,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    if (data.heartbeat) return

    if (data.chat?.id && !this.realChatId) {
      this.realChatId = data.chat.id
      console.log('[Kimi] Chat identifier received')
    }

    if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
      this.lastMessageId = data.message.id
      console.log('[Kimi] Assistant message identifier received')
    }

    const multiStagePhase = this.detectMultiStage(data)
    if (multiStagePhase) {
      this.currentPhase = multiStagePhase
      console.log('[Kimi] Response phase detected')
    }

    if (data.block?.text?.flags === 'thinking') {
      this.currentPhase = 'thinking'
    } else if (data.block?.text?.flags === 'answer') {
      this.currentPhase = 'answer'
    }

    if ((data.op === 'set' || data.op === 'append')) {
      const mask = data.mask
      let content: string | null = null
      let thinking = false
      if (this.isThinkingMask(mask)) {
        content = this.extractThinkContent(data)
        thinking = true
      } else if (this.isAnswerMask(mask)) {
        content = this.extractTextContent(data)
      } else {
        content = this.extractTextContent(data)
        thinking = this.currentPhase === 'thinking'
      }
      if (content !== null) {
        const delta = this.streamTextDelta(content, data.op === 'set', thinking)
        if (!delta) return
        if (!getSentRole()) {
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            created,
          })}\n\n`)
          setSentRole(true)
        }

        if (thinking) {
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
            created,
          })}\n\n`)
        } else {
          this.sendChunk(transStream, delta, created)
        }
      }
    }

    // data.done is an application message, not Connect's terminal 0x02 frame.
    // Final success requires a validated EndStreamResponse and clean EOF.
  }

  private sendChunk(transStream: PassThrough, content: string, created: number) {
    if (content.trim()) this.streamHasAnswer = true
    // Process tool call interception
    // Use getConversationId() to get the real chat_id if available
    const chatId = this.getConversationId() || this.conversationId
    const baseChunk = createBaseChunk(chatId, this.model, created)
    const outputChunks = this.toolStreamParser?.push(content, baseChunk, false) ?? []

    // Check if we emitted tool calls first
    const hasToolCalls = outputChunks.some(c => c.choices?.[0]?.delta?.tool_calls)

    for (const outChunk of outputChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (!this.toolStreamParser || (!this.toolStreamParser.isBuffering() && !this.toolStreamParser.hasEmittedToolCall() && !hasToolCalls && outputChunks.length === 0)) {
      transStream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`)
    }
  }

  async handleNonStream(stream: any): Promise<any> {
    const created = unixTimestamp()
    let content = ''
    let reasoningContent = ''
    const decoder = new KimiConnectDecoder()
    let currentPhase: 'thinking' | 'answer' | undefined = undefined

    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        this.hasError = true
        reject(error instanceof KimiProxyFailure ? error : new KimiProxyFailure('response-decoding'))
        try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
      }
      const finish = () => {
        if (settled) return
        const { content: cleanContent, toolCalls } =
          (this.toolCallingPlan?.toolChoiceMode === 'none' || this.toolCallingPlan?.shouldParseResponse)
          ? { content, toolCalls: [] }
          : parseToolCallsFromText(content, 'kimi')
        if (!cleanContent.trim() && toolCalls.length === 0) {
          fail(new Error('Kimi Connect stream completed without a usable assistant answer'))
          return
        }
        const message: any = { role: 'assistant', content: toolCalls.length > 0 ? null : cleanContent.trim() }
        if (reasoningContent.trim()) message.reasoning_content = reasoningContent.trim()
        if (toolCalls.length > 0) message.tool_calls = toolCalls
        settled = true
        resolve({
          id: this.realChatId || this.conversationId,
          model: this.model,
          object: 'chat.completion',
          created,
          choices: [{ index: 0, message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
        })
      }
      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        try {
          decoder.push(chunk, data => {
            if (data.chat?.id && !this.realChatId) {
              this.realChatId = data.chat.id
              console.log('[Kimi] Non-stream chat identifier received')
            }

            if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
              this.lastMessageId = data.message.id
              console.log('[Kimi] Non-stream assistant message identifier received')
            }

            const multiStagePhase = this.detectMultiStage(data)
            if (multiStagePhase) {
              currentPhase = multiStagePhase
              console.log('[Kimi] Non-stream response phase detected')
            }

            if (data.block?.text?.flags === 'thinking') {
              currentPhase = 'thinking'
            } else if (data.block?.text?.flags === 'answer') {
              currentPhase = 'answer'
            }

            if ((data.op === 'set' || data.op === 'append')) {
              const mask = data.mask
              const replace = data.op === 'set'
              if (this.isThinkingMask(mask)) {
                const thinkContent = this.extractThinkContent(data)
                if (typeof thinkContent === 'string') {
                  reasoningContent = replace ? thinkContent : reasoningContent + thinkContent
                }
              } else if (this.isAnswerMask(mask)) {
                const textContent = this.extractTextContent(data)
                if (typeof textContent === 'string') {
                  content = replace ? textContent : content + textContent
                }
              } else if (typeof data.block?.text?.content === 'string') {
                const textContent = data.block.text.content
                if (currentPhase === 'thinking') {
                  reasoningContent = replace ? textContent : reasoningContent + textContent
                } else {
                  content = replace ? textContent : content + textContent
                }
              }
              if (content.length > KIMI_MAX_CONNECT_FRAME || reasoningContent.length > KIMI_MAX_CONNECT_FRAME) {
                throw new KimiProxyFailure('response-decoding')
              }
            }
          })
        } catch (error) {
          fail(error)
        }
      })

      stream.once('error', () => fail(new Error('Kimi Connect transport failed; outcome unknown')))
      stream.once('end', () => {
        if (settled) return
        try {
          if (!decoder.isComplete()) fail(new KimiProxyFailure('response-decoding'))
          else finish()
        } catch (error) {
          fail(error)
        }
      })
      stream.once('aborted', () => fail(new KimiProxyFailure('response-decoding')))
      stream.once('close', () => {
        if (!settled) {
          fail(new Error('Kimi Connect transport closed without its terminal frame'))
        }
      })
    })
  }
}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}
