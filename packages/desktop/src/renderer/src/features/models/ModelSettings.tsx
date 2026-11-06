import { useEffect, useState } from 'react'
import type { ProviderView, SettingsView } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { ProviderCard } from './ProviderCard'
import { ProviderDialog } from './ProviderDialog'
import { RolesCard } from './RolesCard'

export function ModelSettings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; provider: ProviderView | null }>({ open: false, provider: null })

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">模型</h1>
          <p className="text-sm text-muted-foreground">用 API Key 接入模型服务，再给各个角色分配模型。</p>
        </div>
        <Button onClick={() => setDialog({ open: true, provider: null })} disabled={view.loadError !== null}>
          添加供应商
        </Button>
      </div>

      {view.loadError && (
        <Alert variant="destructive">
          <AlertTitle>设置暂时无法保存</AlertTitle>
          <AlertDescription>{view.loadError}</AlertDescription>
        </Alert>
      )}

      {view.providers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有供应商。点「添加供应商」，选一个预置或自定义。
        </p>
      ) : (
        view.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onChange={setView}
            onEdit={() => setDialog({ open: true, provider })}
          />
        ))
      )}

      <RolesCard view={view} onChange={setView} />

      <ProviderDialog
        open={dialog.open}
        provider={dialog.provider}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSaved={setView}
      />
    </div>
  )
}
