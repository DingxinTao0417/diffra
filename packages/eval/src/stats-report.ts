import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalComparison, EvalModelSummary, EvalOutcome } from '@diffra/core/types'
import { coreTypes } from './core.ts'

// 评测统计（v2 · M11）：报告里的按难度和费用，两次结果的比较。计算都在 core 的 stats.ts，这里只排版
const DIFFICULTY_LABELS = { easy: '易', medium: '中', hard: '难' } as const

interface StoredTask {
  id: string
  category: string
  model: string
  passed: boolean
  difficulty?: 'easy' | 'medium' | 'hard' | null
  durationMs: number
  usage: { inputTokens: number; outputTokens: number; cost?: string | null }
}

// results.json（或它所在的目录）→ 每道题每遍的结果；旧结果没有难度和费用
export function readOutcomes(path: string): EvalOutcome[] {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'results.json') : path
  const results = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: StoredTask[] }
  return outcomesOf(results.tasks ?? [])
}

export function outcomesOf(tasks: readonly StoredTask[]): EvalOutcome[] {
  return tasks.map((task) => ({
    id: task.id,
    category: task.category,
    model: task.model,
    passed: task.passed,
    difficulty: task.difficulty ?? null,
    tokens: task.usage.inputTokens + task.usage.outputTokens,
    cost: task.usage.cost ?? null,
    durationMs: task.durationMs,
  }))
}

const percent = (value: number) => `${Math.round(value * 100)}%`
const interval = (rate: { low: number; high: number }) => `${percent(rate.low)}–${percent(rate.high)}`

// 报告里每个模型多两行：通过率的区间和费用、按难度
export function summaryLines(summary: EvalModelSummary): string[] {
  const lines = [`通过率 ${percent(summary.rate.rate)}（95% 区间 ${interval(summary.rate)}）${summary.cost !== null ? `；费用 ${summary.cost}${summary.costPartial ? '（有的题没有单价，没算）' : ''}` : ''}`, '']
  const declared = summary.byDifficulty.filter((item) => item.declared)
  const measured = summary.byDifficulty.filter((item) => item.measured)
  lines.push(
    `按难度：${declared.length > 0 ? `标的 ${declared.map((item) => `${DIFFICULTY_LABELS[item.difficulty]} ${item.declared!.passed}/${item.declared!.runs}`).join('，')}；` : ''}按实际通过率 ${measured.map((item) => `${DIFFICULTY_LABELS[item.difficulty]} ${item.measured!.passed}/${item.measured!.runs}`).join('，')}`,
    '',
  )
  return lines
}

export function compareMarkdown(aLabel: string, bLabel: string, comparisons: readonly EvalComparison[]): string {
  const lines = ['# 评测结果比较', '', `- A：${aLabel}`, `- B：${bLabel}`, '', '按题配对：每道题看两边的通过率；p 值是符号检验（双侧），区间是按题重抽 2000 次的 95% 自助法区间。p < 0.05 才算有差别；题少、遍数少时区间会很宽。', '']
  if (comparisons.length === 0) lines.push('两边没有同一个模型跑过的同一道题，比不了。')
  for (const item of comparisons) {
    const verdict = item.pValue < 0.05 ? (item.difference > 0 ? 'B 更好' : 'A 更好') : '看不出差别'
    lines.push(
      `## ${item.model}`,
      '',
      `${item.tasks} 道题：A 通过 ${item.a.passed}/${item.a.runs}（${percent(item.a.rate)}），B 通过 ${item.b.passed}/${item.b.runs}（${percent(item.b.rate)}）；` +
        `B 减 A 平均 ${item.difference >= 0 ? '+' : ''}${percent(item.difference)}（区间 ${percent(item.low)}–${percent(item.high)}）；B 更好 ${item.better} 道、更差 ${item.worse} 道、一样 ${item.ties} 道；p = ${item.pValue.toFixed(4)}，${verdict}`,
      '',
    )
    const changed = item.rows.filter((row) => row.a !== row.b)
    if (changed.length > 0) {
      lines.push('| 题目 | A | B |', '|---|---|---|')
      for (const row of changed) lines.push(`| ${row.id} | ${percent(row.a)} | ${percent(row.b)} |`)
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function compareResults(aPath: string, bPath: string): string {
  return compareMarkdown(aPath, bPath, coreTypes.compareEval(readOutcomes(aPath), readOutcomes(bPath)))
}
