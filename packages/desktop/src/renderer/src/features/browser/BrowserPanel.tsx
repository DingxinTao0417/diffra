import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SidePanel } from '@/features/task/SidePanel'
import { errorMessage } from '@/lib/errors'
import { showToast, store, useAppState } from '@/state/store'

// 任务页右侧的内置浏览器。网页本身是主进程叠在这块区域上的原生视图，这里只负责地址栏和把位置告诉主进程。
// 原生视图盖在页面上面：弹窗、下拉菜单打开时（Radix 给 body 加 data-scroll-locked）先把它藏起来
export function BrowserPanel({ sessionId }: { sessionId: string }) {
  const state = useAppState((app) => app.browsers[sessionId] ?? null)
  const body = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    window.diffra.getBrowserState(sessionId).then(
      (current) => current && store.set((app) => ({ ...app, browsers: { ...app.browsers, [sessionId]: current } })),
      (error: unknown) => console.error('读取浏览器状态失败', error),
    )
  }, [sessionId])

  useEffect(() => {
    if (!editing) setAddress(state?.url ?? '')
  }, [state?.url, editing])

  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const sync = () => {
      const covered = document.body.hasAttribute('data-scroll-locked')
      const rect = element.getBoundingClientRect()
      window.diffra.setBrowserBounds(sessionId, covered || rect.width === 0 ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    sync()
    const resize = new ResizeObserver(sync)
    resize.observe(element)
    resize.observe(document.body)
    const locked = new MutationObserver(sync)
    locked.observe(document.body, { attributes: true, attributeFilter: ['data-scroll-locked'] })
    window.addEventListener('resize', sync)
    return () => {
      resize.disconnect()
      locked.disconnect()
      window.removeEventListener('resize', sync)
      window.diffra.setBrowserBounds(sessionId, null)
    }
  }, [sessionId])

  const open = async (event: FormEvent) => {
    event.preventDefault()
    if (!address.trim()) return
    setEditing(false)
    try {
      await window.diffra.browserNavigate(sessionId, address)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  return (
    <SidePanel
      width="wide"
      testId="browser-panel"
      controls={
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <ToolButton label="后退" disabled={!state?.canGoBack} onClick={() => window.diffra.browserCommand(sessionId, 'back')}>
            <ArrowLeft className="size-4" />
          </ToolButton>
          <ToolButton label="前进" disabled={!state?.canGoForward} onClick={() => window.diffra.browserCommand(sessionId, 'forward')}>
            <ArrowRight className="size-4" />
          </ToolButton>
          {state?.loading ? (
            <ToolButton label="停止加载" onClick={() => window.diffra.browserCommand(sessionId, 'stop')}>
              <X className="size-4" />
            </ToolButton>
          ) : (
            <ToolButton label="刷新" disabled={!state?.url} onClick={() => window.diffra.browserCommand(sessionId, 'reload')}>
              <RotateCw className="size-3.5" />
            </ToolButton>
          )}
          <form onSubmit={open} className="mx-1 min-w-0 flex-1">
            <input
              aria-label="网址"
              value={address}
              placeholder="输入网址，比如 localhost:5173"
              onFocus={(event) => {
                setEditing(true)
                event.currentTarget.select()
              }}
              onBlur={() => setEditing(false)}
              onChange={(event) => setAddress(event.target.value)}
              className="h-7.5 w-full rounded-md bg-muted px-2.5 text-sm outline-none focus:bg-background focus:ring-1 focus:ring-ring/60"
            />
          </form>
        </div>
      }
      // 和关闭按钮之间有分隔线，免得想在系统浏览器里打开时误关面板
      actions={
        <ToolButton label="在系统浏览器里打开" disabled={!state?.url} onClick={() => window.diffra.browserCommand(sessionId, 'external')}>
          <ExternalLink className="size-3.5" />
        </ToolButton>
      }
    >
      <div ref={body} className="relative min-h-0 flex-1 bg-background" data-testid="browser-viewport">
        {!state?.url && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted-foreground">
            <Globe className="size-8 text-muted-foreground/60" />
            <p>在上面输入网址，或者让智能体打开网页。</p>
            <p className="max-w-md text-xs text-balance">本地开发服务器（localhost）直接打开；其他网站，智能体打开前会先问你。浏览器的登录状态和你自己的浏览器分开。</p>
          </div>
        )}
      </div>
    </SidePanel>
  )
}

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="text-muted-foreground">
      {children}
    </Button>
  )
}
