import axios, { AxiosError } from 'axios'
import { getBuiltinProvider } from './builtin'
import { selectQwenChinaTicket } from './qwenTicket'
import { selectQwenAiToken } from './qwenAiToken'
import { readZaiTokenIdentity, readZaiSessionClaims } from '../oauth/zaiSession'
import type { Provider, ProviderCheckResult, Account } from '../../shared/types'
import type { BuiltinProviderConfig } from '../store/types'

const CHECK_TIMEOUT = 15000

export interface TokenCheckResult {
  valid: boolean
  error?: string
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
}

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const builtinConfig = provider.type === 'builtin' 
        ? getBuiltinProvider(provider.id) 
        : null
      
      if (builtinConfig) {
        return await this.checkBuiltinProvider(builtinConfig)
      }
      
      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(config: BuiltinProviderConfig): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`
      
      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        // A mere reachability check must never follow a redirect with
        // credentials or create more requests than the user requested.
        maxRedirects: 0,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500 &&
          (response.status < 300 || response.status >= 400)) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        maxRedirects: 0,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500 &&
          (response.status < 300 || response.status >= 400)) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  static async checkAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' 
      ? getBuiltinProvider(provider.id) 
      : null
    
    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }
    
    switch (provider.id) {
      case 'deepseek':
        return this.checkDeepSeekToken(account.credentials.token)
      case 'glm': {
        const credentials: unknown = account?.credentials
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
          return { valid: false, error: 'GLM token validation failed' }
        }
        const values = credentials as Record<string, unknown>
        let selected: string | undefined
        // Match the consumer adapter; never replace a malformed/conflicting alias.
        for (const field of ['refresh_token', 'chatglm_refresh_token', 'refreshToken', 'token']) {
          if (!Object.prototype.hasOwnProperty.call(values, field)) continue
          const value = values[field]
          if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value) ||
              (selected !== undefined && selected !== value)) {
            return { valid: false, error: 'GLM token validation failed' }
          }
          selected = value
        }
        return selected === undefined
          ? { valid: false, error: 'GLM token validation failed' }
          : this.checkGLMToken(selected)
      }
      case 'kimi':
        {
          // Manual Kimi login saves accessToken. Match the exact precedence of
          // the web completion adapter without substituting malformed values.
          const token = this.selectKimiToken(account?.credentials)
          return token ? this.checkKimiToken(token) : { valid: false, error: 'Kimi token validation failed' }
        }
      case 'minimax':
        return this.checkMiniMaxToken(
          account.credentials.realUserID || '',
          account.credentials.token
        )
      case 'qwen': {
        const ticket = selectQwenChinaTicket(account?.credentials)
        return ticket ? this.checkQwenToken(ticket)
          : { valid: false, error: 'Qwen China ticket validation failed' }
      }
      case 'qwen-ai':
        return this.checkQwenAiToken(selectQwenAiToken(account?.credentials))
      case 'zai':
        return this.checkZaiToken(account?.credentials)
      case 'perplexity':
        return this.checkPerplexityToken(account.credentials.sessionToken || account.credentials.token)
      case 'mimo':
        return this.checkMimoToken(
          account.credentials.service_token,
          account.credentials.user_id,
          account.credentials.ph_token
        )
      default:
        if (!builtinConfig.tokenCheckEndpoint) {
          return { valid: true }
        }
        return this.checkGenericToken(builtinConfig, account)
    }
  }

  private static checkMimoToken(
    serviceToken: string,
    userId: string,
    phToken: string
  ): TokenCheckResult {
    if (!serviceToken || !userId || !phToken) {
      return { valid: false, error: 'Missing required credentials: service_token, user_id, ph_token' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Mimo User',
      },
    }
  }

  private static async checkDeepSeekToken(token: string): Promise<TokenCheckResult> {
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
      return { valid: false, error: 'DeepSeek token validation failed' }
    }
    try {
      console.log('[DeepSeek] Validating token')
      
      const response = await axios.get(
        'https://chat.deepseek.com/api/v0/users/current',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
          },
          timeout: CHECK_TIMEOUT,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
      
      console.log('[DeepSeek] Validation response received')
      
      // Response format: { code: 0, data: { biz_data: { ... } } }
      if (response.status === 200 && response.data?.code === 0 && response.data?.data?.biz_data) {
        const bizData = response.data.data.biz_data
        return {
          valid: true,
          userInfo: {
            name: bizData.id_profile?.name,
            email: bizData.email,
          },
        }
      }
      
      if (response.status === 401 || response.data?.code === 40003 || response.data?.data?.biz_code === 40003) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: 'DeepSeek token validation failed' }
    } catch {
      console.error('[DeepSeek] Validation request failed')
      return {
        valid: false,
        error: 'DeepSeek token validation failed',
      }
    }
  }

  private static async checkGLMToken(refreshToken: string): Promise<TokenCheckResult> {
    if (typeof refreshToken !== 'string' || !/^[\x21-\x7e]+$/.test(refreshToken)) {
      return { valid: false, error: 'GLM token validation failed' }
    }
    try {
      console.log('[GLM] Validating token')
      
      const sign = await this.generateGLMSignV2()
      
      const response = await axios.post(
        'https://chatglm.cn/chatglm/user-api/user/refresh',
        {},
        {
          headers: {
            'Accept': 'text/event-stream',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'App-Name': 'chatglm',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://chatglm.cn',
            'Pragma': 'no-cache',
            'Priority': 'u=1, i',
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
            'X-Exp-Groups': 'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable',
            'X-Lang': 'zh',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            Authorization: `Bearer ${refreshToken}`,
            'X-Device-Id': this.generateUUID().replace(/-/g, ''),
            'X-Nonce': sign.nonce,
            'X-Request-Id': this.generateUUID().replace(/-/g, ''),
            'X-Sign': sign.sign,
            'X-Timestamp': `${sign.timestamp}`,
          },
          timeout: CHECK_TIMEOUT,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
      
      console.log('[GLM] Validation response received')
      
      const result = response.data?.result
      const isSuccess = response.data?.code === 0 || response.data?.status === 0
      if (response.status === 200 && isSuccess &&
          result && typeof result === 'object' && !Array.isArray(result) &&
          typeof result.access_token === 'string' && /^[\x21-\x7e]+$/.test(result.access_token) &&
          typeof result.refresh_token === 'string' && /^[\x21-\x7e]+$/.test(result.refresh_token)) {
        return {
          valid: true,
          userInfo: {
            name: response.data.result.user?.name,
          },
        }
      }
      
      if (response.status === 401 || response.data?.status === 40001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: 'GLM token validation failed' }
    } catch {
      console.error('[GLM] Validation request failed')
      return {
        valid: false,
        error: 'GLM token validation failed',
      }
    }
  }
  
  private static async generateGLMSignV2(): Promise<{ timestamp: string; nonce: string; sign: string }> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    
    // GLM timestamp algorithm
    const now = Date.now()
    const timestampStr = now.toString()
    const len = timestampStr.length
    const digits = timestampStr.split('').map(d => parseInt(d))
    const sum = digits.reduce((a, b) => a + b, 0) - digits[len - 2]
    const checkDigit = sum % 10
    const timestamp = timestampStr.substring(0, len - 2) + checkDigit + timestampStr.substring(len - 1)
    
    // Random UUID (no separators)
    const nonce = this.generateUUID().replace(/-/g, '')
    
    // Signature
    const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
    
    return { timestamp, nonce, sign }
  }

  private static selectKimiToken(credentials: unknown): string | null {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null
    const values = credentials as Record<string, unknown>
    for (const field of ['token', 'refreshToken', 'accessToken']) {
      const value = values[field]
      if (value === undefined || value === '') continue
      if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return null
      return value
    }
    return null
  }

  private static async checkKimiToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[Kimi] Validating token')
      
      const response = await axios.post(
        'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'Accept': '*/*',
            'Origin': 'https://www.kimi.com',
            'Referer': 'https://www.kimi.com/',
          },
          timeout: CHECK_TIMEOUT,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
      
      console.log('[Kimi] Validation response received')
      
      const subscription = response.data?.subscription
      if (response.status === 200 && subscription &&
          typeof subscription === 'object' && !Array.isArray(subscription) &&
          response.data?.error === undefined) {
        return {
          valid: true,
          userInfo: {
            name: subscription.userName,
          },
        }
      }
      
      return { valid: false, error: 'Kimi token validation failed' }
    } catch {
      console.error('[Kimi] Validation request failed')
      return { valid: false, error: 'Kimi token validation failed' }
    }
  }

  private static async checkMiniMaxToken(
    _realUserID: string,
    token: string
  ): Promise<TokenCheckResult> {
    try {
      console.log('[MiniMax] Validating token')
      
      const crypto = await import('crypto')
      
      let realUserID = ''
      let jwtToken = token
      
      if (token.includes('+')) {
        const parts = token.split('+')
        realUserID = parts[0]
        jwtToken = parts[1]
      } else {
        try {
          const parts = token.split('.')
          if (parts.length >= 2) {
            let payload = parts[1]
            const padding = payload.length % 4
            if (padding > 0) {
              payload += '='.repeat(4 - padding)
            }
            payload = payload.replace(/-/g, '+').replace(/_/g, '/')
            const decoded = Buffer.from(payload, 'base64').toString('utf8')
            const data = JSON.parse(decoded)
            realUserID = data.user?.id || data.id || data.sub || ''
            console.log('[MiniMax] Extracted user identifier from token')
          }
        } catch {
          console.log('[MiniMax] Failed to parse JWT')
        }
      }
      
      if (!realUserID) {
        return { valid: false, error: 'Cannot extract user ID from token' }
      }
      
      const uuid = realUserID
      const unix = Date.now().toString()
      const timestamp = Math.floor(Date.now() / 1000)
      const dataJson = JSON.stringify({ uuid })
      
      const signature = crypto.createHash('md5').update(`${timestamp}${jwtToken}${dataJson}`).digest('hex')
      
      const queryParams = new URLSearchParams({
        device_platform: 'web',
        biz_id: '3',
        app_id: '3001',
        version_code: '22201',
        uuid: uuid,
        user_id: realUserID,
      }).toString()
      
      const fullUri = `/v1/api/user/device/register?${queryParams}`
      const yy = crypto.createHash('md5').update(`${encodeURIComponent(fullUri)}_${dataJson}${crypto.createHash('md5').update(unix).digest('hex')}ooui`).digest('hex')
      
      const response = await axios.post(
        `https://agent.minimaxi.com${fullUri}`,
        { uuid },
        {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://agent.minimaxi.com',
            'Pragma': 'no-cache',
            'Referer': 'https://agent.minimaxi.com/',
            'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'token': jwtToken,
            'x-timestamp': String(timestamp),
            'x-signature': signature,
            'yy': yy,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[MiniMax] Validation response received')
      
      if (response.status === 200 && response.data?.data?.deviceIDStr) {
        const userInfo = response.data.data.userInfo
        return {
          valid: true,
          userInfo: {
            name: userInfo?.name || userInfo?.nickname,
            email: userInfo?.email,
          },
        }
      }
      
      if (response.data?.statusInfo?.code === 1001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.statusInfo?.message || 'Unknown error'}` }
    } catch (error) {
      console.error('[MiniMax] Validation request failed')
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenToken(ticket: string): Promise<TokenCheckResult> {
    const invalid = (): TokenCheckResult => ({ valid: false, error: 'Qwen China ticket validation failed' })
    if (!selectQwenChinaTicket({ ticket })) return invalid()
    try {
      const response = await axios.post(
        'https://chat2-api.qianwen.com/api/v2/session/page/list',
        {},
        {
          headers: {
            Cookie: `tongyi_sso_ticket=${ticket}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.qianwen.com',
            'Referer': 'https://www.qianwen.com/',
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: CHECK_TIMEOUT,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )
      
      if (response.status === 200 && response.data &&
          typeof response.data === 'object' && !Array.isArray(response.data) &&
          response.data.success === true && response.data.error == null) {
        return {
          valid: true,
        }
      }
      return invalid()
    } catch {
      // A transport exception may embed the Cookie, URL or upstream body.
      return invalid()
    }
  }

  /** A successful generic /settings HTTP 200 is reachability, not proof that
   * this stored Z.ai JWT belongs to the current first-party account. Verify
   * the exact subject (including no-exp JWTs) against the established official
   * /auths/ endpoint before reporting a valid account. Read-only, once only:
   * never refresh/rewrite, redirect, retry, or accept an unrelated subject. */
  private static async checkZaiToken(credentials: unknown): Promise<TokenCheckResult> {
    const invalid = (): TokenCheckResult => ({ valid: false, error: 'Z.ai session identity verification failed' })
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return invalid()
    const fields = credentials as Record<string, unknown>
    let token: unknown
    for (const key of ['token', 'accessToken', 'jwt']) {
      const candidate = fields[key]
      if (candidate === undefined || candidate === null || candidate === '') continue
      token = candidate
      break
    }
    const identity = readZaiTokenIdentity(token)
    if (!identity || (identity.expiryKnown && !readZaiSessionClaims(token)?.usable)) return invalid()
    try {
      const response = await axios.get('https://chat.z.ai/api/v1/auths/', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: `token=${token}`,
          Origin: 'https://chat.z.ai',
          Referer: 'https://chat.z.ai/',
        },
        timeout: 12000,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
        responseType: 'json',
        validateStatus: () => true,
      })
      const contentType = response.headers?.['content-type']
      const body: unknown = response.data
      if (response.status !== 200 || typeof contentType !== 'string' ||
          !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType) ||
          !body || typeof body !== 'object' || Array.isArray(body)) return invalid()
      const user = body as Record<string, unknown>
      if (user.id !== identity.subject || user.error != null ||
          (Object.hasOwn(user, 'success') && user.success !== true)) return invalid()
      if (Object.hasOwn(user, 'token')) {
        const rotated = readZaiTokenIdentity(user.token)
        if (!rotated || rotated.subject !== identity.subject ||
            (rotated.expiryKnown && !readZaiSessionClaims(user.token)?.usable)) return invalid()
      }
      return { valid: true }
    } catch {
      // Axios exceptions may contain URL, Authorization, Cookie, or response.
      return invalid()
    }
  }

  private static async checkQwenAiToken(token: unknown): Promise<TokenCheckResult> {
    const invalid = (): TokenCheckResult => ({ valid: false, error: 'Qwen AI token validation failed' })
    // Match the proxy's opaque header-token boundary without inferring a JWT.
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) return invalid()
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)

    try {
      const response = await axios.get(
        'https://chat.qwen.ai/api/v2/user',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            source: 'web',
          },
          timeout: CHECK_TIMEOUT,
          maxRedirects: 0,
          validateStatus: () => true,
        }
      )

      const body: unknown = response.data
      // Keep the existing /user response with omitted success compatible.
      // A supplied failure/error or guest record cannot authenticate an account.
      if (response.status !== 200 || !isRecord(body) || body.error != null ||
          (Object.prototype.hasOwnProperty.call(body, 'success') && body.success !== true)) {
        return invalid()
      }
      const user = body.data
      if (!isRecord(user) || Object.keys(user).length === 0 || user.error != null ||
          (Object.prototype.hasOwnProperty.call(user, 'is_guest') && user.is_guest !== false)) {
        return invalid()
      }
      const email = typeof user.email === 'string' ? user.email : ''
      if (email.trim().toLowerCase().endsWith('@guest.com')) return invalid()
      const name = typeof user.name === 'string' ? user.name : ''
      return {
        valid: true,
        userInfo: { name: name || email, email },
      }
    } catch {
      // Axios errors can contain credential-bearing URLs, headers or bodies.
      return invalid()
    }
  }

  private static checkPerplexityToken(sessionToken: string): TokenCheckResult {
    if (!sessionToken) {
      return { valid: false, error: 'Session token is required' }
    }

    if (sessionToken.length < 100) {
      return { valid: false, error: 'Session token appears to be invalid (too short)' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Perplexity User',
      },
    }
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  private static async generateGLMSign(timestamp: string, nonce: string): Promise<string> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    return crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
  }

  static async fetchProviderModels(
    providerId: string
  ): Promise<{
    supportedModels: string[]
    modelMappings: Record<string, string>
  }> {
    const builtinConfig = getBuiltinProvider(providerId)
    
    if (!builtinConfig) {
      throw new Error(`Provider ${providerId} not found`)
    }

    if (!builtinConfig.modelsApiEndpoint) {
      throw new Error(`Provider ${providerId} does not support dynamic model fetching`)
    }

    try {
      const headers: Record<string, string> = {
        ...(builtinConfig.modelsApiHeaders || builtinConfig.headers),
      }

      const response = await axios.get(builtinConfig.modelsApiEndpoint, {
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }

      const models = response.data.data || []
      const supportedModels: string[] = []
      const modelMappings: Record<string, string> = {}

      for (const model of models) {
        if (model.name && model.id) {
          supportedModels.push(model.name)
          modelMappings[model.name] = model.id
        }
      }

      return { supportedModels, modelMappings }
    } catch (error) {
      console.error('[ProviderChecker] Failed to fetch models')
      throw error
    }
  }
}

export default ProviderChecker
