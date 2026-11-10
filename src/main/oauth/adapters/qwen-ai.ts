/**
 * Qwen AI (International) Authentication Adapter
 * Implements chat.qwen.ai API authentication
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const QWEN_AI_API_BASE = 'https://chat.qwen.ai'
const QWEN_AI_AUTH_FAILURE = 'Qwen AI session verification failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isGuestEmail(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().endsWith('@guest.com')
}

function hasValidTokenTimes(payload: Record<string, unknown>): boolean {
  const now = Date.now() / 1000
  if (!Number.isFinite(now)) return false
  for (const key of ['exp', 'nbf'] as const) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const value = payload[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        (key === 'exp' ? value <= now : value > now)) return false
  }
  return true
}

function isUserInfo(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0 || value.error != null) return false
  // Existing successful profiles may omit is_guest. A present value must be
  // explicitly false; do not invent a required server-side identity field.
  if (Object.prototype.hasOwnProperty.call(value, 'is_guest') && value.is_guest !== false) return false
  return !isGuestEmail(value.email)
}

const FAKE_HEADERS = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Origin: QWEN_AI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  source: 'web',
}

export class QwenAiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'qwen-ai',
      authMethods: ['manual'],
      loginUrl: QWEN_AI_API_BASE,
      apiUrl: QWEN_AI_API_BASE,
    })
  }

  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (validation?.valid !== true) {
        return {
          success: false,
          providerId,
          providerType: 'qwen-ai',
          error: QWEN_AI_AUTH_FAILURE,
        }
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'qwen-ai',
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch {
      return {
        success: false,
        providerId,
        providerType: 'qwen-ai',
        error: QWEN_AI_AUTH_FAILURE,
      }
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Qwen AI does not support OAuth callback
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const invalid = (): TokenValidationResult => ({ valid: false, error: QWEN_AI_AUTH_FAILURE })
    try {
      const token = credentials?.token
      if (typeof token !== 'string' || token.length > 8192 || !token.startsWith('eyJ')) return invalid()
      const parts = token.split('.')
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return invalid()
      const header: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
      const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (!isRecord(header) || typeof header.alg !== 'string' || !header.alg ||
          header.alg.trim() !== header.alg || header.alg.toLowerCase() === 'none' ||
          !isRecord(payload) || !hasValidTokenTimes(payload) || isGuestEmail(payload.email)) return invalid()

      const userId = payload.sub ?? payload.id ?? payload.user_id ?? payload.uid
      if (typeof userId !== 'string' || !userId.trim()) return invalid()

      // Decoding metadata does not authenticate a JWT. Only the fixed official
      // lookup may confirm this token; missing time claims never supply proof.
      const userInfo = await this.getUserInfo(token)
      if (!isUserInfo(userInfo) || !hasValidTokenTimes(payload)) return invalid()

      const email = typeof payload.email === 'string' ? payload.email : ''
      const name = typeof payload.name === 'string' ? payload.name : ''
      return {
        valid: true,
        tokenType: 'access',
        accountInfo: {
          userId,
          email: email || (typeof userInfo.email === 'string' ? userInfo.email : ''),
          name: name || (typeof userInfo.name === 'string' ? userInfo.name : '') || email || userId,
        },
      }
    } catch {
      // Provider exceptions and malformed JWT parser messages can contain secrets.
      return invalid()
    }
  }

  async getUserInfo(token: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await axios.get(`${QWEN_AI_API_BASE}/api/v2/user/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
        responseType: 'json',
        validateStatus: () => true,
      })

      const body: unknown = response.data
      if (response.status !== 200 || !isRecord(body) || body.success !== true ||
          body.error != null || !isUserInfo(body.data)) {
        return null
      }

      return body.data
    } catch {
      return null
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    return null
  }
}

export default QwenAiAdapter
