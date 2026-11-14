/**
 * Provider Management Page
 * Integrates all components for CRUD operations on providers and accounts
 */

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/hooks/use-toast'
import { useProvidersStore } from '@/stores/providersStore'
import {
  ProviderCard,
  AddProviderDialog,
  CustomProviderForm,
  AccountList,
  AddAccountDialog,
  AccountDetail,
  ProviderFilter,
} from '@/components/providers'
import { ModelEditor } from '@/components/models/ModelEditor'
import type { 
  Provider, 
  ProviderStatus, 
  BuiltinProviderConfig,
  CustomProviderFormData,
  Account,
} from '@/types/electron'
import { FilterType, StatusFilter } from '@/components/providers/ProviderFilter'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Server, ArrowLeft } from 'lucide-react'

type ViewMode = 'providers' | 'accounts' | 'account-detail'

export function Providers() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const store = useProvidersStore()
  
  const [viewMode, setViewMode] = useState<ViewMode>('providers')
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<FilterType>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  // Keep a provider-scoped, non-secret catalog failure visible after toast
  // expiry; a transient toast alone hides why the previous model list stayed.
  const [modelRefreshErrors, setModelRefreshErrors] = useState<Record<string, string>>({})
  // The trusted store can change while a previous multi-IPC page load is
  // pending. Only the latest generation may publish provider/account rows;
  // an older completed fetch must not undo a saved edit or a reconnect.
  const dataRequestGenerationRef = useRef(0)
  
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false)
  const [showCustomProviderForm, setShowCustomProviderForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  
  const [showAddAccountDialog, setShowAddAccountDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [zaiReconnectProgress, setZaiReconnectProgress] = useState<string | null>(null)
  
  const [showModelEditor, setShowModelEditor] = useState(false)
  const [modelEditorProvider, setModelEditorProvider] = useState<{ id: string; name: string } | null>(null)
  
  useEffect(() => {
    const loadInitialData = async () => {
      const generation = ++dataRequestGenerationRef.current
      if (!window.electronAPI?.providers?.getAll) {
        if (generation !== dataRequestGenerationRef.current) return
        console.log('electronAPI not available')
        useProvidersStore.getState().setIsLoading(false)
        useProvidersStore.getState().setProviders([])
        useProvidersStore.getState().setBuiltinProviders([])
        useProvidersStore.getState().setAccounts([])
        return
      }
      
      try {
        useProvidersStore.getState().setIsLoading(true)
        const [providersData, builtinData, accountsData] = await Promise.all([
          window.electronAPI.providers.getAll(),
          window.electronAPI.providers.getBuiltin(),
          window.electronAPI.accounts.getAll(),
        ])
        if (generation !== dataRequestGenerationRef.current) return
        
        useProvidersStore.getState().setProviders(providersData)
        useProvidersStore.getState().setBuiltinProviders(builtinData)
        useProvidersStore.getState().setAccounts(accountsData)
        
        const existingStatuses = useProvidersStore.getState().providerStatuses
        const statusMap: Record<string, ProviderStatus> = { ...existingStatuses }
        const countMap: Record<string, { total: number; active: number }> = {}
        
        for (const provider of providersData) {
          if (provider.status) {
            statusMap[provider.id] = provider.status
          } else if (!statusMap[provider.id]) {
            statusMap[provider.id] = 'unknown'
          }
          const providerAccounts = accountsData.filter(a => a.providerId === provider.id)
          countMap[provider.id] = {
            total: providerAccounts.length,
            active: providerAccounts.filter(a => a.status === 'active').length,
          }
        }
        
        useProvidersStore.getState().setProviderStatuses(statusMap)
        useProvidersStore.getState().setAccountCounts(countMap)
      } catch (error) {
        if (generation === dataRequestGenerationRef.current) {
          console.error('Failed to load providers:')
        }
      } finally {
        if (generation === dataRequestGenerationRef.current) {
          useProvidersStore.getState().setIsLoading(false)
        }
      }
    }
    
    void loadInitialData()
    const unsubscribe = window.electronAPI?.store?.onChanged?.(kind => {
      if (kind === 'providers' || kind === 'accounts') void loadInitialData()
    })
    return () => {
      ++dataRequestGenerationRef.current
      unsubscribe?.()
    }
  }, [])

  const filteredProviders = store.providers.filter((provider) => {
    const matchesSearch = 
      provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.supportedModels?.some(model => 
        model.toLowerCase().includes(searchQuery.toLowerCase())
      )

    if (!matchesSearch) return false

    switch (typeFilter) {
      case 'builtin':
        if (provider.type !== 'builtin') return false
        break
      case 'custom':
        if (provider.type !== 'custom') return false
        break
      case 'enabled':
        if (!provider.enabled) return false
        break
      case 'disabled':
        if (provider.enabled) return false
        break
    }

    if (statusFilter !== 'all') {
      if (store.providerStatuses[provider.id] !== statusFilter) return false
    }

    return true
  })

  const handleToggleProvider = async (id: string, enabled: boolean) => {
    try {
      await window.electronAPI.providers.update(id, { enabled })
      store.updateProvider(id, { enabled })
      toast({
        title: enabled ? t('providers.enabled') : t('providers.disabled'),
        description: enabled ? t('providers.providerEnabled') : t('providers.providerDisabled'),
      })
    } catch (error) {
      toast({
        title: t('providers.operationFailed'),
        description: t('providers.cannotUpdateProviderStatus'),
        variant: 'destructive',
      })
    }
  }

  const handleEditProvider = (id: string) => {
    const provider = store.providers.find(p => p.id === id)
    if (provider) {
      setEditingProvider(provider)
      setShowCustomProviderForm(true)
    }
  }

  const handleDeleteProvider = async (id: string) => {
    const provider = store.providers.find(p => p.id === id)
    // Built-ins can be disabled, never deleted. Custom deletion requires an
    // explicit confirmation because it also deletes associated accounts.
    if (!provider || provider.type !== 'custom' || store.builtinProviders.some(builtin => builtin.id === id)) return
    const attachedAccounts = store.accounts.filter(account => account.providerId === id).length
    if (!window.confirm(
      `Permanently delete this custom provider and its ${attachedAccounts} saved account(s)? ` +
      'This action cannot be undone. Cancel to preserve the provider and accounts.'
    )) return
    try {
      const success = await window.electronAPI.providers.delete(id)
      if (success) {
        store.removeProvider(id)
        toast({
          title: t('providers.deleteSuccess'),
          description: t('providers.providerDeleted'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.deleteFailed'),
        description: error instanceof Error ? error.message : t('providers.cannotDeleteProvider'),
        variant: 'destructive',
      })
    }
  }

  const handleDuplicateProvider = async (id: string) => {
    try {
      const newProvider = await window.electronAPI.providers.duplicate(id)
      store.addProvider(newProvider)
      toast({
        title: t('providers.duplicateSuccess'),
        description: t('providers.providerDuplicated'),
      })
    } catch (error) {
      toast({
        title: t('providers.duplicateFailed'),
        description: t('providers.cannotDuplicateProvider'),
        variant: 'destructive',
      })
    }
  }

  const handleCheckProviderStatus = async (id: string) => {
    try {
      const result = await window.electronAPI.providers.checkStatus(id)
      store.updateProviderStatus(id, result.status)
      toast({
        title: result.status === 'online' ? t('providers.providerOnline') : t('providers.providerOffline'),
        description: result.error || `${t('providers.latency')}: ${result.latency}ms`,
        variant: result.status === 'online' ? 'default' : 'destructive',
      })
    } catch (error) {
      toast({
        title: t('providers.checkFailed'),
        description: t('providers.cannotCheckProviderStatus'),
        variant: 'destructive',
      })
    }
  }

  const handleCheckAllStatus = async () => {
    setIsRefreshing(true)
    try {
      const statuses = await window.electronAPI.providers.checkAllStatus()
      const newStatusMap: Record<string, ProviderStatus> = {}
      for (const [id, result] of Object.entries(statuses)) {
        newStatusMap[id] = result.status
      }
      store.setProviderStatuses(newStatusMap)
      toast({
        title: t('providers.statusRefreshed'),
        description: `${t('providers.onlineCount')}: ${Object.values(newStatusMap).filter(s => s === 'online').length} / ${store.providers.length}`,
      })
    } catch (error) {
      toast({
        title: t('providers.refreshFailed'),
        description: t('providers.cannotRefreshProviderStatus'),
        variant: 'destructive',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleUpdateModels = async (providerId: string) => {
    try {
      if (providerId === 'glm' && !window.confirm(
        'GLM model discovery will open the official chatglm.cn website in a temporary, '
        + 'isolated guest browser. Its website may initialize a guest session. '
        + 'Your saved GLM account, refresh token and Chrome cookies will not be used '
        + 'or changed. This only lists public website model choices; it does NOT '
        + 'verify your account entitlements or a successful model invocation. Continue?',
      )) return
      if (providerId === 'deepseek' && !window.confirm(
        'DeepSeek currently publishes website chat modes (Quick/Expert), not versioned API model IDs. '
        + 'Refreshing replaces the bundled provider model names and can affect existing local model aliases. '
        + 'Cancel to keep the previous list, or OK to use the discovered website modes.',
      )) return
      setModelRefreshErrors(current => ({ ...current, [providerId]: '' }))
      toast({
        title: t('providers.updatingModels'),
        description: providerId === 'deepseek'
          ? 'Checking the public DeepSeek website chat modes; no account token will be sent.'
            : providerId === 'glm'
              ? 'Reading the official GLM guest model picker in an isolated temporary browser. Existing account secrets are not used.'
          : providerId === 'qwen'
            ? 'Trying the first-party Qwen China model list. Website session acceptance is not guaranteed.'
            : t('providers.updatingModels'),
      })
      
      const result = await window.electronAPI.providers.updateModels?.(providerId)
      
      if (result?.success) {
        setModelRefreshErrors(current => ({ ...current, [providerId]: '' }))
        const providers = await window.electronAPI.providers.getAll()
        useProvidersStore.getState().setProviders(providers)
        useProvidersStore.getState().setModelsLastUpdated(Date.now())
        toast({
          title: t('providers.modelsUpdated'),
          description: providerId === 'deepseek'
            ? `Synced ${result.modelsCount || 0} selectable website chat modes (not API version names). Live inference was not tested.`
            : providerId === 'glm'
              ? `Synced ${result.modelsCount || 0} GLM public GUEST website models. Account access and chat invocation were NOT tested.`
            : `Synced ${result.modelsCount || 0} web-chat models. Availability is not a successful model invocation.`,
        })
      } else {
        setModelRefreshErrors(current => ({
          ...current,
          [providerId]: result?.error || t('common.error'),
        }))
        toast({
          title: t('providers.updateModelsFailed'),
          description: result?.error || t('common.error'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      setModelRefreshErrors(current => ({ ...current, [providerId]: t('common.error') }))
      toast({
        title: t('providers.updateModelsFailed'),
        description: t('common.error'),
        variant: 'destructive',
      })
    }
  }

  const handleManageModels = (providerId: string) => {
    const provider = store.providers.find(p => p.id === providerId)
    if (provider) {
      setModelEditorProvider({ id: provider.id, name: provider.name })
      setShowModelEditor(true)
    }
  }

  const handleManageAccounts = (providerId: string) => {
    store.setSelectedProviderId(providerId)
    setViewMode('accounts')
  }

  const handleOpenProtectedZaiAccounts = async (definition: BuiltinProviderConfig): Promise<void> => {
    // This is a navigation/registration-only bridge, never a generic OAuth
    // login. An existing Z.ai provider and its accounts must not be recreated.
    if (definition.id !== 'zai') throw new Error('Invalid protected provider selection')
    const builtin = useProvidersStore.getState().builtinProviders.find(p => p.id === 'zai')
    if (!builtin) throw new Error('Protected Z.ai provider unavailable')

    const before = await window.electronAPI.providers.getAll()
    const existing = before.find(p => p.id === 'zai')
    if (existing && existing.type !== 'builtin') throw new Error('Protected Z.ai provider identity conflict')
    if (!existing) {
      // Only an explicit owner click may register the shipped builtin entry.
      // It creates NO Z.ai account, session, token or model mapping.
      const registered = await window.electronAPI.providers.add({
        id: builtin.id, name: builtin.name, type: 'builtin',
        authType: builtin.authType, apiEndpoint: builtin.apiEndpoint,
      })
      if (registered?.id !== 'zai' || registered.type !== 'builtin') {
        throw new Error('Protected Z.ai provider registration failed')
      }
    }

    const [providers, accounts] = await Promise.all([
      window.electronAPI.providers.getAll(),
      window.electronAPI.accounts.getAll(),
    ])
    if (!providers.some(p => p.id === 'zai' && p.type === 'builtin')) {
      throw new Error('Protected Z.ai provider unavailable after registration')
    }
    useProvidersStore.getState().setProviders(providers)
    useProvidersStore.getState().setAccounts(accounts)
    const zaiAccounts = accounts.filter(account => account.providerId === 'zai')
    useProvidersStore.getState().updateAccountCount(
      'zai', zaiAccounts.length, zaiAccounts.filter(account => account.status === 'active').length,
    )
    useProvidersStore.getState().setSelectedProviderId('zai')
    setViewMode('accounts')
    setShowAddProviderDialog(false)
    toast({
      title: 'Protected Z.ai account connection',
      description: zaiAccounts.length
        ? 'Select Reconnect Z.ai (keep account) for an existing account. Do not add a duplicate.'
        : 'No saved Z.ai account. Select Add Account to sign in and add one after verification.',
    })
  }

  const handleSelectBuiltinProvider = async (provider: BuiltinProviderConfig, credentials: Record<string, string>) => {
    // A stale legacy callback must never insert a Z.ai account or forward a
    // captured token through the renderer. Use the protected navigation above.
    if (provider.id === 'zai') throw new Error('Use protected Z.ai account management')
    let targetProvider = store.providers.find(p => p.id === provider.id)
    
    if (!targetProvider) {
      const newProvider = await window.electronAPI.providers.add({
        id: provider.id,
        name: provider.name,
        type: 'builtin',
        authType: provider.authType,
        apiEndpoint: provider.apiEndpoint,
        headers: provider.headers,
        description: provider.description,
        supportedModels: provider.supportedModels,
        credentialFields: provider.credentialFields,
      })
      store.addProvider(newProvider)
      targetProvider = newProvider
    }
    
    if (credentials && Object.keys(credentials).length > 0) {
      const account = await window.electronAPI.accounts.add({
        providerId: targetProvider.id,
        name: `${provider.name} ${t('providers.accounts')}`,
        credentials: credentials,
      })
      store.addAccount(account)
      
      const providerAccounts = store.getAccountsByProvider(targetProvider.id)
      store.updateAccountCount(targetProvider.id, providerAccounts.length, providerAccounts.filter(a => a.status === 'active').length)
    }
    
    setShowAddProviderDialog(false)
    toast({
      title: t('providers.addSuccess'),
      description: `${provider.name} ${t('providers.accounts')} ${t('providers.accountAdded')}`,
    })
  }

  const handleCreateCustomProvider = () => {
    setShowAddProviderDialog(false)
    setShowCustomProviderForm(true)
  }

  const handleCustomProviderFormSubmit = async (data: CustomProviderFormData) => {
    try {
      if (editingProvider) {
        const updated = await window.electronAPI.providers.update(editingProvider.id, {
          name: data.name,
          authType: data.authType,
          apiEndpoint: data.apiEndpoint,
          headers: data.headers,
          description: data.description,
          supportedModels: data.supportedModels,
        })
        if (updated) {
          store.updateProvider(editingProvider.id, updated)
          toast({
            title: t('providers.updateSuccess'),
            description: t('providers.providerConfigUpdated'),
          })
        }
      } else {
        const newProvider = await window.electronAPI.providers.add({
          name: data.name,
          authType: data.authType,
          apiEndpoint: data.apiEndpoint,
          headers: data.headers,
          description: data.description,
          supportedModels: data.supportedModels,
          credentialFields: data.credentialFields,
        })
        store.addProvider(newProvider)
        toast({
          title: t('providers.createSuccess'),
          description: t('providers.customProviderCreated'),
        })
      }
      setShowCustomProviderForm(false)
      setEditingProvider(null)
    } catch (error) {
      toast({
        title: editingProvider ? t('providers.updateFailed') : t('providers.createFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
    }
  }

  /** Replace renderer account metadata only from the authoritative main store.
   * Never merge an unverified status or plaintext edited credentials into the
   * cached account list. Store change notifications also use this source. */
  const reloadAccountMetadata = async (): Promise<void> => {
    // This authoritative account refresh supersedes an earlier page fetch.
    // It must not reread credentials or allow an older load to replace the
    // just-committed name, validation status or usage counters in React.
    const generation = ++dataRequestGenerationRef.current
    try {
      const accounts = await window.electronAPI.accounts.getAll()
      if (generation !== dataRequestGenerationRef.current) return
      const state = useProvidersStore.getState()
      state.setAccounts(accounts)
      if (state.selectedProviderId) {
        const providerAccounts = accounts.filter(account =>
          account.providerId === state.selectedProviderId)
        state.updateAccountCount(state.selectedProviderId,
          providerAccounts.length, providerAccounts.filter(account => account.status === 'active').length)
      }
    } finally {
      // An account write may supersede a still-pending initial load. Its
      // finally handler then (correctly) refuses to clear the newest loading
      // state, so the superseding refresh must settle that state instead.
      // Never clear it when a *newer* generation still owns the page.
      if (generation === dataRequestGenerationRef.current) {
        useProvidersStore.getState().setIsLoading(false)
      }
    }
  }

  const handleAddAccount = async (data: {
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => {
    if (!store.selectedProviderId) return
    
    try {
      const account = await window.electronAPI.accounts.add({
        providerId: store.selectedProviderId,
        name: data.name,
        email: data.email,
        credentials: data.credentials,
        dailyLimit: data.dailyLimit,
      })
      store.addAccount(account)
      
      const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
      store.updateAccountCount(
        store.selectedProviderId,
        providerAccounts.length,
        providerAccounts.filter(a => a.status === 'active').length
      )
      
      setShowAddAccountDialog(false)
      toast({
        title: t('providers.addSuccess'),
        description: 'Account saved as inactive. Use Validate Credentials on the saved account to activate it. Saving did not verify the provider.',
      })
    } catch (error) {
      toast({
        title: t('providers.addFailed'),
        description: error instanceof Error ? error.message : t('providers.cannotAddAccount'),
        variant: 'destructive',
      })
      // AddAccountDialog must retain the entered form on an uncommitted write.
      throw error
    }
  }

  const handleCreateZaiAccount = async (accountName: string): Promise<{
    success: boolean
    accountId?: string
    reason?: string
  }> => {
    // This path is only the explicit Z.ai new-account login button. The
    // credential, session partition and final store write stay in Electron
    // main; the renderer knows only the selected provider and display name.
    if (useProvidersStore.getState().selectedProviderId !== 'zai') {
      return { success: false, reason: 'provider_unavailable' }
    }
    let result: { success: boolean; accountId?: string; reason?: string }
    try {
      result = await window.electronAPI.oauth.createZaiAccount(accountName)
    } catch {
      return { success: false, reason: 'local_login_error' }
    }
    if (result.success && result.accountId) {
      // Never reinterpret a committed account creation as retryable failure
      // solely because refreshing the GUI failed afterward. Do not prolong
      // the UI's active-login/cancel state after the durable main receipt.
      // The refresh is metadata-only and independent of the login owner.
      void (async () => {
        try {
          const accounts = await window.electronAPI.accounts.getAll()
          useProvidersStore.getState().setAccounts(accounts)
          const providerAccounts = accounts.filter(account => account.providerId === 'zai')
          useProvidersStore.getState().updateAccountCount(
            'zai',
            providerAccounts.length,
            providerAccounts.filter(account => account.status === 'active').length,
          )
        } catch {
          // A committed success stays successful. A later page refresh
          // can safely refresh the list without creating another account.
        }
      })()
      toast({
        title: 'Z.ai account added',
        description: 'The official web session was verified and saved. Chat inference has not yet been tested.',
      })
    }
    return result
  }

  const handleUpdateAccount = async (id: string, updates: Partial<Account>) => {
    try {
      const account = store.getAccountById(id)
      if (!account) return
      
      const updated = await window.electronAPI.accounts.update(id, updates)
      if (updated) {
        // A successful write is irreversible even when the subsequent UI
        // metadata refresh fails. Avoid caching plaintext form credentials.
        try { await reloadAccountMetadata() } catch {}
        
        toast({
          title: t('providers.updateSuccess'),
          description: t('providers.accountUpdated'),
        })
      } else {
        throw new Error('Account update was not committed')
      }
    } catch (error) {
      toast({
        title: t('providers.updateFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
      // The form must not close/discard edits after an IPC/store refusal.
      throw error
    }
  }

  const handleDeleteAccount = async (id: string) => {
    try {
      const success = await window.electronAPI.accounts.delete(id)
      if (success) {
        const account = store.getAccountById(id)
        store.removeAccount(id)
        
        if (account && store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => a.status === 'active').length
          )
        }
        
        toast({
          title: t('providers.deleteSuccess'),
          description: t('providers.accountDeleted'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.deleteFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleValidateAccount = async (id: string) => {
    let isValid: boolean
    try {
      isValid = await window.electronAPI.accounts.validate(id)
    } catch (error) {
      // A canceled/superseded validation or refused durable write can reject
      // without changing stored status. The main store remains authoritative.
      try { await reloadAccountMetadata() } catch {}
      const errorMessage = error instanceof Error ? error.message : t('providers.operationFailed')
      toast({
        title: t('providers.validateFailed'),
        description: errorMessage,
        variant: 'destructive',
      })
      return
    }
    try { await reloadAccountMetadata() } catch {
      // Validation already reached a definite result; failure to refresh
      // metadata is not evidence that credentials became invalid.
    }
    toast(isValid ? {
      title: t('providers.validateSuccess'),
      description: t('providers.credentialsValid'),
    } : {
      title: t('providers.validateFailed'),
      description: 'Account validation was not confirmed. The saved status remains authoritative.',
      variant: 'destructive',
    })
  }

  const handleReconnectZaiAccount = async (id: string): Promise<void> => {
    const existing = store.getAccountById(id)
    if (!existing || existing.providerId !== 'zai') return
    // The progress channel is a trusted main-process status hint. Display only
    // these fixed messages, never a provider-supplied error, body or credential.
    const safeProgress: Record<string, string> = {
      'Opening login window...': 'Opening the official Z.ai sign-in page',
      'Reconnect the existing Z.ai account in the login window': 'Waiting for Z.ai sign-in',
      'Validating token...': 'Checking the detected sign-in credential',
      'Token invalid, waiting for valid login...': 'Waiting for a usable sign-in credential',
      'Session verification failed; continue logging in': 'Sign-in detected; server session verification was not accepted',
      'Validation error, waiting for valid login...': 'Sign-in verification was interrupted',
    }
    setZaiReconnectProgress(safeProgress['Opening login window...'])
    const unsubscribe = window.electronAPI.oauth.onProgress(({ message }) => {
      if (Object.prototype.hasOwnProperty.call(safeProgress, message)) {
        setZaiReconnectProgress(safeProgress[message])
      }
    })
    try {
      // No token/cookie enters the renderer; only an existing account ID.
      const result = await window.electronAPI.oauth.reconnectZaiAccount(id)
      if (!result.success || result.accountId !== id) {
        toast({
          title: 'Z.ai reconnection not completed',
          description: 'Existing account was preserved. Reason: ' + (result.reason || 'LOGIN_NOT_COMPLETED'),
          variant: 'destructive',
        })
        return
      }
      const accounts = await window.electronAPI.accounts.getAll()
      useProvidersStore.getState().setAccounts(accounts)
      const providerAccounts = accounts.filter(account => account.providerId === 'zai')
      useProvidersStore.getState().updateAccountCount(
        'zai', providerAccounts.length, providerAccounts.filter(account => account.status === 'active').length,
      )
      toast({
        title: 'Z.ai account reconnected',
        description: 'Existing account and model mappings were retained. Chat has not yet been live-tested.',
      })
    } catch {
      toast({
        title: 'Z.ai reconnection failed',
        description: 'The existing account was preserved; please use the official Z.ai login again.',
        variant: 'destructive',
      })
    } finally {
      unsubscribe()
      setZaiReconnectProgress(null)
    }
  }

  const handleValidateToken = async (providerId: string, credentials: Record<string, string>) => {
    return await window.electronAPI.accounts.validateToken(providerId, credentials)
  }

  const handleViewAccountDetail = (account: Account) => {
    store.setSelectedAccountId(account.id)
    setViewMode('account-detail')
  }

  const handleBackToProviders = () => {
    setViewMode('providers')
    store.setSelectedProviderId(null)
    store.setSelectedAccountId(null)
  }

  const handleBackToAccounts = () => {
    setViewMode('accounts')
    store.setSelectedAccountId(null)
  }

  const stats = {
    total: store.providers.length,
    builtin: store.providers.filter(p => p.type === 'builtin').length,
    custom: store.providers.filter(p => p.type === 'custom').length,
    enabled: store.providers.filter(p => p.enabled).length,
    online: Object.values(store.providerStatuses).filter(s => s === 'online').length,
  }

  if (store.isLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <div className="text-muted-foreground">{t('providers.loading')}</div>
      </div>
    )
  }

  const selectedProvider = store.selectedProviderId 
    ? store.getProviderById(store.selectedProviderId) 
    : null

  const selectedAccount = store.selectedAccountId 
    ? store.getAccountById(store.selectedAccountId) 
    : null

  const providerAccounts = store.selectedProviderId 
    ? store.getAccountsByProvider(store.selectedProviderId) 
    : []

  if (viewMode === 'account-detail' && selectedAccount && selectedProvider) {
    return (
      <div className="space-y-6">
        <AccountDetail
          account={selectedAccount}
          provider={selectedProvider}
          onBack={handleBackToAccounts}
          onEdit={async () => {
            // Edit only metadata already loaded from trusted main. Credentials
            // stay OS-protected; the account form supports deliberate reentry.
            setEditingAccount(selectedAccount)
            setViewMode('accounts')
            setShowAddAccountDialog(true)
          }}
          onDelete={() => handleDeleteAccount(selectedAccount.id)}
          onValidate={() => handleValidateAccount(selectedAccount.id)}
        />
      </div>
    )
  }

  if (viewMode === 'accounts' && selectedProvider) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button
            onClick={handleBackToProviders}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
            <span>{t('providers.backToProviderList')}</span>
          </button>
        </div>

        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {selectedProvider.name} - {t('providers.accountManagement')}
          </h2>
          <p className="text-muted-foreground">
            {t('providers.manageAllAccounts')}
          </p>
        </div>

        <AccountList
          accounts={providerAccounts}
          providerId={selectedProvider.id}
          onAddAccount={() => setShowAddAccountDialog(true)}
          onEditAccount={async (account) => {
            setEditingAccount(account)
            setShowAddAccountDialog(true)
          }}
          onDeleteAccount={handleDeleteAccount}
          onValidateAccount={handleValidateAccount}
          onReconnectZaiAccount={handleReconnectZaiAccount}
          reconnectProgress={zaiReconnectProgress}
          onViewDetail={handleViewAccountDetail}
        />

        <AddAccountDialog
          open={showAddAccountDialog}
          onOpenChange={(open) => {
            setShowAddAccountDialog(open)
            if (!open) setEditingAccount(null)
          }}
          provider={selectedProvider}
          onAddAccount={handleAddAccount}
          onCreateZaiAccount={handleCreateZaiAccount}
          onValidateToken={handleValidateToken}
          editingAccount={editingAccount}
          onUpdateAccount={handleUpdateAccount}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('providers.title')}</h2>
          <p className="text-muted-foreground">{t('providers.subtitle')}</p>
        </div>
      </div>

      <ProviderFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onRefresh={handleCheckAllStatus}
        onAddProvider={() => setShowAddProviderDialog(true)}
        isRefreshing={isRefreshing}
        stats={stats}
      />

      {filteredProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Server className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">{t('providers.noProvidersFound')}</p>
          <p className="text-sm">
            {searchQuery || typeFilter !== 'all' || statusFilter !== 'all'
              ? t('providers.tryAdjustingFilters')
              : t('providers.clickToAddProvider')}
          </p>
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-280px)]">
          <div className="grid gap-4 pr-4">
            {filteredProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                status={store.providerStatuses[provider.id]}
                accountCount={store.accountCounts[provider.id]?.total || 0}
                activeAccountCount={store.accountCounts[provider.id]?.active || 0}
                onToggle={handleToggleProvider}
                onEdit={handleEditProvider}
                onDelete={handleDeleteProvider}
                onDuplicate={handleDuplicateProvider}
                onCheckStatus={handleCheckProviderStatus}
                onManageAccounts={handleManageAccounts}
                onUpdateModels={handleUpdateModels}
                modelRefreshError={modelRefreshErrors[provider.id]}
                canUpdateModels={store.builtinProviders.some(
                  builtin => builtin.id === provider.id && !!builtin.modelsApiEndpoint,
                ) && (
                  ['deepseek', 'kimi', 'mimo', 'qwen', 'glm'].includes(provider.id) ||
                  (store.accountCounts[provider.id]?.active || 0) > 0
                )}
                onManageModels={handleManageModels}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <AddProviderDialog
        open={showAddProviderDialog}
        onOpenChange={setShowAddProviderDialog}
        builtinProviders={store.builtinProviders}
        onSelectBuiltin={handleSelectBuiltinProvider}
        onOpenProtectedZaiAccounts={handleOpenProtectedZaiAccounts}
        onCreateCustom={handleCreateCustomProvider}
        onValidateToken={handleValidateToken}
      />

      <CustomProviderForm
        open={showCustomProviderForm}
        onOpenChange={(open) => {
          setShowCustomProviderForm(open)
          if (!open) setEditingProvider(null)
        }}
        onSubmit={handleCustomProviderFormSubmit}
        initialData={editingProvider ? {
          name: editingProvider.name,
          authType: editingProvider.authType,
          apiEndpoint: editingProvider.apiEndpoint,
          headers: editingProvider.headers,
          description: editingProvider.description || '',
          supportedModels: editingProvider.supportedModels || [],
        } : undefined}
      />

      {modelEditorProvider && (
        <ModelEditor
          open={showModelEditor}
          onOpenChange={(open) => {
            setShowModelEditor(open)
            if (!open) setModelEditorProvider(null)
          }}
          providerId={modelEditorProvider.id}
          providerName={modelEditorProvider.name}
        />
      )}
    </div>
  )
}

export default Providers
