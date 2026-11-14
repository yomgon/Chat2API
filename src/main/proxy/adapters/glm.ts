/**
 * GLM Adapter
 * Implements GLM (Zhipu Qingyan) web API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import mime from 'mime-types'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createBaseChunk,
} from '../utils/streamToolHandler'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES = 3600
const FILE_MAX_SIZE = 100 * 1024 * 1024 // 100MB
// Local resource limits, not claims about an undocumented provider contract.
const ATTACHMENT_MAX_COUNT = 8
const ATTACHMENT_URL_MAX_LENGTH = 8192
const ATTACHMENT_DNS_TIMEOUT = 15000

type AttachmentKind = 'file' | 'image'
type AttachmentAddress = { address: string; family: 4 | 6 }
type AttachmentSource =
  | { kind: AttachmentKind; type: 'data'; encoded: string; mimeType: string; size: number }
  | { kind: AttachmentKind; type: 'https'; url: URL; hostname: string; literal?: AttachmentAddress }
type PreparedAttachment = { kind: AttachmentKind; data: Buffer; mimeType: string }

/** Only thrown by the complete, pure preflight before DNS or any transport. */
export class GLMAttachmentInputFailure extends Error {
  constructor() {
    super('GLM attachment input is invalid')
    this.name = 'GLMAttachmentInputFailure'
  }
}

/** Fixed private-free auth failure, with only a bounded observed HTTP status. */
export class GLMAuthPreflightFailure extends Error {
  readonly upstreamStatus?: number

  constructor(message: string, observedStatus?: unknown) {
    super(message)
    this.name = 'GLMAuthPreflightFailure'
    if (Number.isInteger(observedStatus) &&
        (observedStatus as number) >= 100 && (observedStatus as number) <= 599) {
      this.upstreamStatus = observedStatus as number
    }
  }
}

function attachmentFailure(): Error {
  return new Error('GLM attachment processing failed')
}

function isAttachmentMimeType(value: string): boolean {
  return value.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
}

/** Accept only global addresses; mapped, local and transition IPv6 are excluded. */
function publicAttachmentAddress(value: unknown): AttachmentAddress | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    const [a, b, c, d] = value.split('.').map(Number)
    if ([a, b, c, d].some(n => n > 255) || a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return undefined
    return { address: value, family: 4 }
  }
  if (!value.includes(':') || !/^[a-f0-9:.]+$/i.test(value)) return undefined
  try {
    const address = new URL(`https://[${value}]/`).hostname.slice(1, -1)
    const [first, second] = address.split(':').map(part => parseInt(part || '0', 16))
    if (first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3ffe || first === 0x3fff ||
        (first === 0x2001 && (second < 0x0200 || second === 0x0db8))) return undefined
    return { address, family: 6 }
  } catch { return undefined }
}

function parseAttachmentSource(kind: AttachmentKind, value: string): AttachmentSource {
  if (value.slice(0, 5).toLowerCase() === 'data:') {
    const comma = value.indexOf(',')
    if (comma < 0 || comma > 1024) throw attachmentFailure()
    const metadata = value.slice(5, comma).split(';')
    if (metadata.length < 2) throw attachmentFailure()
    const encoding = metadata.pop()?.toLowerCase()
    const mimeType = (metadata.shift() || 'application/octet-stream').toLowerCase()
    if (encoding !== 'base64' || !isAttachmentMimeType(mimeType) ||
        metadata.some(param => !/^[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+%-]+$/i.test(param))) {
      throw attachmentFailure()
    }
    const encoded = value.slice(comma + 1)
    if (!encoded.length || encoded.length > 4 * Math.ceil(FILE_MAX_SIZE / 3) ||
        encoded.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw attachmentFailure()
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const finalValue = alphabet.indexOf(encoded[encoded.length - padding - 1])
    if ((padding === 2 && (finalValue & 15) !== 0) || (padding === 1 && (finalValue & 3) !== 0)) {
      throw attachmentFailure()
    }
    const size = encoded.length / 4 * 3 - padding
    if (size < 1 || size > FILE_MAX_SIZE) throw attachmentFailure()
    return { kind, type: 'data', encoded, mimeType, size }
  }
  if (!value.length || value.length > ATTACHMENT_URL_MAX_LENGTH || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw attachmentFailure()
  }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port === '0') {
    throw attachmentFailure()
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const literal = publicAttachmentAddress(hostname)
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority || authority.includes('@')) throw attachmentFailure()
  const rawHost = authority?.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority?.split(':')[0]
  if (!rawHost) throw attachmentFailure()
  if (hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(hostname)) {
    if (!literal || (literal.family === 4 && rawHost !== hostname)) throw attachmentFailure()
  } else {
    const labels = hostname.split('.')
    const suffix = labels.at(-1) || ''
    if (rawHost.toLowerCase() !== hostname || hostname.length > 253 || labels.length < 2 ||
        !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(suffix) ||
        ['localhost', 'local', 'localdomain', 'lan', 'internal', 'intranet', 'corp', 'home',
          'private', 'arpa', 'onion', 'alt', 'test', 'invalid', 'example'].includes(suffix)) {
      throw attachmentFailure()
    }
  }
  return { kind, type: 'https', url, hostname, literal }
}

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface GLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: GLMMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  deep_research?: boolean
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

export class GLMAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getRefreshToken(): string {
    const credentials: unknown = this.account.credentials
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new Error('GLM credentials are invalid')
    }
    const values = credentials as Record<string, unknown>
    let selected: string | undefined
    // OAuth, browser capture and manual accounts use different refresh aliases.
    // A malformed or conflicting alias must never select a different identity.
    for (const field of ['refresh_token', 'chatglm_refresh_token', 'refreshToken', 'token']) {
      if (!Object.prototype.hasOwnProperty.call(values, field)) continue
      const value = values[field]
      if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value) ||
          (selected !== undefined && selected !== value)) {
        throw new Error('GLM credentials are invalid')
      }
      selected = value
    }
    if (selected === undefined) throw new Error('GLM credentials are invalid')
    return selected
  }

  private async acquireToken(): Promise<string> {
    const refreshToken = this.getRefreshToken()
    const cached = tokenCache.get(refreshToken)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken
    }

    const failure = (message: string, observedStatus?: unknown): GLMAuthPreflightFailure =>
      new GLMAuthPreflightFailure(message, observedStatus)

    console.log('[GLM] Refreshing Token...')
    const sign = generateSign()
    const response = await axios.post(
      `${GLM_API_BASE}/user-api/user/refresh`,
      {},
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Nonce': sign.nonce,
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    ).catch((error: unknown) => {
      const status = error && typeof error === 'object'
        ? (error as { response?: { status?: unknown } }).response?.status : undefined
      throw failure('GLM token refresh failed', status)
    })

    console.log('[GLM] Token response received')
    const { code, status } = response.data || {}
    const isSuccess = code === 0 || status === 0
    if (response.status !== 200 || !isSuccess) {
      throw failure('GLM token refresh failed', response.status)
    }

    const result = response.data?.result
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        typeof result.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(result.access_token) ||
        typeof result.refresh_token !== 'string' || !/^[\x21-\x7e]+$/.test(result.refresh_token)) {
      throw failure('GLM token refresh response is invalid', response.status)
    }
    const { access_token, refresh_token } = result
    const tokenInfo: TokenInfo = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES * 1000,
    }

    if (refresh_token !== refreshToken) {
      console.log('[GLM] Token updated, saving new token')
      try {
        // Refresh can rotate a stateful login. Never replace the complete
        // credentials object with one refresh_token: that discards the OAuth
        // refreshToken/accessToken pair and legacy browser aliases, breaking
        // later validation, manual reconnect and persisted account settings.
        // Also recheck the originally selected row after the awaited provider
        // effect: a concurrent login/edit must not be overwritten by a stale
        // rotation response. The check and store write are synchronous.
        const current = storeManager.getAccountById(this.account.id, true)
        const original = this.account
        const originalKeys = Object.keys(original.credentials || {})
        const currentKeys = Object.keys(current?.credentials || {})
        if (!current || current.providerId !== original.providerId ||
            current.id !== original.id ||
            current.createdAt !== original.createdAt ||
            current.updatedAt !== original.updatedAt ||
            current.status !== original.status ||
            originalKeys.length !== currentKeys.length ||
            originalKeys.some(key =>
              !Object.prototype.hasOwnProperty.call(current.credentials, key) ||
              current.credentials[key] !== original.credentials[key])) {
          throw new Error('GLM account changed during token rotation')
        }
        const rotatedCredentials: Record<string, string> = {
          ...current.credentials,
          refresh_token,
        }
        for (const alias of ['chatglm_refresh_token', 'refreshToken', 'token']) {
          if (Object.prototype.hasOwnProperty.call(rotatedCredentials, alias)) {
            rotatedCredentials[alias] = refresh_token
          }
        }
        for (const alias of ['accessToken', 'access_token']) {
          if (Object.prototype.hasOwnProperty.call(rotatedCredentials, alias)) {
            rotatedCredentials[alias] = access_token
          }
        }
        const updated = storeManager.updateAccount(this.account.id, {
          credentials: rotatedCredentials,
        })
        if (!updated || updated.id !== original.id ||
            updated.providerId !== original.providerId) {
          throw new Error('GLM credential persistence failed')
        }
      } catch {
        throw failure('GLM credential persistence failed', response.status)
      }
    }

    // Publish only validated credentials after any required durable update.
    // Existing selected snapshots and the newly stored refresh key share access.
    tokenCache.set(refreshToken, tokenInfo)
    if (refresh_token !== refreshToken) tokenCache.set(refresh_token, tokenInfo)
    console.log('[GLM] Token refresh successful')
    return access_token
  }

  /** Validate the entire request and prepare bounded bytes before provider auth. */
  private async prepareAttachments(messages: GLMMessage[]): Promise<PreparedAttachment[]> {
    let sources: AttachmentSource[]
    let remainingInline: number
    try {
      const { fileUrls, imageUrls } = this.extractFileUrls(messages)
      if (fileUrls.length + imageUrls.length > ATTACHMENT_MAX_COUNT) throw attachmentFailure()
      sources = [
        ...fileUrls.map(url => parseAttachmentSource('file', url)),
        ...imageUrls.map(url => parseAttachmentSource('image', url)),
      ]
      remainingInline = sources.reduce((sum, source) => sum + (source.type === 'data' ? source.size : 0), 0)
      if (remainingInline + sources.filter(source => source.type === 'https').length > FILE_MAX_SIZE) {
        throw attachmentFailure()
      }
    } catch { throw new GLMAttachmentInputFailure() }
    try {
      const pins = new Map<string, readonly AttachmentAddress[]>()
      for (const source of sources) {
        if (source.type !== 'https' || pins.has(source.hostname)) continue
        if (source.literal) {
          pins.set(source.hostname, Object.freeze([Object.freeze(source.literal)]))
          continue
        }
        // Lazy imports keep text-only/stream consumers free of attachment I/O.
        const { lookup } = await import('node:dns/promises')
        let timer: ReturnType<typeof setTimeout> | undefined
        let answers: import('node:dns').LookupAddress[]
        try {
          answers = await Promise.race([
            lookup(source.hostname, { all: true, verbatim: true }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(attachmentFailure()), ATTACHMENT_DNS_TIMEOUT) }),
          ])
        } finally { if (timer !== undefined) clearTimeout(timer) }
        if (!Array.isArray(answers) || answers.length < 1 || answers.length > 64) throw attachmentFailure()
        const verified = answers.map(answer => {
          const address = publicAttachmentAddress(answer?.address)
          if (!address || address.family !== answer.family) throw attachmentFailure()
          return Object.freeze(address)
        })
        pins.set(source.hostname, Object.freeze(verified))
      }
      const prepared: PreparedAttachment[] = []
      let used = 0
      for (const source of sources) {
        if (source.type === 'data') {
          remainingInline -= source.size
          const data = Buffer.from(source.encoded, 'base64')
          if (data.length !== source.size) throw attachmentFailure()
          used += data.length
          prepared.push({ kind: source.kind, data, mimeType: source.mimeType })
        } else {
          const limit = FILE_MAX_SIZE - used - remainingInline
          if (limit < 1) throw attachmentFailure()
          const file = await this.downloadAttachment(source, pins.get(source.hostname)!, limit)
          used += file.data.length
          prepared.push(file)
        }
      }
      return prepared
    } catch { throw attachmentFailure() }
  }

  private async downloadAttachment(
    source: Extract<AttachmentSource, { type: 'https' }>,
    addresses: readonly AttachmentAddress[],
    limit: number,
  ): Promise<PreparedAttachment> {
    const { Agent } = await import('node:https')
    // The socket's lookup can ONLY return the already verified addresses. It
    // cannot perform a second DNS lookup or follow a changed private answer.
    const lookup: import('node:net').LookupFunction = (hostname, options, callback) => {
      const expectedHost = hostname.replace(/^\[|\]$/g, '').toLowerCase()
      const family = typeof options === 'number' ? options : options?.family || 0
      const all = typeof options === 'object' && (options as { all?: boolean }).all === true
      const selected = addresses.filter(address => !family || address.family === family)
      queueMicrotask(() => {
        if (expectedHost !== source.hostname || !selected.length ||
            selected.some(address => !publicAttachmentAddress(address.address))) {
          callback(attachmentFailure(), '', 0)
        } else if (all) {
          const allCallback = callback as unknown as (error: Error | null, records: AttachmentAddress[]) => void
          allCallback(null, selected.map(address => ({ ...address })))
        } else {
          callback(null, selected[0].address, selected[0].family)
        }
      })
    }
    const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0,
      rejectUnauthorized: true, lookup })
    try {
      const response = await axios.get(source.url.href, {
        responseType: 'arraybuffer',
        maxContentLength: limit,
        timeout: 60000,
        httpsAgent: agent,
        proxy: false,
        maxRedirects: 0,
        // Axios treats false as a disabled header even when defaults contain it.
        headers: { Authorization: false, Cookie: false, 'Proxy-Authorization': false },
        validateStatus: status => status === 200,
      })
      if (response.status !== 200 || !Buffer.isBuffer(response.data) ||
          response.data.length < 1 || response.data.length > limit) throw attachmentFailure()
      const length = response.headers?.['content-length']
      if (length !== undefined && ((typeof length !== 'string' && typeof length !== 'number') ||
          !/^\d+$/.test(String(length)) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
        throw attachmentFailure()
      }
      const contentType = response.headers?.['content-type']
      if (contentType !== undefined && (typeof contentType !== 'string' || contentType.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(contentType))) throw attachmentFailure()
      const mimeType = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase()
        : mime.lookup(source.url.pathname) || 'application/octet-stream'
      if (!isAttachmentMimeType(mimeType)) throw attachmentFailure()
      return { kind: source.kind, data: response.data, mimeType }
    } catch { throw attachmentFailure() }
    finally { agent.destroy() }
  }

  private async uploadFile(file: PreparedAttachment, token: string): Promise<{ source_id: string; file_url?: string }> {
    try {
      console.log('[GLM] Uploading file')
      const extension = mime.extension(file.mimeType) || 'bin'
      const filename = `${uuid()}.${/^[a-z0-9]{1,16}$/i.test(extension) ? extension : 'bin'}`
      const formData = new FormData()
      formData.append('file', file.data, { filename, contentType: file.mimeType })
      const response = await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/file_upload`, formData,
        {
          headers: {
            Authorization: `Bearer ${token}`, Referer: 'https://chatglm.cn/',
            ...FAKE_HEADERS, ...formData.getHeaders(),
          },
          maxBodyLength: FILE_MAX_SIZE + 16384, // bounded multipart overhead
          timeout: 60000, maxRedirects: 0, validateStatus: () => true,
        }
      )
      const result = response.data?.result
      if (response.status !== 200 || !result || typeof result !== 'object' || Array.isArray(result) ||
          typeof result.source_id !== 'string' || !result.source_id.trim() || result.source_id.length > 512 ||
          /[\u0000-\u001f\u007f]/.test(result.source_id) ||
          (result.file_url !== undefined && (typeof result.file_url !== 'string' || !result.file_url.trim() ||
            result.file_url.length > ATTACHMENT_URL_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(result.file_url)))) {
        throw attachmentFailure()
      }
      console.log('[GLM] File uploaded successfully')
      return { source_id: result.source_id, ...(result.file_url !== undefined ? { file_url: result.file_url } : {}) }
    } catch { throw attachmentFailure() }
  }

  /**
   * Extract file URLs from message content
   */
  private extractFileUrls(messages: GLMMessage[]): { fileUrls: string[]; imageUrls: string[] } {
    const fileUrls: string[] = []
    const imageUrls: string[] = []

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') throw attachmentFailure()
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== 'object' || Array.isArray(part)) throw attachmentFailure()
          if (part.type === 'image_url' || part.type === 'file') {
            const value = part.type === 'image_url' ? part.image_url?.url : part.file_url?.url
            if (typeof value !== 'string' || !value.length) throw attachmentFailure()
            if (part.type === 'image_url') imageUrls.push(value)
            else fileUrls.push(value)
            if (fileUrls.length + imageUrls.length > ATTACHMENT_MAX_COUNT) throw attachmentFailure()
          }
        }
      }
    }

    return { fileUrls, imageUrls }
  }

  private messagesToPrompt(messages: GLMMessage[], refs: any[] = [], toolsPrompt?: string, isMultiTurn: boolean = false): { role: string; content: any[] }[] {
    const toolProfile = getProviderToolProfile('glm')
    // Separate image refs and file refs
    const imageRefs = refs.filter((ref) => ref.width !== undefined || ref.height !== undefined || ref.image_url)
    const fileRefs = refs.filter((ref) => ref.width === undefined && ref.height === undefined && !ref.image_url)

    // Build content array
    const content: any[] = []

    // Add file references first
    if (fileRefs.length > 0) {
      content.push({
        type: 'file',
        file: fileRefs.map((ref) => ({
          source_id: ref.source_id,
          file_url: ref.file_url,
        })),
      })
    }

    // Add image references
    for (const imageRef of imageRefs) {
      content.push({
        type: 'image_url',
        image_url: {
          url: imageRef.image_url || imageRef.source_id,
        },
      })
    }

    // Process messages including tool calls and tool responses
    const processedMessages = messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const callsText = toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })))
        const precedingText = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((part: any) => part.type === 'text')
              .map((part: any) => part.text).join('')
            : ''
        return {
          ...msg,
          // Keep the assistant's actual text before the serialized tool call;
          // the next tool-result turn depends on both pieces of history.
          content: precedingText ? precedingText + '\n' + callsText : callsText,
        }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        let toolResultText: string
        if (typeof msg.content === 'string') {
          toolResultText = msg.content
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          toolResultText = msg.content.map((part: unknown) => {
            if (!part || typeof part !== 'object' || Array.isArray(part)) {
              throw new Error('GLM tool result content is not supported')
            }
            const item = part as { type?: unknown, text?: unknown }
            if (item.type !== 'text' || typeof item.text !== 'string' ||
                Object.keys(item).some(key => key !== 'type' && key !== 'text')) {
              throw new Error('GLM tool result content is not supported')
            }
            return item.text
          }).join('')
        } else {
          throw new Error('GLM tool result content is not supported')
        }
        return { 
          ...msg, 
          role: 'user' as const,
          content: toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: toolResultText,
          }),
        }
      }
      return msg
    })

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
        let textContent = ''
        if (typeof lastUserMsg.content === 'string') {
          textContent = lastUserMsg.content
        } else if (Array.isArray(lastUserMsg.content)) {
          textContent = lastUserMsg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        }
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'user') {
            const toolText = typeof processedMessages[i].content === 'string' 
              ? processedMessages[i].content 
              : ''
            textContent += '\n' + toolText
          }
        }
        
        if (toolsPrompt) {
          textContent = textContent.trim() + "\n\n" + toolsPrompt
        }
        
        content.push({ type: 'text', text: textContent })
        return [{ role: 'user', content }]
      }
    }

    // Extract text from messages
    if (processedMessages.length < 2) {
      let textContent = processedMessages.reduce((acc, msg) => {
        if (typeof msg.content === 'string') {
          return acc + msg.content + '\n'
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((c) => c.type === 'text').map((c) => c.text)
          return acc + textParts.join('') + '\n'
        }
        return acc
      }, '')

      // Inject tools prompt at the VERY END
      if (toolsPrompt) {
        textContent = textContent.trim() + "\n\n" + toolsPrompt
      }

      content.push({ type: 'text', text: textContent })
      return [{ role: 'user', content }]
    }

    let textContent = processedMessages.reduce((acc, msg) => {
      const role = msg.role
        .replace('system', 'System')
        .replace('assistant', 'Assistant')
        .replace('user', 'User')
        .replace('tool', 'User')
      if (typeof msg.content === 'string') {
        return acc + `${role}: ${msg.content}\n\n`
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        return acc + `${role}: ${text}\n\n`
      }
      return acc
    }, '')

    // Inject tools prompt at the VERY END
    if (toolsPrompt) {
      textContent = textContent.trim() + "\n\n" + toolsPrompt
    }

    content.push({ type: 'text', text: textContent + 'Assistant: ' })
    return [{ role: 'user', content }]
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    // Clone messages to avoid modifying original request
    const messages = [...request.messages]
    const attachments = await this.prepareAttachments(messages)
    const token = await this.acquireToken()
    const sign = generateSign()

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    // Inject tools definition into prompt if tools are provided and not already injected
    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      const glmStrictHint = `

GLM STRICT RULES:
- If user asks to create/modify code or files, you MUST call tools instead of replying with plain text.
- You MUST output ONLY one [function_calls] block when calling tools.
- Use exact tool names from list, case-sensitive, do not rename.`
      toolsPrompt = toolsToSystemPrompt(request.tools) + glmStrictHint

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

    // All sources and bytes were verified before authentication. Upload failure
    // aborts this request; it must never silently produce an answer without files.
    const refs: any[] = []
    for (const attachment of attachments) {
      const result = await this.uploadFile(attachment, token)
      refs.push(attachment.kind === 'file'
        ? { source_id: result.source_id, file_url: result.file_url }
        : { source_id: result.source_id, image_url: result.file_url, width: 0, height: 0 })
    }

    const preparedMessages = this.messagesToPrompt(messages, refs, toolsPrompt, false)

    let assistantId = DEFAULT_ASSISTANT_ID
    let chatMode = ''
    let isNetworking = false

    // Use request parameters for mode control (OpenAI compatible)
    if (request.reasoning_effort) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode')
    }
    
    if (request.web_search) {
      isNetworking = true
      console.log('[GLM] Web search enabled')
    }
    
    if (request.deep_research) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode')
    }

    // Fallback: check model name for backward compatibility
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    if (!chatMode && request.reasoning_effort === undefined && (modelLower.includes('think') || modelLower.includes('zero'))) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode (from model name)')
    }
    if (!chatMode && request.deep_research === undefined && modelLower.includes('deepresearch')) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode (from model name)')
    }
    
    // Check if model is an assistant ID (24+ alphanumeric characters)
    if (/^[a-z0-9]{24,}$/.test(request.model)) {
      assistantId = request.model
    }

    console.log('[GLM] Sending chat request...')
    
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/stream`,
      {
        assistant_id: assistantId,
        conversation_id: '',
        project_id: '',
        chat_type: 'user_chat',
        messages: preparedMessages,
        meta_data: {
          channel: '',
          chat_mode: chatMode || undefined,
          draft_id: '',
          if_plus_model: true,
          input_question_type: 'xxxx',
          is_networking: isNetworking,
          is_test: false,
          platform: 'pc',
          quote_log_id: '',
          cogview: {
            rm_label_watermark: false,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
        },
        timeout: 120000,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    return { response, conversationId: '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const sign = generateSign()
      await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: conversationId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
      console.log('[GLM] Conversation deleted')
      return true
    } catch (error) {
      console.error('[GLM] Failed to delete conversation')
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()

      // Step 1: Get all conversations (handle pagination)
      const allConversationIds: string[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const sign = generateSign()
        const listResponse = await axios.post(
          `${GLM_API_BASE}/mainchat-api/conversation/recent_list`,
          { page, page_size: 100 },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Referer: 'https://chatglm.cn/main/alltoolsdetail',
              'X-Device-Id': uuid(),
              'X-Request-Id': uuid(),
              'X-Sign': sign.sign,
              'X-Timestamp': sign.timestamp,
              'X-Nonce': sign.nonce,
              ...FAKE_HEADERS,
            },
            timeout: 30000,
            maxRedirects: 0,
            validateStatus: () => true,
          }
        )

        console.log('[GLM] Conversation list page received')

        const { status, result } = listResponse.data || {}
        if (listResponse.status !== 200 || status !== 0) {
          console.error('[GLM] Failed to get conversation list')
          return false
        }

        const conversationList = result?.conversation_list || []
        for (const c of conversationList) {
          allConversationIds.push(c.conversation_id)
        }

        hasMore = result?.has_more || false
        page++

        if (conversationList.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[GLM] No conversations to delete')
        return true
      }

      console.log('[GLM] Conversations found for deletion')

      // Step 2: Bulk delete conversations
      const sign = generateSign()
      const deleteResponse = await axios.post(
        `${GLM_API_BASE}/mainchat-api/conversation/bulk_delete`,
        { conversation_ids: allConversationIds },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 60000,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      console.log('[GLM] Bulk delete response')

      const deleteResult = deleteResponse.data || {}
      const success = deleteResponse.status === 200 && deleteResult.status === 0
      if (success) {
        console.log('[GLM] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[GLM] Failed to delete all chats')
      return false
    }
  }

  static isGLMProvider(provider: Provider): boolean {
    if (provider.id === 'glm') return true
    // Only the actual first-party chat origin may act as an alias. A URL path
    // or unrelated hostname containing chatglm.cn is a generic provider.
    try {
      const url = new URL(provider.apiEndpoint)
      return url.origin === 'https://chatglm.cn' &&
        !url.username && !url.password
    } catch {
      return false
    }
  }
}

function hasValidGLMTextContent(part: any): boolean {
  return !Array.isArray(part?.content) ||
    part.content.every((item: any) =>
      item?.type !== 'text' || typeof item.text === 'string')
}

export class GLMStreamHandler {
  private conversationId: string = ''
  private model: string
  private created: number
  private onEnd?: () => void
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan

  constructor(model: string, onEnd?: () => void, initialConversationId?: string, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    if (initialConversationId) {
      this.conversationId = initialConversationId
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const cachedParts: any[] = []
    let sentContent = ''
    let sentReasoning = ''
    let sentRole = false
    let sawFinish = false
    let failed = false
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pendingWire = ''
    let completed = false
    const releaseRaw = () => {
      // A rejected or client-aborted converted stream must release the
      // original HTTP response. No remote retry or delete is attempted.
      try { if (typeof stream?.destroy === 'function' && !stream.destroyed) stream.destroy() } catch { /* local only */ }
    }
    const fail = () => {
      if (failed || completed) return
      failed = true
      releaseRaw()
      transStream.end('data: {"error":{"code":"glm_response_incomplete","type":"api_error"}}\n\n')
    }

    transStream.once('close', () => {
      if (!completed && !failed) {
        failed = true
        releaseRaw()
      }
    })
    const finalize = () => {
      if (failed || transStream.destroyed || transStream.writableEnded) return
      if (!sawFinish) {
        fail()
        return
      }
      const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      if (!sentContent.trim() && !this.toolStreamParser?.hasEmittedToolCall()) {
        fail()
        return
      }
      for (const outChunk of flushChunks) {
        transStream.write('data: ' + JSON.stringify(outChunk) + '\n\n')
      }
      const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
      transStream.write('data: ' + JSON.stringify({
        id: this.conversationId, model: this.model, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        created: this.created,
      }) + '\n\n')
      transStream.end('data: [DONE]\n\n')
      completed = true
      this.onEnd?.()
    }

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          if (failed) return
          if (event.event === 'error') { fail(); return }
          if (sawFinish) {
            if (event.data === '[DONE]') return
            fail()
            return
          }
          const result = JSON.parse(event.data)
          if (!result || typeof result !== 'object' || Array.isArray(result) ||
              result.error !== undefined || result.last_error !== undefined ||
              ['intervene', 'error', 'failed'].includes(result.status)) {
            fail()
            return
          }

          if (!this.conversationId && result.conversation_id) {
            this.conversationId = result.conversation_id
          }

          if (result.status !== 'finish') {
            if (result.parts) {
              result.parts.forEach((part: any) => {
                if (!hasValidGLMTextContent(part)) throw new Error('GLM text part is invalid')
                const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                if (index !== -1) {
                  cachedParts[index] = part
                } else {
                  cachedParts.push(part)
                }
              })
            }

            const searchMap = new Map<string, any>()
            cachedParts.forEach((part) => {
              if (!part.content || !Array.isArray(part.content)) return
              const { meta_data } = part
              part.content.forEach((item: any) => {
                if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => {
                    if (res.match_key) {
                      searchMap.set(res.match_key, res)
                    }
                  })
                }
              })
            })

            const keyToIdMap = new Map<string, number>()
            let counter = 1
            let fullText = ''
            let fullReasoning = ''

            cachedParts.forEach((part) => {
              const { content, meta_data } = part
              if (!Array.isArray(content)) return

              let partText = ''
              let partReasoning = ''

              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value

                if (type === 'text') {
                  let txt = text
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key)
                      if (!searchInfo) return match
                      if (!keyToIdMap.has(key)) {
                        keyToIdMap.set(key, counter++)
                      }
                      return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                    })
                  }
                  partText += txt
                } else if (type === 'think') {
                  partReasoning += think
                } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                  const imageText =
                    image.reduce((imgs: string, v: any) => {
                      return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                    }, '') + '\n'
                  partText += imageText
                } else if (type === 'code') {
                  partText += '```python\n' + code + (part.status === 'finish' ? '\n```\n' : '')
                } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                  partText += innerContent + '\n'
                }
              })

              if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
            })

            const reasoningChunk = fullReasoning.substring(sentReasoning.length)
            if (reasoningChunk) {
              sentReasoning += reasoningChunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
            }

            const chunk = fullText.substring(sentContent.length)
            if (chunk) {
              sentContent += chunk
            }
            
            // Process tool call interception with shared parser buffering.
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !sentRole) ?? (
              chunk ? [{
                ...baseChunk,
                choices: [{ index: 0, delta: { ...(!sentRole ? { role: 'assistant' } : {}), content: chunk }, finish_reason: null }],
              }] : []
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) sentRole = true
          } else {
            sawFinish = true
            return
          }
        } catch (err) {
          console.error('[GLM] Stream parse error')
          fail()
        }
      },
    })

    const feed = (text: string) => {
      pendingWire += text
      while (!failed) {
        const delimiter = /\r?\n\r?\n/.exec(pendingWire)
        if (!delimiter) break
        if (delimiter.index > 1_048_576) { fail(); return }
        pendingWire = pendingWire.slice(delimiter.index + delimiter[0].length)
      }
      if (pendingWire.length > 1_048_576) { fail(); return }
      if (!failed) parser.feed(text)
    }
    stream.on('data', (buffer: Buffer) => {
      if (failed) return
      try { feed(decoder.decode(buffer, { stream: true })) } catch { fail() }
    })
    stream.once('end', () => {
      if (failed) return
      try {
        const remaining = decoder.decode()
        if (remaining) feed(remaining)
        if (pendingWire.trim()) { fail(); return }
        finalize()
      } catch { fail() }
    })
    stream.once('error', () => {
      console.error('[GLM] Stream error')
      fail()
    })
    stream.once('close', () => {
      if (!stream.readableEnded) fail()
    })
    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const cachedParts: any[] = []
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let pendingWire = ''
      let sawFinish = false
      let failed = false
      let pendingResult: unknown
      const fail = () => {
        if (failed) return
        failed = true
        reject(new Error('GLM response decoding failed'))
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            if (failed) return
            if (event.event === 'error') { fail(); return }
            if (sawFinish) {
              if (event.data === '[DONE]') return
              fail()
              return
            }
            const result = JSON.parse(event.data)
            if (!result || typeof result !== 'object' || Array.isArray(result) ||
                result.error !== undefined || result.last_error !== undefined ||
                ['intervene', 'error', 'failed'].includes(result.status)) {
              fail()
              return
            }

            if (!this.conversationId && result.conversation_id) {
              this.conversationId = result.conversation_id
            }

            if (result.status !== 'finish') {
              if (result.parts) {
                // Accumulate parts (same as handleStream), don't replace
                // GLM sends incremental parts, each event only contains new content
                result.parts.forEach((part: any) => {
                  if (!hasValidGLMTextContent(part)) throw new Error('GLM text part is invalid')
                  const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                  if (index !== -1) {
                    cachedParts[index] = part
                  } else {
                    cachedParts.push(part)
                  }
                })
              }
            } else {
              const searchMap = new Map<string, any>()
              cachedParts.forEach((part) => {
                if (!part.content || !Array.isArray(part.content)) return
                const { meta_data } = part
                part.content.forEach((item: any) => {
                  if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                    meta_data.tool_result_extra.search_results.forEach((res: any) => {
                      if (res.match_key) {
                        searchMap.set(res.match_key, res)
                      }
                    })
                  }
                })
              })

              const keyToIdMap = new Map<string, number>()
              let counter = 1
              let fullText = ''
              let fullReasoning = ''

              cachedParts.forEach((part) => {
                const { content, meta_data } = part
                if (!Array.isArray(content)) return

                let partText = ''
                let partReasoning = ''

                content.forEach((value: any) => {
                  const { type, text, think, image, code, content: innerContent } = value

                  if (type === 'text') {
                    let txt = text
                    if (searchMap.size > 0) {
                      txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                        const searchInfo = searchMap.get(key)
                        if (!searchInfo) return match
                        if (!keyToIdMap.has(key)) {
                          keyToIdMap.set(key, counter++)
                        }
                        return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                      })
                    }
                    partText += txt
                  } else if (type === 'think') {
                    partReasoning += think
                  } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                    const imageText =
                      image.reduce((imgs: string, v: any) => {
                        return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                      }, '') + '\n'
                    partText += imageText
                  } else if (type === 'code') {
                    partText += '```python\n' + code + '\n```\n'
                  } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                    partText += innerContent + '\n'
                  }
                })

                if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
                if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
              })

              const { content: cleanContent, toolCalls } =
                (this.toolCallingPlan?.mode === 'disabled' || this.toolCallingPlan?.toolChoiceMode === 'none' || this.toolCallingPlan?.shouldParseResponse)
                ? { content: fullText, toolCalls: [] }
                : parseToolCallsFromText(fullText, 'glm')

              pendingResult = {
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: toolCalls.length > 0 ? null : cleanContent.trim(),
                      reasoning_content: fullReasoning || null,
                      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    },
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  },
                ],
                created: Math.floor(Date.now() / 1000),
              }
              sawFinish = true
            }
          } catch (err) {
            fail()
          }
        },
      })

      const feed = (text: string) => {
        pendingWire += text
        while (!failed) {
          const delimiter = /\r?\n\r?\n/.exec(pendingWire)
          if (!delimiter) break
          if (delimiter.index > 1_048_576) { fail(); return }
          pendingWire = pendingWire.slice(delimiter.index + delimiter[0].length)
        }
        if (pendingWire.length > 1_048_576) { fail(); return }
        if (!failed) parser.feed(text)
      }
      stream.on('data', (buffer: Buffer) => {
        if (failed) return
        try { feed(decoder.decode(buffer, { stream: true })) } catch { fail() }
      })
      stream.once('end', () => {
        if (failed) return
        try {
          const remaining = decoder.decode()
          if (remaining) feed(remaining)
          if (failed) return
          if (pendingWire.trim() || !sawFinish || !pendingResult) {
            fail()
            return
          }
          resolve(pendingResult)
        } catch { fail() }
      })
      stream.once('error', fail)
      stream.once('close', () => {
        if (!stream.readableEnded) fail()
      })
    })
  }

  getConversationId(): string {
    return this.conversationId
  }
}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}
