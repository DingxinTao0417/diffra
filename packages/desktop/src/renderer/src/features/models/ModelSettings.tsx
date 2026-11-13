import { useEffect, useState } from 'react'
import { Boxes, Plus } from 'lucide-react'
import type { ProviderView, SettingsView } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { errorMessage } from '@/lib/errors'
import { SavedHint, SettingsHeader, useSavedFlash } from '../settings/SettingsLayout'
import { ProviderCard } from './ProviderCard'
import { ProviderDialog } from './ProviderDialog'
import { RolesCard } from './RolesCard'

export function ModelSettings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; provider: ProviderView | null }>({ open: false, provider: null })
  const [saved, flashSaved] = useSavedFlash()

  useEffect(() => {
    window.diffra.getSettings().then(setView, (error: unknown) => setReadError(errorMessage(error)))
  }, [])

  if (readError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>读取设置失败</AlertTitle>
        <AlertDescription>{readError}</AlertDescription>
      </Alert>
    )
  }
  if (!view) return <p className="text-sm text-muted-foreground">正在读取设置…</p>

  const empty = view.providers.length === 0
  const hasModels = view.providers.some((provider) => provider.models.length > 0)
  const addProvider = () => setDialog({ open: true, provider: null })
  const changed = (next: SettingsView) => {
    setView(next)
    flashSaved(true)
  }

  return (
    <div>
      <SettingsHeader
        title="模型与角色"
        description="用 API Key 接入模型服务，再给各个角色分配模型。"
        actions={
          <>
            <SavedHint saved={saved} note="新任务生效" />
            {/* 列表为空时添加按钮只放在空状态里，页头不重复 */}
            {!empty && (
              <Button onClick={addProvider} disabled={view.loadError !== null}>
                <Plus />
                添加模型服务
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-6">
        {view.loadError && (
          <Alert variant="destructive">
            <AlertTitle>设置暂时无法保存</AlertTitle>
            <AlertDescription>{view.loadError}</AlertDescription>
          </Alert>
        )}

        {empty ? (
          <EmptyState icon={Boxes} title="还没有接入模型" description="填好服务地址和 API Key，再选要用的模型。" variant="card">
            <Button onClick={addProvider} disabled={view.loadError !== null}>
              <Plus />
              添加模型服务
            </Button>
          </EmptyState>
        ) : (
          view.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              roles={view.roles}
              onChange={changed}
              onEdit={() => setDialog({ open: true, provider })}
            />
          ))
        )}

        {hasModels ? (
          <RolesCard view={view} onChange={changed} />
        ) : (
          !empty && <p className="text-sm text-muted-foreground">添加模型后可以在这里分配角色。</p>
        )}
      </div>

      <ProviderDialog
        open={dialog.open}
        provider={dialog.provider}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSaved={changed}
      />
    </div>
  )
}
