import { useState } from 'react'
import { parseSteps, STEPS_CARD_TITLE } from '@diffra/core/types'
import { Check, ChevronDown, ChevronUp, ListChecks, LoaderCircle } from 'lucide-react'
import { cn } from 'cn'
import type { Turn } from '@/features/session/transcript'
import { StepMark } from './StepMark'

// 输入框上方的步骤条（第 542 步）：最近一次提问那一轮里智能体列的步骤（update_plan 的最新一份），默认收起成一行，点开看全部，跟着更新。
// 以前在对话里画成步骤卡。这一轮做完后还留着，发了下一条消息、新的一轮没列步骤时就没了
export function StepsBar({ turns, running }: { turns: Turn[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const steps = latestSteps(turns)
  if (steps.length === 0) return null
  const done = steps.filter((step) => step.status === 'completed').length
  const finished = done === steps.length
  const current = steps.find((step) => step.status === 'in_progress') ?? steps.find((step) => step.status === 'pending')
  const Icon = finished ? Check : running ? LoaderCircle : ListChecks
  const summary = finished ? '已完成' : (current?.content ?? '')
  return (
    // 贴在输入框上沿，两边比输入框各收进一点；-mb-2 抵掉外面一列的间距，底边接上输入框的边框
    <div className="mx-3.5 -mb-2 flex flex-col rounded-t-xl border border-b-0 border-input bg-card text-sm dark:border-input/50" data-testid="steps-bar">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`步骤 ${done}/${steps.length}，${finished ? '已完成' : `正在做：${summary}`}`}
        className="flex h-8 items-center gap-2 rounded-t-xl px-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(!open)}
      >
        <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', running && !finished && 'animate-spin')} />
        <span className="shrink-0 text-muted-foreground">
          步骤 {done}/{steps.length}
        </span>
        {!open && <span className={cn('min-w-0 flex-1 truncate', finished ? 'text-muted-foreground' : 'text-foreground/90')}>{summary}</span>}
        {open && <span className="flex-1" />}
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto px-3 pt-0.5 pb-3 pl-8">
          {steps.map((step, index) => (
            <li key={index} className="flex items-start gap-2 leading-relaxed" data-testid="step" data-status={step.status}>
              <StepMark status={step.status} />
              <span className={cn('min-w-0 break-words', step.status === 'completed' && 'text-muted-foreground', step.status === 'in_progress' && 'font-bold')}>{step.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// 最近一次提问（或目标）那一轮里主智能体最新的步骤清单；子智能体自己的不算
function latestSteps(turns: Turn[]) {
  const turn = turns.findLast((item) => item.kind === 'prompt' || item.kind === 'goal')
  const card = turn?.items.findLast((item) => item.kind === 'tool' && item.title === STEPS_CARD_TITLE && !item.parentId)
  if (card?.kind !== 'tool') return []
  return parseSteps(card.content.flatMap((content) => (content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [])).join('\n'))
}
