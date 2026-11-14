/**
 * Qwen Adapter
 * Implements Qwen (Tongyi Qianwen) web API protocol
 * Based on new chat2.qianwen.com API
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import * as ZstdCodec from 'zstd-codec'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected, shouldInjectToolPrompt } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import { selectQwenChinaTicket } from '../../providers/qwenTicket'

/**
 * Check if content contains tool calls (both bracket and XML formats)
 */
function hasToolCalls(content: string): boolean {
  return content.includes('[function_calls]') || hasToolUse(content)
}

const QWEN_API_BASE = 'https://chat2.qianwen.com'
const QWEN_CHAT2_API_BASE = 'https://chat2-api.qianwen.com'
const QWEN_CHAT_SIDE_API_BASE = 'https://chat-side.qianwen.com'

const MODEL_MAP: Record<string, string> = {
  'Qwen3.6': 'Qwen',
  'Qwen3.7-Max': 'Qwen3.7-Max',
  'Qwen3.5-Flash': 'Qwen3.5-Flash',
  'Qwen3-Max': 'Qwen3-Max',
  'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
  'Qwen3-Coder': 'Qwen3-Coder',
}

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: 'https://www.qianwen.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

interface QwenMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[]
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  /** The LoadBalancer already selected an exact effective-catalog wire ID. */
  resolvedModelId?: boolean
  messages: QwenMessage[]
  tools?: any[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  enableThinking?: boolean
  enableWebSearch?: boolean
}

interface QwenSessionListPage {
  sessionIds: string[]
  hasMore: boolean
  nextCursor: string
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function extractTextContent(content: string | any[]): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('')
  }
  return ''
}

export class QwenAdapter {
  private provider: Provider
  private account: Account
  private axiosInstance = axios.create({
    timeout: 120000,
    maxRedirects: 0,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getTicket(): string {
    return selectQwenChinaTicket(this.account.credentials) ?? ''
  }

  private mapModel(model: string): string {
    if (MODEL_MAP[model]) {
      return MODEL_MAP[model]
    }
    return model
  }

  private getApiHeaders(ticket: string): Record<string, string> {
    return {
      Cookie: `tongyi_sso_ticket=${ticket}`,
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
      'X-Platform': 'pc_tongyi',
      'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
    }
  }

  private getApiParams(extra: Record<string, string | number> = {}): Record<string, string | number> {
    return {
      biz_id: 'ai_qwen',
      chat_client: 'h5',
      device: 'pc',
      fr: 'pc',
      pr: 'qwen',
      ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
      la: 'zh_CN',
      tz: 'Asia/Shanghai',
      wv: '1',
      ve: '1',
      ...extra,
    }
  }

  private extractSessionIds(data: any): string[] {
    const candidateLists = [
      data?.data?.list,
      data?.data?.sessions,
      data?.data?.sessionList,
      data?.data?.records,
      data?.data?.items,
      data?.data?.dataList,
      data?.data?.result?.list,
      data?.data?.result?.records,
      data?.data?.pageData?.list,
      data?.data?.pageData?.records,
      data?.list,
      data?.sessions,
    ].filter(Array.isArray)

    const sessionIds = candidateLists.flatMap((items: any[]) => (
      items
        .map((item: any) => item?.session_id || item?.sessionId || item?.session?.id || item?.id)
        .filter((sessionId: any): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)
    ))

    return [...new Set(sessionIds)]
  }

  private async listSessions(pageNum: number, cursor?: string): Promise<QwenSessionListPage> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v2/session/page/list`,
      {
        pageSize: 100,
        pageNum,
        ...(cursor ? { cursor } : {}),
      },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      throw new Error(`Qwen session list failed: HTTP ${response.status}`)
    }

    const data = response.data?.data || {}
    const nextCursor = data.nextCursor || data.next_cursor || data.cursor || ''

    return {
      sessionIds: this.extractSessionIds(response.data),
      hasMore: Boolean(data.hasMore ?? data.has_more ?? data.page?.hasMore ?? data.result?.hasMore),
      nextCursor: typeof nextCursor === 'string' ? nextCursor : '',
    }
  }

  private async deleteRelatedFileRecords(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return true
    }

    const timestamp = Date.now()
    const response = await axios.post(
      `${QWEN_CHAT_SIDE_API_BASE}/api/v2/file/record/delete`,
      { sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams({
          nonce: generateNonce(),
          timestamp,
        }),
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      console.warn('[Qwen] Failed to delete related file records')
      return false
    }

    return true
  }

  private async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return sessionIds.length === 0
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v1/session/delete/batch`,
      { session_ids: sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200) {
      console.warn('[Qwen] Session deletion request failed')
      return false
    }

    const { success, code, msg } = response.data || {}
    if (success === false || (typeof code === 'number' && code !== 0)) {
      console.warn('[Qwen] Session deletion response reported failure')
      return false
    }

    const fileRecordSuccess = await this.deleteRelatedFileRecords(sessionIds)
    if (!fileRecordSuccess) {
      console.warn('[Qwen] Sessions deleted but related file record cleanup failed')
    }

    return true
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    sessionId: string
    reqId: string
  }> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const reqId = uuid(false)
    const sessionId = uuid(false)
    
    // A selected catalog actualModelId is the wire contract. Historical
    // display aliases are mapped only for direct callers without this flag.
    let actualModel = request.resolvedModelId === true
      ? request.model : this.mapModel(request.model)
    
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
      console.log('[Qwen] Thinking mode enabled (from model name)')
    }
    if (request.enableWebSearch === undefined && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Qwen] Web search enabled (from model name)')
    }

    // Map thinking mode to model
    if (enableThinking && request.resolvedModelId !== true) {
      // Use thinking model if available
      if (actualModel === 'Qwen3-Max') {
        actualModel = 'Qwen3-Max-Thinking-Preview'
        console.log('[Qwen] Using thinking model')
      }
    }
    
    console.log('[Qwen] Session prepared')
    console.log('[Qwen] Using model')

    const toolProfile = getProviderToolProfile('qwen')

    // Build prompt content from conversation messages
    let systemPrompt = ''
    const conversationParts: string[] = []
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        // The consumer endpoint accepts one combined prompt, not multiple
        // system roles. Preserve every supplied leading system instruction in
        // order instead of silently overwriting all but the last one.
        const systemContent = extractTextContent(msg.content)
        systemPrompt = systemPrompt ? systemPrompt + '\n\n' + systemContent : systemContent
      } else if (msg.role === 'user') {
        conversationParts.push(extractTextContent(msg.content))
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // An assistant can explain its intent and issue a tool call in the
        // same OpenAI turn. Keep the explanation before the serialized call.
        const precedingText = extractTextContent(msg.content)
        if (precedingText) conversationParts.push(`Assistant: ${precedingText}`)
        conversationParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))))
      } else if (msg.role === 'assistant') {
        conversationParts.push(`Assistant: ${extractTextContent(msg.content)}`)
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        conversationParts.push(toolProfile.formatToolResult({
          toolCallId: msg.tool_call_id,
          content: extractTextContent(msg.content),
        }))
      }
    }

    let userContent = conversationParts.join('\n\n')

    // Inject tools prompt if tools are provided and not already injected by client
    if (request.tools && request.tools.length > 0 && !hasToolPromptInjected(request.messages)) {
      const toolsPrompt = toolsToSystemPrompt(request.tools)
      systemPrompt = systemPrompt 
        ? systemPrompt + '\n\n' + toolsPrompt 
        : toolsPrompt
      // Add tool wrap hint to user content
      userContent = userContent + TOOL_WRAP_HINT
    }

    // If system prompt exists, prepend it to user content
    const finalContent = systemPrompt 
      ? `${systemPrompt}\n\nUser: ${userContent}`
      : userContent

    const timestamp = Date.now()
    const nonce = generateNonce()

    const requestBody = {
      deep_search: (enableWebSearch || enableThinking) ? '1' : '0',
      req_id: reqId,
      model: actualModel,
      scene: 'chat',
      session_id: sessionId,
      sub_scene: 'chat',
      temporary: false,
      messages: [
        {
          content: finalContent,
          mime_type: 'text/plain',
          meta_data: {
            ori_query: finalContent
          }
        }
      ],
      from: 'default',
      parent_req_id: '0',
      enable_search: enableWebSearch,
      biz_data: '{"entryPoint":"tongyigw"}',
      scene_param: 'first_turn',
      chat_client: 'h5',
      client_tm: timestamp.toString(),
      protocol_version: 'v2',
      biz_id: 'ai_qwen'
    }

    const queryString = `biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${uuid(false)}&nonce=${nonce}&timestamp=${timestamp}`
    const url = `${QWEN_API_BASE}/api/v2/chat?${queryString}`

    console.log('[Qwen] Sending request to /api/v2/chat...')

    const response = await this.axiosInstance.post(url, requestBody, {
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `tongyi_sso_ticket=${ticket}`,
      },
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 0,
      validateStatus: () => true,
      decompress: false,
    })

    console.log('[Qwen] Response received')
    console.log('[Qwen] Response headers received')

    return { response, sessionId, reqId }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      if (!sessionId) {
        return false
      }

      const success = await this.deleteSessions([sessionId])
      if (success) {
        console.log('[Qwen] Session deleted successfully')
      }
      return success
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete session')
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allSessionIds: string[] = []
      let nextCursor = ''

      for (let pageNum = 1; pageNum <= 100; pageNum++) {
        const result = await this.listSessions(pageNum, nextCursor || undefined)
        allSessionIds = [...allSessionIds, ...result.sessionIds]

        if (!result.hasMore || result.sessionIds.length === 0) {
          break
        }

        nextCursor = result.nextCursor
      }

      allSessionIds = [...new Set(allSessionIds)]

      if (allSessionIds.length === 0) {
        console.log('[Qwen] No sessions to delete')
        return true
      }

      console.log('[Qwen] Sessions found for deletion')

      for (let i = 0; i < allSessionIds.length; i += 100) {
        const batch = allSessionIds.slice(i, i + 100)
        const success = await this.deleteSessions(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Qwen] All sessions deleted successfully')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete all sessions')
      return false
    }
  }

  static isQwenProvider(provider: Provider): boolean {
    if (provider.id === 'qwen') return true
    // The China consumer-web adapter talks to fixed first-party Qianwen
    // origins. A custom API whose hostname/path merely contains qianwen.com
    // or aliyun.com must retain its configured generic endpoint and identity.
    try {
      const url = new URL(provider.apiEndpoint)
      const trustedHost = [
        'qianwen.com', 'www.qianwen.com', 'chat2.qianwen.com',
        'chat2-api.qianwen.com', 'chat-side.qianwen.com',
      ].includes(url.hostname)
      return url.protocol === 'https:' && trustedHost &&
        !url.username && !url.password && !url.port
    } catch {
      return false
    }
  }
}

function qwenDecodingFailure(): Error {
  return new Error('Qwen response decoding failed')
}

function isQwenRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate fields consumed below before exposing any content from this event. */
function qwenEventMessages(value: unknown): any[] {
  if (!isQwenRecord(value)) throw qwenDecodingFailure()
  if (Object.prototype.hasOwnProperty.call(value, 'error') ||
      (Object.prototype.hasOwnProperty.call(value, 'error_code') && value.error_code !== 0)) {
    throw qwenDecodingFailure()
  }
  if (value.communication !== undefined) {
    if (!isQwenRecord(value.communication)) throw qwenDecodingFailure()
    for (const key of ['sessionid', 'reqid']) {
      if (value.communication[key] !== undefined && typeof value.communication[key] !== 'string') {
        throw qwenDecodingFailure()
      }
    }
  }
  if (value.data !== undefined && !isQwenRecord(value.data)) throw qwenDecodingFailure()
  const messages = value.data?.messages
  if (messages === undefined) return []
  if (!Array.isArray(messages)) throw qwenDecodingFailure()
  for (const message of messages) {
    if (!isQwenRecord(message) ||
        (message.mime_type !== undefined && typeof message.mime_type !== 'string') ||
        (message.status !== undefined && typeof message.status !== 'string') ||
        (message.role !== undefined && message.role !== 'assistant')) {
      throw qwenDecodingFailure()
    }
    if ((message.mime_type === 'text/plain' || message.mime_type === 'multi_load/iframe') &&
        message.content !== undefined && typeof message.content !== 'string') {
      throw qwenDecodingFailure()
    }
    if (message.meta_data !== undefined && !isQwenRecord(message.meta_data)) throw qwenDecodingFailure()
    const loads = message.meta_data?.multi_load
    if (loads === undefined) continue
    if (!Array.isArray(loads)) throw qwenDecodingFailure()
    for (const load of loads) {
      if (!isQwenRecord(load) || (load.type !== undefined && typeof load.type !== 'string')) {
        throw qwenDecodingFailure()
      }
      if ((load.type === 'deep_think' || load.type === 'multimodal_chat_think') && load.content !== undefined) {
        if (!isQwenRecord(load.content) ||
            (load.content.think_content !== undefined && typeof load.content.think_content !== 'string') ||
            (load.content.content !== undefined && typeof load.content.content !== 'string')) {
          throw qwenDecodingFailure()
        }
      }
    }
  }
  return messages
}

/** Strict UTF-8 and complete SSE events, including event-only completion. */
class QwenSseDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private skipLF = false
  private eventType = 'message'
  private data: string[] = []
  private pendingEvent = false

  constructor(private onEvent: (type: string, data: string | undefined) => void) {}

  feed(bytes: Buffer): void {
    if (!Buffer.isBuffer(bytes)) throw qwenDecodingFailure()
    this.consume(this.decoder.decode(bytes, { stream: true }))
  }

  finish(): void {
    this.consume(this.decoder.decode())
    // EOF must not invent a line break or silently discard a partial event.
    if (this.line || this.pendingEvent) throw qwenDecodingFailure()
  }

  private consume(text: string): void {
    let offset = 0
    while (offset < text.length) {
      if (this.skipLF) {
        this.skipLF = false
        if (text[offset] === '\n') {
          offset++
          continue
        }
      }
      const nextLF = text.indexOf('\n', offset)
      const nextCR = text.indexOf('\r', offset)
      const next = nextLF < 0 ? nextCR : nextCR < 0 ? nextLF : Math.min(nextLF, nextCR)
      if (next < 0) {
        this.line += text.slice(offset)
        return
      }
      this.line += text.slice(offset, next)
      const line = this.line
      this.line = ''
      this.skipLF = text[next] === '\r'
      offset = next + 1
      this.acceptLine(line)
    }
  }

  private acceptLine(line: string): void {
    if (!line) {
      const type = this.eventType
      const data = this.data.length ? this.data.join('\n') : undefined
      const pending = this.pendingEvent
      this.eventType = 'message'
      this.data = []
      this.pendingEvent = false
      if (pending) this.onEvent(type, data)
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.pendingEvent = true
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.eventType = value.trim()
    else if (field === 'id') {
      if (value.includes('\0')) throw qwenDecodingFailure()
    } else if (field === 'retry') {
      if (!/^\d+$/.test(value)) throw qwenDecodingFailure()
    } else {
      throw qwenDecodingFailure()
    }
  }
}

export class QwenStreamHandler {
  private sessionId: string = ''
  private model: string
  private created: number
  private onEnd?: (sessionId: string) => void
  private content: string = ''
  private responseId: string = ''
  private hasError: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private sentRole: boolean = false
  private thinkingContent: string = ''
  private sentThinkingRole: boolean = false

  constructor(model: string, onEnd?: (sessionId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private consumeResponse(
    stream: any,
    response: AxiosResponse | undefined,
    onProgress: (content: string, thinking: string) => void,
    prepareComplete: () => (() => void),
    onFailure: () => void
  ): void {
    let settled = false
    let sourceEnded = false
    let decodedEnded = false
    let providerFinished = false
    let messageFinished = false
    let decodeTimeout: ReturnType<typeof setTimeout> | undefined

    const clearDecodeTimeout = () => {
      if (decodeTimeout !== undefined) clearTimeout(decodeTimeout)
      decodeTimeout = undefined
    }

    const fail = () => {
      if (settled) return
      settled = true
      clearDecodeTimeout()
      this.hasError = true
      console.error('[Qwen] Response did not complete')
      onFailure()
    }
    const complete = () => {
      if (settled || !sourceEnded || !decodedEnded) return
      let commit: () => void
      try {
        if (!providerFinished || !this.content.trim()) throw qwenDecodingFailure()
        // Tool flush and serialization may throw or synchronously report a
        // source error. Prepare every terminal byte before committing success.
        commit = prepareComplete()
      } catch {
        fail()
        return
      }
      if (settled) return
      settled = true
      clearDecodeTimeout()
      try {
        commit()
      } catch {
        this.hasError = true
        onFailure()
        return
      }
      // Preserve the existing message-finish callback selection, but only
      // after verified completion. Cleanup failure cannot change the answer.
      if (messageFinished && this.onEnd) {
        try {
          Promise.resolve(this.onEnd(this.sessionId)).catch(() => {
            console.warn('[Qwen] Completion callback failed')
          })
        } catch {
          console.warn('[Qwen] Completion callback failed')
        }
      }
    }

    const parser = new QwenSseDecoder((type, body) => {
      if (settled) return
      if (type === 'error') throw qwenDecodingFailure()
      if (body?.trim() === '[DONE]') {
        // Preserve the existing ignored marker: only an iframe status or
        // complete event supplies completion proof. Keep reading later events.
        return
      }
      if (body !== undefined && !(type === 'complete' && !body.trim())) {
        const value: unknown = JSON.parse(body)
        const messages = qwenEventMessages(value)
        const result = value as Record<string, any>
        if (!this.sessionId && result.communication?.sessionid) this.sessionId = result.communication.sessionid
        if (!this.responseId && result.communication?.reqid) this.responseId = result.communication.reqid

        let eventThinking = ''
        let fallbackThinking = ''
        let hasDeepThink = false
        let nextContent = this.content
        let finishesMessage = false
        for (const message of messages) {
          for (const load of message.meta_data?.multi_load ?? []) {
            if (load.type === 'deep_think' && load.content) {
              hasDeepThink = true
              const thinking = load.content.think_content || load.content.content || ''
              if (thinking.length > eventThinking.length) eventThinking = thinking
            } else if (load.type === 'multimodal_chat_think' && load.content) {
              const thinking = load.content.think_content || load.content.content || ''
              if (thinking.length > fallbackThinking.length) fallbackThinking = thinking
            }
          }
          if ((message.mime_type === 'text/plain' || message.mime_type === 'multi_load/iframe') &&
              typeof message.content === 'string') {
            const content = message.content.replace(/\[\(deep_think\)\]/g, '')
              .replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
            if (providerFinished && content.trim() && content !== this.content) throw qwenDecodingFailure()
            if (content.trim() && content.length > nextContent.length) nextContent = content
          }
          if (message.mime_type === 'multi_load/iframe' &&
              (message.status === 'complete' || message.status === 'finished')) {
            finishesMessage = true
          }
        }
        if (!hasDeepThink) eventThinking = fallbackThinking
        if (providerFinished && eventThinking && eventThinking !== this.thinkingContent) throw qwenDecodingFailure()
        const contentDelta = nextContent.slice(this.content.length)
        const thinkingDelta = eventThinking.length > this.thinkingContent.length
          ? eventThinking.slice(this.thinkingContent.length) : ''
        this.content = nextContent
        if (thinkingDelta) this.thinkingContent = eventThinking
        onProgress(contentDelta, thinkingDelta)
        if (finishesMessage) {
          providerFinished = true
          messageFinished = true
        }
      }
      if (type === 'complete') providerFinished = true
    })

    const feed = (chunk: Buffer) => {
      if (settled) return
      try { parser.feed(chunk) } catch { fail() }
    }
    const endDecoded = () => {
      if (settled || decodedEnded) return
      try {
        parser.finish()
        decodedEnded = true
        complete()
      } catch {
        fail()
      }
    }
    const watchErrors = (input: any, ended: () => boolean) => {
      // Keep the error listener after settlement so a late error cannot escape.
      input.on('error', fail)
      input.once('aborted', fail)
      input.once('timeout', fail)
      input.once('close', () => { if (!ended()) fail() })
    }

    try {
      watchErrors(stream, () => sourceEnded)
      stream.once('end', () => {
        sourceEnded = true
        complete()
      })
      const encodingValue = response?.headers?.['content-encoding']
      const encoding = typeof encodingValue === 'string' ? encodingValue.toLowerCase() : undefined
      if (encoding === 'zstd') {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => {
          if (settled) return
          if (!Buffer.isBuffer(chunk)) { fail(); return }
          chunks.push(chunk)
        })
        stream.once('end', () => {
          if (settled) return
          try {
            // The installed CommonJS module exports { ZstdCodec }, while the
            // legacy ambient declaration describes its inner run function.
            const codec = (ZstdCodec as unknown as { ZstdCodec: { run: typeof ZstdCodec.run } }).ZstdCodec
            const compressed = Buffer.concat(chunks)
            chunks.length = 0
            // Network timeout no longer covers initialization after raw EOF.
            // Bound local codec waiting by the existing 120-second budget.
            decodeTimeout = setTimeout(fail, 120_000)
            decodeTimeout.unref?.()
            codec.run(zstd => {
              if (settled) return
              try {
                const decompressed = new zstd.Simple().decompress(compressed)
                if (!(decompressed instanceof Uint8Array)) throw qwenDecodingFailure()
                feed(Buffer.from(decompressed))
                endDecoded()
              } catch {
                fail()
              }
            })
          } catch {
            fail()
          }
        })
        return
      }

      let decoded = stream
      if (encoding === 'gzip') decoded = createGunzip()
      else if (encoding === 'deflate') decoded = createInflate()
      else if (encoding === 'br') decoded = createBrotliDecompress()
      if (decoded !== stream) watchErrors(decoded, () => decodedEnded)
      decoded.on('data', feed)
      decoded.once('end', endDecoded)
      if (decoded !== stream) stream.pipe(decoded)
    } catch {
      fail()
    }
  }

  handleStream(stream: any, response?: AxiosResponse): PassThrough {
    const transStream = new PassThrough()
    this.consumeResponse(stream, response, (content, thinking) => {
      if (!this.sentRole && thinking.trim()) {
        if (!this.sentThinkingRole) {
          transStream.write('data: ' + JSON.stringify({
            id: this.responseId || this.sessionId, model: this.model,
            object: 'chat.completion.chunk', created: this.created,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }) + '\n\n')
          this.sentThinkingRole = true
        }
        transStream.write('data: ' + JSON.stringify({
          id: this.responseId || this.sessionId, model: this.model,
          object: 'chat.completion.chunk', created: this.created,
          choices: [{ index: 0, delta: { reasoning_content: thinking }, finish_reason: null }],
        }) + '\n\n')
      }
      if (content) {
        const base = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
        const chunks = this.toolStreamParser?.push(content, base, !this.sentRole) ?? [{
          ...base, choices: [{ index: 0,
            delta: { ...(!this.sentRole ? { role: 'assistant' } : {}), content }, finish_reason: null }],
        }]
        for (const chunk of chunks) transStream.write('data: ' + JSON.stringify(chunk) + '\n\n')
        if (chunks.length) this.sentRole = true
      }
    }, () => {
      const base = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
      const chunks = this.toolStreamParser?.flush(base) ?? []
      const frames = chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n')
      frames.push('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {},
          finish_reason: this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop' }],
      }) + '\n\n')
      return () => {
        for (const frame of frames) transStream.write(frame)
        transStream.end('data: [DONE]\n\n')
      }
    }, () => {
      try {
        transStream.end('data: ' + JSON.stringify({
          error: { message: 'Qwen upstream stream did not complete', type: 'api_error' },
        }) + '\n\n')
      } catch {
        transStream.destroy()
      }
    })
    return transStream
  }

  async handleNonStream(stream: any, response?: AxiosResponse): Promise<any> {
    return new Promise((resolve, reject) => {
      this.consumeResponse(stream, response, () => {}, () => {
        const { content, toolCalls } =
          (this.toolCallingPlan?.toolChoiceMode === 'none' || this.toolCallingPlan?.shouldParseResponse)
          ? { content: this.content, toolCalls: [] }
          : parseToolCallsFromText(this.content, 'qwen')
        if (!content.trim() && toolCalls.length === 0) throw qwenDecodingFailure()
        const message: any = { role: 'assistant', content: toolCalls.length ? null : content.trim() }
        if (this.thinkingContent) message.reasoning_content = this.thinkingContent
        if (toolCalls.length) message.tool_calls = toolCalls
        const result = {
          id: this.sessionId, model: this.model, object: 'chat.completion', created: this.created,
          choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
        }
        return () => resolve(result)
      }, () => reject(qwenDecodingFailure()))
    })
  }

  getSessionId(): string {
    return this.sessionId
  }
}

export const qwenAdapter = {
  QwenAdapter,
  QwenStreamHandler,
}
