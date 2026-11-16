import { useMemo, useState } from 'react'
import { compareEval, type EvalOutcome, summarizeEval } from '@diffra/core/types'
import { FileJson, GitCompare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { formatDuration, formatTokens } from '@/lib/format'
import { showToast } from '@/state/store'
import { SettingsGroup, SettingsHeader } from './SettingsLayout'

type Loaded = { path: string; startedAt: string | null; outcomes: EvalOutcome[] }

const DIFFICULTY = { easy: '易', medium: '中', hard: '难' } as const
const percent = (value: number) => `${Math.round(value * 100)}%`

// 评测结果（v2 · M11）：看 packages/eval 跑出来的 results.json——通过率和 95% 区间、费用、按类别和难度，
// 再选一份就按题配对比较（自助法区间和符号检验）。统计用 core 的 stats.ts，和评测命令行的报告同一套算法
export function EvalSection() {
  const [current, setCurrent] = useState<Loaded | null>(null)
  const [baseline, setBaseline] = useState<Loaded | null>(null)

  const open = async (target: 'current' | 'baseline') => {
    try {
      const loaded = await window.diffra.openEvalResults()
      if (!loaded) return
      if (target === 'current') setCurrent(loaded)
      else setBaseline(loaded)
    } catch (error) {
      showToast(`打不开：${errorMessage(error)}`)
    }
  }

  const summary = useMemo(() => (current ? summarizeEval(current.outcomes) : null), [current])
  const comparisons = useMemo(() => (current && baseline ? compareEval(baseline.outcomes, current.outcomes) : null), [current, baseline])

  return (
    <>
      <SettingsHeader
        title="评测结果"
        description="看评测命令行（packages/eval）跑出来的 results.json：通过率和区间、费用、按类别和难度；再选一份旧结果就能比较。只读，不改文件。"
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void open('current')}>
              <FileJson className="size-3.5" />
              打开 results.json
            </Button>
            {current && (
              <Button size="sm" variant="outline" onClick={() => void open('baseline')}>
                <GitCompare className="size-3.5" />
                和另一份比较
              </Button>
            )}
          </div>
        }
      />
      {!current && <p className="text-sm text-muted-foreground">还没打开评测结果。</p>}
      {current && summary && (
        <div className="space-y-6" data-testid="eval-results">
          <p className="truncate text-xs text-muted-foreground" title={current.path}>
            {current.path}
            {current.startedAt && ` · ${current.startedAt}`} · {current.outcomes.length} 次运行
          </p>
          {summary.models.map((model) => (
            <SettingsGroup key={model.model} title={model.model} data-testid="eval-model">
              <div className="space-y-2 p-4 text-sm">
                <p>
                  通过 {model.rate.passed}/{model.rate.runs}（{percent(model.rate.rate)}，95% 区间 {percent(model.rate.low)}–{percent(model.rate.high)}）；平均每次 {formatTokens(Math.round(model.averageTokens))} token、{formatDuration(model.averageDurationMs)}
                  {model.cost !== null && `；费用 ${model.cost}${model.costPartial ? '（有的题没有单价）' : ''}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  按类别：{model.byCategory.map((item) => `${item.category} ${item.rate.passed}/${item.rate.runs}`).join('，')}
                </p>
                <p className="text-xs text-muted-foreground" data-testid="eval-difficulty">
                  按实际难度：
                  {model.byDifficulty
                    .filter((item) => item.measured)
                    .map((item) => `${DIFFICULTY[item.difficulty]} ${item.measured!.passed}/${item.measured!.runs}`)
                    .join('，')}
                  {model.byDifficulty.some((item) => item.declared) && `；按标的难度：${model.byDifficulty.filter((item) => item.declared).map((item) => `${DIFFICULTY[item.difficulty]} ${item.declared!.passed}/${item.declared!.runs}`).join('，')}`}
                </p>
              </div>
            </SettingsGroup>
          ))}
          {comparisons && (
            <SettingsGroup title="比较" data-testid="eval-compare">
              <div className="space-y-3 p-4 text-sm">
                <p className="truncate text-xs text-muted-foreground" title={baseline!.path}>
                  A（旧）：{baseline!.path}；B（新）：当前打开的这份。按题配对，p 值是符号检验，区间是按题重抽的自助法区间。
                </p>
                {comparisons.length === 0 && <p className="text-muted-foreground">两份没有同一个模型跑过的同一道题。</p>}
                {comparisons.map((item) => {
                  const significant = item.pValue < 0.05
                  return (
                    <div key={item.model} className="space-y-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.model}</span>
                        <Badge variant={significant ? (item.difference > 0 ? 'secondary' : 'destructive') : 'outline'}>{significant ? (item.difference > 0 ? '新的更好' : '新的更差') : '看不出差别'}</Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.tasks} 道题：A {percent(item.a.rate)} → B {percent(item.b.rate)}，平均 {item.difference >= 0 ? '+' : ''}
                        {percent(item.difference)}（区间 {percent(item.low)}–{percent(item.high)}）；更好 {item.better}、更差 {item.worse}、一样 {item.ties}；p = {item.pValue.toFixed(4)}
                      </p>
                    </div>
                  )
                })}
              </div>
            </SettingsGroup>
          )}
          <SettingsGroup title="每道题" className="overflow-x-auto">
            <table className="w-full min-w-xl text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-normal">题目</th>
                  <th className="px-3 py-2 text-left font-normal">模型</th>
                  <th className="px-3 py-2 text-right font-normal">通过</th>
                  <th className="px-3 py-2 text-right font-normal">实际难度</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {summary.tasks.map((task) => (
                  <tr key={`${task.model}:${task.id}`} data-testid="eval-task">
                    <td className="px-3 py-1.5 font-mono text-xs">{task.id}</td>
                    <td className="px-3 py-1.5 text-xs">{task.model}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {task.rate.passed}/{task.rate.runs}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {DIFFICULTY[task.measured]}
                      {task.declared && task.declared !== task.measured && <span className="text-xs text-muted-foreground">（标的{DIFFICULTY[task.declared]}）</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SettingsGroup>
        </div>
      )}
    </>
  )
}
