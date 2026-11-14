/**
 * DeepSeek Authentication Adapter
 * Authentication method: Login using default browser, manually extract token
 */

import axios from 'axios'
import { shell } from 'electron'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: DEEPSEEK_API_BASE,
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Referer: `${DEEPSEEK_API_BASE}/`,
  'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'X-App-Version': '20241129.1',
  'X-Client-Locale': 'zh-CN',
  'X-Client-Platform': 'web',
  'X-Client-Version': '1.6.1',
}

export class DeepSeekAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'deepseek',
      authMethods: ['manual'],
      loginUrl: DEEPSEEK_API_BASE,
      apiUrl: DEEPSEEK_API_BASE,
    })
  }

  /**
   * Start login flow - Open default browser
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')
    
    try {
      await shell.openExternal(DEEPSEEK_API_BASE)
      this.emitProgress('pending', 'Please log in via browser and enter Token manually')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'deepseek',
        error: 'Please log in via browser, extract Token from Developer Tools and enter manually',
      }
    } catch {
      console.error('[DeepSeek] Failed to open login browser')
      this.emitProgress('error', 'Failed to open DeepSeek login page')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'deepseek',
        error: 'Failed to open DeepSeek login page',
      }
    }
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'deepseek',
          error: validation.error || 'Token validation failed',
        }
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'deepseek',
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch {
      this.emitProgress('error', 'DeepSeek token validation failed')
      
      return {
        success: false,
        providerId,
        providerType: 'deepseek',
        error: 'DeepSeek token validation failed',
      }
    }
  }

  /**
   * Handle callback (DeepSeek does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // DeepSeek does not support OAuth callback
  }

  /**
   * Validate token validity
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials?.token || credentials?.userToken
    
    if (!token) {
      return {
        valid: false,
        error: 'Token cannot be empty',
      }
    }
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
      return { valid: false, error: 'DeepSeek token validation failed' }
    }
    
    try {
      const response = await axios.get(`${DEEPSEEK_API_BASE}/api/v0/users/current`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      })
      
      console.log('[DeepSeek OAuth] Validation response received')
      
      const envelope = response.data
      if (response.status !== 200 || !envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          (Object.prototype.hasOwnProperty.call(envelope, 'code') && envelope.code !== 0) ||
          (envelope.data && typeof envelope.data === 'object' &&
            Object.prototype.hasOwnProperty.call(envelope.data, 'biz_code') && envelope.data.biz_code !== 0)) {
        return {
          valid: false,
          error: 'DeepSeek token validation failed',
        }
      }
      
      // DeepSeek API returns: { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { ... } } }
      const bizData = envelope.data?.biz_data
      
      if (!bizData || typeof bizData !== 'object' || Array.isArray(bizData)) {
        return {
          valid: false,
          error: 'DeepSeek token validation failed',
        }
      }
      
      return {
        valid: true,
        tokenType: 'access',
        accountInfo: {
          userId: bizData.id,
          email: bizData.email,
          name: bizData.name,
        },
      }
    } catch {
      return {
        valid: false,
        error: 'DeepSeek token validation failed',
      }
    }
  }

  /**
   * Refresh token
   */
  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const token = credentials?.token || credentials?.refreshToken
    
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
      return null
    }
    
    try {
      const response = await axios.get(`${DEEPSEEK_API_BASE}/api/v0/users/current`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      })
      
      // Validation and completion use the nested data.biz_data envelope;
      // retain the old flat form for manually imported accounts. Reject
      // explicit error codes before exposing any returned bearer credential.
      const envelope = response.data
      if (response.status !== 200 || !envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          (Object.prototype.hasOwnProperty.call(envelope, 'code') && envelope.code !== 0) ||
          (envelope.data && typeof envelope.data === 'object' &&
            Object.prototype.hasOwnProperty.call(envelope.data, 'biz_code') && envelope.data.biz_code !== 0)) {
        return null
      }
      
      const newToken = envelope.data?.biz_data?.token ?? envelope.biz_data?.token
      if (typeof newToken !== 'string' || !/^[\x21-\x7e]+$/.test(newToken)) return null
      
      return {
        type: 'access',
        value: newToken,
        expiresAt: this.getTimestamp() + 3600,
      }
    } catch {
      return null
    }
  }
}

export default DeepSeekAdapter
