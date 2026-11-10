import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { remPx } from '@/lib/shell'
import { saveLayout, setLayout } from '@/state/actions'
import { store, useAppState } from '@/state/store'

// 审阅和浏览器共用一个宽度，两者互切时对话列不动；设计面板占满对话列以外的主区
const WIDTHS = {
  narrow: 'w-[22rem]',
  wide: 'w-[min(50%,720px)] min-w-96',
  fill: 'min-w-0 flex-1',
}

// 拖过的宽度存在哪一项；设计面板占满主区，拖的是对话列（见 TaskView）
const LAYOUT_KEYS = { narrow: 'monitorWidth', wide: 'widePanelWidth' } as const
const MIN_REM = { narrow: 18, wide: 24 }
// 拖面板时对话列至少留这么宽；窗口变窄时同样用它压住拖过的宽度
export const CHAT_MIN_REM = 24

interface SidePanelProps {
  width: keyof typeof WIDTHS
  testId: string
  title?: ReactNode
  // 标题右侧的面板专属控件；顶栏不换行，放不下的内容由各面板自己按容器宽度隐藏
  controls?: ReactNode
  // 紧挨关闭按钮左侧、用分隔线隔开的操作
  actions?: ReactNode
  children: ReactNode
}

export function SidePanel({ width, testId, title, controls, actions, children }: SidePanelProps) {
  const resize = width === 'fill' ? null : { key: LAYOUT_KEYS[width], minRem: MIN_REM[width] }
  const stored = useAppState((state) => (resize ? (state.settings?.layout[resize.key] ?? null) : null))
  return (
    <aside
      className={cn('relative flex shrink-0 flex-col border-l border-border bg-background', WIDTHS[width])}
      style={stored === null ? undefined : { width: stored, maxWidth: `calc(100% - ${CHAT_MIN_REM}rem)` }}
      data-testid={testId}
    >
      {resize && (
        // 拖动条整个放在面板这一侧：对话列贴边的 10px 是对话区的滚动条，实测按在那里点到的是滚动条，盖在上面的拖动条抢不到；
        // 浏览器的网页是盖在面板上的原生视图，所以网页区左边留出 ml-2（见 BrowserPanel）
        <ResizeHandle
          orientation="vertical"
          grow={-1}
          label="拖动调整面板宽度"
          className="absolute inset-y-0 -left-px"
          measure={(handle) => {
            const panel = handle.parentElement!
            const row = panel.parentElement!.clientWidth
            const min = remPx(resize.minRem)
            return { size: panel.getBoundingClientRect().width, min, max: Math.max(min, row - remPx(CHAT_MIN_REM)) }
          }}
          onResize={(size) => setLayout({ [resize.key]: size })}
          onCommit={(size) => void saveLayout({ [resize.key]: size })}
          onReset={() => void saveLayout({ [resize.key]: null })}
        />
      )}
      <div className="@container flex h-11 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b border-border pr-2.5 pl-4">
        {title && <span className="shrink-0 text-sm font-bold">{title}</span>}
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2">{controls}</div>
        {actions && (
          <>
            {actions}
            <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="关闭面板" className="text-muted-foreground" onClick={() => store.set((state) => ({ ...state, panel: null }))}>
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>关闭面板</TooltipContent>
        </Tooltip>
      </div>
      {children}
    </aside>
  )
}
