import { type ReactNode, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

// 回答里富块（代码、改动、公式、流程图、图表……）共用的外壳：顶栏放图标、标题和操作，下面是内容。
// code 是代码类的底色（和以前的代码块一样是 muted），card 是图表这类的卡片底色
export interface BlockShellProps {
  testId: string
  kind?: string
  icon?: ReactNode
  title: ReactNode
  // 标题后面的补充：行数、增删数
  meta?: ReactNode
  actions?: ReactNode
  // 放大看：在弹窗里重新画一份内容（给了才有「放大」按钮）
  expand?: () => ReactNode
  tone?: 'code' | 'card'
  className?: string
  children: ReactNode
}

export function BlockShell({ testId, kind, icon, title, meta, actions, expand, tone = 'code', className, children }: BlockShellProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <figure className={cn('min-w-0 overflow-hidden rounded-lg border', tone === 'code' ? 'bg-muted' : 'bg-card', className)} data-testid={testId} data-kind={kind}>
      <figcaption className="flex h-7 items-center gap-1.5 border-b pr-1 pl-3 text-xs text-muted-foreground">
        {icon}
        <span className="min-w-0 truncate">{title}</span>
        {meta}
        <span className="ml-auto flex shrink-0 items-center">
          {actions}
          {expand && (
            <ShellAction label="放大" onClick={() => setExpanded(true)}>
              <Maximize2 />
            </ShellAction>
          )}
        </span>
      </figcaption>
      {children}
      {expand && (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="flex max-h-[90vh] max-w-[min(90vw,72rem)] flex-col gap-3 sm:max-w-[min(90vw,72rem)]">
            <DialogTitle className="truncate pr-8 text-base">{title}</DialogTitle>
            <div className="min-h-0 flex-1 overflow-auto">{expanded && expand()}</div>
          </DialogContent>
        </Dialog>
      )}
    </figure>
  )
}

export function ShellAction({ label, onClick, pressed, children }: { label: string; onClick(): void; pressed?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} aria-pressed={pressed} className={cn(pressed && 'bg-accent text-foreground')} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// 流式输出里还没写完的富块：先占一块位置，写完再换成图，不先闪一下代码
export function BlockSkeleton({ label, testId = 'rich-skeleton' }: { label: string; testId?: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded-lg border border-dashed bg-muted/40 text-xs text-muted-foreground" role="status" aria-busy="true" data-testid={testId}>
      <span className="animate-pulse">{label}</span>
    </div>
  )
}

// 富块画不出来（数据不对、语法错误）时贴在代码下面的一句话
export function FallbackNote({ message }: { message: string }) {
  return (
    <p className="border-t px-3 py-1.5 text-xs text-muted-foreground" data-testid="rich-fallback">
      {message}
    </p>
  )
}

export function copyText(text: string, done: string) {
  navigator.clipboard.writeText(text).then(
    () => showToast(done),
    (error: unknown) => showToast(`复制失败：${errorMessage(error)}`),
  )
}
