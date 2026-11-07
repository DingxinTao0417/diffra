import { useEffect, useState } from 'react'
import type { McpServerStatus } from '@diffra/core/types'
import type { McpServerConfig, SettingsView } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
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
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">MCP 服务器</h1>
          <p className="text-sm text-muted-foreground">给智能体接上外部工具和 prompt。本地命令在项目目录里启动，所有项目共用；新建或重新打开的任务生效。</p>
        </div>
        <Button onClick={() => setDialog({ open: true, server: null })} disabled={view.loadError !== null}>
          添加服务器
        </Button>
      </div>

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

      {view.mcpServers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有 MCP 服务器。点「添加服务器」，填上 MCP 服务器说明里的启动命令或地址。
        </p>
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

      <McpServerDialog
        open={dialog.open}
        server={dialog.server}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSaved={changed}
      />
    </div>
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

function McpServerCard({ server, status, loading, onChange, onEdit, onRetry }: McpServerCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
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

  const names = server.transport === 'stdio' ? server.envNames : server.headerNames
  return (
    <Card data-testid="mcp-server-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {server.name}
          <Badge variant="secondary">{server.transport === 'stdio' ? '本地命令' : 'HTTP'}</Badge>
        </CardTitle>
        <CardDescription className="font-mono text-xs break-all">
          {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Switch label={`启用 ${server.name}`} checked={server.enabled} onChange={(enabled) => void setEnabled(enabled)} />
          <Button size="sm" variant="outline" onClick={onEdit}>
            编辑
          </Button>
          {confirmingDelete ? (
            <>
              <Button size="sm" variant="destructive" onClick={() => void run(() => window.diffra.deleteMcpServer(server.id))}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(true)}>
              删除
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {names.length > 0 && (
          <div className="text-muted-foreground">
            {server.transport === 'stdio' ? '环境变量' : '请求头'}：<span className="font-mono">{names.join('、')}</span>
          </div>
        )}
        <div data-testid="mcp-status">
          {!server.enabled ? (
            <span className="text-muted-foreground">已停用</span>
          ) : !status ? (
            <span className="text-muted-foreground">{loading ? '正在连接…' : '还没连接'}</span>
          ) : status.state === 'connected' ? (
            <div className="space-y-1">
              <span className="text-primary">
                已连接 · {status.tools.length} 个工具 · {status.prompts.length} 个 prompt
              </span>
              {status.tools.length > 0 && <div className="font-mono text-xs text-muted-foreground">{status.tools.map((item) => item.name).join('  ')}</div>}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="max-h-32 overflow-y-auto font-mono text-xs whitespace-pre-wrap text-destructive">连接失败：{status.error}</div>
              <Button size="sm" variant="outline" disabled={loading} onClick={onRetry}>
                重新连接
              </Button>
            </div>
          )}
        </div>
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
