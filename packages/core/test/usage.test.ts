import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgent } from '../src/agent.js'
import { connectToCore, createSession, handshake, sendPrompt, usageSummary } from '../src/client.js'
import type { UsageRecord } from '../src/protocol.js'
import { UsageLog } from '../src/usage/log.js'
import { UsageAggregator } from '../src/usage/summary.js'
import { type ScriptedServer, startScriptedServer } from './scripted-server.js'

let dir: string
let server: ScriptedServer | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffra-usage-'))
})

afterEach(async () => {
  await server?.close()
  server = null
  rmSync(dir, { recursive: true, force: true })
})

function record(change: Partial<UsageRecord> & { at: string }): UsageRecord {
  return {
    v: 1,
    sessionId: 's1',
    cwd: 'D:\\work\\app',
    providerId: 'p1',
    providerName: '供应商',
    modelId: 'm1',
    role: 'coder',
    input: 100,
    cacheRead: 40,
    cacheWrite: null,
    output: 10,
    reasoning: 2,
    ...change,
  }
}

async function scanAll(log: UsageLog, from: string, to: string) {
  const records: UsageRecord[] = []
  const { skippedLines } = await log.scan(new Date(from), new Date(to), (item) => records.push(item))
  return { records, skippedLines }
}

describe('用量记录', () => {
  test('按 UTC 月份分文件追加；读取只返回范围内的记录', async () => {
    const log = new UsageLog(dir)
    await log.append(record({ at: '2026-10-31T23:30:00.000Z', sessionId: 'a' }))
    await log.append(record({ at: '2026-11-01T00:10:00.000Z', sessionId: 'b' }))
    await log.append(record({ at: '2026-11-20T08:00:00.000Z', sessionId: 'c' }))

    expect(readFileSync(join(dir, '2026-10.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(readFileSync(join(dir, '2026-11.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    const { records } = await scanAll(log, '2026-10-31T00:00:00.000Z', '2026-11-20T08:00:00.000Z')
    expect(records.map((item) => item.sessionId)).toEqual(['a', 'b'])
  })

  test('目录还不存在时读到空结果', async () => {
    const log = new UsageLog(join(dir, 'missing'))
    expect(await scanAll(log, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')).toEqual({ records: [], skippedLines: 0 })
  })

  test('上次崩溃留下的半行跳过并计数，新记录另起一行不被接坏', async () => {
    const good = JSON.stringify(record({ at: '2026-11-02T00:00:00.000Z', sessionId: 'old' }))
    writeFileSync(join(dir, '2026-11.jsonl'), `${good}\n{"v":1,"at":"2026-11-0`)
    const log = new UsageLog(dir)
    await log.append(record({ at: '2026-11-03T00:00:00.000Z', sessionId: 'new' }))

    const { records, skippedLines } = await scanAll(log, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
    expect(records.map((item) => item.sessionId)).toEqual(['old', 'new'])
    expect(skippedLines).toBe(1)
  })
})

describe('用量汇总', () => {
  test('按时区划日，没有调用的天也列出来；按模型、项目、任务分组', () => {
    // 上海时间 11 月 6 日 01:30，UTC 还是 5 日
    const from = new Date('2026-11-03T16:00:00.000Z')
    const to = new Date('2026-11-06T16:00:00.000Z')
    const aggregator = new UsageAggregator(from, to, 'Asia/Shanghai')
    aggregator.add(record({ at: '2026-11-05T17:30:00.000Z', sessionId: 'a' }))
    aggregator.add(record({ at: '2026-11-04T02:00:00.000Z', sessionId: 'b', modelId: 'm2', input: 1000, output: 100 }))
    aggregator.add(record({ at: '2026-11-04T03:00:00.000Z', sessionId: 'a', cwd: 'd:\\WORK\\app', role: 'reviewer' }))
    aggregator.add(
      record({ at: '2026-11-04T04:00:00.000Z', sessionId: 'c', cwd: 'D:\\other', input: null, cacheRead: null, output: null, reasoning: null }),
    )
    const summary = aggregator.result(0)

    expect(summary.totals).toEqual({ calls: 4, unknownCalls: 1, input: 1200, cacheRead: 120, cacheWrite: 0, output: 120, reasoning: 6 })
    expect(summary.days.map((day) => [day.date, day.calls])).toEqual([
      ['2026-11-04', 3],
      ['2026-11-05', 0],
      ['2026-11-06', 1],
    ])
    expect(summary.models.map((model) => [model.modelId, model.calls])).toEqual([
      ['m2', 1],
      ['m1', 3],
    ])
    // 路径大小写不同：Windows 上算同一个项目；其他系统路径区分大小写，算两个
    if (process.platform === 'win32') expect(summary.projects[0]).toMatchObject({ cwd: 'D:\\work\\app', calls: 3, input: 1200 })
    else expect(summary.projects.map((project) => [project.cwd, project.calls])).toEqual(expect.arrayContaining([['D:\\work\\app', 2], ['d:\\WORK\\app', 1]]))
    expect(summary.tasks.map((task) => task.sessionId)).toEqual(['b', 'a', 'c'])
  })
})

describe('经过 agent 记录和汇总', () => {
  test('每次模型调用记一行，带供应商；汇总接口按范围返回', async () => {
    server = await startScriptedServer([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { text: '看完了' },
    ])
    const project = mkdtempSync(join(tmpdir(), 'diffra-usage-project-'))
    writeFileSync(join(project, 'a.txt'), 'hi\n')
    try {
      const toAgent = new PassThrough()
      const toClient = new PassThrough()
      createAgent({ usageDir: join(dir, 'usage') }).connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
      const connection = connectToCore(toAgent, toClient, {
        onSessionUpdate: () => {},
        onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      })
      await handshake(connection, 5000)
      const { sessionId } = await createSession(connection, project, {
        model: {
          endpoint: { protocol: 'openai-compatible', baseUrl: server.baseUrl, apiKey: 'usage-test-key' },
          modelId: 'scripted',
          contextWindow: 100_000,
          provider: { id: 'p1', name: '脚本供应商' },
        },
        reviewModel: null,
        planModel: null,
        fallbackModel: null,
        checks: { afterEdit: null, beforeFinish: null },
        readOnlyPaths: [],
        rules: { packs: [], review: false },
        permissionMode: 'ask',
        security: { staticCheck: false, lightScan: false },
        limits: { compactAtPercent: 70, maxSteps: 100, goalMaxRounds: 5 },
        plugins: [],
        checkpointDir: null,
      })
      await sendPrompt(connection, sessionId, 'turn-1', '看看 a.txt')

      const lines = readFileSync(join(dir, 'usage', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines.join('\n')).not.toContain('usage-test-key')
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({
        sessionId,
        cwd: project,
        providerId: 'p1',
        providerName: '脚本供应商',
        modelId: 'scripted',
        role: 'coder',
        input: 1200,
        output: 20,
      })

      const now = Date.now()
      const summary = await usageSummary(connection, {
        from: new Date(now - 86_400_000).toISOString(),
        to: new Date(now + 60_000).toISOString(),
        timeZone: 'Asia/Shanghai',
      })
      expect(summary.totals).toMatchObject({ calls: 2, input: 2400, output: 40 })
      expect(summary.models).toEqual([expect.objectContaining({ providerName: '脚本供应商', modelId: 'scripted', calls: 2 })])
      expect(summary.tasks).toEqual([expect.objectContaining({ sessionId, calls: 2 })])

      await expect(
        usageSummary(connection, { from: new Date(now).toISOString(), to: new Date(now - 1).toISOString(), timeZone: 'Asia/Shanghai' }),
      ).rejects.toThrow()
      await expect(
        usageSummary(connection, { from: new Date(now - 1).toISOString(), to: new Date(now).toISOString(), timeZone: 'Mars/Base' }),
      ).rejects.toThrow()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
