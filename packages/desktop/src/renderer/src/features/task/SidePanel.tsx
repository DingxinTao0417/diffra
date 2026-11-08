import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { store } from '@/state/store'

// 审阅和浏览器共用一个宽度，两者互切时对话列不动；设计面板占满对话列以外的主区
const WIDTHS = {
  narrow: 'w-[22rem]',
  wide: 'w-[min(50%,720px)] min-w-96',
  fill: 'min-w-0 flex-1',
}

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
  return (
    <aside className={cn('flex shrink-0 flex-col border-l border-border bg-background', WIDTHS[width])} data-testid={testId}>
      <div className="@container flex h-11 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b border-border pr-2.5 pl-4">
        {title && <span className="shrink-0 text-sm font-semibold">{title}</span>}
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
