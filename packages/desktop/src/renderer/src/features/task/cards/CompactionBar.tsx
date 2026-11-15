import type { CompactionStats } from '@diffra/core/types'
import { formatTokens } from '@/lib/format'

// 上下文压缩前后的对比条（第 660 步）：按模型窗口画（手动压缩没有窗口时按压缩前的量画满），颜色用上下文用量的 chart 令牌
export function CompactionBar({ stats }: { stats: CompactionStats }) {
  const scale = Math.max(stats.window ?? stats.before, 1)
  const width = (value: number) => `${Math.max(1, Math.min(100, (value / scale) * 100))}%`
  const saved = stats.after === null ? null : Math.max(0, stats.before - stats.after)
  return (
    <div className="mt-1.5 ml-5.5 flex max-w-96 flex-col gap-1 text-xs text-muted-foreground" data-testid="compaction-bar">
      <Bar label="压缩前" value={stats.before} width={width(stats.before)} className="bg-chart-4" />
      {stats.after !== null && <Bar label="压缩后" value={stats.after} width={width(stats.after)} className="bg-chart-1" />}
      <p className="tabular-nums">
        {stats.window !== null && `窗口 ${formatTokens(stats.window)} · `}
        {saved !== null ? `少了约 ${formatTokens(saved)} token（${Math.round((saved / Math.max(stats.before, 1)) * 100)}%）` : '压缩后的用量下一次调用模型时才知道'}
      </p>
    </div>
  )
}

function Bar({ label, value, width, className }: { label: string; value: number; width: string; className: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0">{label}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}约 ${formatTokens(value)} token`}>
        <span className={`block h-full rounded-full ${className}`} style={{ width }} />
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums">{formatTokens(value)}</span>
    </div>
  )
}
