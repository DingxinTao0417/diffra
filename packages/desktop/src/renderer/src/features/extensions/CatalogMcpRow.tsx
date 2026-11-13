import { type FormEvent, useState } from 'react'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import { type CatalogMcp, PREREQUISITES, type PrerequisiteState } from '../../../../shared/extensions'
import type { SettingsView } from '../../../../shared/settings'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { ExtensionRow, initialOf, RowPanel } from './parts'

export function openLink(url: string): void {
  window.diffra.openExternal(url).catch((error: unknown) => showToast(errorMessage(error)))
}

// 目录里的说明行：要填什么、要先装什么
function needs(entry: CatalogMcp): string {
  const { connection, key } = entry
  if (connection.transport === 'oauth') return entry.note ?? '只支持浏览器登录'
  if (connection.transport === 'stdio') return '在本机运行'
  if (!key) return '不用填 Key'
  return key.optional ? '不填 Key 也能用' : `贴一个 ${key.label}`
}

// 装的是什么：远程服务写地址，本地命令写整条命令
function summary(entry: CatalogMcp): string {
  const { connection } = entry
  if (connection.transport === 'stdio') return `在本机运行 ${[connection.command, ...connection.args].join(' ')}。`
  const url = new URL(connection.url)
  return `连接 ${entry.name} 的远程 MCP 服务器 ${url.host}${url.pathname === '/' ? '' : url.pathname}，不在本机运行程序。`
}

// 目录里的一个 MCP 服务（第 596 步）：点「安装」在原地展开，只填一个 Key；连得上才保存
export function CatalogMcpRow({
  entry,
  installed,
  prerequisites,
  expanded,
  onExpand,
  onInstalled,
  onRecheck,
}: {
  entry: CatalogMcp
  installed: boolean
  prerequisites: PrerequisiteState | null
  expanded: boolean
  onExpand(open: boolean): void
  onInstalled(view: SettingsView): void
  onRecheck(): void
}) {
  const { connection } = entry
  const missing = connection.transport === 'stdio' && prerequisites !== null && !prerequisites[connection.requires] ? PREREQUISITES[connection.requires] : null
  const action = installed ? (
    <span className="text-xs text-muted-foreground">已安装</span>
  ) : connection.transport === 'oauth' ? (
    <Button size="sm" variant="outline" disabled>
      下一版支持
    </Button>
  ) : missing ? (
    <Button size="sm" variant="ghost" onClick={onRecheck}>
      重新检测
    </Button>
  ) : expanded ? (
    <Button size="sm" variant="ghost" aria-expanded onClick={() => onExpand(false)}>
      收起
    </Button>
  ) : (
    <Button size="sm" variant="outline" aria-label={`安装 ${entry.name}`} onClick={() => onExpand(true)}>
      安装
    </Button>
  )
  return (
    <ExtensionRow
      testId="catalog-mcp"
      initial={initialOf(entry.name)}
      dark
      name={entry.name}
      badge={entry.publisher}
      wide={expanded}
      detail={
        <>
          <span className="block truncate">
            {entry.description} · {needs(entry)}
          </span>
          {missing && !installed && (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-warning" data-testid="catalog-missing">
              <span className="flex items-center gap-1">
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                需要 {missing.label}：没检测到 {missing.command} 命令
              </span>
              <button type="button" className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline" onClick={() => openLink(missing.guideUrl)}>
                安装说明
                <ExternalLink aria-hidden className="size-3" />
              </button>
            </span>
          )}
        </>
      }
      actions={action}
    >
      {expanded && !installed && !missing && (
        <McpInstallPanel
          entry={entry}
          summary={summary(entry)}
          onCancel={() => onExpand(false)}
          onInstalled={(view) => {
            onExpand(false)
            onInstalled(view)
          }}
        />
      )}
    </ExtensionRow>
  )
}

function McpInstallPanel({ entry, summary, onCancel, onInstalled }: { entry: CatalogMcp; summary: string; onCancel(): void; onInstalled(view: SettingsView): void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `catalog-key-${entry.id}`

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onInstalled(await window.diffra.installCatalogMcp(entry.id, key.trim() || null))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RowPanel>
      <form onSubmit={submit} className="space-y-4" aria-label={`安装 ${entry.name}`}>
        <div className="space-y-1">
          <p className="text-sm">{summary}</p>
          {entry.note && <p className="text-xs text-muted-foreground">{entry.note}</p>}
        </div>
        {entry.key && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={id}>
                {entry.key.label}
                {entry.key.optional && <span className="font-normal text-muted-foreground">（可选）</span>}
              </Label>
              <button type="button" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => openLink(entry.key!.helpUrl)}>
                去获取
                <ExternalLink aria-hidden className="size-3" />
              </button>
            </div>
            <Input id={id} type="password" autoComplete="off" autoFocus value={key} onChange={(event) => setKey(event.target.value)} required={!entry.key.optional} className="bg-background" />
            <p className="text-xs text-muted-foreground">{entry.key.hint}加密保存在本机，只发给 {entry.name}。</p>
          </div>
        )}
        {error && (
          <Alert variant="destructive" data-testid="catalog-install-error">
            <AlertDescription className="break-words whitespace-pre-wrap">{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? '正在连接…' : '安装并测试'}
          </Button>
        </div>
      </form>
    </RowPanel>
  )
}
