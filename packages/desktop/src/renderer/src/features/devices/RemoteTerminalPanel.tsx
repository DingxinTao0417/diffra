import { useEffect, useRef, useState } from 'react'
import { SquareTerminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createXterm } from '@/features/terminal/terminals'
import { errorMessage } from '@/lib/errors'
import { listenRemoteTerminal } from './remote-tasks'

// 输入攒这么久一发（逐键发一来一回太多帧），大小变了等这么久再告诉对方
const INPUT_BATCH_MS = 20
const RESIZE_DEBOUNCE_MS = 150

// 对方电脑上的终端（「完全控制」）：打开面板时请对方在这个任务的项目目录里开一个，关掉面板、离开任务时请对方结束。
// 输出、结束经推送来（remote-tasks.ts 的 listenRemoteTerminal）
export function RemoteTerminalPanel({ deviceId, sessionId, deviceName, onClose }: { deviceId: string; sessionId: string; deviceName: string; onClose(): void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<{ state: 'opening' | 'open' | 'exited' | 'error'; message?: string }>({ state: 'opening' })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let terminalId: string | null = null
    let disposed = false
    let input = ''
    let inputTimer: number | undefined
    let resizeTimer: number | undefined
    const call = (method: 'terminal.input' | 'terminal.resize' | 'terminal.close', extra: Record<string, unknown> = {}) => {
      if (!terminalId) return
      window.diffra.remoteCall(deviceId, { method, terminalId, ...extra } as Parameters<typeof window.diffra.remoteCall>[1]).catch((error: unknown) => {
        if (method !== 'terminal.close') setStatus({ state: 'error', message: errorMessage(error) })
      })
    }
    const flushInput = () => {
      inputTimer = undefined
      if (!input) return
      const data = input
      input = ''
      call('terminal.input', { data })
    }
    const view = createXterm((data) => {
      input += data
      inputTimer ??= window.setTimeout(flushInput, INPUT_BATCH_MS)
    })
    host.replaceChildren(view.element)
    view.term.open(view.element)
    view.fit.fit()
    let off = () => {}
    window.diffra.remoteCall(deviceId, { method: 'terminal.open', sessionId, cols: view.term.cols, rows: view.term.rows }).then(
      (result) => {
        terminalId = (result as { terminalId: string }).terminalId
        // 面板在对方回复之前就关了：马上请对方结束
        if (disposed) return call('terminal.close')
        off = listenRemoteTerminal(terminalId, {
          data: (data) => view.term.write(data),
          exit: () => setStatus({ state: 'exited' }),
        })
        setStatus({ state: 'open' })
        view.term.focus()
      },
      (error: unknown) => !disposed && setStatus({ state: 'error', message: errorMessage(error) }),
    )
    const observer = new ResizeObserver(() => {
      view.fit.fit()
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => call('terminal.resize', { cols: view.term.cols, rows: view.term.rows }), RESIZE_DEBOUNCE_MS)
    })
    observer.observe(host)
    return () => {
      disposed = true
      observer.disconnect()
      window.clearTimeout(inputTimer)
      window.clearTimeout(resizeTimer)
      off()
      call('terminal.close')
      view.term.dispose()
    }
  }, [deviceId, sessionId])

  return (
    <div className="flex h-64 shrink-0 flex-col border-t" data-testid="remote-terminal">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
        <SquareTerminal className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          「{deviceName}」上的终端
          {status.state === 'opening' && ' · 正在打开…'}
          {status.state === 'exited' && ' · 已结束'}
          {status.state === 'error' && <span className="text-destructive"> · {status.message}</span>}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="关闭远程终端" className="size-5 rounded-sm" onClick={onClose}>
          <X className="size-3" />
        </Button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-3 pb-2" />
    </div>
  )
}
