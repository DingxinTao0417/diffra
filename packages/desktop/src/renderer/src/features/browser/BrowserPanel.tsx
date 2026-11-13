import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppWindow, ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Globe, Info, Play, RotateCw, X } from 'lucide-react'
import type { AgentBrowser } from '../../../../shared/settings'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SidePanel } from '@/features/task/SidePanel'
import { errorMessage } from '@/lib/errors'
import { openSettings } from '@/state/actions'
import { showToast, store, useAppState } from '@/state/store'

const BROWSER_LABELS: Record<AgentBrowser, string> = { builtin: '内置浏览器', chrome: 'Chrome', edge: 'Edge' }

// 任务页右侧的浏览器面板。
// 内置浏览器：网页本身是主进程叠在这块区域上的原生视图，这里只负责地址栏和把位置告诉主进程；
// 原生视图盖在页面上面，弹窗、下拉菜单打开时（Radix 给 body 加 data-scroll-locked）先把它藏起来。
// 用户的 Chrome、Edge：网页在用户的浏览器里，这里显示智能体那个标签页的投屏画面，位置用来决定投不投屏
export function BrowserPanel({ sessionId }: { sessionId: string }) {
  const state = useAppState((app) => app.browsers[sessionId] ?? null)
  const defaultBrowser = useAppState((app) => app.settings?.browser.agent ?? 'builtin')
  const body = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [frame, setFrame] = useState<string | null>(null)
  const backend = state?.backend ?? defaultBrowser
  const external = backend !== 'builtin'

  // 设置里换了默认浏览器，这个任务用哪个可能跟着变，重新读一次
  useEffect(() => {
    window.diffra.getBrowserState(sessionId).then(
      (current) => current && store.set((app) => ({ ...app, browsers: { ...app.browsers, [sessionId]: current } })),
      (error: unknown) => console.error('读取浏览器状态失败', error),
    )
  }, [sessionId, defaultBrowser])

  useEffect(() => {
    if (!editing) setAddress(state?.url ?? '')
  }, [state?.url, editing])

  useEffect(() => {
    setFrame(null)
    if (!external) return
    return window.diffra.onBrowserFrame((event) => {
      if (event.sessionId === sessionId) setFrame(event.data)
    })
  }, [sessionId, external])

  // 换了浏览器也要重新报一次位置：主进程按这时用的浏览器决定显示原生视图还是投屏
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
  }, [sessionId, backend])

  const navigate = async (url: string) => {
    try {
      await window.diffra.browserNavigate(sessionId, url)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  const open = async (event: FormEvent) => {
    event.preventDefault()
    if (!address.trim()) return
    setEditing(false)
    await navigate(address)
  }

  const openExample = async () => {
    setAddress('localhost:5173')
    await navigate('localhost:5173')
  }

  const hasPage = Boolean(state?.url)
  const name = BROWSER_LABELS[backend]

  return (
    <SidePanel
      width="wide"
      testId="browser-panel"
      controls={
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {hasPage && (
            <>
              <ToolButton label="后退" disabled={!state?.canGoBack} onClick={() => window.diffra.browserCommand(sessionId, 'back')}>
                <ArrowLeft className="size-4" />
              </ToolButton>
              <ToolButton label="前进" disabled={!state?.canGoForward} onClick={() => window.diffra.browserCommand(sessionId, 'forward')}>
                <ArrowRight className="size-4" />
              </ToolButton>
            </>
          )}
          {state?.loading ? (
            <ToolButton label="停止加载" onClick={() => window.diffra.browserCommand(sessionId, 'stop')}>
              <X className="size-4" />
            </ToolButton>
          ) : (
            hasPage && (
              <ToolButton label="刷新" onClick={() => window.diffra.browserCommand(sessionId, 'reload')}>
                <RotateCw className="size-4" />
              </ToolButton>
            )
          )}
          <form onSubmit={open} className={cn('mr-1 min-w-0 flex-1', hasPage && 'ml-1')}>
            <input
              ref={input}
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
        <>
          <BackendMenu sessionId={sessionId} backend={backend} />
          {hasPage &&
            (external ? (
              <ToolButton label={`在 ${name} 里查看`} onClick={() => window.diffra.browserCommand(sessionId, 'external')}>
                <AppWindow className="size-4" />
              </ToolButton>
            ) : (
              <ToolButton label="在系统浏览器里打开" onClick={() => window.diffra.browserCommand(sessionId, 'external')}>
                <ExternalLink className="size-4" />
              </ToolButton>
            ))}
        </>
      }
    >
      {state && state.tabs.length > 1 && (
        // 智能体开了新标签页、网页开了新窗口时才有多个；原生视图在下面，标签条要占位置，不能叠在网页上
        <div role="tablist" aria-label="标签页" className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2" data-testid="browser-tabs">
          {state.tabs.map((tab, index) => (
            <div key={index} className={cn('flex h-7 max-w-44 min-w-0 shrink-0 items-center rounded-md pr-0.5 text-xs', index === state.activeTab ? 'bg-soft text-foreground' : 'text-muted-foreground hover:bg-accent')}>
              <button
                type="button"
                role="tab"
                aria-selected={index === state.activeTab}
                title={tab.url || undefined}
                className="min-w-0 flex-1 truncate px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => window.diffra.browserTab(sessionId, 'select', index)}
              >
                {tab.title || tab.url || '空白页'}
              </button>
              <button
                type="button"
                aria-label="关闭标签页"
                className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10"
                onClick={() => window.diffra.browserTab(sessionId, 'close', index)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {external && state?.external?.paused && (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b bg-warning-soft px-4 py-2.5 text-sm" data-testid="browser-paused">
          <span className="min-w-0 flex-1">你在 {name} 里取消了调试，智能体不再操作浏览器。</span>
          <Button size="sm" variant="outline" onClick={() => window.diffra.browserResume(sessionId)}>
            <Play className="size-3.5" />
            继续
          </Button>
        </div>
      )}
      {/* 网页区域被原生视图盖住，进度条只能画在它上面：零高度的定位层，进度条向上压住顶栏底边，不挤动网页区域 */}
      {state?.loading && (
        <div className="relative h-0 shrink-0">
          <div role="progressbar" aria-label="正在加载网页" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted-foreground/15">
            <div className="h-full w-1/3 -translate-x-full animate-out bg-muted-foreground ease-in-out repeat-infinite slide-out-to-right-[400%] animation-duration-[1.2s] motion-reduce:w-full motion-reduce:translate-x-0 motion-reduce:animate-none" />
          </div>
        </div>
      )}
      {/* 左边 ml-2 留给面板的拖动条：原生视图盖在上面时拖动条点不到 */}
      <div ref={body} className="relative ml-2 min-h-0 flex-1 bg-background" data-testid="browser-viewport">
        {external ? (
          <ExternalBody sessionId={sessionId} name={name} connected={state?.external?.connected ?? false} hasPage={hasPage} frame={frame} />
        ) : (
          !hasPage && (
            <div className="flex h-full items-center justify-center px-6">
              <EmptyState
                icon={Globe}
                title="在上面输入网址，或者让智能体打开网页"
                description={
                  <span className="inline-flex items-center gap-1">
                    本地地址直接打开，外部网站会先征求你同意。
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label="登录状态说明" className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                          <Info className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>内置浏览器的登录状态和你自己的浏览器分开。</TooltipContent>
                    </Tooltip>
                  </span>
                }
                variant="plain"
                className="py-0"
              >
                <Button variant="outline" size="sm" onClick={() => void openExample()}>
                  打开 localhost:5173
                </Button>
              </EmptyState>
            </div>
          )
        )}
      </div>
    </SidePanel>
  )
}

// 用户的 Chrome、Edge：扩展没连上时说怎么装；连上了显示智能体那个标签页的画面
function ExternalBody({ sessionId, name, connected, hasPage, frame }: { sessionId: string; name: string; connected: boolean; hasPage: boolean; frame: string | null }) {
  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState icon={Globe} title={`${name} 里的 Diffra 扩展没有连上`} description={`在 ${name} 里装好并启用 Diffra 浏览器扩展，连上后智能体就能用你的 ${name}。`} variant="plain" className="py-0">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openSettings('browser')}>
              去设置
            </Button>
            <Button variant="ghost" size="sm" onClick={() => window.diffra.browserSetBackend(sessionId, 'builtin')}>
              改用内置浏览器
            </Button>
          </div>
        </EmptyState>
      </div>
    )
  }
  if (!hasPage || !frame) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <EmptyState
          icon={Globe}
          title={hasPage ? '正在取画面…' : `智能体会在你的 ${name} 里操作`}
          description={hasPage ? undefined : `用到浏览器时，它会在 ${name} 里开一个「Diffra · 任务名」分组的标签页，这里显示那个标签页的画面。也可以在上面输入网址。`}
          variant="plain"
          className="py-0"
        />
      </div>
    )
  }
  return <img src={`data:image/jpeg;base64,${frame}`} alt={`${name} 里的页面画面`} className="h-full w-full object-contain object-top" data-testid="browser-mirror" />
}

// 这个任务的智能体用哪个浏览器；默认是设置里选的
function BackendMenu({ sessionId, backend }: { sessionId: string; backend: AgentBrowser }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`智能体用的浏览器：${BROWSER_LABELS[backend]}`} className="gap-1 px-2 text-muted-foreground">
              <span className="max-w-24 truncate text-xs">{BROWSER_LABELS[backend]}</span>
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>智能体用哪个浏览器</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">这个任务的智能体用</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={backend} onValueChange={(next) => window.diffra.browserSetBackend(sessionId, next as AgentBrowser)}>
          {(Object.keys(BROWSER_LABELS) as AgentBrowser[]).map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              {item === 'builtin' ? BROWSER_LABELS[item] : `我的 ${BROWSER_LABELS[item]}`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} className="text-muted-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
