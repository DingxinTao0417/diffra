import { useState } from 'react'
import { ArrowDown, ArrowUp, Play } from 'lucide-react'
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

export function joinPlan({ head, steps, tail }: PlanParts): string {
  return [...head, ...steps.flatMap((step, index) => [`${index + 1}. ${step.title}`, ...step.body]), ...tail].join('\n')
}

export function PlanSteps({ text, readOnly, running, onChange, onRunFrom }: { text: string; readOnly: boolean; running: boolean; onChange(text: string): void; onRunFrom(step: number, done: number[]): void }) {
  const parts = splitPlan(text)
  const [done, setDone] = useState<Set<string>>(new Set())
  if (parts.steps.length < 2) return null
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
        const checked = done.has(step.title)
        return (
          <li key={`${index}-${step.title}`} className="group/step flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-accent/50" data-testid="plan-step">
            {!readOnly && (
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
                  <ShellAction label={`从第 ${index + 1} 步开始执行`} onClick={() => onRunFrom(index + 1, doneNumbers)}>
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
