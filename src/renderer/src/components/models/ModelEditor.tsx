/**
 * Model Editor Component
 * Manages default and custom models for a provider
 */

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { useProvidersStore } from '@/stores/providersStore'
import type { EffectiveModel } from '@/types/electron'
import { Plus, Trash2, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react'

interface ModelEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerName: string
}

export function ModelEditor({
  open,
  onOpenChange,
  providerId,
  providerName,
}: ModelEditorProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const setModelsLastUpdated = useProvidersStore((state) => state.setModelsLastUpdated)

  const [models, setModels] = useState<EffectiveModel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newActualModelId, setNewActualModelId] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)
  // A preceding read can finish after add/remove/reset, or after the dialog
  // switches providers. It must not undo an acknowledged persisted model edit.
  const modelRequestGenerationRef = useRef(0)

  useEffect(() => {
    if (open) {
      void loadModels()
    } else {
      ++modelRequestGenerationRef.current
      setIsLoading(false)
    }
    return () => { ++modelRequestGenerationRef.current }
  }, [open, providerId])

  const loadModels = async () => {
    const generation = ++modelRequestGenerationRef.current
    setIsLoading(true)
    try {
      const effectiveModels = await window.electronAPI.providers.getEffectiveModels(providerId)
      if (generation !== modelRequestGenerationRef.current) return
      setModels(effectiveModels || [])
    } catch (error) {
      if (generation !== modelRequestGenerationRef.current) return
      console.error('Failed to load models:')
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Failed to load models',
        variant: 'destructive',
      })
    } finally {
      if (generation === modelRequestGenerationRef.current) setIsLoading(false)
    }
  }

  const defaultModels = models.filter(m => !m.isCustom)
  const customModels = models.filter(m => m.isCustom)

  const handleAddModel = async () => {
    if (!newDisplayName.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameRequired'),
        variant: 'destructive',
      })
      return
    }

    if (!newActualModelId.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.idRequired'),
        variant: 'destructive',
      })
      return
    }

    if (models.some(m => m.displayName === newDisplayName.trim())) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameExists'),
        variant: 'destructive',
      })
      return
    }

    const generation = ++modelRequestGenerationRef.current
    setIsAdding(true)
    try {
      const result = await window.electronAPI.providers.addCustomModel(providerId, {
        displayName: newDisplayName.trim(),
        actualModelId: newActualModelId.trim(),
      })

      if (generation !== modelRequestGenerationRef.current) return
      if (result.success) {
        setModels(result.models)
        setIsLoading(false)
        setNewDisplayName('')
        setNewActualModelId('')
        setIsAddDialogOpen(false)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.addSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to add model')
      }
    } catch (error) {
      if (generation !== modelRequestGenerationRef.current) return
      console.error('Failed to add model:')
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.addError'),
        variant: 'destructive',
      })
    } finally {
      if (generation === modelRequestGenerationRef.current) {
        setIsAdding(false)
        setIsLoading(false)
      }
    }
  }

  const handleRemoveModel = async (modelName: string) => {
    const generation = ++modelRequestGenerationRef.current
    setDeletingModel(modelName)
    try {
      const result = await window.electronAPI.providers.removeModel(providerId, modelName)

      if (generation !== modelRequestGenerationRef.current) return
      if (result.success) {
        setModels(result.models)
        setIsLoading(false)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.removeSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to remove model')
      }
    } catch (error) {
      if (generation !== modelRequestGenerationRef.current) return
      console.error('Failed to remove model:')
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.removeError'),
        variant: 'destructive',
      })
    } finally {
      if (generation === modelRequestGenerationRef.current) {
        setDeletingModel(null)
        setIsLoading(false)
      }
    }
  }

  const handleResetModels = async () => {
    if (!window.confirm(t('modelEditor.confirmReset'))) {
      return
    }

    const generation = ++modelRequestGenerationRef.current
    setIsResetting(true)
    try {
      const result = await window.electronAPI.providers.resetModels(providerId)

      if (generation !== modelRequestGenerationRef.current) return
      if (result.success) {
        setModels(result.models)
        setIsLoading(false)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.resetSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to reset models')
      }
    } catch (error) {
      if (generation !== modelRequestGenerationRef.current) return
      console.error('Failed to reset models:')
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.resetError'),
        variant: 'destructive',
      })
    } finally {
      if (generation === modelRequestGenerationRef.current) {
        setIsResetting(false)
        setIsLoading(false)
      }
    }
  }

  const renderModelTable = (modelList: EffectiveModel[]) => {
    if (modelList.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground border rounded-lg">
          <p className="text-sm">{t('modelEditor.noModels')}</p>
        </div>
      )
    }

    return (
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('modelEditor.displayName')}</TableHead>
              <TableHead>{t('modelEditor.actualModelId')}</TableHead>
              <TableHead className="w-[80px]">{t('modelEditor.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modelList.map((model) => {
              const isDeleting = deletingModel === model.displayName
              const showBoth = model.displayName !== model.actualModelId

              return (
                <TableRow key={model.displayName}>
                  <TableCell>
                    <code className="text-sm">{model.displayName}</code>
                  </TableCell>
                  <TableCell>
                    <code className="text-sm">
                      {showBoth ? model.actualModelId : model.displayName}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (window.confirm(t('modelEditor.confirmDelete'))) {
                          handleRemoveModel(model.displayName)
                        }
                      }}
                      disabled={isDeleting}
                      className="h-8 w-8 text-destructive hover:text-destructive"
                    >
                      {isDeleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('modelEditor.title', { name: providerName })}
            </DialogTitle>
            <DialogDescription>
              {t('modelEditor.warningMessage')}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6 mt-4">
              <div>
                <h3 className="text-lg font-semibold mb-3">{t('modelEditor.defaultModels')}</h3>
                {renderModelTable(defaultModels)}
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-3">{t('modelEditor.customModels')}</h3>
                {renderModelTable(customModels)}
              </div>

              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t('modelEditor.warningMessage')}
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter className="mt-6">
            <div className="flex gap-2 w-full justify-between">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsAddDialogOpen(true)}
                  disabled={isLoading}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {t('modelEditor.addModel')}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleResetModels}
                  disabled={isLoading || isResetting}
                >
                  {isResetting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4 mr-2" />
                  )}
                  {t('modelEditor.resetDefault')}
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('modelEditor.cancel')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('modelEditor.addDialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('modelEditor.displayNameLabel')}</Label>
              <Input
                id="displayName"
                placeholder={t('modelEditor.displayNamePlaceholder')}
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.displayNameHelp')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="actualModelId">{t('modelEditor.actualIdLabel')}</Label>
              <Input
                id="actualModelId"
                placeholder={t('modelEditor.actualIdPlaceholder')}
                value={newActualModelId}
                onChange={(e) => setNewActualModelId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.actualIdHelp')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddDialogOpen(false)
                setNewDisplayName('')
                setNewActualModelId('')
              }}
              disabled={isAdding}
            >
              {t('modelEditor.cancel')}
            </Button>
            <Button onClick={handleAddModel} disabled={isAdding}>
              {isAdding ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                t('modelEditor.add')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default ModelEditor
