import { useState } from 'react'
import { CircleAlert, Ellipsis, ExternalLink, Loader2, Pencil, Plug, Trash2, TriangleAlert } from 'lucide-react'
import type { McpServerStatus } from '@diffra/core/types'
import { type CatalogMcp, catalogEntryOf, PREREQUISITES, type PrerequisiteState } from '../../../../shared/extensions'
import type { McpOAuthState } from '../../../../shared/mcp-oauth'
import type { McpServerConfig, SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Switch } from '@/components/ui/switch'
import { openLink } from '@/features/extensions/CatalogMcpRow'
import { brandIcon } from '@/features/extensions/brand-icons'
import { ExtensionRow, initialOf, SectionTitle } from '@/features/extensions/parts'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { McpServerDialog } from './McpServerDialog'
import type { useMcpStatus } from './useMcpStatus'

// 扩展页「已安装」里的 MCP 服务器（第 601 步从设置搬过来）：目录装的和手动加的都在这里，能停用、编辑、删除，看连接状态
export function McpInstalled({
  view,
  status,
  catalog,
  prerequisites,
  onChange,
  onRecheck,
  onBrowse,
}: {
  view: SettingsView
  status: ReturnType<typeof useMcpStatus>
  // 当前的目录（可能是联网取到的），认装上的服务器对应目录里哪一项
  catalog: CatalogMcp[]
  prerequisites: PrerequisiteState | null
  onChange(view: SettingsView): void
  onRecheck(): void
  onBrowse(): void
}) {
  const [dialog, setDialog] = useState<{ open: boolean; server: McpServerConfig | null }>({ open: false, server: null })
  const empty = view.mcpServers.length === 0
  const addButton = (
    <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, server: null })} disabled={view.loadError !== null}>
      手动添加
    </Button>
  )

  return (
    <section>
      <SectionTitle actions={!empty && addButton}>MCP 服务器</SectionTitle>
      {status.error && (
        <Alert variant="destructive" className="mb-3">
          <AlertTitle>读取 MCP 状态失败</AlertTitle>
          <AlertDescription>{status.error}</AlertDescription>
        </Alert>
      )}
      {empty ? (
        <EmptyState icon={Plug} title="还没有 MCP 服务器" description="接上外部工具后，智能体可以在任务里直接调用它们。" variant="card">
          <Button variant="outline" onClick={onBrowse}>
            去目录看看
          </Button>
          {addButton}
        </EmptyState>
      ) : (
        view.mcpServers.map((server) => (
          <McpServerRow
            key={server.id}
            server={server}
            status={status.statuses?.find((item) => item.name === server.name) ?? null}
            oauth={view.mcpOAuth[server.id] ?? null}
            catalog={catalog}
            loading={status.loading}
            prerequisites={prerequisites}
            onChange={onChange}
            onEdit={() => setDialog({ open: true, server })}
            onRetry={status.retry}
            onRecheck={onRecheck}
          />
        ))
      )}
      <McpServerDialog open={dialog.open} server={dialog.server} onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} onSaved={onChange} />
    </section>
  )
}

// 浏览器登录的服务器（v2）：登录状态和登录、退出登录。没登录时任务里不带它
function OAuthLine({ server, state, onChange }: { server: McpServerConfig; state: McpOAuthState | null; onChange(view: SettingsView): void }) {
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = async (kind: 'login' | 'logout') => {
    setBusy(kind)
    setError(null)
    try {
      onChange(await (kind === 'login' ? window.diffra.loginMcpServer(server.id) : window.diffra.logoutMcpServer(server.id)))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }
  const status = state?.status ?? 'signed-out'
  const label =
    status === 'signed-in'
      ? `已用浏览器登录${state?.expiresAt ? `，令牌 ${formatTime(state.expiresAt)} 到期，快到期时自动续` : ''}`
      : status === 'expired'
        ? '登录过期了，任务里暂时用不了它，重新登录一下'
        : '还没登录，任务里用不了它'
  return (
    <div className="space-y-1.5" data-testid="mcp-oauth">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn(status === 'signed-in' ? 'text-muted-foreground' : 'text-warning')} data-testid="mcp-oauth-status" data-status={status}>
          {label}
        </span>
        {busy === 'login' ? (
          <>
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              等你在浏览器里登录…
            </span>
            <Button size="xs" variant="ghost" onClick={() => void window.diffra.cancelMcpLogin(server.id)}>
              取消登录
            </Button>
          </>
        ) : (
          <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act('login')}>
            {status === 'signed-out' ? '在浏览器里登录' : '重新登录'}
          </Button>
        )}
        {status !== 'signed-out' && busy !== 'login' && (
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void act('logout')}>
            退出登录
          </Button>
        )}
      </div>
      {error && <p className="text-xs break-words text-destructive">{error}</p>}
    </div>
  )
}

type ConnectionState = 'disabled' | 'connected' | 'failed' | 'connecting' | 'idle'

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  disabled: '已停用',
  connected: '已连接',
  failed: '连接失败',
  connecting: '连接中',
  idle: '未连接',
}

interface McpServerRowProps {
  server: McpServerConfig
  status: McpServerStatus | null
  oauth: McpOAuthState | null
  catalog: CatalogMcp[]
  loading: boolean
  prerequisites: PrerequisiteState | null
  onChange(view: SettingsView): void
  onEdit(): void
  onRetry(): void
  onRecheck(): void
}

function McpServerRow({ server, status, oauth, catalog, loading, prerequisites, onChange, onEdit, onRetry, onRecheck }: McpServerRowProps) {
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
        ...(server.auth ? { auth: server.auth } : {}),
      }),
    )

  const stdio = server.transport === 'stdio'
  const names = stdio ? server.envNames : server.headerNames
  const state: ConnectionState = !server.enabled ? 'disabled' : status ? status.state : loading ? 'connecting' : 'idle'
  // 目录里要先装命令的服务：本机没有那个命令时直接说缺什么，不给一大段启动失败的日志
  const entry = catalogEntryOf(server, catalog)
  const requires = entry?.connection.transport === 'stdio' ? entry.connection.requires : null
  const missing = requires && prerequisites && !prerequisites[requires] && state !== 'connected' ? PREREQUISITES[requires] : null
  // 失败原因的第一行是摘要，后面是 stdio 服务器的 stderr
  const [reason, ...log] = (status?.state === 'failed' ? (status.error ?? '') : '').split(/\r?\n/)
  const fullLog = log.join('\n').trim()
  return (
    <ExtensionRow
      testId="mcp-server-card"
      initial={initialOf(entry?.name ?? server.name)}
      brand={entry ? brandIcon(entry.id) : null}
      dark
      name={server.name}
      detail={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span
            data-testid="mcp-status"
            className={cn('inline-flex shrink-0 items-center gap-1.5', state === 'failed' && !missing ? 'text-destructive' : 'text-muted-foreground')}
          >
            {state === 'connecting' ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : (
              <span aria-hidden className={cn('size-2 rounded-full', state === 'connected' ? 'bg-muted-foreground' : state === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/50')} />
            )}
            {CONNECTION_LABELS[state]}
          </span>
          <span className="min-w-0 truncate font-mono" title={stdio ? [server.command, ...server.args].join(' ') : server.url}>
            {stdio ? `本地命令 ${[server.command, ...server.args].join(' ')}` : `远程 HTTP ${server.url}`}
          </span>
        </span>
      }
      actions={
        <>
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
        </>
      }
    >
      <div className="mt-2 ml-13 space-y-2 text-sm empty:hidden">
        {names.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {stdio ? '环境变量' : '请求头'}：<span className="font-mono">{names.join('、')}</span>
          </div>
        )}
        {server.auth === 'oauth' && <OAuthLine server={server} state={oauth} onChange={onChange} />}
        {state === 'connected' && status && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
        {missing ? (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-warning" data-testid="mcp-missing">
            <span className="flex items-center gap-1">
              <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
              没启动：没检测到 {missing.command} 命令
            </span>
            <button type="button" className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline" onClick={() => openLink(missing.guideUrl)}>
              安装说明
              <ExternalLink aria-hidden className="size-3" />
            </button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                onRecheck()
                onRetry()
              }}
            >
              重新检测
            </Button>
          </p>
        ) : (
          state === 'failed' && (
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
          )
        )}
        {error && <p className="text-destructive">{error}</p>}
      </div>

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
    </ExtensionRow>
  )
}
