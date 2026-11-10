/**
 * Account List Component
 * Displays all accounts under a provider with status and actions
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu'
import { 
  MoreVertical, 
  Edit, 
  Trash2, 
  Check, 
  X, 
  Clock,
  User,
  RefreshCw,
  AlertCircle,
  Activity,
  Plus,
  Trash
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Account, AccountStatus } from '@/types/electron'
import { cn } from '@/lib/utils'

interface AccountListProps {
  accounts: Account[]
  providerId: string
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onDeleteAccount: (id: string) => void
  onValidateAccount: (id: string) => void
  onReconnectZaiAccount: (id: string) => Promise<void>
  reconnectProgress?: string | null
  onViewDetail: (account: Account) => void
}

export function AccountList({
  accounts,
  providerId,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onValidateAccount,
  onReconnectZaiAccount,
  reconnectProgress,
  onViewDetail,
}: AccountListProps) {
  const { t } = useTranslation()
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())
  const [clearingChatsId, setClearingChatsId] = useState<string | null>(null)
  const [showClearChatsDialog, setShowClearChatsDialog] = useState(false)
  const [selectedAccountForClear, setSelectedAccountForClear] = useState<Account | null>(null)
  const [selectedAccountForReconnect, setSelectedAccountForReconnect] = useState<Account | null>(null)
  const [reconnectingId, setReconnectingId] = useState<string | null>(null)

  const confirmReconnectZai = async () => {
    const account = selectedAccountForReconnect
    if (!account || providerId !== 'zai' || reconnectingId) return
    setReconnectingId(account.id)
    try {
      await onReconnectZaiAccount(account.id)
    } finally {
      setReconnectingId(null)
      setSelectedAccountForReconnect(null)
    }
  }

  const statusConfig: Record<AccountStatus, { 
    labelKey: string
    color: string
    bgColor: string
    icon: typeof Check
  }> = {
    active: {
      labelKey: 'providers.active',
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      icon: Check,
    },
    inactive: {
      labelKey: 'providers.inactive',
      color: 'text-gray-600',
      bgColor: 'bg-gray-100',
      icon: Clock,
    },
    expired: {
      labelKey: 'providers.expired',
      color: 'text-orange-600',
      bgColor: 'bg-orange-100',
      icon: AlertCircle,
    },
    error: {
      labelKey: 'common.error',
      color: 'text-red-600',
      bgColor: 'bg-red-100',
      icon: X,
    },
  }

  const handleValidate = async (id: string) => {
    setValidatingIds(prev => new Set(prev).add(id))
    try {
      await onValidateAccount(id)
    } finally {
      setValidatingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleClearChats = (account: Account) => {
    setSelectedAccountForClear(account)
    setShowClearChatsDialog(true)
  }

  const confirmClearChats = async () => {
    if (!selectedAccountForClear) return
    
    setClearingChatsId(selectedAccountForClear.id)
    try {
      const result = await window.electronAPI.accounts.clearChats(selectedAccountForClear.id)
      if (result.success) {
        console.log('[Renderer] Operation event')
      } else {
        console.error('[Renderer] Operation failed')
      }
    } catch (error) {
      console.error('Failed to clear chats:')
    } finally {
      setClearingChatsId(null)
      setShowClearChatsDialog(false)
      setSelectedAccountForClear(null)
    }
  }

  const activeCount = accounts.filter(a => a.status === 'active').length
  const totalCount = accounts.length

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatUsage = (account: Account) => {
    if (account.dailyLimit) {
      return `${account.todayUsed || 0} / ${account.dailyLimit}`
    }
    return account.todayUsed || 0
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <User className="h-12 w-12 text-muted-foreground opacity-50 mb-4" />
          <p className="text-lg font-medium text-muted-foreground">{t('common.noData')}</p>
          <p className="text-sm text-muted-foreground mb-4">
            {t('providers.clickToAddProvider')}
          </p>
          <Button onClick={onAddAccount}>
            <Plus className="mr-2 h-4 w-4" />
            {t('providers.addAccount')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('providers.total')}: {totalCount}</span>
          <span>•</span>
          <span className="text-green-600">{activeCount} {t('providers.onlineCount')}</span>
        </div>
        <Button size="sm" onClick={onAddAccount}>
          <Plus className="mr-2 h-4 w-4" />
          {t('providers.addAccount')}
        </Button>
      </div>

      <ScrollArea className="h-[calc(100vh-400px)]">
        <div className="space-y-3 pr-4">
          {accounts.map((account) => {
            const config = statusConfig[account.status]
            const StatusIcon = config.icon
            const isValidating = validatingIds.has(account.id)

            return (
              <Card 
                key={account.id} 
                className="hover:shadow-sm transition-shadow cursor-pointer"
                onClick={() => onViewDetail(account)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={cn(
                        'h-10 w-10 rounded-full flex items-center justify-center',
                        config.bgColor
                      )}>
                        <User className={cn('h-5 w-5', config.color)} />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{account.name}</span>
                          <Badge 
                            variant="outline" 
                            className={cn('text-xs', config.color, config.bgColor)}
                          >
                            <StatusIcon className="mr-1 h-3 w-3" />
                            {t(config.labelKey)}
                          </Badge>
                        </div>
                        
                        <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                          {account.email && (
                            <span className="truncate">{account.email}</span>
                          )}
                          <span>{t('dashboard.totalRequests')}: {account.requestCount || 0}</span>
                          <span>{t('providers.usedToday')}: {formatUsage(account)}</span>
                        </div>
                        
                        {account.status === 'error' && account.errorMessage && (
                          <p className="text-xs text-red-500 mt-1 truncate">
                            {account.errorMessage}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{t('providers.lastCheck')}</div>
                        <div>{formatDate(account.lastUsed)}</div>
                      </div>
                      
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              onViewDetail(account)
                            }}
                          >
                            <Activity className="mr-2 h-4 w-4" />
                            {t('common.details')}
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              handleValidate(account.id)
                            }}
                            disabled={isValidating}
                          >
                            <RefreshCw className={cn(
                              'mr-2 h-4 w-4',
                              isValidating && 'animate-spin'
                            )} />
                            {isValidating ? t('oauth.validating') : t('providers.validateCredentials')}
                          </DropdownMenuItem>
                          {providerId === 'zai' && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedAccountForReconnect(account)
                              }}
                              disabled={reconnectingId !== null}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              Reconnect Z.ai (keep account)
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              onEditAccount(account)
                            }}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            {t('providers.editAccount')}
                          </DropdownMenuItem>
                          {/* Show Clear Chats for supported web providers */}
                          {(providerId === 'kimi' || providerId === 'qwen' || providerId === 'qwen-ai' || providerId === 'minimax' || providerId === 'zai' || providerId === 'perplexity' || providerId === 'deepseek' || providerId === 'glm' || providerId === 'mimo') && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem 
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleClearChats(account)
                                }}
                                disabled={clearingChatsId === account.id}
                                className="text-amber-600"
                              >
                                <Trash className="mr-2 h-4 w-4" />
                                {clearingChatsId === account.id ? t('common.loading') : t('providers.clearChats')}
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              onDeleteAccount(account.id)
                            }}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('providers.deleteAccount')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>

      {/* Clear Chats Confirmation Dialog */}
      <Dialog open={showClearChatsDialog} onOpenChange={setShowClearChatsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers.clearChats')}</DialogTitle>
            <DialogDescription>
              <div className="space-y-2">
                <p>{t('providers.clearChatsConfirm')}</p>
                <p className="text-amber-600 font-medium">{t('providers.clearChatsWarning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowClearChatsDialog(false)
              setSelectedAccountForClear(null)
            }}>
              {t('common.cancel')}
            </Button>
            <Button 
              onClick={confirmClearChats}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Explicit account-bound consent. The official site may require the
          user to complete CAPTCHA/2FA; no account replacement is authorized. */}
      <Dialog open={!!selectedAccountForReconnect} onOpenChange={(open) => {
        if (!open && !reconnectingId) setSelectedAccountForReconnect(null)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconnect existing Z.ai account</DialogTitle>
            <DialogDescription>
              Continue with the official Z.ai web login for <strong>{selectedAccountForReconnect?.name}</strong>?
              The existing account, provider mapping and credentials will be kept if login fails.
              Only the same Z.ai identity can replace this account's expired token.
              Sign in inside the Z.ai window opened by this app; a separate Chrome login is not imported.
              {reconnectingId && reconnectProgress && (
                <span className="mt-3 block" role="status">{reconnectProgress}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={!!reconnectingId} onClick={() => setSelectedAccountForReconnect(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!!reconnectingId} onClick={() => void confirmReconnectZai()}>
              {reconnectingId ? 'Waiting for Z.ai login…' : 'Open Z.ai login'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default AccountList
