import { type PointerEvent, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Plus, SquareTerminal, X } from 'lucide-react'
import { cn } from 'cn'
import { folderName } from '@/lib/format'
import { store, useAppState } from '@/state/store'
import { attachTerminal, closeTerminal, fitTerminal, newTerminal } from './terminals'

const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 280

// 任务页底部的终端面板；cwd 是「新建终端」用的目录（当前任务的项目）
export function TerminalPanel({ cwd }: { cwd: string }) {
  const terminals = useAppState((state) => state.terminals)
  const active = useAppState((state) => state.activeTerminal)
  const hostRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || !active) return
    attachTerminal(active, host)
    const observer = new ResizeObserver(() => fitTerminal(active))
    observer.observe(host)
    return () => observer.disconnect()
  }, [active])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: event.clientY, startHeight: height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const max = Math.round(window.innerHeight * 0.7)
    setHeight(Math.min(max, Math.max(MIN_HEIGHT, drag.current.startHeight + drag.current.startY - event.clientY)))
  }

  return (
    <div className="flex shrink-0 flex-col border-t" style={{ height }} data-testid="terminal-panel">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整终端高度"
        className="-mt-1 h-2 shrink-0 cursor-row-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
      />
      <div className="flex h-8 shrink-0 items-center gap-1 px-3 text-[0.93rem]">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="终端">
          {terminals.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === active}
              data-testid="terminal-tab"
              className={cn(
                'group/tab flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2',
                tab.id === active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <button
                type="button"
                className="flex items-center gap-1.5"
                title={tab.cwd}
                onClick={() => store.set((state) => ({ ...state, activeTerminal: tab.id }))}
              >
                <SquareTerminal className="size-3.5" />
                <span>{folderName(tab.cwd)}</span>
                <span className="text-xs text-muted-foreground">{tab.exitCode === null ? tab.shell : '已退出'}</span>
              </button>
              <button
                type="button"
                aria-label="关闭终端"
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={() => closeTerminal(tab.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            aria-label="新建终端"
            title={`在 ${folderName(cwd)} 新建终端`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void newTerminal(cwd)}
          >
            <Plus className="size-4" />
          </button>
        </div>
        <button
          type="button"
          aria-label="收起终端"
          title="收起终端 Ctrl+`"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => store.set((state) => ({ ...state, terminalOpen: false }))}
        >
          <ChevronDown className="size-4" />
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-3 pb-2" data-testid="terminal-host" />
    </div>
  )
}
