import { ChevronLeft, ChevronRight, Columns2, RefreshCw } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { DiffView } from '@/features/session/DiffView'
import type { Turn } from '@/features/session/transcript'
import { Markdown } from './Markdown'

// 重新生成过的一轮（第 676 步）：切换着看每一次、并排对比两次的回答，没改过文件的那一次能换回来。
// 「第几次」按开始的先后数，换回去以后编号不变；null 是现在这一次
export function versionOrder(versions: NonNullable<Turn['versions']>, current: Turn): Array<number | null> {
  return [...versions.map((version, index) => ({ key: index as number | null, at: version.turn.startedAt ?? 0 })), { key: null, at: current.startedAt ?? 0 }].sort((a, b) => a.at - b.at).map((entry) => entry.key)
}

interface TurnVersionsProps {
  versions: NonNullable<Turn['versions']>
  current: Turn
  // 正在看 versions 里的第几个，null 是现在这一次
  viewing: number | null
  onView(index: number | null): void
  comparing: boolean
  onCompare(comparing: boolean): void
  // 能不能换回：最后一轮、没在跑、本机任务
  canUse: boolean
  // 现在这一次改了几个文件：换回去会撤销它们，先说清楚
  currentFiles: number
  onUse(index: number): void
  confirming: boolean
  onConfirm(confirming: boolean): void
}

export function TurnVersions({ versions, current, viewing, onView, comparing, onCompare, canUse, currentFiles, onUse, confirming, onConfirm }: TurnVersionsProps) {
  const order = versionOrder(versions, current)
  const total = order.length
  const position = order.indexOf(viewing) + 1
  const go = (next: number) => onView(order[next - 1] ?? null)
  const version = viewing === null ? null : versions[viewing]
  return (
    <div className="flex flex-col gap-1.5" data-testid="turn-versions">
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5" aria-hidden />
        <span>重新生成过</span>
        <Button variant="ghost" size="icon-xs" aria-label="上一次" disabled={position === 1} onClick={() => go(position - 1)}>
          <ChevronLeft />
        </Button>
        <span className="tabular-nums" data-testid="turn-version-position">
          第 {position}/{total} 次
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="下一次" disabled={position === total} onClick={() => go(position + 1)}>
          <ChevronRight />
        </Button>
        <Button variant="ghost" size="xs" aria-pressed={comparing} className={cn(comparing && 'bg-accent text-foreground')} onClick={() => onCompare(!comparing)}>
          <Columns2 />
          {comparing ? '不对比' : '并排对比'}
        </Button>
        {version && canUse && !version.edited && !confirming && (
          <Button variant="outline" size="xs" onClick={() => (currentFiles > 0 ? onConfirm(true) : onUse(viewing!))}>
            用这一次
          </Button>
        )}
        {version?.edited && <span>那一次改过文件，换不回来；要用它请重新生成</span>}
      </div>
      {version && !comparing && <p className="text-xs text-muted-foreground">这是重新生成之前的那一次，只能看</p>}
      {confirming && version && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs" role="alert">
          <span>换回去会撤销现在这一次改的 {currentFiles} 个文件。</span>
          <Button size="xs" variant="outline" onClick={() => onUse(viewing!)}>
            撤销并换回
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onConfirm(false)}>
            取消
          </Button>
        </div>
      )}
    </div>
  )
}

const answerOf = (turn: Turn) =>
  turn.items
    .flatMap((item) => (item.kind === 'agent' ? [item.text] : []))
    .join('\n\n')
    .trim()

// 两次的回答左右放，下面是逐行的差异
export function VersionCompare({ older, olderLabel, current, currentLabel }: { older: Turn; olderLabel: string; current: Turn; currentLabel: string }) {
  const before = answerOf(older)
  const after = answerOf(current)
  return (
    <div className="flex flex-col gap-3" data-testid="version-compare">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-3">
        {[
          [olderLabel, before],
          [currentLabel, after],
        ].map(([label, text]) => (
          <section key={label} className="min-w-0 rounded-xl border px-3 py-2.5" aria-label={label}>
            <p className="mb-1.5 text-xs text-muted-foreground">{label}</p>
            {text ? <Markdown text={text} /> : <p className="text-sm text-muted-foreground">（这一次没有文字回答）</p>}
          </section>
        ))}
      </div>
      {before !== after && (
        <div className="min-w-0 overflow-hidden rounded-xl border">
          <p className="border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">差异（{olderLabel} → {currentLabel}）</p>
          <DiffView oldText={before} newText={after} />
        </div>
      )}
    </div>
  )
}
