/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import { BaseOAuthAdapter } from './base'
import { readZaiSessionClaims } from '../zaiSession'
import {
  OAuthResult,
  TokenValidationResult,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const ZAI_API_BASE = 'https://chat.z.ai'

export class ZaiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'zai',
      authMethods: ['manual'],
      loginUrl: ZAI_API_BASE,
      apiUrl: ZAI_API_BASE,
    })
  }

  /**
   * Check a manually entered token locally. This does not authenticate it
   * against the server; account reconnect performs the first-party identity GET.
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Checking local session metadata...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'zai',
          error: validation.error || 'Token validation failed',
        }
      }
      
      this.emitProgress('success', 'Local session metadata accepted')
      
      return {
        success: true,
        providerId,
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch {
      return {
        success: false,
        providerId,
        providerType: 'zai',
        error: 'Z.ai session validation failed',
      }
    }
  }

  /**
   * Handle callback (Z.ai does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Z.ai does not support OAuth callback
  }

  /**
   * Check local session metadata, not the JWT signature or server authentication.
   * Account reconnection also requires the authenticated first-party identity GET.
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const claims = readZaiSessionClaims(credentials?.token)
    if (!claims) {
      return {
        valid: false,
        error: 'Invalid Z.ai session metadata',
      }
    }
    if (!claims.usable) {
      return { valid: false, error: 'Z.ai session expired; reconnect the existing account' }
    }
    return {
      valid: true,
      tokenType: 'access',
      expiresAt: claims.expiresAt,
      accountInfo: {
        userId: claims.subject,
        email: claims.email || '',
        name: claims.email || claims.subject,
        expiresAt: claims.expiresAt,
      },
    }
  }
}
