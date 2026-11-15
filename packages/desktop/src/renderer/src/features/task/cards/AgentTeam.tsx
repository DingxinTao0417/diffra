import { Check, LoaderCircle, Users, X } from 'lucide-react'
import type { TranscriptItem } from '@/features/session/transcript'
import { formatDuration } from '@/lib/format'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// 一次派出几个子智能体时，卡片上面一行「组织图」（第 660 步）：主智能体下面挂着每个子智能体的名字、颜色、状态和用时，点一下滚到它的卡片
export function AgentTeam({ items, onJump }: { items: ToolItem[]; onJump(id: string): void }) {
  const done = items.filter((item) => item.status === 'completed').length
  const failed = items.filter((item) => item.status === 'failed').length
  const running = items.length - done - failed
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="agent-team">
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Users className="size-3.5 shrink-0" aria-hidden="true" />
        主智能体派出 {items.length} 个子智能体
        {running > 0 && <span>· 进行中 {running}</span>}
        {done > 0 && <span>· 完成 {done}</span>}
        {failed > 0 && <span className="text-destructive">· 没完成 {failed}</span>}
      </p>
      <ul className="ml-1.5 flex flex-wrap gap-1.5 border-l-2 pl-3">
        {items.map((item) => {
          const card = item.agentCard!
          const duration = card.startedAt !== undefined && card.endedAt !== undefined ? card.endedAt - card.startedAt : null
          return (
            <li key={item.id}>
              <button type="button" className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 hover:bg-accent" title={card.task} onClick={() => onJump(item.id)} data-testid="agent-team-member" data-status={item.status}>
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: card.color }} aria-hidden="true" />
                <span className="font-bold">{card.name}</span>
                {item.status === 'completed' ? (
                  <Check className="size-3 shrink-0 text-muted-foreground" strokeWidth={2.6} aria-label="完成" />
                ) : item.status === 'failed' ? (
                  <X className="size-3 shrink-0 text-destructive" strokeWidth={2.6} aria-label="没完成" />
                ) : (
                  <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="进行中" />
                )}
                {duration !== null && <span className="text-muted-foreground tabular-nums">{formatDuration(duration)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
