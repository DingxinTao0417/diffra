import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgent } from '../src/agent.js'
import { applyCandidate, cancelSession, candidateDiff, connectToCore, createSession, deleteSession, discardCandidates, generateCandidates, handshake, loadSession } from '../src/client.js'
import { CANDIDATES_META_KEY, type CandidateRunView, type SessionConfig } from '../src/protocol.js'
import { recoverRuns } from '../src/session/candidates.js'
import type { Session } from '../src/session/session.js'
import type { CandidateRun } from '../src/session/store.js'
import { captureBaseline, createWorktree } from '../src/session/worktrees.js'
import { addFile, replaceLines } from './loop-helpers.js'
import { type ScriptedServer, type ScriptStep, startScriptedServer } from './scripted-server.js'

let project: string
let dataDir: string
let worktrees: string
let server: ScriptedServer | null = null
let notifications: acp.SessionNotification[] = []

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-candidates-project-'))
  dataDir = mkdtempSync(join(tmpdir(), 'diffra-candidates-data-'))
  worktrees = join(dataDir, 'worktrees')
  notifications = []
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(project, 'x.txt'), 'line one\nline two\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(async () => {
  await server?.close()
  server = null
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function startCore() {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  createAgent({ sessionsDir: join(dataDir, 'sessions'), worktreesDir: worktrees }).connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
  const connection = connectToCore(toAgent, toClient, {
    onSessionUpdate: (notification) => notifications.push(notification),
    onPermissionRequest: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
  })
  await handshake(connection, 5000)
  return connection
}

function config(baseUrl: string): SessionConfig {
  return {
    model: { endpoint: { protocol: 'openai-compatible', baseUrl, apiKey: 'k' }, modelId: 'scripted', contextWindow: 100_000, provider: null },
    reviewModel: null,
    planModel: null,
    fallbackModel: null,
    checks: { afterEdit: null, beforeFinish: null },
    readOnlyPaths: [],
    rules: { packs: [], review: false },
    permissionMode: 'full',
    security: { staticCheck: false, lightScan: false },
    limits: { compactAtPercent: 70, maxSteps: 20, goalMaxRounds: 5 },
    plugins: [],
    checkpointDir: join(dataDir, 'checkpoints'),
  }
}

// 「候选方案」卡片最新的样子
function lastRun(): CandidateRunView | undefined {
  return notifications
    .map((item) => item.update)
    .filter((update) => (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update._meta?.diffra && CANDIDATES_META_KEY in (update._meta.diffra as object))
    .map((update) => (update._meta!.diffra as Record<string, unknown>)[CANDIDATES_META_KEY] as CandidateRunView)
    .at(-1)
}

const TWO = [
  { name: '甲', approach: '改第一行' },
  { name: '乙', approach: '加一个新文件' },
]

// 甲改 x.txt 第一行，乙加 b.txt；两个候选并行，按提问里的「候选方案「名字」」分剧本
function twoCandidates(extra: Partial<Record<'甲' | '乙', Partial<ScriptStep>>> = {}): ScriptStep[] {
  return [
    { match: '候选方案「甲」', toolCalls: [replaceLines('x.txt', 'line one', 'LINE ONE')], ...extra.甲 },
    { match: '候选方案「甲」', text: '甲做完了：改了第一行' },
    { match: '候选方案「乙」', toolCalls: [addFile('b.txt', 'from 乙\n')], ...extra.乙 },
    { match: '候选方案「乙」', text: '乙做完了：加了 b.txt' },
  ]
}

describe('多候选方案', () => {
  test('生成两个候选：各在一个 worktree 里做，项目不动；看改动、选一个应用回项目，worktree 全清掉', async () => {
    server = await startScriptedServer(twoCandidates())
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    expect(await generateCandidates(core, { sessionId, turnId: 'c1', title: '生成 2 个候选方案', request: '改一下项目', plan: '1. 改', candidates: TWO })).toEqual({ stopReason: 'end_turn' })

    const run = lastRun()!
    expect(run.status).toBe('ready')
    expect(run.candidates.map((candidate) => [candidate.name, candidate.status, candidate.stats, candidate.paths, candidate.summary])).toEqual([
      ['甲', 'done', { files: 1, added: 1, removed: 1 }, ['x.txt'], '甲做完了：改了第一行'],
      ['乙', 'done', { files: 1, added: 1, removed: 0 }, ['b.txt'], '乙做完了：加了 b.txt'],
    ])
    // 计划和思路都发给了候选
    expect(server.bodies.some((body) => body.includes('候选方案「甲」：改第一行') && body.includes('计划：'))).toBe(true)
    // 项目本身没动，两个 worktree 在应用数据目录里
    expect(readFileSync(join(project, 'x.txt'), 'utf8')).toBe('line one\nline two\n')
    expect(existsSync(join(project, 'b.txt'))).toBe(false)
    expect(readdirSync(worktrees)[0] && readdirSync(join(worktrees, readdirSync(worktrees)[0]!)).sort()).toEqual(['a', 'a.cp', 'b', 'b.cp'])
    // 每个候选一张卡片，它的工具调用挂在下面
    const cards = notifications.map((item) => item.update).filter((update) => update.sessionUpdate === 'tool_call' && update.title.startsWith('候选方案 '))
    expect(cards.map((update) => (update as acp.ToolCall).title)).toEqual(['候选方案 甲', '候选方案 乙'])

    expect(await candidateDiff(core, sessionId, 'c1', 'a')).toContain('+LINE ONE')
    await applyCandidate(core, { sessionId, turnId: 'apply-1', title: '应用候选方案「甲」', runTurnId: 'c1', candidateId: 'a' })
    expect(readFileSync(join(project, 'x.txt'), 'utf8')).toBe('LINE ONE\nline two\n')
    expect(existsSync(join(project, 'b.txt'))).toBe(false)
    expect(lastRun()).toMatchObject({ status: 'applied', appliedId: 'a' })
    expect(readdirSync(join(worktrees, readdirSync(worktrees)[0]!))).toEqual([])
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1)
    // 应用的那一轮有改动卡片，能撤销
    expect(notifications.some((item) => item.update.sessionUpdate === 'tool_call' && item.update.title === '应用候选方案「甲」：x.txt')).toBe(true)

    // 记录里有这组候选；重开后卡片在、状态对
    const loaded = await loadSession(await startCore(), sessionId, project, config(server.baseUrl))
    const card = loaded.turns.find((turn) => turn.id === 'c1')!.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'candidates-c1').at(-1)
    expect((card?._meta?.diffra as Record<string, CandidateRunView>)[CANDIDATES_META_KEY]?.status).toBe('applied')
  })

  test('应用前检查冲突：项目里同一处又改了就什么都不改、列出冲突；放弃后 worktree 清掉', async () => {
    server = await startScriptedServer(twoCandidates())
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await generateCandidates(core, { sessionId, turnId: 'c1', title: '生成 2 个候选方案', request: '改一下项目', plan: null, candidates: TWO })
    writeFileSync(join(project, 'x.txt'), 'line uno\nline two\n')
    await applyCandidate(core, { sessionId, turnId: 'apply-1', title: '应用候选方案「甲」', runTurnId: 'c1', candidateId: 'a' })
    expect(readFileSync(join(project, 'x.txt'), 'utf8')).toBe('line uno\nline two\n')
    expect(lastRun()).toMatchObject({ status: 'ready', conflicts: ['x.txt'] })
    const conflict = notifications.map((item) => item.update).find((update) => update.sessionUpdate === 'notice' && update.severity === 'error')
    expect(conflict).toMatchObject({ title: '候选方案「甲」和项目现在的文件合不上，什么都没改' })

    // 乙不碰 x.txt，照样能应用
    await discardCandidates(core, sessionId, 'c1')
    expect(lastRun()).toMatchObject({ status: 'discarded' })
    expect(readdirSync(join(worktrees, readdirSync(worktrees)[0]!))).toEqual([])
    await expect(applyCandidate(core, { sessionId, turnId: 'apply-2', title: '应用候选方案「乙」', runTurnId: 'c1', candidateId: 'b' })).rejects.toThrow('已经不能用了')
  })

  test('生成到一半停止：两个候选都停下，worktree 清掉', async () => {
    server = await startScriptedServer(twoCandidates({ 甲: { delayMs: 5000 }, 乙: { delayMs: 5000 } }))
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    const running = generateCandidates(core, { sessionId, turnId: 'c1', title: '生成 2 个候选方案', request: '改一下项目', plan: null, candidates: TWO })
    const started = Date.now()
    while (server.bodies.length < 2) {
      if (Date.now() - started > 10_000) throw new Error('候选没有开始')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await cancelSession(core, sessionId)
    expect(await running).toEqual({ stopReason: 'cancelled' })
    expect(lastRun()).toMatchObject({ status: 'cancelled' })
    expect(lastRun()!.candidates.map((candidate) => candidate.status)).toEqual(['cancelled', 'cancelled'])
    expect(readdirSync(join(worktrees, readdirSync(worktrees)[0]!))).toEqual([])
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  test('不是 git 仓库：说明原因，什么都不建', async () => {
    rmSync(join(project, '.git'), { recursive: true, force: true })
    server = await startScriptedServer([])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await generateCandidates(core, { sessionId, turnId: 'c1', title: '生成 2 个候选方案', request: '改一下项目', plan: null, candidates: TWO })
    const error = notifications.map((item) => item.update).find((update) => update.sessionUpdate === 'notice')
    expect(error).toMatchObject({ severity: 'error', title: '生成不了候选方案' })
    expect(existsSync(worktrees)).toBe(false)
  })

  test('删除任务时还没选的候选一起清掉', async () => {
    server = await startScriptedServer(twoCandidates())
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await generateCandidates(core, { sessionId, turnId: 'c1', title: '生成 2 个候选方案', request: '改一下项目', plan: null, candidates: TWO })
    expect(readdirSync(join(worktrees, readdirSync(worktrees)[0]!)).length).toBeGreaterThan(0)
    await deleteSession(core, sessionId)
    expect(readdirSync(join(worktrees, readdirSync(worktrees)[0]!))).toEqual([])
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  test('上次生成到一半应用就退出了：打开时记成停止、清掉 worktree', async () => {
    const baseline = await captureBaseline(project)
    const worktree = await createWorktree(baseline, join(worktrees, 'crash', 'a'))
    const run: CandidateRun = {
      turnId: 'c1',
      status: 'running',
      appliedId: null,
      candidates: [{ id: 'a', name: '甲', approach: '改', status: 'running', verification: null, summary: null, error: null, stats: null, paths: [] }],
      repoRoot: baseline.repoRoot,
      subdir: '',
      baseTree: worktree.baseTree,
      worktrees: [{ id: 'a', dir: worktree.dir, links: worktree.links, tree: null }],
    }
    expect(await recoverRuns({ candidateRuns: [run] } as unknown as Session)).toBe(true)
    expect(run.status).toBe('cancelled')
    expect(run.candidates[0]!.status).toBe('cancelled')
    expect(existsSync(worktree.dir)).toBe(false)
  })
})
