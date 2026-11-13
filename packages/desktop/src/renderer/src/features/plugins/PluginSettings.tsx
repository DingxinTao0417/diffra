import { type FormEvent, useEffect, useState } from 'react'
import { Ellipsis, Folder, GitBranch, Info, Puzzle, Trash2, TriangleAlert } from 'lucide-react'
import type { PluginView } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Field } from '@/components/ui/field'
import { SavedHint, SettingsHeader, useSavedFlash } from '@/features/settings/SettingsLayout'
import { errorMessage } from '@/lib/errors'

export function PluginSettings() {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [saved, flashSaved] = useSavedFlash()

  // 安装按钮一开始就能点：装完的结果比最初的列表先回来时，不能被晚到的旧列表盖掉
  useEffect(() => {
    window.diffra.listPlugins().then(
      (list) => setPlugins((current) => current ?? list),
      (caught: unknown) => setError(errorMessage(caught)),
    )
  }, [])

  const run = async (action: () => Promise<PluginView[] | null>) => {
    setError(null)
    try {
      const next = await action()
      // 从文件夹安装时取消选择会返回 null，不算保存
      if (next) {
        setPlugins(next)
        flashSaved(true)
      }
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const installFolder = async () => {
    setInstalling(true)
    await run(() => window.diffra.installPluginFromFolder())
    setInstalling(false)
  }

  const empty = plugins !== null && plugins.length === 0
  // 列表为空时安装按钮只放在空状态里，页头不重复
  const installButtons = (
    <>
      <Button variant="outline" disabled={installing} onClick={() => void installFolder()}>
        从文件夹安装
      </Button>
      <Button disabled={installing} onClick={() => setGitOpen(true)}>
        从 Git 安装
      </Button>
    </>
  )

  return (
    <>
      <SettingsHeader
        title="插件"
        description="插件能带来命令、Skill 和 MCP 服务器，只装信任的来源。"
        actions={
          <>
            <SavedHint saved={saved} note="新任务生效" />
            {!empty && installButtons}
          </>
        }
      />

      <div className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>操作失败</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
          </Alert>
        )}

        {plugins === null ? (
          <p className="text-sm text-muted-foreground">正在读取插件…</p>
        ) : empty ? (
          <EmptyState
            icon={Puzzle}
            variant="card"
            title="还没有插件"
            description={
              <span>
                装上插件，就能在斜杠菜单里用它带来的命令和 Skill。
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="不装插件的自定义命令"
                      className="ml-1 inline-flex rounded-sm align-middle text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>项目的 .diffra/commands 和 ~/.diffra/commands 里的 markdown 文件不用装插件，也会出现在斜杠菜单里。</TooltipContent>
                </Tooltip>
              </span>
            }
          >
            {installButtons}
          </EmptyState>
        ) : (
          plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onToggle={(enabled) => void run(() => window.diffra.setPluginEnabled(plugin.id, enabled))}
              onDelete={() => void run(() => window.diffra.deletePlugin(plugin.id))}
            />
          ))
        )}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">兼容 Claude Code 插件的格式。插件里的 MCP 服务器会在本机运行命令。</p>

      <GitInstallDialog
        open={gitOpen}
        onOpenChange={setGitOpen}
        onInstalled={(next) => {
          setPlugins(next)
          setError(null)
          flashSaved(true)
        }}
      />
    </>
  )
}

function PluginCard({ plugin, onToggle, onDelete }: { plugin: PluginView; onToggle(enabled: boolean): void; onDelete(): void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const info = plugin.info
  // 空的类别不显示
  const groups = info
    ? (
        [
          ['个命令', info.commands.map((name) => `/${name}`)],
          ['个 Skill', info.skills],
          ['个 MCP 服务器', info.mcpServers],
        ] as const
      ).filter(([, names]) => names.length > 0)
    : []
  const git = plugin.source === 'git'
  const SourceIcon = git ? GitBranch : Folder
  return (
    <Card data-testid="plugin-card">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{plugin.name}</span>
          {info?.version && <span className="shrink-0 text-xs font-normal text-muted-foreground">v{info.version.replace(/^v/i, '')}</span>}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-normal text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <SourceIcon aria-hidden className="size-3.5" />
                {git ? 'Git' : '本地文件夹'}
              </span>
            </TooltipTrigger>
            <TooltipContent className="break-all">{plugin.url ?? plugin.dir}</TooltipContent>
          </Tooltip>
        </CardTitle>
        {info?.description && <CardDescription>{info.description}</CardDescription>}
        <CardAction className="flex items-center gap-2">
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
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 text-sm" data-testid="plugin-contents">
        {plugin.error && <p className="text-destructive">读不了这个插件：{plugin.error}</p>}
        {info && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>{groups.length > 0 ? groups.map(([unit, names]) => `${names.length} ${unit}`).join(' · ') : '没有可用的命令、Skill 或 MCP 服务器'}</span>
            {groups.length > 0 && (
              <Button size="xs" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                {expanded ? '收起' : '查看'}
              </Button>
            )}
          </div>
        )}
        {expanded && (
          <div className="flex flex-wrap gap-1">
            {groups.flatMap(([unit, names]) =>
              names.map((name) => (
                <Badge key={`${unit}:${name}`} variant="secondary" className="font-mono">
                  {name}
                </Badge>
              )),
            )}
          </div>
        )}
        {info && info.unsupported.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>Diffra 暂不支持、已忽略：{info.unsupported.join('、')}</span>
          </p>
        )}
      </CardContent>

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
    </Card>
  )
}

function GitInstallDialog({ open, onOpenChange, onInstalled }: { open: boolean; onOpenChange(open: boolean): void; onInstalled(plugins: PluginView[]): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Git 安装插件</DialogTitle>
          <DialogDescription>用本机的 git 克隆到 Diffra 的数据目录。插件里的 MCP 服务器会在本机运行命令，只装信任的仓库。</DialogDescription>
        </DialogHeader>
        <GitInstallForm
          onCancel={() => onOpenChange(false)}
          onInstalled={(plugins) => {
            onInstalled(plugins)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function GitInstallForm({ onCancel, onInstalled }: { onCancel(): void; onInstalled(plugins: PluginView[]): void }) {
  const [url, setUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setInstalling(true)
    setError(null)
    try {
      onInstalled(await window.diffra.installPluginFromGit(url.trim()))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setInstalling(false)
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="plugin-git-url" label="仓库地址">
        <Input id="plugin-git-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/plugin.git" required />
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
        <Button type="submit" disabled={installing}>
          {installing ? '正在克隆…' : '安装'}
        </Button>
      </DialogFooter>
    </form>
  )
}
