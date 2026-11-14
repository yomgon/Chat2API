/**
 * DeepSeek Adapter
 * Implements DeepSeek web API protocol
 * 
 * NOTE: Tool prompt injection is handled by Forwarder.transformRequestForPromptToolUse()
 * This adapter only handles message format conversion and API communication
 */

import axios, { AxiosResponse } from 'axios'
import { getDeepSeekHash } from '../../lib/challenge'
import type { Account, Provider } from '../../store/types'
import { resolveDeepSeekChatOptions } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface ChallengeResponse {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  // The Chat route accepts text-part arrays. Preserve typed text in the
  // prompt projector instead of assuming all consumer messages are strings.
  content: string | Array<{ type: 'text'; text: string }> | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  /** Public alias only for legacy search/thinking feature suffixes. */
  originalModel?: string
  messages: DeepSeekMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()
// A stable account ID may survive a credential replacement or re-login.
// Keep the session tied to the exact credential that created it, not merely
// the account ID. This is volatile in-process state, never persisted/logged.
const sessionCache = new Map<string, {
  sessionId: string
  createdAt: number
  credentialToken: string
}>()

function generateRandomString(length: number, charset: string = 'alphanumeric'): string {
  const sets = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    hex: '0123456789abcdef',
  }
  const chars = sets[charset as keyof typeof sets] || sets.alphanumeric
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function generateCookie(): string {
  const timestamp = Date.now()
  return `intercom-HWWAFSESTIME=${timestamp}; HWWAFSESID=${generateRandomString(18, 'hex')}; Hm_lvt_${uuid()}=${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)}; Hm_lpvt_${uuid()}=${Math.floor(timestamp / 1000)}; _frid=${uuid()}; _fr_ssid=${uuid()}; _fr_pvid=${uuid()}`
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export class DeepSeekAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    console.log('[DeepSeek] Account configured')
    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''
    console.log('[DeepSeek] Token selected')
  }

  private async acquireToken(): Promise<string> {
    // Reject wrong-typed stored credentials and CRLF before any bearer GET.
    // A JSON object must never be coerced into Authorization.
    if (typeof this.token !== 'string' || !/^[\x21-\x7e]+$/.test(this.token)) {
      throw new Error('DeepSeek token is missing or invalid')
    }

    const cached = tokenCache.get(this.token)
    if (cached && cached.expiresAt > unixTimestamp()) {
      return cached.accessToken
    }

    console.log('[DeepSeek] Acquiring token...')
    
    const result = await axios.get(`${DEEPSEEK_API_BASE}/v0/users/current`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: () => true,
    })

    console.log('[DeepSeek] Token response received')
    
    if (result.status === 401 || result.status === 403) {
      throw new Error(`Token invalid or expired, please get a new Token`)
    }

    if (result.status !== 200) {
      throw new Error(`Failed to acquire token: HTTP ${result.status}`)
    }

    // HTTP 200 can still contain a failed business envelope. Never adopt a
    // stale token field or create remote session state from such a response.
    // A successful legacy flat envelope has code:0 without nested biz_code.
    const data = result.data
    const bizCode = data?.data?.biz_code ?? data?.biz_code
    const bizData = data?.data?.biz_data || data?.biz_data
    const accessToken = bizData?.token
    if (data?.code !== 0 ||
        (bizCode !== undefined && bizCode !== 0) ||
        typeof accessToken !== 'string' ||
        !/^[\x21-\x7e]+$/.test(accessToken)) {
      console.log('[DeepSeek] Token response was not confirmed')
      throw new Error('Failed to acquire token: authentication response unconfirmed')
    }

    tokenCache.set(this.token, {
      accessToken,
      refreshToken: this.token,
      expiresAt: unixTimestamp() + 3600,
    })

    console.log('[DeepSeek] Token acquired successfully')
    return accessToken
  }

  private async createSession(): Promise<string> {
    const cacheKey = this.account.id
    const cached = sessionCache.get(cacheKey)
    if (cached && cached.credentialToken === this.token &&
        Date.now() - cached.createdAt < 300000) {
      return cached.sessionId
    }

    const token = await this.acquireToken()
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat_session/create`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    console.log('[DeepSeek] Create session response')

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { id: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.chat_session?.id) {
      throw new Error(`Failed to create session: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    const sessionId = bizData?.chat_session?.id
    sessionCache.set(cacheKey, {
      sessionId, createdAt: Date.now(), credentialToken: this.token,
    })

    return sessionId
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete`,
        { chat_session_id: sessionId },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete session response')

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        // Clear cache
        const cacheKey = this.account.id
        // An old in-flight conversation may finish cleanup after the user
        // reconnects the same account with a different credential. Never
        // evict the new session from the old operation's deletion ACK.
        const current = sessionCache.get(cacheKey)
        if (current?.sessionId === sessionId && current.credentialToken === this.token) {
          sessionCache.delete(cacheKey)
        }
        console.log('[DeepSeek] Session deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete session')
      return false
    }
  }

  private async getChallenge(targetPath: string): Promise<ChallengeResponse> {
    const token = await this.acquireToken()
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
      { target_path: targetPath },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { challenge: {...} } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.challenge) {
      throw new Error(`Failed to get challenge: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    return bizData.challenge
  }

  private async calculateChallengeAnswer(challenge: ChallengeResponse): Promise<string> {
    const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge
    
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`)
    }
    
    console.log('[DeepSeek] Preparing challenge')
    
    const deepSeekHash = await getDeepSeekHash()
    const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)
    
    if (answer === undefined) {
      throw new Error('Challenge calculation failed')
    }
    
    console.log('[DeepSeek] Challenge answer found')

    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path: '/api/v0/chat/completion',
    })).toString('base64')
  }

  private messagesToPrompt(messages: DeepSeekMessage[], isMultiTurn: boolean = false): string {
    const toolProfile = getProviderToolProfile('deepseek')
    // Koa accepts text-part arrays for every text-capable role, including tool
    // results. Preserve their exact concatenation: String(array) leaks
    // "[object Object]" into the wire and join('\n') invents user text.
    const readText = (value: unknown, nullForToolOnly = false): string => {
      if (typeof value === 'string') return value
      if (nullForToolOnly && value === null) return ''
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error('DeepSeek message content is not supported')
      }
      return value.map((part: unknown) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          throw new Error('DeepSeek message content is not supported')
        }
        const item = part as { type?: unknown, text?: unknown }
        if (item.type !== 'text' || typeof item.text !== 'string' ||
            Object.keys(item).some(key => key !== 'type' && key !== 'text')) {
          throw new Error('DeepSeek message content is not supported')
        }
        return item.text
      }).join('')
    }
    const processedMessages = messages.map(message => {
      let text: string

      // Handle tool calls in assistant message
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        const callsText = toolProfile.formatAssistantToolCalls(message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })))
        // The OpenAI assistant turn may contain both natural-language content
        // and tool_calls. Dropping the text corrupts multi-turn context.
        const precedingText = readText(message.content, true)
        text = precedingText ? precedingText + '\n' + callsText : callsText
      }
      // Handle tool response message
      else if (message.role === 'tool' && message.tool_call_id) {
        text = toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: readText(message.content),
        })
      }
      else {
        text = readText(message.content)
      }
      return { role: message.role, text }
    })

    if (processedMessages.length === 0) return ''

    // For multi-turn mode, only send the last user message
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let text = lastUserMsg.text
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'tool') {
            text += `\n\n${processedMessages[i].text}`
          }
        }
        return `<｜User｜>${text}`
      }
    }

    const mergedBlocks: { role: string; text: string }[] = []
    let currentBlock = { ...processedMessages[0] }

    for (let i = 1; i < processedMessages.length; i++) {
      const msg = processedMessages[i]
      if (msg.role === currentBlock.role) {
        currentBlock.text += `\n\n${msg.text}`
      } else {
        mergedBlocks.push(currentBlock)
        currentBlock = { ...msg }
      }
    }
    mergedBlocks.push(currentBlock)

    return mergedBlocks
      .map((block, index) => {
        if (block.role === 'assistant') {
          return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
        }
        if (block.role === 'user' || block.role === 'system') {
          return index > 0 ? `<｜User｜>${block.text}` : block.text
        }
        if (block.role === 'tool') {
          return `<｜User｜>${block.text}`
        }
        return block.text
      })
      .join('')
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; sessionId: string }> {
    const token = await this.acquireToken()
    
    const sessionId = await this.createSession()
    console.log('[DeepSeek] Created new session')
    
    const challenge = await this.getChallenge('/api/v0/chat/completion')
    const challengeAnswer = await this.calculateChallengeAnswer(challenge)

    // Clone messages to avoid modifying original request
    // Note: Tool prompt injection is already handled by Forwarder.transformRequestForPromptToolUse()
    const messages = [...request.messages]

    let prompt = this.messagesToPrompt(messages, false)

    const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request, prompt)

    if (request.web_search || request.model.toLowerCase().includes('search')) {
      console.log('[DeepSeek] Web search enabled')
    }

    if (request.reasoning_effort || thinkingEnabled) {
      console.log('[DeepSeek] Reasoning mode enabled')
    }

    const response = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/completion`,
      {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt,
        model_type: modelType,
        ref_file_ids: [],
        search_enabled: searchEnabled,
        thinking_enabled: thinkingEnabled,
        preempt: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challengeAnswer,
        },
        timeout: 120000,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    return { response, sessionId }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete_all`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 30000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete all chats response')

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        sessionCache.clear()
        console.log('[DeepSeek] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete all chats')
      return false
    }
  }

  static isDeepSeekProvider(provider: Provider): boolean {
    if (provider.id === 'deepseek') return true
    // A configured custom endpoint such as notdeepseek.com or a URL path
    // containing "deepseek.com" must not be dispatched to the fixed consumer
    // web origin with that custom account's credentials.
    try {
      const url = new URL(provider.apiEndpoint)
      return url.origin === 'https://chat.deepseek.com' &&
        !url.username && !url.password
    } catch {
      return false
    }
  }

  /**
   * Clear session cache for a specific account
   * This should be called when a session is deleted externally (e.g., from web)
   */
  static clearSessionCache(accountId: string): void {
    sessionCache.delete(accountId)
    console.log('[DeepSeek] Account session cache cleared')
  }
}

export const deepSeekAdapter = {
  DeepSeekAdapter,
}
