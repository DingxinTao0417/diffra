import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { usageTotals } from '../src/metrics.ts'
import { compareResults, readOutcomes } from '../src/stats-report.ts'

// 评测统计（v2 · M11）：按配置的单价算费用，两次结果按题比较
let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const task = (id: string, passed: boolean, extra: Record<string, unknown> = {}) => ({ id, category: 'feature', model: 'flash', passed, durationMs: 1000, usage: { inputTokens: 100, outputTokens: 10 }, ...extra })

describe('评测统计', () => {
  test('用量按配置里的单价算费用；没配单价时费用是 null', () => {
    dir = mkdtempSync(join(tmpdir(), 'diffra-eval-stats-'))
    const usage = join(dir, 'usage')
    mkdirSync(usage)
    const record = (modelId: string, input: number, output: number) => JSON.stringify({ v: 1, at: '2026-11-15T00:00:00.000Z', sessionId: 's', cwd: dir, providerId: 'p', providerName: 'p', modelId, role: 'coder', input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0 })
    writeFileSync(join(usage, '2026-11.jsonl'), `${record('flash', 1_000_000, 100_000)}\n${record('judge', 500_000, 0)}\n`)
    const priced = usageTotals(usage, [{ providerId: null, modelId: 'flash', input: '1', output: '2' }])
    expect(priced.cost).toBe('1.200000')
    expect(priced.inputTokens).toBe(1_500_000)
    expect(usageTotals(usage).cost).toBeNull()
  })

  test('比较两次结果：写出每个模型的通过率、差、p 值和变了的题；旧结果没有难度和费用也能读', () => {
    dir = mkdtempSync(join(tmpdir(), 'diffra-eval-compare-'))
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a)
    mkdirSync(b)
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6']
    writeFileSync(join(a, 'results.json'), JSON.stringify({ tasks: ids.flatMap((id) => [task(id, false), task(id, false)]) }))
    writeFileSync(join(b, 'results.json'), JSON.stringify({ tasks: ids.flatMap((id) => [task(id, true, { difficulty: 'hard', usage: { inputTokens: 1, outputTokens: 1, cost: '0.010000' } }), task(id, true)]) }))
    expect(readOutcomes(a)[0]).toMatchObject({ difficulty: null, cost: null, tokens: 110 })
    const markdown = compareResults(a, join(b, 'results.json'))
    expect(markdown).toContain('## flash')
    expect(markdown).toContain('6 道题：A 通过 0/12（0%），B 通过 12/12（100%）')
    expect(markdown).toContain('B 更好 6 道、更差 0 道')
    expect(markdown).toContain('p = 0.0313，B 更好')
    expect(markdown).toContain('| t1 | 0% | 100% |')
    expect(readFileSync(join(b, 'results.json'), 'utf8')).toContain('t6')
  })
})
