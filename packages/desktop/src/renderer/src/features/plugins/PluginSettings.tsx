import { type FormEvent, useEffect, useState } from 'react'
import type { PluginView } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Field } from '@/features/models/ProviderDialog'
import { errorMessage } from '@/lib/errors'

export function PluginSettings() {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)

  useEffect(() => {
    window.diffra.listPlugins().then(setPlugins, (caught: unknown) => setError(errorMessage(caught)))
  }, [])

  const run = async (action: () => Promise<PluginView[] | null>) => {
    setError(null)
    try {
      const next = await action()
      if (next) setPlugins(next)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const installFolder = async () => {
    setInstalling(true)
    await run(() => window.diffra.installPluginFromFolder())
    setInstalling(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">插件</h1>
          <p className="text-sm text-muted-foreground">
            一个插件可以带自定义命令、Skill 和 MCP 服务器，兼容 Claude Code 插件的格式。插件里的 MCP 服务器会在本机运行命令，只装信任的来源。新建或重新打开的任务生效。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" disabled={installing} onClick={() => void installFolder()}>
            从文件夹安装
          </Button>
          <Button disabled={installing} onClick={() => setGitOpen(true)}>
            从 Git 安装
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}

      {plugins === null ? (
        <p className="text-sm text-muted-foreground">正在读取插件…</p>
      ) : plugins.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有插件。项目的 .diffra/commands 和用户目录的 ~/.diffra/commands 里的 markdown 文件不用装插件，也会出现在输入框的斜杠菜单里。
        </p>
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

      <GitInstallDialog
        open={gitOpen}
        onOpenChange={setGitOpen}
        onInstalled={(next) => {
          setPlugins(next)
          setError(null)
        }}
      />
    </div>
  )
}

function PluginCard({ plugin, onToggle, onDelete }: { plugin: PluginView; onToggle(enabled: boolean): void; onDelete(): void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const info = plugin.info
  const rows: Array<[string, string[]]> = info
    ? [
        ['命令', info.commands.map((name) => `/${name}`)],
        ['Skill', info.skills],
        ['MCP 服务器', info.mcpServers],
      ]
    : []
  return (
    <Card data-testid="plugin-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {plugin.name}
          {info?.version && <Badge variant="outline">{info.version}</Badge>}
          <Badge variant="secondary">{plugin.source === 'git' ? 'Git' : '本地文件夹'}</Badge>
        </CardTitle>
        <CardDescription className="space-y-1">
          {info?.description && <span className="block">{info.description}</span>}
          <span className="block font-mono text-xs break-all">{plugin.url ?? plugin.dir}</span>
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Switch label={`启用 ${plugin.name}`} checked={plugin.enabled} onChange={onToggle} />
          {confirmingDelete ? (
            <>
              <Button size="sm" variant="destructive" onClick={onDelete}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" title={plugin.source === 'git' ? '连同克隆下来的文件一起删除' : '只是不再使用，文件夹不动'} onClick={() => setConfirmingDelete(true)}>
              删除
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm" data-testid="plugin-contents">
        {plugin.error && <p className="text-destructive">读不了这个插件：{plugin.error}</p>}
        {rows.map(([label, names]) => (
          <div key={label} className="flex gap-2">
            <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 font-mono text-xs leading-5 break-all">{names.length > 0 ? names.join('  ') : '无'}</span>
          </div>
        ))}
        {info && info.unsupported.length > 0 && <p className="text-xs text-muted-foreground">Diffra 暂不支持、已忽略：{info.unsupported.join('、')}</p>}
      </CardContent>
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
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={installing}>
          {installing ? '正在克隆…' : '安装'}
        </Button>
      </DialogFooter>
    </form>
  )
}
