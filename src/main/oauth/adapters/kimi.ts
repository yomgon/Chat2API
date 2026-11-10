/**
 * Kimi Authentication Adapter
 * Login using default browser, manually extract token
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

const KIMI_API_BASE = 'https://www.kimi.com'
const KIMI_VALIDATION_ERROR = 'Kimi token validation failed'

function validKimiToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    !/[\s\u0000-\u001f\u007f-\u009f]/.test(value)
}

function selectKimiCredential(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null
  const values = credentials as Record<string, unknown>
  // Align these known fields with the proxy's selected-account preference;
  // retain legacy OAuth aliases only if no canonical field is configured.
  for (const field of ['token', 'refreshToken', 'accessToken', 'access_token', 'apiKey', 'api_key']) {
    const value = values[field]
    if (value === undefined || value === '') continue
    return validKimiToken(value) ? value : null
  }
  return null
}

function hasKimiSubscription(response: unknown): response is {
  subscription: { userId?: string; userName?: string }
} {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false
  const data = response as Record<string, unknown>
  if (data.error !== undefined || !data.subscription || typeof data.subscription !== 'object' ||
      Array.isArray(data.subscription)) return false
  const sub = data.subscription as Record<string, unknown>
  return (sub.userId === undefined || typeof sub.userId === 'string') &&
    (sub.userName === undefined || typeof sub.userName === 'string')
}

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: KIMI_API_BASE,
  'R-Timezone': 'Asia/Shanghai',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
  'X-Msh-Platform': 'web',
}

export class KimiAdapter extends BaseOAuthAdapter {
  private deviceId: string
  private sessionId: string

  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'kimi',
      authMethods: ['manual'],
      loginUrl: KIMI_API_BASE,
      apiUrl: KIMI_API_BASE,
    })
    this.deviceId = this.generateDeviceId()
    this.sessionId = this.generateSessionId()
  }

  /**
   * Generate device ID
   */
  private generateDeviceId(): string {
    return `${Math.floor(Math.random() * 999999999999999999) + 7000000000000000000}`
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return `${Math.floor(Math.random() * 99999999999999999) + 1700000000000000000}`
  }

  /**
   * Detect token type
   * Reference: detectTokenType function from Kimi-Free-API
   */
  detectTokenType(token: string): 'jwt' | 'refresh' {
    if (token.startsWith('eyJ') && token.split('.').length === 3) {
      try {
        const payload = this.parseJWT(token)
        if (payload && payload.app_id === 'kimi' && payload.typ === 'access') {
          return 'jwt'
        }
      } catch {
        // Parse failed, treat as refresh token
      }
    }
    return 'refresh'
  }

  /**
   * Extract device ID from JWT token
   */
  private extractDeviceIdFromJWT(token: string): string | undefined {
    const payload = this.parseJWT(token)
    return payload?.device_id as string | undefined
  }

  /**
   * Extract session ID from JWT token
   */
  private extractSessionIdFromJWT(token: string): string | undefined {
    const payload = this.parseJWT(token)
    return payload?.ssid as string | undefined
  }

  /**
   * Extract user ID from JWT token
   */
  private extractUserIdFromJWT(token: string): string | undefined {
    const payload = this.parseJWT(token)
    return payload?.sub as string | undefined
  }

  /**
   * Get request headers
   */
  private getHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...FAKE_HEADERS,
      'X-Msh-Device-Id': this.deviceId,
      'X-Msh-Session-Id': this.sessionId,
      'Connect-Protocol-Version': '1',
    }
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
    return headers
  }

  
  private async callGrpcApi(token: string, service: string, body: object): Promise<any> {
    const response = await axios.post(
      `${KIMI_API_BASE}${service}`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      }
    )
    
    if (response.status !== 200) {
      return null
    }
    
    return response.data
  }

  /**
   * Start login flow - Open default browser
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')
    
    try {
      await shell.openExternal(KIMI_API_BASE)
      this.emitProgress('pending', 'Please log in via browser and enter Token manually')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'kimi',
        error: 'Please log in via browser, extract Token from Developer Tools and enter manually',
      }
    } catch {
      const errorMessage = 'Failed to open Kimi login page'
      this.emitProgress('error', errorMessage)
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'kimi',
        error: errorMessage,
      }
    }
  }

  /**
   * Complete authentication with token
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')

    if (!validKimiToken(token)) {
      this.emitProgress('error', KIMI_VALIDATION_ERROR)
      return { success: false, providerId, providerType: 'kimi', error: KIMI_VALIDATION_ERROR }
    }
    
    const tokenType = this.detectTokenType(token)
    this.emitProgress('pending', `Detected token type: ${tokenType === 'jwt' ? 'JWT Access Token' : 'Unknown Token'}`)
    
    try {
      const credentials: Record<string, string> = { accessToken: token }
      let accountInfo: Record<string, string> = {}
      
      if (tokenType === 'jwt') {
        const userId = this.extractUserIdFromJWT(token)
        const deviceId = this.extractDeviceIdFromJWT(token)
        
        if (deviceId) {
          this.deviceId = deviceId
        }
        
        accountInfo = { userId: userId || '' }
      }
      
      const userResponse = await this.callGrpcApi(token, '/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription', {})
      
      if (!hasKimiSubscription(userResponse)) {
        return {
          success: false,
          providerId,
          providerType: 'kimi',
          error: 'Token is invalid or expired',
        }
      }
      
      accountInfo = {
        ...accountInfo,
        userId: userResponse.subscription?.userId || '',
        name: userResponse.subscription?.userName || '',
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'kimi',
        credentials,
        accountInfo,
      }
    } catch {
      const errorMessage = KIMI_VALIDATION_ERROR
      this.emitProgress('error', errorMessage)
      
      return {
        success: false,
        providerId,
        providerType: 'kimi',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (Kimi does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Kimi does not support OAuth callback
  }

  /**
   * Validate token validity using gRPC API
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const accessToken = selectKimiCredential(credentials)
    
    if (!accessToken) {
      return {
        valid: false,
        error: 'Token cannot be empty',
      }
    }
    
    const tokenType = this.detectTokenType(accessToken)
    
    try {
      const result = await this.callGrpcApi(accessToken, '/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription', {})
      
      if (!hasKimiSubscription(result)) {
        return {
          valid: false,
          error: 'Token is invalid or expired',
        }
      }
      
      return {
        valid: true,
        tokenType,
        accountInfo: {
          userId: result.subscription?.userId || '',
          name: result.subscription?.userName || '',
        },
      }
    } catch {
      return { valid: false, error: KIMI_VALIDATION_ERROR }
    }
  }

  /**
   * Refresh token - Kimi no longer supports refresh token API
   */
  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    return null
  }

  /**
   * Get research version usage
   */
  async getResearchUsage(token: string): Promise<{ remain: number; total: number; used: number } | null> {
    try {
      const response = await axios.get(`${KIMI_API_BASE}/api/chat/research/usage`, {
        headers: this.getHeaders(token),
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
      })
      
      if (response.status !== 200 || !response.data) {
        return null
      }
      
      return response.data
    } catch {
      return null
    }
  }
}

export default KimiAdapter
