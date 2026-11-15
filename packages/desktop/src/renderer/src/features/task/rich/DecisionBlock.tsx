import { useContext, useMemo, useState } from 'react'
import type { DecisionData } from '@diffra/core/rich'
import { Check, ChevronDown, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fillComposer } from '@/state/actions'
import { AnswerContext } from '../answer-links'
import { useStatic } from '../static-context'

const MAX_WEIGHT = 5

// 决策卡（第 689 步）：方案按加权平均分排名，改权重（0–5，0 是不看这一项）排名跟着变；「选这个」连同当时的权重填进输入框（只有本机任务）。
// 「推荐」是模型的说法，用中性的描边徽标；分数条用图表色。远程、只读的会话也能改权重看排名，只是没有「选这个」
export function DecisionBlock({ data }: { data: DecisionData }) {
  const target = useContext(AnswerContext)
  const isStatic = useStatic()
  const initial = data.criteria.map((criterion) => criterion.weight)
  const [weights, setWeights] = useState(initial)
  const [open, setOpen] = useState<number | null>(null)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const changed = weights.some((weight, index) => weight !== initial[index])
  const ranked = useMemo(
    () =>
      data.options
        .map((option, index) => ({ option, index, score: option.scores.reduce((sum, score, at) => sum + score * weights[at]!, 0) / total }))
        .sort((a, b) => b.score - a.score || a.index - b.index),
    [data.options, weights, total],
  )
  // 权重合计只剩 1 时不能再降（下面的 disabled）：至少留一项大于 0，平均分才有意义
  const step = (index: number, delta: number) => setWeights((current) => current.map((weight, at) => (at === index ? Math.min(MAX_WEIGHT, Math.max(0, weight + delta)) : weight)))
  const choose = (name: string) => fillComposer(target!.sessionId, `选「${name}」。我看重的：${data.criteria.map((criterion, index) => `${criterion.name}（权重 ${weights[index]}）`).join('、')}`)

  return (
    <figure className="flex flex-col gap-2" data-testid="rich-decision" data-kind="decision">
      {(data.title || data.question) && (
        <figcaption className="flex flex-col gap-0.5">
          {data.title && <span className="text-xs text-muted-foreground">{data.title}</span>}
          {data.question && <span className="text-sm">{data.question}</span>}
        </figcaption>
      )}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="评判标准的权重">
        {data.criteria.map((criterion, index) => (
          <span key={index} className="flex items-center gap-0.5 rounded-md border py-0.5 pr-0.5 pl-2 text-sm" data-testid="decision-weight">
            <span className={cn('break-all', weights[index] === 0 && 'text-muted-foreground line-through')}>{criterion.name}</span>
            {isStatic ? (
              <span className="px-1 text-xs text-muted-foreground tabular-nums">×{weights[index]}</span>
            ) : (
              <>
                <Button variant="ghost" size="icon-xs" aria-label={`降低「${criterion.name}」的权重`} disabled={weights[index] === 0 || total === 1} onClick={() => step(index, -1)}>
                  <Minus />
                </Button>
                <span className="w-3 text-center text-xs tabular-nums" aria-live="polite" aria-label={`「${criterion.name}」的权重`}>
                  {weights[index]}
                </span>
                <Button variant="ghost" size="icon-xs" aria-label={`提高「${criterion.name}」的权重`} disabled={weights[index] === MAX_WEIGHT} onClick={() => step(index, 1)}>
                  <Plus />
                </Button>
              </>
            )}
          </span>
        ))}
        {changed && !isStatic && (
          <Button variant="ghost" size="xs" onClick={() => setWeights(initial)}>
            <RotateCcw />
            恢复模型给的权重
          </Button>
        )}
      </div>
      <ol className="flex flex-col gap-1.5">
        {ranked.map(({ option, index, score }, rank) => {
          const expanded = isStatic || open === index
          return (
            <li key={index} className="flex min-w-0 flex-col gap-1.5 rounded-lg border px-3 py-2" data-testid="decision-option" data-recommended={option.recommended || undefined}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs text-muted-foreground tabular-nums">{rank + 1}</span>
                <span className="min-w-0 font-bold break-words">{option.name}</span>
                {option.recommended && <Badge variant="outline">模型推荐</Badge>}
                <span className="ml-auto text-sm tabular-nums" data-testid="decision-score">
                  {score.toFixed(1)}
                  <span className="text-xs text-muted-foreground"> / {data.scale}</span>
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full bg-chart-1 transition-[width]" style={{ width: `${(score / data.scale) * 100}%` }} />
              </div>
              {option.summary && <p className="text-sm break-words text-muted-foreground">{option.summary}</p>}
              {!isStatic && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" aria-expanded={open === index} className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(open === index ? null : index)}>
                    {open === index ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    各项得分
                  </button>
                  {target && (
                    <Button variant="outline" size="sm" className="ml-auto" onClick={() => choose(option.name)}>
                      <Check />
                      选这个
                    </Button>
                  )}
                </div>
              )}
              {expanded && (
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm" data-testid="decision-scores">
                  {data.criteria.map((criterion, at) => (
                    <div key={at} className="contents">
                      <dt className={cn('text-muted-foreground', weights[at] === 0 && 'line-through')}>{criterion.name}</dt>
                      <dd className="tabular-nums">
                        {option.scores[at]} / {data.scale}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          )
        })}
      </ol>
    </figure>
  )
}
