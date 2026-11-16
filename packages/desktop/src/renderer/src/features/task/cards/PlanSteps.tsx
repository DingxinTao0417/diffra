import { useState } from 'react'
import { parseSteps, STEPS_CARD_TITLE, type StepStatus } from '@diffra/core/types'
import { ArrowDown, ArrowUp, Check, Circle, LoaderCircle, Play } from 'lucide-react'
import type { Turn } from '@/features/session/transcript'
import { cn } from 'cn'
import { Checkbox } from '@/components/ui/checkbox'
import { ShellAction } from '../rich/BlockShell'

// 计划卡的步骤视图（第 663 步）：计划文字里「1. …」这样的编号步骤拆出来，能勾掉做完的、上下挪、从某一步开始执行。
// 文字仍是唯一的来源：挪动会重写文字、重新编号；步骤下面缩进的行跟着它走，编号步骤后面不缩进的段落（风险、待确认的问题）原样留在最后

export interface PlanParts {
  head: string[]
  steps: Array<{ title: string; body: string[] }>
  tail: string[]
}

const STEP = /^(\d+)[.、)]\s+(.*)$/

export function splitPlan(text: string): PlanParts {
  const lines = text.split('\n')
  const head: string[] = []
  const steps: PlanParts['steps'] = []
  const tail: string[] = []
  for (const line of lines) {
    const match = STEP.exec(line)
    if (tail.length === 0 && match) {
      steps.push({ title: match[2]!, body: [] })
      continue
    }
    if (steps.length === 0) head.push(line)
    else if (tail.length === 0 && (/^\s+\S/.test(line) || line.trim() === '')) steps.at(-1)!.body.push(line)
    else tail.push(line)
  }
  // 最后一步后面的空行算进结尾，免得挪动时跟着那一步走；中间步骤之间的空行跟着各自的步骤
  const last = steps.at(-1)
  while (last && last.body.at(-1)?.trim() === '') tail.unshift(last.body.pop()!)
  return { head, steps, tail }
}

// 按计划执行（v2，计划逐步打勾）：点「按计划执行」发出的那一轮里，智能体最新的步骤清单（文字）。没有按计划执行过是 null。
// 返回文字而不是数组：选择器每次返回新数组会让界面一直重画
export function planProgressText(turns: Turn[], planTurnId: string): string | null {
  const run = turns.findLast((turn) => turn.fromPlan === planTurnId)
  if (!run) return null
  const card = run.items.findLast((item) => item.kind === 'tool' && item.title === STEPS_CARD_TITLE)
  const text = card?.kind === 'tool' ? card.content.flatMap((content) => (content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [])).join('\n') : ''
  return `${run.endedAt === null ? 'running' : 'ended'}\n${text}`
}

// 计划的每一步对上步骤清单里的状态：先按文字对，对不上按位置（智能体照着计划列的，顺序一样）
export function stepStatuses(titles: string[], progress: string | null): StepStatus[] | null {
  if (progress === null) return null
  const items = parseSteps(progress.slice(progress.indexOf('\n') + 1))
  if (items.length === 0) return titles.map(() => 'pending')
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  return titles.map((title, index) => items.find((item) => normalize(item.content) === normalize(title))?.status ?? (items.length === titles.length ? items[index]!.status : 'pending'))
}

export function joinPlan({ head, steps, tail }: PlanParts): string {
  return [...head, ...steps.flatMap((step, index) => [`${index + 1}. ${step.title}`, ...step.body]), ...tail].join('\n')
}

// progress：按计划执行后每一步的状态（stepStatuses），有了就用它打勾，不再让用户手动勾
export function PlanSteps({
  text,
  readOnly,
  running,
  onChange,
  onRunFrom,
  progress = null,
}: {
  text: string
  readOnly: boolean
  running: boolean
  onChange(text: string): void
  onRunFrom(step: number, done: number[]): void
  progress?: StepStatus[] | null
}) {
  const parts = splitPlan(text)
  const [done, setDone] = useState<Set<string>>(new Set())
  if (parts.steps.length < 2 && !progress) return null
  if (parts.steps.length === 0) return null
  const move = (index: number, offset: number) => {
    const steps = [...parts.steps]
    const [step] = steps.splice(index, 1)
    steps.splice(index + offset, 0, step!)
    onChange(joinPlan({ ...parts, steps }))
  }
  const doneNumbers = parts.steps.flatMap((step, index) => (done.has(step.title) ? [index + 1] : []))
  return (
    <ol className="flex flex-col gap-0.5" data-testid="plan-steps" aria-label="计划步骤">
      {parts.steps.map((step, index) => {
        const status = progress?.[index] ?? null
        const checked = status ? status === 'completed' : done.has(step.title)
        return (
          <li key={`${index}-${step.title}`} className="group/step flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-accent/50" data-testid="plan-step" data-status={status ?? undefined}>
            {status && <StepIcon status={status} />}
            {!readOnly && !status && (
              <Checkbox
                checked={checked}
                aria-label={`第 ${index + 1} 步已经做完：${step.title}`}
                onCheckedChange={() =>
                  setDone((current) => {
                    const next = new Set(current)
                    if (next.has(step.title)) next.delete(step.title)
                    else next.add(step.title)
                    return next
                  })
                }
              />
            )}
            <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{index + 1}.</span>
            <span className={cn('min-w-0 flex-1 truncate', checked && 'text-muted-foreground line-through')} title={[step.title, ...step.body.map((line) => line.trim())].join('\n')}>
              {step.title}
            </span>
            {!readOnly && (
              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/step:opacity-100 focus-within:opacity-100">
                <ShellAction label={`把第 ${index + 1} 步往上挪`} onClick={() => index > 0 && move(index, -1)}>
                  <ArrowUp />
                </ShellAction>
                <ShellAction label={`把第 ${index + 1} 步往下挪`} onClick={() => index < parts.steps.length - 1 && move(index, 1)}>
                  <ArrowDown />
                </ShellAction>
                {!running && (
                  <ShellAction
                    label={`从第 ${index + 1} 步开始执行`}
                    onClick={() => onRunFrom(index + 1, progress ? parts.steps.flatMap((_, position) => (progress[position] === 'completed' ? [position + 1] : [])) : doneNumbers)}
                  >
                    <Play />
                  </ShellAction>
                )}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

const STEP_LABELS: Record<StepStatus, string> = { completed: '已完成', in_progress: '进行中', pending: '还没开始' }

function StepIcon({ status }: { status: StepStatus }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" role="img" aria-label={STEP_LABELS[status]}>
      {/* primary-color-allow: 计划里做完的一步打勾 */}
      {status === 'completed' ? <Check className="size-4 text-primary" /> : status === 'in_progress' ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" /> : <Circle className="size-3 text-muted-foreground" />}
    </span>
  )
}
