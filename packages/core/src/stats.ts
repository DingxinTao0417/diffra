// 评测结果的统计（v2 · M11）：纯计算，评测命令行和桌面端的「评测结果」页共用。
// 同一道题跑几遍、几个模型，算通过率和 95% 置信区间（Wilson），按题目实际的通过率分难度；
// 两次结果比较时按题配对：每道题看两边的通过率谁高，符号检验给 p 值，自助法（按题重抽）给通过率差的区间
export type Difficulty = 'easy' | 'medium' | 'hard'

export interface EvalOutcome {
  id: string
  category: string
  model: string
  passed: boolean
  // 题目里标的难度；没标是 null
  difficulty: Difficulty | null
  tokens: number
  // 按评测配置里的单价算的费用（6 位小数的字符串）；没配单价是 null
  cost: string | null
  durationMs: number
}

export interface RateSummary {
  passed: number
  runs: number
  rate: number
  low: number
  high: number
}

export interface EvalTaskSummary {
  id: string
  model: string
  category: string
  rate: RateSummary
  declared: Difficulty | null
  // 按这道题实际的通过率：九成以上算易，一半以上算中，其余算难
  measured: Difficulty
}

export interface EvalModelSummary {
  model: string
  rate: RateSummary
  averageTokens: number
  averageDurationMs: number
  // 总费用；有题没有单价时 partial 为 true
  cost: string | null
  costPartial: boolean
  byCategory: Array<{ category: string; rate: RateSummary }>
  byDifficulty: Array<{ difficulty: Difficulty; declared: RateSummary | null; measured: RateSummary | null }>
}

export interface EvalComparison {
  model: string
  // 两边都有的题
  tasks: number
  a: RateSummary
  b: RateSummary
  // b 的通过率减 a 的（按题平均），自助法 95% 区间
  difference: number
  low: number
  high: number
  // b 比 a 好的题、差的题、一样的题
  better: number
  worse: number
  ties: number
  // 符号检验的双侧 p 值
  pValue: number
  rows: Array<{ id: string; a: number; b: number }>
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']

export function wilson(passed: number, runs: number, z = 1.96): RateSummary {
  if (runs === 0) return { passed, runs, rate: 0, low: 0, high: 0 }
  const rate = passed / runs
  const denominator = 1 + (z * z) / runs
  const center = (rate + (z * z) / (2 * runs)) / denominator
  const margin = (z * Math.sqrt((rate * (1 - rate)) / runs + (z * z) / (4 * runs * runs))) / denominator
  return { passed, runs, rate, low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}

export function measuredDifficulty(rate: number): Difficulty {
  return rate >= 0.9 ? 'easy' : rate >= 0.5 ? 'medium' : 'hard'
}

// 金额字符串按微元（6 位小数）用整数相加
const MICRO = 1_000_000n
function micros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0')
}
function decimal(value: bigint): string {
  return `${value / MICRO}.${(value % MICRO).toString().padStart(6, '0')}`
}

const rateOf = (items: readonly EvalOutcome[]) => wilson(items.filter((item) => item.passed).length, items.length)
const average = (values: number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length)

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

export function summarizeTasks(outcomes: readonly EvalOutcome[]): EvalTaskSummary[] {
  return [...groupBy(outcomes, (item) => `${item.model}\u0000${item.id}`).values()].map((runs) => {
    const rate = rateOf(runs)
    return { id: runs[0]!.id, model: runs[0]!.model, category: runs[0]!.category, rate, declared: runs[0]!.difficulty, measured: measuredDifficulty(rate.rate) }
  })
}

export function summarizeEval(outcomes: readonly EvalOutcome[]): { models: EvalModelSummary[]; tasks: EvalTaskSummary[] } {
  const tasks = summarizeTasks(outcomes)
  const models = [...groupBy(outcomes, (item) => item.model)].map(([model, runs]): EvalModelSummary => {
    const priced = runs.filter((item) => item.cost !== null)
    const measuredOf = new Map(tasks.filter((task) => task.model === model).map((task) => [task.id, task.measured]))
    return {
      model,
      rate: rateOf(runs),
      averageTokens: average(runs.map((item) => item.tokens)),
      averageDurationMs: average(runs.map((item) => item.durationMs)),
      cost: priced.length > 0 ? decimal(priced.reduce((sum, item) => sum + micros(item.cost!), 0n)) : null,
      costPartial: priced.length > 0 && priced.length < runs.length,
      byCategory: [...groupBy(runs, (item) => item.category)].map(([category, group]) => ({ category, rate: rateOf(group) })),
      byDifficulty: DIFFICULTIES.map((difficulty) => {
        const declared = runs.filter((item) => item.difficulty === difficulty)
        const measured = runs.filter((item) => measuredOf.get(item.id) === difficulty)
        return { difficulty, declared: declared.length > 0 ? rateOf(declared) : null, measured: measured.length > 0 ? rateOf(measured) : null }
      }),
    }
  })
  return { models, tasks }
}

// 二项分布下至少这么偏的概率（双侧），n 不大时直接加
export function signTest(better: number, worse: number): number {
  const n = better + worse
  if (n === 0) return 1
  const k = Math.min(better, worse)
  let probability = Math.pow(0.5, n)
  let tail = probability
  for (let i = 1; i <= k; i++) {
    probability = (probability * (n - i + 1)) / i
    tail += probability
  }
  return Math.min(1, 2 * tail)
}

// 可复现的伪随机数（mulberry32），同样的输入给同样的区间
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function compareEval(a: readonly EvalOutcome[], b: readonly EvalOutcome[], resamples = 2000): EvalComparison[] {
  const models = [...new Set([...a.map((item) => item.model), ...b.map((item) => item.model)])]
  return models.flatMap((model) => {
    const left = new Map(summarizeTasks(a.filter((item) => item.model === model)).map((task) => [task.id, task]))
    const right = new Map(summarizeTasks(b.filter((item) => item.model === model)).map((task) => [task.id, task]))
    const ids = [...left.keys()].filter((id) => right.has(id)).sort()
    if (ids.length === 0) return []
    const rows = ids.map((id) => ({ id, a: left.get(id)!.rate.rate, b: right.get(id)!.rate.rate }))
    const differences = rows.map((row) => row.b - row.a)
    const next = random(42)
    const samples: number[] = []
    for (let round = 0; round < resamples; round++) {
      let sum = 0
      for (let i = 0; i < differences.length; i++) sum += differences[Math.floor(next() * differences.length)]!
      samples.push(sum / differences.length)
    }
    samples.sort((x, y) => x - y)
    const better = differences.filter((value) => value > 0).length
    const worse = differences.filter((value) => value < 0).length
    const sumRates = (side: 'a' | 'b') => ids.reduce((acc, id) => ({ passed: acc.passed + (side === 'a' ? left : right).get(id)!.rate.passed, runs: acc.runs + (side === 'a' ? left : right).get(id)!.rate.runs }), { passed: 0, runs: 0 })
    const totalA = sumRates('a')
    const totalB = sumRates('b')
    return [
      {
        model,
        tasks: ids.length,
        a: wilson(totalA.passed, totalA.runs),
        b: wilson(totalB.passed, totalB.runs),
        difference: average(differences),
        low: samples[Math.floor(resamples * 0.025)]!,
        high: samples[Math.min(resamples - 1, Math.floor(resamples * 0.975))]!,
        better,
        worse,
        ties: ids.length - better - worse,
        pValue: signTest(better, worse),
        rows: rows.sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a) || (x.id < y.id ? -1 : 1)),
      },
    ]
  })
}
