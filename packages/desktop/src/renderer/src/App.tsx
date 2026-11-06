import { useEffect, useState } from 'react'
import type { CoreStatus } from '../../shared/ipc'

export function App() {
  const [status, setStatus] = useState<CoreStatus | null>(null)

  useEffect(() => {
    window.diffra
      .getCoreStatus()
      .then(setStatus, (error: unknown) => setStatus({ state: 'failed', error: String(error) }))
  }, [])

  return (
    <main>
      <h1>Diffra</h1>
      <p data-testid="core-status">{describeStatus(status)}</p>
    </main>
  )
}

function describeStatus(status: CoreStatus | null): string {
  if (status === null) return '正在连接 core…'
  if (status.state === 'failed') return `Core 连接失败：${status.error}`
  return `Core 已连接：${status.agentName} ${status.agentVersion} · ACP 协议 v${status.protocolVersion}`
}
