import { type ComponentProps, type ReactNode, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Download, MessageCircleQuestion, Pin } from 'lucide-react'
import { cn } from 'cn'
import { copyText, ShellAction } from '../rich/BlockShell'
import { downloadBlob, safeFileName } from '../rich/download'
import { useAskAbout } from '../SelectionAsk'
import { pinItem, pinnedFrom, usePinTarget } from '../pins'
import { snapshotHtml } from '../static-html'

// 对话里过程卡片的统一外壳（第 656 步）：状态色、密度、图标、标题、副标题、操作区、页脚、展开收起、复制、导出 Markdown。
// 新卡片只写内容。两档密度沿用以前 Conversation.tsx 的 CARD、CARD_COMPACT：标准给出错、定位结果、计划、深度扫描报告；
// 紧凑给提醒、子智能体、规范审查打回、安全检查有发现（docs/decisions.md 的「界面视觉规范」）
// 标准卡带一层很浅的卡片阴影（第 693 步），紧凑卡是行内提示，仍然只画边线
export const CARD = 'flex flex-col gap-2.5 rounded-xl border bg-card px-3.5 py-3 shadow-card'
export const CARD_COMPACT = 'flex flex-col gap-1.5 rounded-xl border px-3 py-2.5'

// 带底色的提示卡描边统一 /30
const TONES = {
  default: '',
  warning: 'border-warning/30 bg-warning-soft',
  danger: 'border-destructive/30 bg-destructive-soft',
} as const

export interface CardShellProps extends Omit<ComponentProps<'section'>, 'title'> {
  tone?: keyof typeof TONES
  density?: 'standard' | 'compact'
  icon?: ReactNode
  title: ReactNode
  // 标题后面的一句补充（灰字）
  subtitle?: ReactNode
  // 标题文字的颜色（出错卡的标题是红的）
  titleClassName?: string
  // 标题行右边的按钮
  actions?: ReactNode
  footer?: ReactNode
  // 能收起：默认展开与否；收起时只剩标题行
  collapsible?: { defaultOpen: boolean }
  // 复制：给了就有「复制」按钮，复制返回的文字
  copy?: { label?: string; text: () => string }
  // 导出：存成 Markdown 文件
  exportMarkdown?: { name: string; text: () => string }
}

export function CardShell({ tone = 'default', density = 'standard', icon, title, subtitle, titleClassName, actions, footer, collapsible, copy, exportMarkdown, className, children, ...props }: CardShellProps) {
  const [open, setOpen] = useState(collapsible?.defaultOpen ?? true)
  const bodyId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  // 「问问这张卡」（第 674 步）：把卡片上的字引用进输入框，远程、只读的会话没有
  const ask = useAskAbout()
  // 固定到白板（第 677 步）：固定这张卡此刻的样子，能固定几次，跨轮对比
  const pin = usePinTarget(null)
  const pinCard = () => {
    const element = sectionRef.current
    if (!pin || !element) return
    const name = element.querySelector('header')?.textContent?.trim() || '卡片'
    pinItem({ kind: 'card', sessionId: pin.sessionId, id: crypto.randomUUID(), title: name, html: snapshotHtml(element), ...pinnedFrom(pin.sessionId, element) })
  }
  const heading = (
    <>
      {icon}
      <span className={cn('min-w-0 font-bold', titleClassName)}>{title}</span>
      {subtitle && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{subtitle}</span>}
    </>
  )
  const tools = (actions || copy || exportMarkdown || ask || pin) && (
    <span className="ml-auto flex shrink-0 items-center text-muted-foreground">
      {actions}
      {pin && (
        <ShellAction label="固定到白板" onClick={pinCard}>
          <Pin />
        </ShellAction>
      )}
      {ask && (
        <ShellAction label="问问这张卡" onClick={() => ask('关于这张卡片：', sectionRef.current?.innerText ?? '')}>
          <MessageCircleQuestion />
        </ShellAction>
      )}
      {copy && (
        <ShellAction label={copy.label ?? '复制'} onClick={() => copyText(copy.text(), '已复制')}>
          <Copy />
        </ShellAction>
      )}
      {exportMarkdown && (
        <ShellAction label="导出为 Markdown" onClick={() => downloadBlob(new Blob([exportMarkdown.text()], { type: 'text/markdown' }), `${safeFileName(exportMarkdown.name)}.md`)}>
          <Download />
        </ShellAction>
      )}
    </span>
  )
  return (
    <section ref={sectionRef} className={cn(density === 'standard' ? CARD : CARD_COMPACT, TONES[tone], 'text-sm', className)} {...props}>
      <header className="-my-0.5 flex min-h-6 items-center gap-2">
        {collapsible ? (
          <button type="button" aria-expanded={open} aria-controls={bodyId} className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-accent/60" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            {heading}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-2">{heading}</span>
        )}
        {tools}
      </header>
      <div id={bodyId} hidden={!open} className="contents">
        {children}
      </div>
      {open && footer}
    </section>
  )
}
