import { type ComponentProps, useId, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { BookOpen, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Info, Lightbulb, type LucideIcon, ShieldAlert, TriangleAlert, Ellipsis } from 'lucide-react'
import { cn } from 'cn'
import type { CalloutKind } from './remark-rich'

// 「完成」（[!SUCCESS]、[!DONE]）只用中性色：模型写的「成功」是它的说法，不是检查跑过的结果（成功色只给经过验证的结果，见 docs/decisions.md 的颜色规则）
const STYLES: Record<CalloutKind, { icon: LucideIcon; title: string; box: string; iconClass: string }> = {
  note: { icon: Info, title: '提示', box: 'bg-muted/50', iconClass: 'text-muted-foreground' },
  tip: { icon: Lightbulb, title: '建议', box: 'bg-muted/50', iconClass: 'text-muted-foreground' },
  important: { icon: CircleAlert, title: '重要', box: 'border-foreground/25 bg-muted/50', iconClass: 'text-foreground' },
  warning: { icon: TriangleAlert, title: '注意', box: 'border-warning/30 bg-warning-soft', iconClass: 'text-warning' },
  risk: { icon: ShieldAlert, title: '风险', box: 'border-destructive/30 bg-destructive-soft', iconClass: 'text-destructive' },
  done: { icon: CircleCheck, title: '完成', box: 'bg-muted/50', iconClass: 'text-muted-foreground' },
  background: { icon: BookOpen, title: '背景', box: 'bg-muted/50', iconClass: 'text-muted-foreground' },
  details: { icon: Ellipsis, title: '详情', box: '', iconClass: 'text-muted-foreground' },
}

// 引用块：带 [!NOTE] 这类标记的（remark-rich 标好的）画成 callout，可以带标题；标记后面加 - 默认收起、加 + 默认展开，「详情」默认收起。普通引用照旧
export function Blockquote({ node, children }: ComponentProps<'blockquote'> & ExtraProps) {
  const kind = node?.properties.dataCallout as CalloutKind | undefined
  if (!kind || !STYLES[kind]) return <blockquote>{children}</blockquote>
  const fold = node?.properties.dataCalloutFold as string | undefined
  const title = (node?.properties.dataCalloutTitle as string | undefined) ?? STYLES[kind].title
  return (
    <Callout kind={kind} title={title} foldable={Boolean(fold) || kind === 'details'} defaultOpen={fold === '+'}>
      {children}
    </Callout>
  )
}

function Callout({ kind, title, foldable, defaultOpen, children }: { kind: CalloutKind; title: string; foldable: boolean; defaultOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!foldable || defaultOpen)
  const bodyId = useId()
  const style = STYLES[kind]
  const Icon = style.icon
  const heading = (
    <>
      <Icon className={cn('size-4 shrink-0', style.iconClass)} aria-hidden="true" />
      <span className="min-w-0 font-bold">{title}</span>
    </>
  )
  return (
    <div className={cn('callout rounded-lg border px-3 py-2', style.box)} role="note" aria-label={title} data-testid="callout" data-callout={kind}>
      {foldable ? (
        <button type="button" aria-expanded={open} aria-controls={bodyId} className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 text-left hover:bg-accent/60" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-2">{heading}</div>
      )}
      <div id={bodyId} hidden={!open} className="callout-body mt-1">
        {children}
      </div>
    </div>
  )
}
