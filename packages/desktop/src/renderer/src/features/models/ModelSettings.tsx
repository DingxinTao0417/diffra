import { useCallback, useEffect, useRef, useState } from 'react'
import { Boxes, Plus } from 'lucide-react'
import type { SettingsView } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { errorMessage } from '@/lib/errors'
import { setLeaveGuard } from '@/state/actions'
import { SavedHint, SettingsHeader, useSavedFlash } from '../settings/SettingsLayout'
import { ProviderCard } from './ProviderCard'
import { ProviderForm } from './ProviderForm'
import { RolesCard } from './RolesCard'

// 同一时间只展开一个面板：添加服务，或者编辑某个服务
type OpenPanel = { kind: 'add' } | { kind: 'edit'; id: string } | null
// 有没保存的改动时被拦下来、等用户确认的那一步：切到别的面板，或者离开这一页
type Pending = { kind: 'panel'; next: OpenPanel } | { kind: 'leave'; proceed(): void }

export function ModelSettings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [open, setOpen] = useState<OpenPanel>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const dirty = useRef(false)
  const [saved, flashSaved] = useSavedFlash()

  useEffect(() => {
    window.diffra.getSettings().then(setView, (error: unknown) => setReadError(errorMessage(error)))
  }, [])

  // 返回、换设置分区、后退、快捷键等离开这一页时，面板里有没保存的改动先问
  useEffect(() => {
    setLeaveGuard((proceed) => {
      if (!dirty.current) return true
      setPending({ kind: 'leave', proceed })
      return false
    })
    return () => setLeaveGuard(null)
  }, [])

  // 展开的服务被删掉了，面板跟着收起
  useEffect(() => {
    if (open?.kind === 'edit' && view && !view.providers.some((provider) => provider.id === open.id)) {
      dirty.current = false
      setOpen(null)
    }
  }, [open, view])

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value
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
  const changed = (next: SettingsView) => {
    setView(next)
    flashSaved(true)
  }
  const show = (next: OpenPanel) => {
    dirty.current = false
    setOpen(next)
  }
  // 有没保存的改动时先问；保存成功、点了取消都直接走 show
  const request = (next: OpenPanel) => {
    if (dirty.current) setPending({ kind: 'panel', next })
    else show(next)
  }
  const adding = open?.kind === 'add'
  const addForm = (
    <ProviderForm
      provider={null}
      onSaved={(next) => {
        changed(next)
        show(null)
      }}
      onCancel={() => show(null)}
      onDirtyChange={setDirty}
    />
  )

  return (
    <div>
      <SettingsHeader title="模型与角色" description="用 API Key 接入模型服务，再给各个角色分配模型。" actions={<SavedHint saved={saved} note="新任务生效" />} />

      <div className="space-y-8">
        {view.loadError && (
          <Alert variant="destructive">
            <AlertTitle>设置暂时无法保存</AlertTitle>
            <AlertDescription>{view.loadError}</AlertDescription>
          </Alert>
        )}

        {empty && !adding ? (
          <EmptyState icon={Boxes} title="还没有接入模型" description="填好服务地址和 API Key，再选要用的模型。" variant="card">
            <Button onClick={() => request({ kind: 'add' })} disabled={view.loadError !== null}>
              <Plus />
              添加模型服务
            </Button>
          </EmptyState>
        ) : (
          <section>
            <h2 className="mb-2 text-sm font-bold">模型服务</h2>
            {!empty && (
              <div className="divide-y rounded-xl border bg-card">
                {view.providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    roles={view.roles}
                    expanded={open?.kind === 'edit' && open.id === provider.id}
                    onExpand={() => request({ kind: 'edit', id: provider.id })}
                    onCollapse={(force) => (force ? show(null) : request(null))}
                    onChange={changed}
                    onDirtyChange={setDirty}
                  />
                ))}
                {!adding && (
                  <button
                    type="button"
                    disabled={view.loadError !== null}
                    className="flex w-full items-center gap-3 rounded-b-xl px-4 py-3 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => request({ kind: 'add' })}
                  >
                    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-input">
                      <Plus className="size-4" />
                    </span>
                    添加模型服务
                  </button>
                )}
              </div>
            )}
            {adding && <div className={empty ? 'rounded-2xl bg-muted p-5' : 'mt-3 rounded-2xl bg-muted p-5'}>{addForm}</div>}
          </section>
        )}

        {hasModels ? (
          <RolesCard view={view} onChange={changed} />
        ) : (
          !empty && <p className="text-sm text-muted-foreground">添加模型后可以在这里分配角色。</p>
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(next) => !next && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃没保存的改动？</AlertDialogTitle>
            <AlertDialogDescription>刚才填写的内容不会保存。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setPending(null)
                if (pending?.kind === 'panel') show(pending.next)
                if (pending?.kind === 'leave') {
                  dirty.current = false
                  pending.proceed()
                }
              }}
            >
              放弃
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
