import { useEffect, useState } from 'react'
import { CircleAlert, Ellipsis, Loader2, Pencil, Plug, Trash2 } from 'lucide-react'
import type { McpServerStatus } from '@diffra/core/types'
import type { McpServerConfig, SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Switch } from '@/components/ui/switch'
import { SavedHint, SettingsHeader, useSavedFlash } from '@/features/settings/SettingsLayout'
import { errorMessage } from '@/lib/errors'
import { McpServerDialog } from './McpServerDialog'
import { useMcpStatus } from './useMcpStatus'

export function McpSettings() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; server: McpServerConfig | null }>({ open: false, server: null })
  // 配置改了重新查状态
  const [version, setVersion] = useState(0)
  const status = useMcpStatus(view ? { projectPath: null } : null, version)
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

  const changed = (next: SettingsView) => {
    setView(next)
    setVersion((value) => value + 1)
    flashSaved(true)
  }
  const empty = view.mcpServers.length === 0
  // 列表为空时添加按钮只放在空状态里，页头不重复
  const addButton = (
    <Button onClick={() => setDialog({ open: true, server: null })} disabled={view.loadError !== null}>
      添加服务器
    </Button>
  )

  return (
    <>
      <SettingsHeader
        title="MCP 服务器"
        description="给智能体接上外部工具和提示词模板。"
        actions={
          <>
            <SavedHint saved={saved} note="新任务生效" />
            {!empty && addButton}
          </>
        }
      />

      <div className="space-y-3">
        {view.loadError && (
          <Alert variant="destructive">
            <AlertTitle>设置暂时无法保存</AlertTitle>
            <AlertDescription>{view.loadError}</AlertDescription>
          </Alert>
        )}
        {status.error && (
          <Alert variant="destructive">
            <AlertTitle>读取 MCP 状态失败</AlertTitle>
            <AlertDescription>{status.error}</AlertDescription>
          </Alert>
        )}

        {empty ? (
          <EmptyState icon={Plug} title="还没有 MCP 服务器" description="接上外部工具后，智能体可以在任务里直接调用它们。" variant="card">
            {addButton}
          </EmptyState>
        ) : (
          view.mcpServers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              status={status.statuses?.find((item) => item.name === server.name) ?? null}
              loading={status.loading}
              onChange={changed}
              onEdit={() => setDialog({ open: true, server })}
              onRetry={status.retry}
            />
          ))
        )}
      </div>

      <McpServerDialog
        open={dialog.open}
        server={dialog.server}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSaved={changed}
      />
    </>
  )
}

interface McpServerCardProps {
  server: McpServerConfig
  status: McpServerStatus | null
  loading: boolean
  onChange(view: SettingsView): void
  onEdit(): void
  onRetry(): void
}

type ConnectionState = 'disabled' | 'connected' | 'failed' | 'connecting' | 'idle'

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  disabled: '已停用',
  connected: '已连接',
  failed: '连接失败',
  connecting: '连接中',
  idle: '未连接',
}

function McpServerCard({ server, status, loading, onChange, onEdit, onRetry }: McpServerCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<SettingsView>) => {
    setError(null)
    try {
      onChange(await action())
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }
  // 开关只改 enabled，值都沿用已保存的
  const setEnabled = (enabled: boolean) =>
    run(() =>
      window.diffra.saveMcpServer({
        id: server.id,
        name: server.name,
        enabled,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: server.envNames.map((name) => ({ name, value: null })),
        headers: server.headerNames.map((name) => ({ name, value: null })),
      }),
    )

  const stdio = server.transport === 'stdio'
  const names = stdio ? server.envNames : server.headerNames
  const state: ConnectionState = !server.enabled ? 'disabled' : status ? status.state : loading ? 'connecting' : 'idle'
  // 失败原因的第一行是摘要，后面是 stdio 服务器的 stderr
  const [reason, ...log] = (status?.state === 'failed' ? (status.error ?? '') : '').split(/\r?\n/)
  const fullLog = log.join('\n').trim()
  return (
    <Card data-testid="mcp-server-card">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{server.name}</span>
          <span
            data-testid="mcp-status"
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 text-xs font-normal',
              state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {state === 'connecting' ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : (
              <span
                aria-hidden
                className={cn('size-2 rounded-full', state === 'connected' ? 'bg-muted-foreground' : state === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/50')}
              />
            )}
            {CONNECTION_LABELS[state]}
          </span>
        </CardTitle>
        <CardDescription className="flex min-w-0 gap-1.5 text-xs">
          <span className="shrink-0">{stdio ? '本地命令' : '远程 HTTP'}</span>
          <span className="min-w-0 font-mono break-all">{stdio ? [server.command, ...server.args].join(' ') : server.url}</span>
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Switch label={`启用 ${server.name}`} checked={server.enabled} onChange={(enabled) => void setEnabled(enabled)} />
          {/* 非模态：菜单关闭和对话框打开同时发生时，模态菜单会把页面留在不可点击的状态 */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`${server.name} 服务器操作`}>
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-36">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                编辑
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                <Trash2 />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {names.length > 0 && (
          <div className="text-muted-foreground">
            {stdio ? '环境变量' : '请求头'}：<span className="font-mono">{names.join('、')}</span>
          </div>
        )}
        {state === 'connected' && status && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span data-testid="mcp-tools">
                {status.tools.length} 个工具 · {status.prompts.length} 个提示词模板
              </span>
              {status.tools.length > 0 && (
                <Button size="xs" variant="ghost" aria-expanded={showTools} onClick={() => setShowTools((value) => !value)}>
                  {showTools ? '收起' : '查看'}
                </Button>
              )}
            </div>
            {showTools && (
              <div className="flex flex-wrap gap-1" data-testid="mcp-tool-list">
                {status.tools.map((tool) => (
                  <Badge key={tool.name} variant="secondary" className="font-mono" title={tool.description || undefined}>
                    {tool.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
        {state === 'failed' && (
          <Alert variant="destructive" data-testid="mcp-error" className="border-transparent bg-destructive-soft">
            <CircleAlert />
            <AlertTitle className="font-normal break-words">{reason || '连接失败'}</AlertTitle>
            {fullLog && (
              <AlertDescription>
                <details>
                  <summary className="cursor-pointer text-xs">完整日志</summary>
                  <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">{fullLog}</pre>
                </details>
              </AlertDescription>
            )}
            <AlertAction>
              <Button size="xs" variant="outline" disabled={loading} onClick={onRetry}>
                重试
              </Button>
            </AlertAction>
          </Alert>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 MCP 服务器「{server.name}」？</AlertDialogTitle>
            <AlertDialogDescription>保存的{stdio ? '环境变量' : '请求头'}的值会一起删除，新任务不再带它的工具。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive-solid" onClick={() => void run(() => window.diffra.deleteMcpServer(server.id))}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
