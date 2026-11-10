/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'

const QWEN_AI_BASE = 'https://chat.qwen.ai'

/** Fixed diagnostic provenance only. Never propagate an Axios exception,
 * upstream URL, response body, cookie, or authorization header. */
export class QwenAiProxyFailure extends Error {
  readonly stage: 'auth-preflight' | 'chat-creation' | 'chat-completion'
  readonly upstreamStatus?: number

  constructor(stage: QwenAiProxyFailure['stage'], message: string, status?: unknown) {
    super(message)
    this.name = 'QwenAiProxyFailure'
    this.stage = stage
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      this.upstreamStatus = status
    }
  }
}

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'bx-v': '2.5.36',
  'bx-umidtoken': 'T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN-UdTuJGig-NM=',
  'bx-ua': '231!lWD36kmUe5E+joKDK5gBZ48FEl2ZWfPwIPF92lBLek2KxVW/XJ2EwruCiDOX5Px4EXNhmh6EfS9eDwQGRwijIK64A4nPqeLysJcDjUACje/H3J4ZgGZpicG6K8AkiGGaEKC830+QSiSUsLRlL/EyhXTmLcJc/5iDkMuOpUhNz0e0Q/nTqjVJ3ko00Q/oyE+jauHhUHfb1GxGHkE+++3+qCS4+ItkaA6tiItCo+romzElfLFD6RIj7oHt9vffs98nLwpHnaqKjufnLFMejSlAUGiQvTofIiGhIvftAMcoFV4mrUHsqyQ/ncQihmJHkbxXjvM57FCb6b9dEIRZl7jgj0+QLNLRs0NZ4azdZ6rzbGTSO8KA5I3Aq/3gBr87X16Mj0oJtaPKmFGaP2zghfOVhxQht8YjRd50lJa+Ue4PAuPSdu2O69DKLH8VOhrsB+psaBIRxnRi5POUQ6w8s8qlb9vxvExjHNOAKWXV1by1Nz+6FPWdyTeAgcmonjCcV0dCtPj/KyeVDkeSrDkKZjnDzHEqeCdfmJ65kve+Vy3YS0vagzyHfVEnzN0ULUZtkGfJXFNm6+bIa55wmGBhUeXbHL0EdlQXMu1YXxmcwBgTaq7tlQcfv7AefanbfjGE8R1IFnNyg2/jXLbnLg5Z6l1oKqgnxZQg0DE9BJuw6s0XjGwTdSxybWxp+WFD/RsXt76uwvCBk7z+YmSFLtFj2UlTsoq+vl0DTmsVItDKf9SZ94NcuJ7mxJYI02S/2kQBfbbHG0d4hXevDrEC0cb86EvzN2ud+v6bAunNRGNFz/RH0KLusoBVeo+puCFKeeIJWEo0t1UicX5YxJwMAoV7+g0gK93y4W9sMQtso8/wY5wsBzis9dwfLvIwXpaAM1g0MZp/YIRq8T/Qc+U/8x99tam4er0IWizvrkjqhIzCWBKpJ4Y4gj3bOmiS3VCMEaoVfKCwUWENwYKuP3H5VI0n+O2vVVRrekUrwvkm6URRhVhN4eEFTCjB9nSQu++qKyDH8HPpkS3YfwF8/OQtrZo7hQXxvNmP2HcH/K7zcweD00BaoOLiYUtXRItGYbl06sVSbm04soRf1Jqpyo3XiRqBWD9rmJfr4w8NOEGVGUCKXLDLsXy+8JC4Iqf0FsIjWxjMVdraTUtCbwXRbYUownQVm6bt7LYD1SNPoWNPqUJgsLMwP33ugrb1UbHCs24roOch6Go5QHIPA8E15SZE9pkr1SkmqrNs/+KRomFJ9HyFnWUYhZIV9MRLqlOAt6XBBTash3WJnCjhx/PZGhXVvdn2jX4+0Pm55LsiNugA8vaAUJQBxD/8a1u/RvTgbj35+b7I7m8tG0hMhClNZF+tpsOmZZhUGuXH9uVbkJMlMuAmMVCHwn3O31GlLeXXzzep2WS3xN2U+p5J0I7GySnuZUkuGs1ZTVqGUvR2g4q+7ljU55Ak78yPZiQXeUeqS74azszvZvCqWxXn2eePj+gcpliOjrYKpglUP19rQrMt8PqLt8L0ghIqVCmMwl3Hgr/VUcqDpXdpPTR=',
  Timezone: 'Mon Feb 23 2026 22:06:02 GMT+0800',
  Version: '0.2.7',
  Origin: 'https://chat.qwen.ai',
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3.6-35b': 'qwen3.6-35b-a3b',
  'qwen3.6-27b': 'qwen3.6-27b',
  'qwen3-coder': 'qwen3-coder-plus',
}

interface QwenAiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  chatId?: string
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getCredential(names: string[]): unknown {
    const credentials: unknown = this.account.credentials
    if (!isQwenRecord(credentials)) {
      throw new QwenAiProxyFailure('auth-preflight', 'Qwen AI credentials are invalid')
    }
    for (const name of names) {
      const value = credentials[name]
      if (value !== undefined && value !== null && value !== '') return value
    }
    return ''
  }

  private getToken(): string {
    const token = this.getCredential(['token', 'accessToken', 'apiKey'])
    // Treat the token as opaque; never coerce objects, trim it or infer a JWT.
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
      throw new QwenAiProxyFailure('auth-preflight', 'Qwen AI token is invalid or missing')
    }
    return token
  }

  private getCookies(): string {
    const cookies = this.getCredential(['cookies', 'cookie'])
    if (cookies === '') return ''
    // A supplied Cookie must already be a raw header. Token-only accounts are
    // valid; no cookie is inferred from a token or serialized from an object.
    const pair = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+=(?:"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*"|[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/
    if (typeof cookies !== 'string' || !/^[\x20-\x7e]+$/.test(cookies) ||
        !cookies.split(';').every(part => pair.test(part.trim()))) {
      throw new QwenAiProxyFailure('auth-preflight', 'Qwen AI cookie header is invalid')
    }
    return cookies
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${this.getToken()}`,
      'X-Request-Id': uuid(),
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const cookies = this.getCookies()
    if (cookies) {
      headers['Cookie'] = cookies
    }

    return headers
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(modelId: string, title: string = 'New Chat'): Promise<string> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.axiosInstance.post(url, payload, {
        headers: this.getHeaders(),
        maxRedirects: 0,
        validateStatus: () => true,
      })

      console.log('[QwenAI] Create chat response')

      if (response.status !== 200 && response.status !== 201) {
        throw new QwenAiProxyFailure('chat-creation', 'Qwen AI chat creation was rejected', response.status)
      }

      const createdId = response.data?.data?.id
      // A remote chat ID is used as a path/query segment on the second
      // effect. Reject malformed values before posting a completion, rather
      // than interpolating an object, slash or token-bearing URL fragment.
      if (typeof createdId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(createdId)) {
        console.log('[QwenAI] Created chat')
        return createdId
      }

      throw new QwenAiProxyFailure('chat-creation', 'Qwen AI chat creation did not return a safe chat ID')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat')
      // Never let an untrusted Axios error escape to another service boundary.
      if (error instanceof QwenAiProxyFailure) throw error
      throw new QwenAiProxyFailure('chat-creation', 'Qwen AI chat creation outcome is unconfirmed')
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
        maxRedirects: 0,
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat')
        return true
      }

      console.warn('[QwenAI] Failed to delete chat')
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat')
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
        maxRedirects: 0,
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats')
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats')
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    // Validate both supplied credential shapes before creating remote state.
    this.getToken()
    this.getCookies()

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.6-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    const rejectMessages = (): never => {
      throw new QwenAiProxyFailure('chat-creation', 'Qwen AI request messages are not supported')
    }
    const readText = (content: unknown): string => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content) || content.length === 0) return rejectMessages()
      return content.map(part => {
        if (!isQwenRecord(part) || part.type !== 'text' || typeof part.text !== 'string' ||
            Object.keys(part).some(key => key !== 'type' && key !== 'text')) return rejectMessages()
        return part.text
      }).join('')
    }

    // This existing wire has one fresh user message, not a history protocol.
    // Validate every input before creating remote state; never discard earlier
    // turns, attachments or tool metadata to make the request appear supported.
    const messages: unknown = request.messages
    if (!Array.isArray(messages) || messages.length === 0) return rejectMessages()
    const systemMessages: string[] = []
    let userContent: string | undefined
    for (const msg of messages) {
      if (!isQwenRecord(msg) ||
          Object.keys(msg).some(key => key !== 'role' && key !== 'content')) return rejectMessages()
      const content = readText(msg.content)
      if (msg.role === 'system' && userContent === undefined) {
        systemMessages.push(content)
      } else if (msg.role === 'user' && userContent === undefined) {
        userContent = content
      } else {
        return rejectMessages()
      }
    }
    if (userContent === undefined) return rejectMessages()

    // Concatenate text parts exactly; keep the established system/user framing.
    const systemContent = systemMessages.join('\n\n')
    if (systemContent) {
      userContent = `${systemContent}\n\nUser: ${userContent}`
    }

    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat')
    console.log('[QwenAI] Created new chat')

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // Default to disable thinking mode to avoid automatic reasoning trigger
    // Users can control thinking via:
    // 1. Model name suffix: -thinking (force thinking), -fast (force fast mode)
    // 2. enable_thinking parameter for explicit control
    // 3. If neither is specified, thinking mode is disabled by default (fast mode)
    const shouldEnableThinking = forceThinking !== undefined 
      ? forceThinking 
      : request.enable_thinking === true
    
    const featureConfig: Record<string, any> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false, // Default to disable auto search
    }

    if (request.thinking_budget) {
      featureConfig.thinking_budget = request.thinking_budget
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: userContent,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`

    console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
    console.log('[QwenAI] Request URL prepared')
    console.log('[QwenAI] Request payload prepared')
    console.log('[QwenAI] Request headers prepared')

    let response: AxiosResponse
    try {
      response = await this.axiosInstance.post(url, payload, {
        headers: {
          ...this.getHeaders(chatId),
          'x-accel-buffering': 'no',
        },
        responseType: 'stream',
        timeout: 120000,
        maxRedirects: 0,
        validateStatus: () => true,
      })
    } catch {
      throw new QwenAiProxyFailure('chat-completion', 'Qwen AI chat completion outcome is unconfirmed')
    }

    if (response.status !== 200) {
      if (typeof response.data?.destroy === 'function') response.data.destroy()
      throw new QwenAiProxyFailure('chat-completion', 'Qwen AI completion was rejected', response.status)
    }

    console.log('[QwenAI] Response received')
    console.log('[QwenAI] Response headers received')

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  static isQwenAiProvider(provider: Provider): boolean {
    if (provider.id === 'qwen-ai') return true
    try {
      const url = new URL(provider.apiEndpoint)
      return url.protocol === 'https:' &&
        url.hostname === 'chat.qwen.ai' &&
        (url.port === '' || url.port === '443') &&
        !url.username && !url.password
    } catch {
      return false
    }
  }
}

type QwenAiFinishReason = 'stop' | 'length' | 'tool_calls'
type QwenAiDelta = { content?: string, reasoning_content?: string }

interface QwenAiCompletion {
  content: string
  reasoningContent: string
  finishReason: QwenAiFinishReason
  toolCalls: ToolCall[]
}

function isQwenRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireQwenValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Qwen AI upstream completion was not confirmed')
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private streamTerminalSuccess: boolean = false

  constructor(model: string, onEnd?: (chatId: string) => void,
    private readonly allowLegacyToolCalls: boolean = true) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  hasSuccessfulTerminal(): boolean {
    return this.streamTerminalSuccess
  }

  private notifyCompleted(): void {
    if (this.onEnd && this.chatId) {
      try {
        void Promise.resolve(this.onEnd(this.chatId)).catch(() => {})
      } catch { /* never expose callback errors */ }
    }
  }

  /**
   * Both output modes use one strict upstream contract. A provider finish is
   * provisional until clean EOF; late errors, extra content and aborted close
   * must not produce successful output or authorize session cleanup.
   */
  private consume(
    stream: any,
    onDelta: (delta: QwenAiDelta) => void,
    onComplete: (completion: QwenAiCompletion) => void,
    onFailure: (message: string) => void,
  ): void {
    const maxFrameBytes = 1_048_576
    let settled = false
    let answerFinished = false
    let sawDone = false
    let content = ''
    let reasoningContent = ''
    let summaryText = ''
    let finishReason: QwenAiFinishReason = 'stop'
    let pendingBytes = Buffer.alloc(0)
    let frameLines: string[] = []
    let frameBytes = 0
    let firstLine = true

    const fail = (modelError = false) => {
      if (settled) return
      settled = true
      console.error('[QwenAI] Upstream completion rejected')
      onFailure(modelError
        ? 'Qwen AI upstream returned a model error'
        : 'Qwen AI upstream completion was not confirmed')
      // Settlement stops local response parsing; an unfinished Axios body is
      // owned by this consumer and must not remain readable after failure.
      try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
    }

    const acceptData = (data: string) => {
      if (data === '[DONE]') {
        requireQwenValue(answerFinished && !sawDone)
        sawDone = true
        return
      }
      requireQwenValue(!answerFinished && !sawDone)
      const body: unknown = JSON.parse(data)
      requireQwenValue(isQwenRecord(body))
      if (body.error !== undefined || body.type === 'error' ||
          (isQwenRecord(body.data) && body.data.error !== undefined)) {
        fail(true)
        return
      }

      const created = body['response.created']
      if (created !== undefined) {
        requireQwenValue(isQwenRecord(created) && typeof created.response_id === 'string' &&
          !!created.response_id.trim() && created.response_id.length <= 256 &&
          !/[\x00-\x20\x7f]/.test(created.response_id))
        requireQwenValue(!this.responseId || this.responseId === created.response_id)
        this.responseId = created.response_id
      }
      if (body.choices === undefined) {
        requireQwenValue(created !== undefined)
        return
      }
      requireQwenValue(Array.isArray(body.choices) && body.choices.length === 1 &&
        isQwenRecord(body.choices[0]))
      requireQwenValue(body.object === undefined || body.object === 'chat.completion.chunk')
      const choice = body.choices[0]
      requireQwenValue(choice.index === undefined || choice.index === 0)
      requireQwenValue(isQwenRecord(choice.delta) && choice.message === undefined)
      const delta = choice.delta
      if (choice.error !== undefined || delta.error !== undefined) {
        fail(true)
        return
      }
      requireQwenValue(delta.role === undefined || delta.role === 'assistant')
      requireQwenValue(delta.content === undefined || delta.content === null ||
        typeof delta.content === 'string')
      requireQwenValue(delta.tool_calls === undefined)
      const text = typeof delta.content === 'string' ? delta.content : ''
      const phase = delta.phase
      const status = delta.status
      const answerPhase = phase === undefined || phase === null || phase === 'answer'
      requireQwenValue(answerPhase || phase === 'think' || phase === 'thinking_summary')
      requireQwenValue(status === undefined || status === null ||
        status === 'streaming' || status === 'finished')

      const reasons = [delta.finish_reason, choice.finish_reason]
        .filter(value => value !== undefined && value !== null)
      requireQwenValue(reasons.every(value =>
        value === 'stop' || value === 'length' || value === 'tool_calls'))
      requireQwenValue(reasons.length < 2 || reasons[0] === reasons[1])
      const reason = reasons[0] as QwenAiFinishReason | undefined
      // Preserve the already-supported choice-level terminal when phase and
      // status are absent, without treating a contradictory streaming status
      // or a reasoning-phase finish as an answer completion.
      const terminal = status === 'finished' ||
        ((phase === undefined || phase === null) &&
          (status === undefined || status === null) && reason !== undefined)
      requireQwenValue(reason === undefined || (answerPhase && terminal))

      if (phase === 'think') {
        if (status !== 'finished' && text) {
          reasoningContent += text
          onDelta({ reasoning_content: text })
        }
      } else if (phase === 'thinking_summary') {
        if (delta.extra !== undefined) {
          requireQwenValue(isQwenRecord(delta.extra))
          const thought = delta.extra.summary_thought
          if (thought !== undefined) {
            requireQwenValue(isQwenRecord(thought) && Array.isArray(thought.content) &&
              thought.content.every(value => typeof value === 'string'))
            const summary = thought.content.join('\n')
            requireQwenValue(summary.startsWith(summaryText))
            const diff = summary.slice(summaryText.length)
            summaryText = summary
            if (diff) {
              reasoningContent += diff
              onDelta({ reasoning_content: diff })
            }
          }
        }
      } else {
        content += text
        if (text) onDelta({ content: text })
        if (terminal) {
          answerFinished = true
          finishReason = reason ?? 'stop'
        }
      }
    }

    const acceptFrame = () => {
      const dataLines: string[] = []
      const fields = new Set<string>()
      for (const line of frameLines) {
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') dataLines.push(value)
        else {
          requireQwenValue(!fields.has(field))
          fields.add(field)
          if (field === 'event') requireQwenValue(value === '' || value === 'message')
          else if (field === 'id') requireQwenValue(!/[\x00-\x1f\x7f]/.test(value))
          else if (field === 'retry') requireQwenValue(/^\d+$/.test(value))
          else requireQwenValue(false)
        }
      }
      if (dataLines.length) acceptData(dataLines.join('\n'))
    }

    if (!stream || typeof stream.on !== 'function' || typeof stream.once !== 'function') {
      fail()
      return
    }
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      try {
        requireQwenValue(Buffer.isBuffer(chunk))
        let offset = 0
        while (offset < chunk.length && !settled) {
          const newline = chunk.indexOf(10, offset)
          const end = newline < 0 ? chunk.length : newline + 1
          const part = chunk.subarray(offset, end)
          // Bound a logical frame, independently of how TCP coalesces chunks.
          requireQwenValue(frameBytes + pendingBytes.length + part.length <= maxFrameBytes)
          pendingBytes = Buffer.concat([pendingBytes, part])
          offset = end
          if (newline < 0) break
          const decoded = pendingBytes.toString('utf8')
          // Buffer decoding substitutes invalid UTF-8. Exact roundtrip rejects
          // malformed bytes while preserving a genuine U+FFFD and split input.
          requireQwenValue(Buffer.from(decoded, 'utf8').equals(pendingBytes))
          frameBytes += pendingBytes.length
          pendingBytes = Buffer.alloc(0)
          let line = decoded.slice(0, -1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (firstLine && line.startsWith('\uFEFF')) line = line.slice(1)
          firstLine = false
          requireQwenValue(!line.includes('\r'))
          if (line === '') {
            acceptFrame()
            frameLines = []
            frameBytes = 0
          } else {
            frameLines.push(line)
          }
        }
      } catch {
        fail()
      }
    })
    // Keep an error listener after settlement so a late transport error cannot
    // escape as an unhandled event or change an already confirmed outcome.
    stream.on('error', () => fail())
    stream.once('close', () => fail())
    stream.once('end', () => {
      if (settled) return
      try {
        requireQwenValue(!pendingBytes.length && !frameLines.length &&
          answerFinished && !!content.trim())
        // Explicit tool_choice:none must not silently reinterpret text/XML as
        // a tool invocation. The default remains compatible with legacy chat.
        const tools = this.allowLegacyToolCalls && hasToolUse(content) ? parseToolUse(content) : []
        requireQwenValue(Array.isArray(tools) && tools.length <= 128 &&
          tools.every(call => isQwenRecord(call) && call.type === 'function' &&
            typeof call.id === 'string' && !!call.id &&
            isQwenRecord(call.function) && typeof call.function.name === 'string' &&
            !!call.function.name.trim() && call.function.name.length <= 256 &&
            typeof call.function.arguments === 'string' && !!call.function.arguments.trim()))
        if (tools.length && finishReason !== 'length') finishReason = 'tool_calls'
        requireQwenValue(finishReason !== 'tool_calls' || tools.length > 0)
        settled = true
        this.streamTerminalSuccess = true
        onComplete({
          content, reasoningContent, finishReason,
          toolCalls: finishReason === 'tool_calls' ? tools : [],
        })
      } catch {
        fail()
      }
    })
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const output = new PassThrough()
    output.once('close', () => {
      // Terminal success is set by consume only after genuine upstream EOF.
      // A downstream gate/client may destroy output before that point.
      if (!this.streamTerminalSuccess) {
        try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
      }
    })
    let sentRole = false
    const send = (delta: Record<string, unknown>, reason: QwenAiFinishReason | null = null) => {
      output.write('data: ' + JSON.stringify({
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: reason }],
        created: this.created,
      }) + '\n\n')
    }
    const initial = () => {
      if (sentRole) return
      sentRole = true
      send({ role: 'assistant', content: '' })
    }
    this.consume(stream, delta => {
      initial()
      send(delta)
    }, completion => {
      initial()
      completion.toolCalls.forEach((call, index) => {
        send({ tool_calls: [{ index, ...call }] })
      })
      send({}, completion.finishReason)
      output.end('data: [DONE]\n\n')
      this.notifyCompleted()
    }, () => {
      output.end('data: ' + JSON.stringify({
        error: { message: 'Qwen AI upstream stream did not complete', type: 'api_error' },
      }) + '\n\n')
    })
    return output
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.consume(stream, () => {}, completion => {
        this.notifyCompleted()
        resolve({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant', content: completion.content,
              reasoning_content: completion.reasoningContent,
              ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
            },
            finish_reason: completion.finishReason,
          }],
          created: this.created,
        })
      }, message => reject(new Error(message)))
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
