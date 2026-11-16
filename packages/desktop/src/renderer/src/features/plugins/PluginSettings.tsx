import { type FormEvent, useState } from 'react'
import { Ellipsis, Folder, GitBranch, Loader2, Puzzle, Trash2, TriangleAlert } from 'lucide-react'
import type { PluginPrepared, PluginUpdateCheck, PluginUpdatePrepared } from '../../../../shared/ipc'
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
import { brandIcon } from '@/features/extensions/brand-icons'
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
  // 插件更新（v2）：手动查，只查从 Git 装的；结果按插件 id
  const [updates, setUpdates] = useState<Record<string, PluginUpdateCheck> | null>(null)
  const [checking, setChecking] = useState(false)
  const gitPlugins = (plugins ?? []).filter((plugin) => plugin.source === 'git')
  const checkUpdates = async () => {
    setChecking(true)
    onError(null)
    try {
      setUpdates(Object.fromEntries((await window.diffra.checkPluginUpdates()).map((item) => [item.pluginId, item])))
    } catch (caught) {
      onError(errorMessage(caught))
    } finally {
      setChecking(false)
    }
  }
  const results = updates ? Object.values(updates) : []
  const available = results.filter((item) => item.state === 'available').length
  const failed = results.filter((item) => item.state === 'error').length

  return (
    <section>
      <SectionTitle
        actions={
          !empty && (
            <>
              {gitPlugins.length > 0 && (
                <Button size="sm" variant="ghost" disabled={checking} onClick={() => void checkUpdates()}>
                  {checking && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
                  {checking ? '正在检查…' : '检查更新'}
                </Button>
              )}
              {manual}
            </>
          )
        }
      >
        插件
      </SectionTitle>
      {updates && !checking && (
        <p className="mb-2 text-xs text-muted-foreground" data-testid="plugin-update-summary">
          {available > 0 ? `${available} 个插件有新版本` : failed > 0 ? '' : '从 Git 装的插件都是最新的'}
          {failed > 0 && <span className="text-warning">{available > 0 ? '；' : ''}{failed} 个没查成，原因写在插件下面</span>}
        </p>
      )}
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
            update={updates?.[plugin.id] ?? null}
            onUpdated={(next) => {
              onChange(next)
              setUpdates((current) => current && { ...current, [plugin.id]: { pluginId: plugin.id, state: 'latest', current: null, latest: null, error: null } })
            }}
            onToggle={(enabled) => void run(() => window.diffra.setPluginEnabled(plugin.id, enabled))}
            onHooks={(allowed) => void run(() => window.diffra.setPluginHooks(plugin.id, allowed))}
            onDelete={() => void run(() => window.diffra.deletePlugin(plugin.id))}
          />
        ))
      )}
    </section>
  )
}

function PluginRow({
  plugin,
  update,
  onUpdated,
  onToggle,
  onHooks,
  onDelete,
}: {
  plugin: PluginView
  update: PluginUpdateCheck | null
  onUpdated(plugins: PluginView[]): void
  onToggle(enabled: boolean): void
  onHooks(allowed: boolean): void
  onDelete(): void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // 更新：取回新版本（fetching）→ 给用户看（review）→ 换上（applying）
  const [updating, setUpdating] = useState<{ phase: 'fetching' } | { phase: 'review' | 'applying'; prepared: PluginUpdatePrepared } | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const fetchUpdate = async () => {
    setUpdating({ phase: 'fetching' })
    setUpdateError(null)
    try {
      setUpdating({ phase: 'review', prepared: await window.diffra.preparePluginUpdate(plugin.id) })
    } catch (caught) {
      setUpdating(null)
      setUpdateError(errorMessage(caught))
    }
  }
  const applyUpdate = async (prepared: PluginUpdatePrepared, allowHooks: boolean) => {
    setUpdating({ phase: 'applying', prepared })
    setUpdateError(null)
    try {
      const next = await window.diffra.commitPluginUpdate(prepared.token, allowHooks)
      setUpdating(null)
      onUpdated(next)
    } catch (caught) {
      setUpdating(null)
      setUpdateError(errorMessage(caught))
    }
  }
  const cancelUpdate = (prepared: PluginUpdatePrepared) => {
    setUpdating(null)
    window.diffra.discardPlugin(prepared.token).catch((caught: unknown) => setUpdateError(errorMessage(caught)))
  }
  const info = plugin.info
  const git = plugin.source === 'git'
  const SourceIcon = git ? GitBranch : Folder
  const hooks = hooksState(plugin)
  const source = git ? [plugin.url, plugin.subdir].filter(Boolean).join(' · ') : plugin.dir
  return (
    <ExtensionRow
      testId="plugin-card"
      initial={initialOf(plugin.name)}
      brand={brandIcon(plugin.name)}
      name={
        <>
          {plugin.name}
          {info?.version && <span className="ml-2 text-xs font-normal text-muted-foreground">v{info.version.replace(/^v/i, '')}</span>}
          {update?.state === 'available' && (
            <Badge variant="warning" className="ml-2" data-testid="plugin-update-available">
              有新版本
            </Badge>
          )}
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
          {update?.state === 'error' && <span className="basis-full text-warning break-words">检查新版本失败：{update.error}</span>}
        </span>
      }
      actions={
        <>
          {update?.state === 'available' && !updating && (
            <Button size="sm" variant="outline" onClick={() => void fetchUpdate()}>
              更新
            </Button>
          )}
          {updating?.phase === 'fetching' && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              正在取回新版本…
            </span>
          )}
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
      {updateError && (
        <Alert variant="destructive" className="mt-3 ml-13 w-auto" data-testid="plugin-update-error">
          <AlertDescription className="break-words whitespace-pre-wrap">{updateError}</AlertDescription>
        </Alert>
      )}
      {(updating?.phase === 'review' || updating?.phase === 'applying') && (
        <PluginUpdateReview
          plugin={plugin}
          prepared={updating.prepared}
          busy={updating.phase === 'applying'}
          onApply={(allowHooks) => void applyUpdate(updating.prepared, allowHooks)}
          onCancel={() => cancelUpdate(updating.prepared)}
        />
      )}
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
            {[...info.commands.map((name) => `/${name}`), ...info.skills, ...info.agents, ...info.mcpServers, ...(info.lspServers ?? []), ...(info.blocks ?? []).map((kind) => `\`\`\`${kind}`)].map((name) => (
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

const shortCommit = (commit: string | null) => commit?.slice(0, 7) ?? '?'

// 换上新版本前给用户看：版本和提交、哪些文件加了删了改了；钩子新加或变了的列出命令，勾了才允许（和安装时一样）
function PluginUpdateReview({ plugin, prepared, busy, onApply, onCancel }: { plugin: PluginView; prepared: PluginUpdatePrepared; busy: boolean; onApply(allowHooks: boolean): void; onCancel(): void }) {
  const [allowHooks, setAllowHooks] = useState(false)
  const { info } = prepared
  const version = (value: string | null) => (value ? `v${value.replace(/^v/i, '')}` : '没写版本')
  const files: Array<[string, string[]]> = [
    ['新加', prepared.added],
    ['删掉', prepared.removed],
    ['改了', prepared.modified],
  ]
  const unchanged = files.every(([, list]) => list.length === 0)
  return (
    <RowPanel data-testid="plugin-update">
      <div className="space-y-1">
        <p className="text-sm">
          「{plugin.name}」{version(prepared.fromVersion)} → {version(info.version || null)}
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {shortCommit(prepared.fromCommit)} → {shortCommit(prepared.toCommit)}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">新版本：{contentsSummary(info)}</p>
      </div>
      <div className="space-y-1 text-xs" data-testid="plugin-update-files">
        {unchanged ? (
          <p className="text-muted-foreground">插件目录里的文件没有变化（仓库别处改了）。</p>
        ) : (
          files.map(
            ([label, list]) =>
              list.length > 0 && (
                <p key={label} className="break-all">
                  <span className="text-muted-foreground">{label}：</span>
                  <span className="font-mono">{list.join('、')}</span>
                </p>
              ),
          )
        )}
        {prepared.truncated && <p className="text-muted-foreground">改动的文件太多，只列了一部分。</p>}
      </div>
      {prepared.hooks === 'changed' && (
        <>
          <div className="rounded-lg border bg-background">
            <div className="border-b px-3.5 py-2.5 text-sm font-bold">{plugin.hooksApproved ? '钩子变了，新版本会在这些时候自动运行命令' : '新版本会在这些时候自动运行命令'}</div>
            <div className="px-3.5 py-2.5">
              <HookList hooks={info.hooks} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={allowHooks} onCheckedChange={(value) => setAllowHooks(value === true)} />
            <span>
              允许这{info.hooks.length > 1 ? '些' : '个'}钩子在本机自动运行
              <span className="block text-xs text-muted-foreground">不勾也能更新，只是钩子不跑；以后可以在下面的「查看」里改。</span>
            </span>
          </label>
        </>
      )}
      {prepared.hooks === 'same' && <p className="text-xs text-muted-foreground">钩子没变，照旧允许。</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button disabled={busy} onClick={() => onApply(allowHooks)}>
          {busy ? '正在更新…' : '更新'}
        </Button>
      </div>
    </RowPanel>
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
