/**
 * Add Account Dialog Component
 * Supports OAuth login and manual input methods
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { 
  ExternalLink, 
  User, 
  AlertCircle,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  Copy,
  Check
} from 'lucide-react'
import type { Provider, CredentialField, Account, BuiltinProviderConfig, ProviderVendor } from '@/types/electron'

/**
 * Map OAuth credentials to provider credential field names
 * OAuth returns credentials with keys like 'chatglm_refresh_token', but providers expect 'refresh_token'
 * DeepSeek stores token as JSON: {"value":"..."}
 */
function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  if (!providerId) return credentials

  const credentialKeyMap: Record<string, string> = {
    'glm': 'chatglm_refresh_token',
    'deepseek': 'userToken',
    'qwen': 'tongyi_sso_ticket',
    'qwen-ai': 'tongyi_sso_ticket',
    'zai': 'tongyi_sso_ticket',
    'perplexity': '__Secure-next-auth.session-token',
    'mimo': 'serviceToken',
  }

  const providerFieldNames: Record<string, string> = {
    'glm': 'refresh_token',
    'deepseek': 'token',
    'qwen': 'ticket',
    'qwen-ai': 'ticket',
    'zai': 'ticket',
    'perplexity': 'sessionToken',
    'mimo': 'service_token',
  }

  const oauthKey = credentialKeyMap[providerId]
  if (oauthKey && credentials[oauthKey]) {
    const fieldName = providerFieldNames[providerId]
    if (fieldName) {
      // Handle JSON-wrapped tokens (DeepSeek stores token as {"value":"..."})
      let tokenValue = credentials[oauthKey]
      if (providerId === 'deepseek' && tokenValue && tokenValue.startsWith('{') && tokenValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(tokenValue)
          if (parsed.value) {
            tokenValue = parsed.value
          }
        } catch (e) {
          console.error('[AddAccountDialog] Error parsing JSON token:')
        }
      }
      return { [fieldName]: tokenValue }
    }
  }

  // For Perplexity, if we have the secure token, map it
  if (providerId === 'perplexity' && credentials['__Secure-next-auth.session-token']) {
    return { sessionToken: credentials['__Secure-next-auth.session-token'] }
  }
  if (providerId === 'perplexity' && credentials['next-auth.session-token']) {
    return { sessionToken: credentials['next-auth.session-token'] }
  }

  // For Mimo, map all three tokens
  if (providerId === 'mimo') {
    const result: Record<string, string> = {}
    // OAuth already returns credentials in correct format (service_token, user_id, ph_token)
    // Check for final format first
    if (credentials['service_token']) {
      result['service_token'] = credentials['service_token']
    } else if (credentials['serviceToken']) {
      result['service_token'] = credentials['serviceToken']
    }
    if (credentials['user_id']) {
      result['user_id'] = credentials['user_id']
    } else if (credentials['userId']) {
      result['user_id'] = credentials['userId']
    }
    if (credentials['ph_token']) {
      result['ph_token'] = credentials['ph_token']
    } else if (credentials['xiaomichatbot_ph']) {
      result['ph_token'] = credentials['xiaomichatbot_ph']
    }
    return result
  }

  return credentials
}

function zaiCreateFailureMessage(reason: unknown): string {
  switch (reason) {
    case 'invalid_name':
      return 'Enter an account name before signing in.'
    case 'busy':
      return 'Another sign-in is already in progress. Finish or cancel it before trying again.'
    case 'provider_unavailable':
      return 'Z.ai sign-in is currently unavailable.'
    case 'login_cancelled':
      return 'Z.ai sign-in was cancelled.'
    case 'login_timeout':
    case 'authentication_timeout':
      return 'Z.ai sign-in timed out. Open the login window again to continue.'
    case 'storage_unavailable':
      return 'The verified account could not be saved. Check local storage availability before trying again.'
    case 'invalid_session':
    case 'invalid_auth_response':
    case 'authentication_failed':
    case 'identity_mismatch':
      return 'Official Z.ai authentication could not be verified. Sign in again to continue.'
    default:
      return 'Z.ai account creation could not be completed. Check the account list before trying again.'
  }
}

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: Provider | null
  onAddAccount: (data: {
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => Promise<void>
  onValidateToken: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
  editingAccount?: Account | null
  onUpdateAccount?: (id: string, updates: Partial<Account>) => Promise<void>
  onCreateZaiAccount?: (name: string) => Promise<{
    success: boolean
    accountId?: string
    reason?: string
  }>
}

export function AddAccountDialog({
  open,
  onOpenChange,
  provider,
  onAddAccount,
  onValidateToken,
  editingAccount,
  onUpdateAccount,
  onCreateZaiAccount,
}: AddAccountDialogProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<string>('manual')
  const [name, setName] = useState('')
  const [dailyLimit, setDailyLimit] = useState<string>('')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid?: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isOAuthLoading, setIsOAuthLoading] = useState(false)
  const [oauthStatus, setOAuthStatus] = useState<string>('')
  const [isCreatingZai, setIsCreatingZai] = useState(false)
  const [zaiCreateStatus, setZaiCreateStatus] = useState('')
  const zaiCreateAttempt = useRef<{ terminal: boolean } | null>(null)

  const isEditing = !!editingAccount
  const isNewZaiAccount = provider?.id === 'zai' && !isEditing
  const isZaiBrowserFlow = isNewZaiAccount && activeTab === 'oauth'
  const zaiCreateLocked = isCreatingZai || zaiCreateAttempt.current !== null
  const isBrowserLoading = isNewZaiAccount ? isCreatingZai : isOAuthLoading
  const browserStatus = isNewZaiAccount ? zaiCreateStatus : oauthStatus
  const builtinProvider = provider as BuiltinProviderConfig | null
  const credentialFields: CredentialField[] = builtinProvider?.credentialFields || getDefaultCredentialFields(provider?.authType, t)
  const supportsOAuth = provider && ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity'].includes(provider.id)

  const cancelPendingZaiCreate = useCallback(() => {
    const attempt = zaiCreateAttempt.current
    if (!attempt) return
    zaiCreateAttempt.current = null
    if (attempt.terminal) return
    try {
      const oauth = window.electronAPI?.oauth
      if (typeof oauth?.cancelInAppLogin === 'function') {
        void Promise.resolve(oauth.cancelInAppLogin()).catch(() => {})
      }
    } catch {
      // Cancellation is best effort; never expose an IPC/provider exception.
    }
  }, [])

  useEffect(() => {
    setIsCreatingZai(false)
    setZaiCreateStatus('')
    // Callback identities change on ordinary parent renders. Only a dialog
    // context change or unmount invalidates this operation.
    return cancelPendingZaiCreate
  }, [open, provider?.id, editingAccount?.id, cancelPendingZaiCreate])

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      cancelPendingZaiCreate()
      setIsCreatingZai(false)
    }
    onOpenChange(nextOpen)
  }

  useEffect(() => {
    if (open) {
      if (editingAccount) {
        setName(editingAccount.name)
        setDailyLimit(editingAccount.dailyLimit?.toString() || '')
        setCredentials(editingAccount.credentials || {})
        setActiveTab('manual')
      } else {
        resetForm()
      }
    }
  }, [open, editingAccount])

  const resetForm = () => {
    setName('')
    setDailyLimit('')
    setCredentials({})
    setValidationResult({})
    setActiveTab('manual')
    setIsOAuthLoading(false)
    setOAuthStatus('')
  }

  const handleCredentialChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({
      ...prev,
      [fieldName]: value,
    }))
    setValidationResult({})
  }

  const handleValidate = async () => {
    if (zaiCreateAttempt.current || isZaiBrowserFlow) return
    if (!provider) return

    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsValidating(true)
    setValidationResult({})

    try {
      const result = await onValidateToken(provider.id, credentials)
      setValidationResult(result)

      if (result.valid && result.userInfo) {
        if (!name && result.userInfo.name) {
          setName(result.userInfo.name)
        }
      }
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.validateFailed'),
      })
    } finally {
      setIsValidating(false)
    }
  }

  const handleSubmit = async () => {
    if (zaiCreateAttempt.current || isZaiBrowserFlow) return
    if (!name.trim()) {
      setValidationResult({
        valid: false,
        error: t('providers.enterAccountName'),
      })
      return
    }

    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsSubmitting(true)

    try {
      // For MiniMax, ensure realUserID is passed correctly
      let finalCredentials = { ...credentials }
      if (provider?.id === 'minimax' && credentials.realUserID && credentials.realUserID.trim()) {
        // realUserID is provided separately, keep both fields
        console.log('[AddAccountDialog] MiniMax identifier supplied')
      }

      const data = {
        name: name.trim(),
        credentials: finalCredentials,
        dailyLimit: dailyLimit ? parseInt(dailyLimit, 10) : undefined,
      }

      if (isEditing && editingAccount && onUpdateAccount) {
        await onUpdateAccount(editingAccount.id, data)
      } else {
        await onAddAccount(data)
      }

      onOpenChange(false)
      resetForm()
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.saveFailed'),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCreateZaiAccount = async () => {
    if (!open || !isNewZaiAccount || zaiCreateAttempt.current || isSubmitting || isValidating) return
    const accountName = name.trim()
    if (!accountName) {
      setZaiCreateStatus(zaiCreateFailureMessage('invalid_name'))
      return
    }
    if (typeof onCreateZaiAccount !== 'function') {
      setZaiCreateStatus(zaiCreateFailureMessage('provider_unavailable'))
      return
    }
    const attempt = { terminal: false }
    zaiCreateAttempt.current = attempt
    setIsCreatingZai(true)
    setValidationResult({})
    setZaiCreateStatus('Complete sign-in in the official Z.ai window. The new account is added after authentication is verified.')
    try {
      const result = await onCreateZaiAccount(accountName)
      if (zaiCreateAttempt.current !== attempt) return
      if (result?.success === true) {
        // A success may already represent a committed write. Never offer a
        // second save/retry merely because its receipt is incomplete.
        attempt.terminal = true
        if (typeof result.accountId !== 'string' || !result.accountId.trim()) {
          setZaiCreateStatus('Account creation could not be confirmed. Check the account list before trying again.')
          return
        }
        setZaiCreateStatus('Z.ai account added.')
        onOpenChange(false)
        resetForm()
      } else {
        setZaiCreateStatus(zaiCreateFailureMessage(result?.reason))
      }
    } catch {
      if (zaiCreateAttempt.current === attempt && !attempt.terminal) {
        setZaiCreateStatus(zaiCreateFailureMessage(undefined))
      }
    } finally {
      if (zaiCreateAttempt.current === attempt) {
        if (!attempt.terminal) zaiCreateAttempt.current = null
        setIsCreatingZai(false)
      }
    }
  }

  const handleOpenOAuthBrowser = async () => {
    if (isNewZaiAccount) {
      await handleCreateZaiAccount()
      return
    }
    if (!provider) return
    
    setIsOAuthLoading(true)
    setOAuthStatus(t('providers.openingLoginWindow'))
    
    try {
      const result = await window.electronAPI?.oauth.startInAppLogin(
        provider.id,
        provider.id as ProviderVendor
      )
      
      if (result?.success && result.credentials) {
        // Map OAuth credentials to provider credential field names
        const mappedCredentials = mapOAuthCredentials(provider?.id, result.credentials)
        setCredentials(mappedCredentials)
        setOAuthStatus(t('providers.loginSuccess'))
        
        if (result.accountInfo?.name) {
          setName(result.accountInfo.name)
        }
        
        setValidationResult({
          valid: true,
          userInfo: result.accountInfo
        })
      } else {
        const errorMsg = result?.error || ''
        const translatedError = errorMsg === 'Login window was closed' 
          ? t('providers.loginWindowClosed')
          : errorMsg === 'A login window is already open'
            ? t('providers.loginWindowAlreadyOpen')
            : errorMsg.includes('Guest account') 
              ? t('providers.guestAccountNotAllowed')
              : errorMsg || t('providers.loginFailed')
        setOAuthStatus(translatedError)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('providers.loginFailed')
      setOAuthStatus(errorMessage)
    } finally {
      setIsOAuthLoading(false)
    }
  }

  if (!provider) return null

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              {isEditing ? t('providers.editAccount') : t('providers.addAccount')}
            </DialogTitle>
            <DialogDescription>
              {t('providers.manageAllAccounts')} - {provider.name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('providers.accountName')} *</Label>
              <Input
                id="name"
                placeholder={t('providers.accountNamePlaceholder')}
                value={name}
                disabled={isNewZaiAccount && zaiCreateLocked}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {!isZaiBrowserFlow && <div className="space-y-2">
              <Label htmlFor="dailyLimit">{t('providers.dailyLimitOptional')}</Label>
              <Input
                id="dailyLimit"
                type="number"
                placeholder={t('providers.dailyLimitPlaceholder')}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            </div>}

            {supportsOAuth && !isEditing && (
              <Tabs value={activeTab} onValueChange={(value) => {
                if (!zaiCreateAttempt.current) setActiveTab(value)
              }}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="manual" disabled={isNewZaiAccount && zaiCreateLocked}>{t('providers.manualInput')}</TabsTrigger>
                  <TabsTrigger value="oauth" disabled={isNewZaiAccount && zaiCreateLocked}>{t('providers.oauthLogin')}</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="mt-4">
                  <CredentialFieldsForm
                    fields={credentialFields}
                    credentials={credentials}
                    onChange={handleCredentialChange}
                    t={t}
                    providerId={provider?.id}
                  />
                </TabsContent>

                <TabsContent value="oauth" className="mt-4">
                  <div className="flex flex-col items-center justify-center py-6 space-y-4">
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground mb-4">
                        {isNewZaiAccount
                          ? 'Sign in with your Z.ai account in the official web login window.'
                          : t('providers.clickToOpenOAuth')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isNewZaiAccount
                          ? 'One NEW account record is added only after official web authentication is verified. Existing accounts are preserved.'
                          : t('providers.oauthAutoCapture')}
                      </p>
                    </div>
                    <Button 
                      onClick={handleOpenOAuthBrowser}
                      disabled={isNewZaiAccount
                        ? zaiCreateLocked || !name.trim() || typeof onCreateZaiAccount !== 'function' || isSubmitting || isValidating
                        : isOAuthLoading}
                    >
                      {isBrowserLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {isNewZaiAccount ? 'Signing in and verifying...' : oauthStatus || t('providers.loggingIn')}
                        </>
                      ) : (
                        <>
                          <ExternalLink className="mr-2 h-4 w-4" />
                          {isNewZaiAccount ? 'Sign in and add Z.ai account' : t('providers.openOAuthLogin')}
                        </>
                      )}
                    </Button>
                    {browserStatus && (isNewZaiAccount || !isOAuthLoading) && (
                      <p className={isNewZaiAccount ? 'text-sm text-muted-foreground' : `text-sm ${validationResult.valid ? 'text-green-600' : 'text-red-500'}`}>
                        <span role="status">{browserStatus}</span>
                      </p>
                    )}
                    {isNewZaiAccount && !browserStatus &&
                      (typeof onCreateZaiAccount !== 'function' || !name.trim()) && (
                      <p className="text-sm text-muted-foreground" role="status">
                        {typeof onCreateZaiAccount !== 'function'
                          ? zaiCreateFailureMessage('provider_unavailable')
                          : zaiCreateFailureMessage('invalid_name')}
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            )}

            {(!supportsOAuth || isEditing) && (
              <CredentialFieldsForm
                fields={credentialFields}
                credentials={credentials}
                onChange={handleCredentialChange}
                t={t}
                providerId={provider?.id}
              />
            )}

            {validationResult.error && (
              <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{validationResult.error}</span>
              </div>
            )}

            {validationResult.valid && validationResult.userInfo && (
              <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <div>
                  <span className="font-medium">{t('providers.validationSuccess')}</span>
                  {validationResult.userInfo.quota !== undefined && (
                    <span className="ml-2">
                      {t('providers.quota')}: {validationResult.userInfo.used || 0} / {validationResult.userInfo.quota}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button
              variant="outline"
              onClick={() => handleDialogOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
            {!isZaiBrowserFlow && <>
            <Button
              variant="outline"
              onClick={handleValidate}
              disabled={isValidating || isSubmitting || (isNewZaiAccount && zaiCreateLocked)}
            >
              {isValidating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('oauth.validating')}
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {t('providers.validateCredentials')}
                </>
              )}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || isValidating || (isNewZaiAccount && zaiCreateLocked)}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('providers.saving')}
                </>
              ) : (
                isEditing ? t('providers.saveChanges') : t('providers.addAccount')
              )}
            </Button>
            </>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface CredentialFieldsFormProps {
  fields: CredentialField[]
  credentials: Record<string, string>
  onChange: (fieldName: string, value: string) => void
  t: (key: string) => string
  providerId?: string
}

function CredentialFieldsForm({ fields, credentials, onChange, t, providerId }: CredentialFieldsFormProps) {
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})

  const toggleFieldVisibility = (fieldName: string) => {
    setVisibleFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }))
  }

  const copyToClipboard = async (fieldName: string, value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedFields(prev => ({ ...prev, [fieldName]: true }))
      setTimeout(() => {
        setCopiedFields(prev => ({ ...prev, [fieldName]: false }))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy:')
    }
  }

  const getFieldTranslation = (field: CredentialField) => {
    if (!providerId) return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }

    const translations: Record<string, Record<string, { label: string; placeholder: string; helpText: string }>> = {
      deepseek: {
        token: {
          label: t('deepseek.userToken'),
          placeholder: t('deepseek.userTokenPlaceholder'),
          helpText: t('deepseek.userTokenHelp'),
        },
      },
      glm: {
        refresh_token: {
          label: t('glm.refreshToken'),
          placeholder: t('glm.refreshTokenPlaceholder'),
          helpText: t('glm.refreshTokenHelp'),
        },
      },
      kimi: {
        token: {
          label: t('kimi.accessToken'),
          placeholder: t('kimi.accessTokenPlaceholder'),
          helpText: t('kimi.accessTokenHelp'),
        },
      },
      minimax: {
        token: {
          label: t('minimax.token'),
          placeholder: t('minimax.tokenPlaceholder'),
          helpText: t('minimax.tokenHelp'),
        },
        realUserID: {
          label: t('minimax.realUserID'),
          placeholder: t('minimax.realUserIDPlaceholder'),
          helpText: t('minimax.realUserIDHelp'),
        },
      },
      qwen: {
        ticket: {
          label: t('qwen.ssoTicket'),
          placeholder: t('qwen.ssoTicketPlaceholder'),
          helpText: t('qwen.ssoTicketHelp'),
        },
      },
      'qwen-ai': {
        token: {
          label: t('qwen-ai.token'),
          placeholder: t('qwen-ai.tokenPlaceholder'),
          helpText: t('qwen-ai.tokenHelp'),
        },
        cookies: {
          label: t('qwen-ai.cookies'),
          placeholder: t('qwen-ai.cookiesPlaceholder'),
          helpText: t('qwen-ai.cookiesHelp'),
        },
      },
      zai: {
        token: {
          label: t('zai.token'),
          placeholder: t('zai.tokenPlaceholder'),
          helpText: t('zai.tokenHelp'),
        },
      },
      mimo: {
        service_token: {
          label: t('mimo.serviceToken'),
          placeholder: t('mimo.serviceTokenPlaceholder'),
          helpText: t('mimo.serviceTokenHelp'),
        },
        user_id: {
          label: t('mimo.userId'),
          placeholder: t('mimo.userIdPlaceholder'),
          helpText: t('mimo.userIdHelp'),
        },
        ph_token: {
          label: t('mimo.phToken'),
          placeholder: t('mimo.phTokenPlaceholder'),
          helpText: t('mimo.phTokenHelp'),
        },
      },
      perplexity: {
        sessionToken: {
          label: t('perplexity.sessionToken'),
          placeholder: t('perplexity.sessionTokenPlaceholder'),
          helpText: t('perplexity.sessionTokenHelp'),
        },
      },
    }

    const providerTranslations = translations[providerId]
    if (providerTranslations && providerTranslations[field.name]) {
      return providerTranslations[field.name]
    }

    return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const translated = getFieldTranslation(field)
        const isPasswordField = field.type === 'password'
        const isVisible = visibleFields[field.name]
        const isCopied = copiedFields[field.name]
        const fieldValue = credentials[field.name] || ''
        
        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={field.name}>{translated.label}</Label>
              {field.required && (
                <Badge variant="outline" className="text-xs">{t('providers.required')}</Badge>
              )}
            </div>
            {field.type === 'textarea' ? (
              <div className="relative">
                <textarea
                  id={field.name}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 pr-20"
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => onChange(field.name, e.target.value)}
                />
                <div className="absolute right-1 top-1 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={!fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : isPasswordField ? (
              <div className="relative">
                <Input
                  id={field.name}
                  type={isVisible ? 'text' : 'password'}
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => onChange(field.name, e.target.value)}
                  className="pr-20"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={!fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <Input
                id={field.name}
                type={field.type}
                placeholder={translated.placeholder}
                value={fieldValue}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}
            {translated.helpText && (
              <p className="text-xs text-muted-foreground">{translated.helpText}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function getDefaultCredentialFields(authType?: string, t?: (key: string) => string): CredentialField[] {
  const fieldConfigs: Record<string, CredentialField[]> = {
    token: [
      {
        name: 'token',
        label: 'API Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterApiToken') : 'Enter API Token',
      },
    ],
    cookie: [
      {
        name: 'cookie',
        label: 'Cookie',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterCookieString') : 'Enter complete Cookie string',
      },
    ],
    oauth: [
      {
        name: 'access_token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterOAuthAccessToken') : 'Enter OAuth Access Token',
      },
    ],
    refresh_token: [
      {
        name: 'refresh_token',
        label: 'Refresh Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterRefreshToken') : 'Enter Refresh Token',
      },
    ],
    jwt: [
      {
        name: 'jwt',
        label: 'JWT Token',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterJwtToken') : 'Enter JWT Token (starts with eyJ)',
      },
    ],
  }

  return fieldConfigs[authType || 'token'] || fieldConfigs.token
}

export default AddAccountDialog
