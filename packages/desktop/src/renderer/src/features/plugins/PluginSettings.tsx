import { type FormEvent, useState } from 'react'
import { Ellipsis, Folder, GitBranch, Puzzle, Trash2, TriangleAlert } from 'lucide-react'
import type { PluginPrepared } from '../../../../shared/ipc'
import type { PluginView } from '../../../../shared/settings'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { contentsSummary, ExtensionRow, HookList, initialOf, RowPanel, SectionTitle } from '@/features/extensions/parts'
import { PluginReview } from '@/features/extensions/PluginReview'
import { errorMessage } from '@/lib/errors'

// 钩子现在的状态：允许时记的指纹和现在的一样才算允许；不一样是钩子变了，不会运行
function hooksState(plugin: PluginView): 'none' | 'allowed' | 'off' | 'changed' {
  if (!plugin.info || plugin.info.hooks.length === 0) return 'none'
  if (!plugin.hooksApproved) return 'off'
  return plugin.hooksApproved === plugin.info.hooksFingerprint ? 'allowed' : 'changed'
}

const HOOK_NOTES = { allowed: '钩子已允许', off: '钩子没允许，不会运行', changed: '钩子变了，没重新允许前不会运行' } as const

// 扩展页「已安装」里的插件（第 601 步从设置搬过来）：开关、钩子允许与否、内容、删除；也能从文件夹或 Git 地址装目录里没有的
export function PluginInstalled({ plugins, error, onChange, onError, onBrowse }: { plugins: PluginView[] | null; error: string | null; onChange(plugins: PluginView[]): void; onError(error: string | null): void; onBrowse(): void }) {
  const run = async (action: () => Promise<PluginView[]>) => {
    onError(null)
    try {
      onChange(await action())
    } catch (caught) {
      onError(errorMessage(caught))
    }
  }
  const empty = plugins !== null && plugins.length === 0
  const manual = <ManualPluginInstall onInstalled={onChange} onError={onError} />

  return (
    <section>
      <SectionTitle actions={!empty && manual}>插件</SectionTitle>
      {error && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}
      {plugins === null ? (
        <p className="text-sm text-muted-foreground">正在读取插件…</p>
      ) : empty ? (
        <EmptyState icon={Puzzle} variant="card" title="还没有插件" description="装上插件，就能用它带来的命令、Skill、子智能体和钩子。">
          <Button variant="outline" onClick={onBrowse}>
            去目录看看
          </Button>
          {manual}
        </EmptyState>
      ) : (
        plugins.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            onToggle={(enabled) => void run(() => window.diffra.setPluginEnabled(plugin.id, enabled))}
            onHooks={(allowed) => void run(() => window.diffra.setPluginHooks(plugin.id, allowed))}
            onDelete={() => void run(() => window.diffra.deletePlugin(plugin.id))}
          />
        ))
      )}
    </section>
  )
}

function PluginRow({ plugin, onToggle, onHooks, onDelete }: { plugin: PluginView; onToggle(enabled: boolean): void; onHooks(allowed: boolean): void; onDelete(): void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const info = plugin.info
  const git = plugin.source === 'git'
  const SourceIcon = git ? GitBranch : Folder
  const hooks = hooksState(plugin)
  const source = git ? [plugin.url, plugin.subdir].filter(Boolean).join(' · ') : plugin.dir
  return (
    <ExtensionRow
      testId="plugin-card"
      initial={initialOf(plugin.name)}
      name={
        <>
          {plugin.name}
          {info?.version && <span className="ml-2 text-xs font-normal text-muted-foreground">v{info.version.replace(/^v/i, '')}</span>}
        </>
      }
      wide
      detail={
        <span data-testid="plugin-contents" className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="inline-flex shrink-0 items-center gap-1" title={source}>
            <SourceIcon aria-hidden className="size-3.5" />
            {git ? 'Git' : '本地文件夹'}
          </span>
          {plugin.error ? (
            <span className="text-destructive">读不了这个插件：{plugin.error}</span>
          ) : (
            info && (
              <span>
                {contentsSummary(info)}
                {hooks !== 'none' && <span className={hooks === 'changed' ? 'text-warning' : undefined}>，{HOOK_NOTES[hooks]}</span>}
              </span>
            )
          )}
        </span>
      }
      actions={
        <>
          {info && (
            <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '查看'}
            </Button>
          )}
          <Switch label={`启用 ${plugin.name}`} checked={plugin.enabled} onChange={onToggle} />
          {/* 非模态：菜单关闭和对话框打开同时发生时，模态菜单会把页面留在不可点击的状态 */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`${plugin.name} 插件操作`}>
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-36">
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                <Trash2 />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      {expanded && info && (
        <RowPanel className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-3 space-y-0 text-sm" data-testid="plugin-detail">
          <span className="text-xs text-muted-foreground">来源</span>
          <span className="font-mono text-xs break-all">{source}</span>
          {hooks !== 'none' && (
            <>
              <span className="text-xs text-muted-foreground">钩子</span>
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <Checkbox checked={hooks === 'allowed'} onCheckedChange={(value) => onHooks(value === true)} />
                  允许钩子在本机自动运行
                </label>
                {hooks === 'changed' && (
                  <p className="flex items-start gap-1.5 text-xs">
                    <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>钩子和你允许时不一样了，现在不会运行。看过下面的命令后再勾上。</span>
                  </p>
                )}
                <HookList hooks={info.hooks} />
              </div>
            </>
          )}
          <span className="text-xs text-muted-foreground">内容</span>
          <div className="flex flex-wrap gap-1">
            {[...info.commands.map((name) => `/${name}`), ...info.skills, ...info.agents, ...info.mcpServers].map((name) => (
              <Badge key={name} variant="secondary" className="font-mono">
                {name}
              </Badge>
            ))}
          </div>
          {info.unsupported.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">不支持</span>
              <span className="flex items-start gap-1.5 text-xs">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>Diffra 暂不支持、已忽略：{info.unsupported.join('、')}</span>
              </span>
            </>
          )}
        </RowPanel>
      )}

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除插件「{plugin.name}」？</AlertDialogTitle>
            <AlertDialogDescription>{git ? '会连同克隆下来的文件一起删除。' : '只是不再使用，文件夹保留不动。'}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive-solid" onClick={() => onDelete()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ExtensionRow>
  )
}

// 目录里没有的插件：从文件夹或 Git 地址装。取回后带钩子的先在对话框里给用户看，没有钩子的直接装
export function ManualPluginInstall({ onInstalled, onError }: { onInstalled(plugins: PluginView[]): void; onError(error: string | null): void }) {
  const [dialog, setDialog] = useState<{ open: false } | { open: true; prepared: PluginPrepared | null }>({ open: false })
  const [busy, setBusy] = useState(false)

  const commit = async (prepared: PluginPrepared, allowHooks: boolean) => {
    onInstalled(await window.diffra.commitPlugin(prepared.token, allowHooks))
    setDialog({ open: false })
  }

  const fromFolder = async () => {
    onError(null)
    setBusy(true)
    try {
      const prepared = await window.diffra.preparePlugin({ kind: 'folder' })
      if (prepared && prepared.info.hooks.length === 0) await commit(prepared, false)
      else if (prepared) setDialog({ open: true, prepared })
    } catch (caught) {
      onError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (dialog.open && dialog.prepared) window.diffra.discardPlugin(dialog.prepared.token).catch((caught: unknown) => console.error('放弃安装插件失败', caught))
    setDialog({ open: false })
  }

  return (
    <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void fromFolder()}>
        从文件夹安装
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog({ open: true, prepared: null })}>
        从 Git 安装
      </Button>
      <Dialog open={dialog.open} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{dialog.open && dialog.prepared ? '安装插件' : '从 Git 安装插件'}</DialogTitle>
            <DialogDescription>插件里的 MCP 服务器和钩子会在本机运行命令，只装信任的来源。</DialogDescription>
          </DialogHeader>
          {dialog.open && dialog.prepared ? (
            <ReviewStep prepared={dialog.prepared} onCommit={commit} onCancel={close} />
          ) : (
            <GitInstallForm
              onCancel={close}
              onPrepared={async (prepared) => {
                if (prepared.info.hooks.length === 0) await commit(prepared, false)
                else setDialog({ open: true, prepared })
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function ReviewStep({ prepared, onCommit, onCancel }: { prepared: PluginPrepared; onCommit(prepared: PluginPrepared, allowHooks: boolean): Promise<void>; onCancel(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <PluginReview
        prepared={prepared}
        busy={busy}
        onCancel={onCancel}
        onInstall={async (allowHooks) => {
          setBusy(true)
          setError(null)
          try {
            await onCommit(prepared, allowHooks)
          } catch (caught) {
            setError(errorMessage(caught))
          } finally {
            setBusy(false)
          }
        }}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function GitInstallForm({ onCancel, onPrepared }: { onCancel(): void; onPrepared(prepared: PluginPrepared): Promise<void> }) {
  const [url, setUrl] = useState('')
  const [subdir, setSubdir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const prepared = await window.diffra.preparePlugin({ kind: 'git', url: url.trim(), subdir: subdir.trim() })
      if (prepared) await onPrepared(prepared)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="plugin-git-url" label="仓库地址">
        <Input id="plugin-git-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/plugin.git" required />
      </Field>
      <Field id="plugin-git-subdir" label="子目录（可选）" hint="插件放在仓库的某个子目录里时填，比如 plugins/feature-dev；只取这个目录。">
        <Input id="plugin-git-subdir" value={subdir} onChange={(event) => setSubdir(event.target.value)} placeholder="plugins/feature-dev" />
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? '正在克隆…' : '安装'}
        </Button>
      </DialogFooter>
    </form>
  )
}
