import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { UsageRecord } from '../src/protocol.js'
import { exportUsageCsv } from '../src/usage/export.js'
import { UsageLog } from '../src/usage/log.js'
import { formatCost, PriceBook, priceMicros } from '../src/usage/pricing.js'
import { UsageAggregator } from '../src/usage/summary.js'

// 用量的 v2 部分（M11）：费用、无项目任务合成一行、导出、清理
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffra-usage-v2-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const record = (change: Partial<UsageRecord> & { at: string }): UsageRecord => ({
  v: 1,
  sessionId: 's1',
  cwd: 'D:\\work\\app',
  providerId: 'p1',
  providerName: '供应商',
  modelId: 'm1',
  role: 'coder',
  input: 1_000_000,
  cacheRead: 400_000,
  cacheWrite: 100_000,
  output: 200_000,
  reasoning: 50_000,
  ...change,
})

const PRICES = [{ providerId: 'p1', modelId: 'm1', input: '2', cachedInput: '0.5', cacheWrite: '2.5', output: '8' }]

describe('费用', () => {
  test('单价按整数微元算，没有浮点误差；缓存读、写缓存各按各的价，没填时按输入价', () => {
    expect(priceMicros('2')).toBe(2_000_000n)
    expect(priceMicros('0.000001')).toBe(1n)
    expect(priceMicros('12.5')).toBe(12_500_000n)
    const book = new PriceBook(PRICES)
    // 普通输入 50 万 ×2 + 缓存读 40 万 ×0.5 + 写缓存 10 万 ×2.5 + 输出 20 万 ×8 = 1 + 0.2 + 0.25 + 1.6 = 3.05
    expect(formatCost(book.cost(record({ at: '2026-11-01T00:00:00.000Z' }))!)).toBe('3.050000')
    // 0.1 + 0.2 这类小数加起来也是准的
    const tiny = new PriceBook([{ providerId: null, modelId: 'm2', input: '0.1', output: '0.2' }])
    const one = tiny.cost(record({ at: '2026-11-01T00:00:00.000Z', modelId: 'm2', providerId: 'other', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }))!
    expect(formatCost(one)).toBe('0.300000')
    expect(tiny.cost(record({ at: '2026-11-01T00:00:00.000Z', modelId: 'm3' }))).toBeNull()
    expect(tiny.cost(record({ at: '2026-11-01T00:00:00.000Z', modelId: 'm2', input: null, output: null }))).toBeNull()
  })

  test('汇总里每天、每个模型、项目、任务都带费用和没单价的次数；没给单价时没有这两项', () => {
    const aggregator = new UsageAggregator(new Date('2026-11-01T00:00:00.000Z'), new Date('2026-11-03T00:00:00.000Z'), 'UTC', { prices: PRICES })
    aggregator.add(record({ at: '2026-11-01T10:00:00.000Z' }))
    aggregator.add(record({ at: '2026-11-02T10:00:00.000Z' }))
    aggregator.add(record({ at: '2026-11-02T11:00:00.000Z', modelId: 'free-model' }))
    const summary = aggregator.result(0)
    expect(summary.totals.cost).toBe('6.100000')
    expect(summary.totals.unpricedCalls).toBe(1)
    expect(summary.days.map((day) => day.cost)).toEqual(['3.050000', '3.050000'])
    expect(summary.models.find((model) => model.modelId === 'free-model')).toMatchObject({ cost: '0.000000', unpricedCalls: 1 })
    const plain = new UsageAggregator(new Date('2026-11-01T00:00:00.000Z'), new Date('2026-11-02T00:00:00.000Z'), 'UTC')
    plain.add(record({ at: '2026-11-01T10:00:00.000Z' }))
    expect(plain.result(0).totals.cost).toBeUndefined()
  })
})

describe('无项目任务合成一行', () => {
  test('无项目任务的根目录下的任务按项目统计时合成「无项目」一行，记下任务数；别的项目照旧', () => {
    const aggregator = new UsageAggregator(new Date('2026-11-01T00:00:00.000Z'), new Date('2026-11-02T00:00:00.000Z'), 'UTC', { workspaceRoot: 'C:\\Users\\me\\Documents\\Diffra\\' })
    aggregator.add(record({ at: '2026-11-01T01:00:00.000Z', sessionId: 'a', cwd: 'C:\\Users\\me\\Documents\\Diffra\\写周报' }))
    aggregator.add(record({ at: '2026-11-01T02:00:00.000Z', sessionId: 'b', cwd: 'C:\\Users\\me\\Documents\\Diffra\\查资料' }))
    aggregator.add(record({ at: '2026-11-01T03:00:00.000Z', sessionId: 'b', cwd: 'C:\\Users\\me\\Documents\\Diffra\\查资料' }))
    aggregator.add(record({ at: '2026-11-01T04:00:00.000Z', sessionId: 'c', cwd: 'D:\\work\\app' }))
    const projects = aggregator.result(0).projects
    expect(projects).toHaveLength(2)
    expect(projects.find((item) => item.noProject)).toMatchObject({ cwd: 'C:\\Users\\me\\Documents\\Diffra', tasks: 2, calls: 3 })
    expect(projects.find((item) => !item.noProject)).toMatchObject({ cwd: 'D:\\work\\app', calls: 1 })
  })
})

describe('导出和清理', () => {
  test('导出 CSV：带 BOM 和表头，一行一次调用，逗号和引号转义，有单价时带费用', async () => {
    const log = new UsageLog(dir)
    await log.append(record({ at: '2026-11-01T10:00:00.000Z', cwd: 'D:\\work\\a,"b"' }))
    await log.append(record({ at: '2026-11-02T10:00:00.000Z', modelId: 'free-model' }))
    const path = join(dir, 'out.csv')
    const result = await exportUsageCsv(log, { from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-11-03T00:00:00.000Z'), timeZone: 'Asia/Shanghai', prices: PRICES }, path)
    expect(result).toEqual({ rows: 2, skippedLines: 0 })
    const lines = readFileSync(path, 'utf8').split('\r\n')
    expect(lines[0]!.charCodeAt(0)).toBe(0xfeff)
    expect(lines[0]!.slice(1)).toBe('时刻(UTC),日期,任务,项目,供应商,模型,角色,输入,缓存读,缓存写,输出,推理,费用')
    expect(lines[1]).toBe('2026-11-01T10:00:00.000Z,2026-11-01,s1,"D:\\work\\a,""b""",供应商,m1,coder,1000000,400000,100000,200000,50000,3.050000')
    expect(lines[2]!.endsWith(',')).toBe(true)
  })

  test('清理：列出各月文件，删掉某个月之前的', async () => {
    const log = new UsageLog(dir)
    await log.append(record({ at: '2026-08-10T00:00:00.000Z' }))
    await log.append(record({ at: '2026-09-10T00:00:00.000Z' }))
    await log.append(record({ at: '2026-11-10T00:00:00.000Z' }))
    expect((await log.files()).map((file) => file.month)).toEqual(['2026-08', '2026-09', '2026-11'])
    expect((await log.files())[0]!.bytes).toBeGreaterThan(100)
    expect(await log.removeBefore('2026-10')).toEqual(['2026-08', '2026-09'])
    expect(readdirSync(dir)).toEqual(['2026-11.jsonl'])
    // 删完照样能接着写
    await log.append(record({ at: '2026-11-11T00:00:00.000Z' }))
    expect(readFileSync(join(dir, '2026-11.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
