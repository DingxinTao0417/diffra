import { useEffect, useState } from 'react'
import type { CoreStatus, UpdateStatus } from '../../shared/ipc'

export function App() {
  const [coreStatus, setCoreStatus] = useState<CoreStatus | null>(null)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    window.diffra
      .getCoreStatus()
      .then(setCoreStatus, (error: unknown) => setCoreStatus({ state: 'failed', error: String(error) }))
    window.diffra.getAppVersion().then(setVersion, (error: unknown) => console.error('读取版本号失败', error))
  }, [])

  return (
    <main>
      <header>
        <h1>Diffra</h1>
        {version && <span data-testid="app-version">版本 {version}</span>}
      </header>
      <p data-testid="core-status">{describeCoreStatus(coreStatus)}</p>
      <UpdatePanel />
    </main>
  )
}

function UpdatePanel() {
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
    <section className="update">
      <span data-testid="update-status">{describeUpdateStatus(status)}</span>
      {status.state === 'downloaded' && (
        <button type="button" onClick={() => window.diffra.installUpdate().catch(logActionError)}>
          重启并更新
        </button>
      )}
      {canCheck && (
        <button type="button" onClick={() => window.diffra.checkForUpdates().catch(logActionError)}>
          检查更新
        </button>
      )}
    </section>
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
