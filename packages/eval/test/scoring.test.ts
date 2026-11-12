import { expect, test } from 'vitest'
import { scoreFindings } from '../src/deep-scan.ts'
import { type Finding, parseFindings, turnMetrics } from '../src/metrics.ts'

const finding = (ruleId: string, path: string, line: number): Finding => ({ card: '深度扫描报告', level: '高危', ruleId, path, line, message: '说明' })

const answers = [
  { path: 'src/a.ts', line: 10, ruleId: 'SEC-INJ-1', note: 'SQL 拼接', alternatives: [] },
  { path: 'src/b.ts', line: 20, ruleId: 'SEC-AUTH-1', note: '越权', alternatives: [] },
]

test('同一个文件、同一个规则号、行号相差 3 以内算查出，超出的算误报', () => {
  const result = scoreFindings(answers, [finding('SEC-INJ-1', 'src/a.ts', 13), finding('SEC-AUTH-1', 'src/b.ts', 24)])
  expect(result.matched.map((item) => item.answer)).toEqual(['SEC-INJ-1 src/a.ts:10（SQL 拼接）'])
  expect(result.missed).toEqual(['SEC-AUTH-1 src/b.ts:20（越权）'])
  expect(result.falsePositives).toEqual(['SEC-AUTH-1 src/b.ts:24 说明'])
})

test('规则号或文件对不上不算查出', () => {
  const result = scoreFindings(answers, [finding('SEC-INJ-2', 'src/a.ts', 10), finding('SEC-AUTH-1', 'src/a.ts', 20)])
  expect(result.matched).toEqual([])
  expect(result.missed).toHaveLength(2)
  expect(result.falsePositives).toHaveLength(2)
})

test('同一个问题报了两遍只算一次查出，也不算误报', () => {
  const result = scoreFindings(answers, [finding('SEC-INJ-1', 'src/a.ts', 10), finding('SEC-INJ-1', 'src/a.ts', 11)])
  expect(result.matched).toHaveLength(1)
  expect(result.falsePositives).toEqual([])
})

test('报在答案表列出的其他修复位置也算查出', () => {
  const idor = { path: 'app/notes.py', line: 24, ruleId: 'SEC-AUTH-1', note: '越权', alternatives: [{ path: 'app/repository.py', line: 12 }] }
  const result = scoreFindings([idor], [finding('SEC-AUTH-1', 'app/repository.py', 12), finding('SEC-AUTH-1', 'app/notes.py', 25)])
  expect(result.matched.map((item) => item.finding)).toEqual(['SEC-AUTH-1 app/repository.py:12 说明'])
  expect(result.missed).toEqual([])
  expect(result.falsePositives).toEqual([])
})

test('其他修复位置也要规则号一致', () => {
  const idor = { path: 'app/notes.py', line: 24, ruleId: 'SEC-AUTH-1', note: '越权', alternatives: [{ path: 'app/repository.py', line: 12 }] }
  const result = scoreFindings([idor], [finding('SEC-INJ-1', 'app/repository.py', 12)])
  expect(result.missed).toHaveLength(1)
  expect(result.falsePositives).toHaveLength(1)
})

test('从报告卡片里读出问题行，跳过链路和修复', () => {
  const text = ['扫描了 3 个入口', '高危  SEC-INJ-1  src/a.ts:12  搜索词拼进 SQL', '  链路：src/routes.ts:5 → src/a.ts:12', '  修复：用参数绑定', '提醒  SEC-KEY-1  config.ts:3  密钥写死'].join('\n')
  expect(parseFindings('深度扫描报告', text)).toEqual([
    { card: '深度扫描报告', level: '高危', ruleId: 'SEC-INJ-1', path: 'src/a.ts', line: 12, message: '搜索词拼进 SQL' },
    { card: '深度扫描报告', level: '提醒', ruleId: 'SEC-KEY-1', path: 'config.ts', line: 3, message: '密钥写死' },
  ])
})

test('派出的子智能体单独计数：卡片不算工具调用，子智能体调用的工具算在总数里并单独列出，没派成的不算', () => {
  const call = (toolCallId: string, title: string, parent?: string) => ({
    sessionUpdate: 'tool_call' as const,
    toolCallId,
    title,
    status: 'completed' as const,
    ...(parent ? { _meta: { diffra: { parentToolCallId: parent } } } : {}),
  })
  const metrics = turnMetrics([
    call('a', 'read_file'),
    call('card', '子智能体 探索'),
    call('w/1', 'search', 'card'),
    call('w/2', 'read_file', 'card'),
    { ...call('refused', '子智能体'), status: 'failed' },
    call('steps', '步骤'),
  ])
  expect(metrics).toMatchObject({ toolCalls: 3, workerToolCalls: 2, delegations: 1 })
})
