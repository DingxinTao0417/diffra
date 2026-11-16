import { describe, expect, test } from 'vitest'
import { compareEval, type EvalOutcome, measuredDifficulty, signTest, summarizeEval, wilson } from '../src/stats.js'

// 评测结果的统计（v2 · M11）
const run = (id: string, passed: boolean, change: Partial<EvalOutcome> = {}): EvalOutcome => ({ id, category: 'feature', model: 'm', passed, difficulty: null, tokens: 1000, cost: '0.100000', durationMs: 1000, ...change })

describe('评测统计', () => {
  test('Wilson 区间：全过也不是 100% 确定；没有数据是 0', () => {
    const all = wilson(10, 10)
    expect(all.rate).toBe(1)
    expect(all.low).toBeCloseTo(0.7225, 3)
    expect(all.high).toBe(1)
    const half = wilson(5, 10)
    expect(half.low).toBeCloseTo(0.2366, 3)
    expect(half.high).toBeCloseTo(0.7634, 3)
    expect(wilson(0, 0)).toEqual({ passed: 0, runs: 0, rate: 0, low: 0, high: 0 })
  })

  test('符号检验：10 道里 9 道变好显著，5:5 不显著', () => {
    expect(signTest(9, 1)).toBeCloseTo(0.0215, 3)
    expect(signTest(5, 5)).toBe(1)
    expect(signTest(0, 0)).toBe(1)
  })

  test('汇总：按模型的通过率、费用（整数相加不丢精度）、按类别、按标的难度和实际难度', () => {
    const outcomes = [
      run('t1', true, { difficulty: 'easy', cost: '0.100000' }),
      run('t1', true, { difficulty: 'easy', cost: '0.200000' }),
      run('t2', true, { difficulty: 'hard', category: 'security' }),
      run('t2', false, { difficulty: 'hard', category: 'security' }),
      run('t3', false, { cost: null }),
    ]
    const { models, tasks } = summarizeEval(outcomes)
    expect(models[0]!.rate).toMatchObject({ passed: 3, runs: 5 })
    expect(models[0]!.cost).toBe('0.500000')
    expect(models[0]!.costPartial).toBe(true)
    expect(models[0]!.byCategory.map((item) => `${item.category} ${item.rate.passed}/${item.rate.runs}`)).toEqual(['feature 2/3', 'security 1/2'])
    expect(models[0]!.byDifficulty.find((item) => item.difficulty === 'hard')?.declared).toMatchObject({ passed: 1, runs: 2 })
    expect(tasks.map((task) => `${task.id} ${task.measured}`)).toEqual(['t1 easy', 't2 medium', 't3 hard'])
    expect(measuredDifficulty(0.9)).toBe('easy')
  })

  test('比较两次结果：按题配对，差的区间、更好更差的题数和 p 值；只算两边都有的题', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((id) => [run(id, false), run(id, id === 'a')])
    const after = [...['a', 'b', 'c', 'd', 'e', 'f'].flatMap((id) => [run(id, true), run(id, id !== 'f')]), run('extra', true)]
    const [comparison] = compareEval(before, after)
    expect(comparison).toMatchObject({ model: 'm', tasks: 6, better: 6, worse: 0, ties: 0 })
    expect(comparison!.a).toMatchObject({ passed: 1, runs: 12 })
    expect(comparison!.b).toMatchObject({ passed: 11, runs: 12 })
    expect(comparison!.difference).toBeCloseTo(10 / 12, 5)
    expect(comparison!.low).toBeGreaterThan(0.5)
    expect(comparison!.pValue).toBeCloseTo(0.03125, 5)
    // 同样的输入同样的区间
    expect(compareEval(before, after)[0]!.low).toBe(comparison!.low)
  })
})
