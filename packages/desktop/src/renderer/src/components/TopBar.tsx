import { useEffect, useState } from 'react'
import type { CoreStatus, UpdateStatus } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'

export function TopBar() {
  const [coreStatus, setCoreStatus] = useState<CoreStatus | null>(null)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    window.diffra
      .getCoreStatus()
      .then(setCoreStatus, (error: unknown) => setCoreStatus({ state: 'failed', error: String(error) }))
    window.diffra.getAppVersion().then(setVersion, (error: unknown) => console.error('读取版本号失败', error))
  }, [])

  return (
    <header className="flex items-center gap-4 border-b px-6 py-3 text-sm">
      <span className="text-base font-semibold">Diffra</span>
      {version && (
        <span data-testid="app-version" className="text-muted-foreground">
          版本 {version}
        </span>
      )}
      <span
        data-testid="core-status"
        className={coreStatus?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
      >
        {describeCoreStatus(coreStatus)}
      </span>
      <div className="ml-auto">
        <UpdateIndicator />
      </div>
    </header>
  )
}

function UpdateIndicator() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    const unsubscribe = window.diffra.onUpdateStatus(setStatus)
    window.diffra
      .getUpdateStatus()
      .then(setStatus, (error: unknown) => setStatus({ state: 'error', message: String(error) }))
    return unsubscribe
  }, [])

  if (status === null) return null

  const canCheck = status.state === 'idle' || status.state === 'up-to-date' || status.state === 'error'
  return (
    <div className="flex items-center gap-2">
      <span data-testid="update-status" className="text-muted-foreground">
        {describeUpdateStatus(status)}
      </span>
      {status.state === 'downloaded' && (
        <Button size="sm" onClick={() => window.diffra.installUpdate().catch(logActionError)}>
          重启并更新
        </Button>
      )}
      {canCheck && (
        <Button size="sm" variant="outline" onClick={() => window.diffra.checkForUpdates().catch(logActionError)}>
          检查更新
        </Button>
      )}
    </div>
  )
}

function logActionError(error: unknown): void {
  console.error('更新操作失败', error)
}

function describeCoreStatus(status: CoreStatus | null): string {
  if (status === null) return '正在连接 core…'
  if (status.state === 'failed') return `Core 连接失败：${status.error}`
  return `Core 已连接：${status.agentName} ${status.agentVersion} · ACP 协议 v${status.protocolVersion}`
}

function describeUpdateStatus(status: UpdateStatus): string {
  switch (status.state) {
    case 'disabled':
      return '开发模式不检查更新'
    case 'idle':
      return '尚未检查更新'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return '已是最新版本'
    case 'downloading':
      return `正在下载新版本 ${status.version}（${status.percent}%）`
    case 'downloaded':
      return `新版本 ${status.version} 已下载`
    case 'error':
      return `检查更新失败：${status.message}`
  }
}
