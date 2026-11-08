import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgent } from '../src/agent.js'
import { McpPool } from '../src/mcp.js'
import {
  cancelSession,
  checkpointDiff,
  configureSession,
  compactSession,
  connectToCore,
  createSession,
  deepScan,
  deleteSession,
  handshake,
  listSessions,
  listCommands,
  listSkills,
  loadSession,
  mcpPrompt,
  mcpStatus,
  plan,
  previewCheckpoint,
  restoreCheckpoint,
  rewindSession,
  searchSessions,
  sendPrompt,
  updateSession,
} from '../src/client.js'
import type { SessionConfig } from '../src/protocol.js'
import { SessionStore } from '../src/session/store.js'
import { MCP_SERVER_SCRIPT, testMcpServer } from './mcp-fixture.js'
import { type ScriptedServer, startScriptedServer } from './scripted-server.js'

let project: string
let dataDir: string
let server: ScriptedServer | null = null
let notifications: acp.SessionNotification[] = []

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-sessions-project-'))
  dataDir = mkdtempSync(join(tmpdir(), 'diffra-sessions-data-'))
  notifications = []
})

afterEach(async () => {
  await server?.close()
  server = null
  rmSync(project, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

// 在同一个进程里起一个 core 和一个客户端；每调用一次相当于重启一次 core
async function startCore(mcpPool?: McpPool) {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  createAgent({ sessionsDir: join(dataDir, 'sessions'), mcpPool }).connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
  const connection = connectToCore(toAgent, toClient, {
    onSessionUpdate: (notification) => notifications.push(notification),
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  await handshake(connection, 5000)
  return connection
}

function lastTaskState(sessionId: string): unknown {
  const metas = notifications.flatMap(({ sessionId: id, update }) =>
    id === sessionId && update.sessionUpdate === 'session_info_update' && update._meta ? [update._meta.diffra as Record<string, unknown>] : [],
  )
  return metas.filter((meta) => 'taskState' in meta).at(-1)?.taskState
}

function config(baseUrl: string): SessionConfig {
  return {
    model: { endpoint: { protocol: 'openai-compatible', baseUrl, apiKey: 'secret-key-should-not-be-saved' }, modelId: 'scripted', contextWindow: 100_000, provider: { id: 'p1', name: '脚本供应商' } },
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
    checkpointDir: join(dataDir, 'checkpoints'),
  }
}

describe('会话持久化', () => {
  test('手动 compact 扩展请求记录和摘要持久化，重启后继续使用摘要，历史仍可加载', async () => {
    server = await startScriptedServer([{ text: '早期回复' }, { text: '最新回复' }, { text: '用户要求保留项目偏好，下一步继续。' }, { text: '已按摘要继续' }])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await sendPrompt(core, sessionId, 'early', `偏好：保持中文。${'早期细节'.repeat(3000)}`)
    await sendPrompt(core, sessionId, 'recent', '继续之前的任务')
    expect(await compactSession(core, sessionId, 'manual')).toEqual({ stopReason: 'end_turn' })
    const store = new SessionStore(join(dataDir, 'sessions'))
    const saved = await store.load(sessionId)
    expect(saved.compaction?.summary).toContain('保留项目偏好')
    expect(saved.turns.at(-1)).toMatchObject({ kind: 'compact', prompt: '/compact' })
    expect(server.bodies[2]).toContain('早期细节')
    const restarted = await startCore()
    const loaded = await loadSession(restarted, sessionId, project, config(server.baseUrl))
    expect(loaded.turns).toHaveLength(3)
    expect(loaded.turns[0]?.prompt).toContain('早期细节')
    await sendPrompt(restarted, sessionId, 'continued', '继续')
    expect(server.bodies[3]).toContain('保留项目偏好')
    expect(server.bodies[3]).not.toContain('早期细节')
    expect(server.bodies[3]).toContain('继续之前的任务')
  })

  test('重启后能列出、加载并接着聊，撤销还能用；改名、归档、搜索、删除', async () => {
    server = await startScriptedServer([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'hello\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了 a.txt' } }] },
      { text: '接着上次的 a.txt 继续' },
    ])
    const first = await startCore()
    const { sessionId } = await createSession(first, project, config(server.baseUrl))
    expect(await listSessions(first)).toEqual([])
    await sendPrompt(first, sessionId, 'turn-1', '写一个 a.txt，内容是 hello')

    const saved = readFileSync(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8')
    expect(saved).not.toContain('secret-key-should-not-be-saved')

    // 重启：新的 core 实例从磁盘读
    const second = await startCore()
    const [summary] = await listSessions(second, project)
    expect(summary).toMatchObject({ sessionId, cwd: project, title: '写一个 a.txt，内容是 hello', archived: false, turnCount: 1 })

    const loaded = await loadSession(second, sessionId, project, config(server.baseUrl))
    expect(loaded.title).toBe('写一个 a.txt，内容是 hello')
    expect(loaded.info.checkpoints).toBe(true)
    expect(loaded.turns).toHaveLength(1)
    expect(loaded.turns[0]).toMatchObject({ id: 'turn-1', prompt: '写一个 a.txt，内容是 hello', stopReason: 'end_turn' })
    const titles = loaded.turns[0]?.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))
    expect(titles).toContain('完成')
    expect(await previewCheckpoint(second, sessionId, 'turn-1')).toEqual([{ path: 'a.txt', change: 'added' }])

    // 接着聊：模型看到了上一轮的对话
    await sendPrompt(second, sessionId, 'turn-2', '再看看 a.txt')
    expect(server.bodies[2]).toContain('写一个 a.txt，内容是 hello')
    expect((await listSessions(second))[0]?.turnCount).toBe(2)

    await updateSession(second, sessionId, { title: '新的标题' })
    expect((await listSessions(second))[0]?.title).toBe('新的标题')
    expect(await searchSessions(second, '继续')).toEqual([
      expect.objectContaining({ sessionId, title: '新的标题', snippet: '接着上次的 a.txt 继续' }),
    ])
    await updateSession(second, sessionId, { archived: true })
    expect((await listSessions(second))[0]?.archived).toBe(true)
    expect(await searchSessions(second, '继续')).toEqual([])

    await deleteSession(second, sessionId)
    expect(await listSessions(second)).toEqual([])
    expect(existsSync(join(dataDir, 'sessions', `${sessionId}.json`))).toBe(false)
  })

  test('加载带上 core 当前的任务状态；撤销之后发出待重新验证的状态，并且存盘', async () => {
    server = await startScriptedServer([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'hello\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了 a.txt' } }] },
    ])
    const first = await startCore()
    const { sessionId } = await createSession(first, project, config(server.baseUrl))
    await sendPrompt(first, sessionId, 'turn-1', '写一个 a.txt')

    const second = await startCore()
    const loaded = await loadSession(second, sessionId, project, config(server.baseUrl))
    expect(loaded.taskState).toEqual({ status: 'completed', reason: null, requirements: [], needsVerification: false })

    notifications = []
    expect(await restoreCheckpoint(second, sessionId, 'turn-1')).toEqual([{ path: 'a.txt', change: 'added' }])
    const restored = { status: 'blocked', reason: '文件已撤销，需要重新验证完成条件。', requirements: [], needsVerification: true }
    expect(lastTaskState(sessionId)).toEqual(restored)

    const third = await startCore()
    expect((await loadSession(third, sessionId, project, config(server.baseUrl))).taskState).toEqual(restored)
  })

  test('撤销给这一轮及之后的轮次记下撤销时刻，撤销了哪些文件记在这一轮末尾，重启后还在', async () => {
    server = await startScriptedServer([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'a\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了 a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'b\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了 b.txt' } }] },
      { text: '好' },
    ])
    const first = await startCore()
    const { sessionId } = await createSession(first, project, config(server.baseUrl))
    await sendPrompt(first, sessionId, 'turn-1', '写 a.txt')
    await sendPrompt(first, sessionId, 'turn-2', '写 b.txt')
    await sendPrompt(first, sessionId, 'turn-3', '看看')

    notifications = []
    const before = Date.now()
    expect(await restoreCheckpoint(first, sessionId, 'turn-2')).toEqual([{ path: 'b.txt', change: 'added' }])
    expect(notifications.some(({ update }) => update.sessionUpdate === 'notice')).toBe(false)

    const loaded = await loadSession(await startCore(), sessionId, project, config(server.baseUrl))
    const [turn1, turn2, turn3] = loaded.turns
    // 第一轮相当于没有这个字段的旧记录
    expect(turn1).not.toHaveProperty('restoredAt')
    expect(Date.parse(turn2?.restoredAt ?? '')).toBeGreaterThanOrEqual(before)
    expect(turn3?.restoredAt).toBe(turn2?.restoredAt)
    expect(turn2?.updates.at(-1)).toEqual({ sessionUpdate: 'notice', severity: 'info', title: '已撤销 1 个文件的改动', description: 'b.txt' })
    expect(turn3?.updates.some((update) => update.sessionUpdate === 'notice')).toBe(false)
  })

  test('撤销提示最多列 50 个文件，没有改动时不带说明；再撤销一次覆盖撤销时刻', async () => {
    server = await startScriptedServer([{ text: '好' }])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await sendPrompt(core, sessionId, 'turn-1', '你好')
    expect(await restoreCheckpoint(core, sessionId, 'turn-1')).toEqual([])
    const once = (await loadSession(core, sessionId, project, config(server.baseUrl))).turns[0]

    const paths = Array.from({ length: 51 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    for (const path of paths) writeFileSync(join(project, path), 'x\n')
    expect(await restoreCheckpoint(core, sessionId, 'turn-1')).toHaveLength(51)
    const twice = (await loadSession(core, sessionId, project, config(server.baseUrl))).turns[0]
    expect(Date.parse(twice?.restoredAt ?? '')).toBeGreaterThan(Date.parse(once?.restoredAt ?? ''))
    expect(twice?.updates.filter((update) => update.sessionUpdate === 'notice')).toEqual([
      { sessionUpdate: 'notice', severity: 'info', title: '已撤销 0 个文件的改动', description: null },
      { sessionUpdate: 'notice', severity: 'info', title: '已撤销 51 个文件的改动', description: [...paths.slice(0, 50), '…等 51 个文件'].join('\n') },
    ])
  })

  test('应用退出时停在运行中的任务，加载后是受阻', async () => {
    server = await startScriptedServer([{ text: '好的' }])
    const first = await startCore()
    const { sessionId } = await createSession(first, project, config(server.baseUrl))
    await sendPrompt(first, sessionId, 'turn-1', '你好')
    const file = join(dataDir, 'sessions', `${sessionId}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8')) as { taskState: { status: string }; turns: Array<{ endedAt: string | null; stopReason: string | null }> }
    record.taskState.status = 'running'
    record.turns[0]!.endedAt = null
    record.turns[0]!.stopReason = null
    writeFileSync(file, JSON.stringify(record))

    const loaded = await loadSession(await startCore(), sessionId, project, config(server.baseUrl))
    expect(loaded.taskState).toMatchObject({ status: 'blocked', reason: '应用退出时任务未完成，请继续执行剩余步骤。' })
  })

  test('没有确定的任务状态时，加载不带任务状态，也不说应用退出过', async () => {
    server = await startScriptedServer([{ text: '好的' }])
    const first = await startCore()
    const { sessionId } = await createSession(first, project, config(server.baseUrl))
    await sendPrompt(first, sessionId, 'turn-1', '你好')
    const file = join(dataDir, 'sessions', `${sessionId}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8')) as { taskState?: { status: string } }

    // 只跑过出计划、深度扫描、压缩，或者撤销后还没开始新一轮：存下来的是初始的 running
    record.taskState!.status = 'running'
    writeFileSync(file, JSON.stringify(record))
    expect((await loadSession(await startCore(), sessionId, project, config(server.baseUrl))).taskState).toBeUndefined()

    // 旧版记录没有 taskState
    delete record.taskState
    writeFileSync(file, JSON.stringify(record))
    expect((await loadSession(await startCore(), sessionId, project, config(server.baseUrl))).taskState).toBeUndefined()
  })

  test('任务进行中加载，带上运行中的任务状态', async () => {
    let received: () => void = () => {}
    const requested = new Promise<void>((resolve) => (received = resolve))
    const hanging = createServer((req) => {
      req.resume()
      received()
    })
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve))
    const { port } = hanging.address() as AddressInfo
    try {
      const core = await startCore()
      const { sessionId } = await createSession(core, project, config(`http://127.0.0.1:${port}/v1`))
      const turn = sendPrompt(core, sessionId, 'turn-1', '你好')
      await requested
      const loaded = await loadSession(core, sessionId, project, config(`http://127.0.0.1:${port}/v1`))
      expect(loaded.taskState).toEqual({ status: 'running', reason: null, requirements: [], needsVerification: false })
      await cancelSession(core, sessionId)
      expect((await turn).stopReason).toBe('cancelled')
    } finally {
      hanging.closeAllConnections()
      await new Promise<void>((resolve) => hanging.close(() => resolve()))
    }
  })

  test('core 返回不合法的任务状态时丢掉，缺检查命令时为 null', async () => {
    const toAgent = new PassThrough()
    const toClient = new PassThrough()
    acp
      .agent({ name: 'fake-core' })
      .onRequest(acp.methods.agent.session.load, () => ({ _meta: { diffra: { info: {}, title: '旧任务', turns: [], taskState: { status: 'unknown' } } } }))
      .connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
    const connection = connectToCore(toAgent, toClient, {
      onSessionUpdate: () => {},
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    })
    const loaded = await loadSession(connection, 'fake', project, config('http://127.0.0.1:1/v1'))
    expect(loaded.title).toBe('旧任务')
    expect(loaded.taskState).toBeUndefined()
    expect(loaded.info.checks).toBeNull()
  })

  test('新建和加载都返回这个会话实际生效的检查命令', async () => {
    server = await startScriptedServer([])
    const core = await startCore()
    const checks = { afterEdit: 'pnpm typecheck', beforeFinish: null }
    const { sessionId, info } = await createSession(core, project, { ...config(server.baseUrl), checks })
    expect(info.checks).toEqual(checks)
    const changed = { afterEdit: null, beforeFinish: 'pnpm test' }
    const loaded = await loadSession(core, sessionId, project, { ...config(server.baseUrl), checks: changed })
    expect(loaded.info.checks).toEqual(changed)
  })

  test('只建了会话、没发过任务时不留记录', async () => {
    server = await startScriptedServer([])
    const core = await startCore()
    await createSession(core, project, config(server.baseUrl))
    expect(await listSessions(core)).toEqual([])
  })
})

describe('会话存储', () => {
  const record = (id: string, cwd: string, title: string, updatedAt: string) => ({
    version: 1 as const,
    id,
    cwd,
    title,
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    turns: [],
    messages: [],
    compaction: null,
  })

  test('索引丢了或坏了时从会话文件重建，按最近更新排序，可按项目过滤', async () => {
    const dir = join(dataDir, 'sessions')
    const store = new SessionStore(dir)
    await store.save(record('s1', 'D:\\a', '一', '2026-01-01T00:00:00Z'))
    await store.save(record('s2', 'D:\\b', '二', '2026-01-02T00:00:00Z'))
    writeFileSync(join(dir, 'index.json'), '{broken')
    writeFileSync(join(dir, 'junk.json'), 'not json')
    const fresh = new SessionStore(dir)
    expect((await fresh.list()).map((entry) => entry.id)).toEqual(['s2', 's1'])
    expect((await fresh.list('D:\\a')).map((entry) => entry.id)).toEqual(['s1'])
  })

  test('拒绝带路径的会话 id；损坏的会话文件给出说明', async () => {
    const dir = join(dataDir, 'sessions')
    const store = new SessionStore(dir)
    await expect(store.load('../secrets')).rejects.toThrow('无效的会话 id')
    await store.save(record('s1', 'D:\\a', '一', '2026-01-01T00:00:00Z'))
    writeFileSync(join(dir, 's1.json'), JSON.stringify({ version: 1, id: 's1' }))
    await expect(store.load('s1')).rejects.toThrow('已损坏')
  })
})

describe('重新生成、切换模型、整段 diff', () => {
  test('重新生成撤掉这一轮的文件改动和对话；切换模型从下一轮生效', async () => {
    server = await startScriptedServer([
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'first\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '第一轮' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'c.txt', old_string: '', new_string: 'second\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '第二轮' } }] },
      { text: '重新生成的回答' },
    ])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await sendPrompt(core, sessionId, 'turn-1', '写 b.txt')
    await sendPrompt(core, sessionId, 'turn-2', '写 c.txt')

    const diff = await checkpointDiff(core, sessionId, 'turn-1')
    expect(diff).toContain('+++ b/b.txt')
    expect(diff).toContain('+++ b/c.txt')

    notifications = []
    expect(await rewindSession(core, sessionId, 'turn-2')).toEqual({ filesRestored: true })
    expect(lastTaskState(sessionId)).toEqual({ status: 'running', reason: null, requirements: [], needsVerification: false })
    expect(existsSync(join(project, 'c.txt'))).toBe(false)
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('first\n')

    const other = await startScriptedServer([{ text: '换了模型' }])
    try {
      await configureSession(core, sessionId, {
        permissionMode: 'auto',
        model: { endpoint: { protocol: 'openai-compatible', baseUrl: other.baseUrl, apiKey: 'k' }, modelId: 'other', contextWindow: 1_000_000, provider: null },
      })
      await sendPrompt(core, sessionId, 'turn-3', '再写一遍 c.txt')
      // 新模型收到的对话里有第一轮，没有被撤掉的第二轮
      expect(other.bodies[0]).toContain('写 b.txt')
      expect(other.bodies[0]).not.toContain('写 c.txt')
    } finally {
      await other.close()
    }
    const [summary] = await listSessions(core)
    expect(summary?.turnCount).toBe(2)
  })
})

describe('错误提示', () => {
  // ACP 把处理函数抛出的错误包成 Internal error，原文在 data.details 里；界面要看到原文
  test('core 抛出的错误原文传到客户端', async () => {
    server = await startScriptedServer([])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await expect(rewindSession(core, sessionId, 'no-such-turn')).rejects.toThrow('这一轮不能重新生成')
    await expect(checkpointDiff(core, sessionId, 'no-such-turn')).rejects.toThrow('这一轮没有检查点，看不了改动')
  })
})

describe('深度安全扫描', () => {
  test('只读审计：改文件被拒，报告里只留有效的问题；这一轮记成深度扫描，不进编码模型的对话', async () => {
    writeFileSync(join(project, 'files.ts'), 'export const read = (req) => fs.readFileSync(path.join(UPLOAD, req.query.name))\n')
    server = await startScriptedServer([
      // 第一轮：普通任务
      { toolCalls: [{ name: 'edit_file', input: { path: 'route.ts', old_string: '', new_string: 'app.get("/file", read)\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了路由' } }] },
      // 深度扫描：搜索、读文件、试图改文件、交报告
      { toolCalls: [{ name: 'search', input: { pattern: 'req.query' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'files.ts' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'files.ts', old_string: 'req.query.name', new_string: 'x' } }] },
      {
        toolCalls: [
          {
            name: 'report',
            input: {
              summary: '检查了新加的路由和读文件函数',
              findings: [
                { severity: 'high', ruleId: 'SEC-INJ-4', path: 'files.ts', line: 1, problem: '文件名来自请求参数', flow: 'route.ts:1 /file → files.ts:1 readFileSync', fix: '用 path.basename 去掉目录' },
                { severity: 'high', ruleId: 'SEC-FAKE-9', path: 'files.ts', line: 1, problem: '不存在的规则', flow: '', fix: '' },
                { severity: 'medium', ruleId: 'SEC-INJ-1', path: 'missing.ts', line: 3, problem: '不存在的文件', flow: '', fix: '' },
              ],
            },
          },
        ],
      },
      // 下一轮普通提问
      { text: '好' },
    ])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    await sendPrompt(core, sessionId, 'turn-1', '加一个读文件的路由')
    expect(await deepScan(core, sessionId, 'scan-1', 'task')).toEqual({ stopReason: 'end_turn' })

    expect(readFileSync(join(project, 'files.ts'), 'utf8')).toContain('req.query.name')
    expect(server.bodies[2]).toContain('Audit the code changed in this task')
    expect(server.bodies[2]).toContain('route.ts')
    expect(server.bodies[5]).toContain("unavailable tool 'edit_file'")

    const loaded = await loadSession(core, sessionId, project, config(server.baseUrl))
    const scan = loaded.turns[1]
    expect(scan).toMatchObject({ id: 'scan-1', kind: 'deep-scan', prompt: '深度安全扫描 · 本任务改动', stopReason: 'end_turn' })
    const report = scan?.updates.find((update) => update.sessionUpdate === 'tool_call' && update.title === '深度扫描报告')
    const text = JSON.stringify(report)
    expect(text).toContain('高危  SEC-INJ-4  files.ts:1  文件名来自请求参数')
    expect(text).toContain('链路：route.ts:1 /file')
    expect(text).not.toContain('SEC-FAKE-9')
    expect(text).not.toContain('missing.ts')

    // 编码模型的下一轮看不到审计过程
    await sendPrompt(core, sessionId, 'turn-2', '继续')
    expect(server.bodies[6]).not.toContain('security auditor')
    expect(server.bodies[6]).not.toContain('req.query')
  })
})

describe('先出计划', () => {
  test('出计划记成一轮，存下计划卡片；编码模型的下一轮看不到规划过程', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    server = await startScriptedServer([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'submit_plan', input: { understanding: '修复 a.txt', steps: [{ title: '改 a.txt', detail: 'broken 改成 fixed', files: ['a.txt'] }], risks: [] } }] },
      { text: '好' },
    ])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))
    expect(await plan(core, sessionId, 'plan-1', '修复 a.txt')).toEqual({ stopReason: 'end_turn' })
    expect(server.bodies[0]).toContain('PLANNING MODE')

    const loaded = await loadSession(core, sessionId, project, config(server.baseUrl))
    expect(loaded.turns[0]).toMatchObject({ id: 'plan-1', kind: 'plan', prompt: '修复 a.txt', stopReason: 'end_turn' })
    const card = loaded.turns[0]?.updates.find((update) => update.sessionUpdate === 'tool_call' && update.title === '计划')
    expect(JSON.stringify(card)).toContain('1. 改 a.txt')

    await sendPrompt(core, sessionId, 'turn-2', '按计划做')
    expect(server.bodies[2]).not.toContain('PLANNING MODE')
    expect(server.bodies[2]).not.toContain('value = broken')
  })
})

describe('Skill 和目标模式', () => {
  test('列出项目里的 Skill；带 Skill 的提问把说明发给模型并记在这一轮；找不到的 Skill 不开始；目标模式记成目标', async () => {
    mkdirSync(join(project, '.diffra', 'skills', 'diffra-test-skill'), { recursive: true })
    writeFileSync(join(project, '.diffra', 'skills', 'diffra-test-skill', 'SKILL.md'), '---\nname: diffra-test-skill\ndescription: 测试用\n---\n回答前先说 OK')
    server = await startScriptedServer([{ text: 'OK，好的' }, { toolCalls: [{ name: 'finish', input: { summary: '完成', goal_met: true } }] }])
    const core = await startCore()
    const { sessionId } = await createSession(core, project, config(server.baseUrl))

    const skills = await listSkills(core, project)
    expect(skills.find((skill) => skill.name === 'diffra-test-skill')).toEqual({
      name: 'diffra-test-skill',
      description: '测试用',
      source: 'project',
      dir: join(project, '.diffra', 'skills', 'diffra-test-skill'),
    })

    await sendPrompt(core, sessionId, 'turn-1', '你好', { skills: ['diffra-test-skill'] })
    expect(server.bodies[0]).toContain('回答前先说 OK')
    await expect(sendPrompt(core, sessionId, 'turn-2', '你好', { skills: ['no-such-skill'] })).rejects.toThrow('找不到 Skill：no-such-skill')
    await sendPrompt(core, sessionId, 'turn-3', '把事做完', { goal: true })
    expect(server.bodies[1]).toContain('Goal mode')

    const loaded = await loadSession(core, sessionId, project, config(server.baseUrl))
    expect(loaded.turns.map(({ id, kind, prompt, skills }) => ({ id, kind, prompt, skills }))).toEqual([
      { id: 'turn-1', kind: 'prompt', prompt: '你好', skills: ['diffra-test-skill'] },
      { id: 'turn-3', kind: 'goal', prompt: '把事做完', skills: [] },
    ])
  })
})

describe('MCP', () => {
  test('建会话时带上 MCP 服务器：按任务或按配置查状态，展开 prompt，模型能用它的工具', async () => {
    server = await startScriptedServer([{ toolCalls: [{ name: 'mcp__demo__echo', input: { text: 'ping' } }] }, { text: '收到' }])
    // MCP 服务器的工作目录是项目目录，删目录前要先关掉
    const pool = new McpPool()
    try {
      const core = await startCore(pool)
      const { sessionId } = await createSession(core, project, config(server.baseUrl), [testMcpServer()])

      const [status] = await mcpStatus(core, { sessionId })
      expect(status).toMatchObject({ name: 'demo', transport: 'stdio', state: 'connected' })
      expect(status?.prompts.map((prompt) => prompt.name)).toEqual(['review'])
      expect(await mcpPrompt(core, { sessionId }, 'demo', 'review', { file: 'a.ts' })).toBe('Please review a.ts')
      await expect(mcpPrompt(core, { sessionId }, 'other', 'review', {})).rejects.toThrow('没有名为「other」的 MCP 服务器')
      const [byConfig] = await mcpStatus(core, { cwd: project, servers: [testMcpServer('demo2')] })
      expect(byConfig?.state).toBe('connected')

      await sendPrompt(core, sessionId, 'turn-1', '试试 MCP')
      expect(server.bodies[0]).toContain('mcp__demo__echo')
      expect(server.bodies[1]).toContain('echo: ping')
    } finally {
      await pool.closeAll()
    }
  })
})

describe('插件', () => {
  test('开着的插件：Skill 能选、命令能列出、MCP 服务器跟着任务连上', async () => {
    const plugin = join(dataDir, 'kit')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }))
    mkdirSync(join(plugin, 'skills', 'kit-style'), { recursive: true })
    writeFileSync(join(plugin, 'skills', 'kit-style', 'SKILL.md'), '---\nname: kit-style\n---\n插件说明 KIT-OK')
    mkdirSync(join(plugin, 'commands'))
    writeFileSync(join(plugin, 'commands', 'greet.md'), '跟 $ARGUMENTS 打招呼')
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [MCP_SERVER_SCRIPT] } } }))
    server = await startScriptedServer([{ text: '好' }])
    const pool = new McpPool()
    try {
      const core = await startCore(pool)
      const plugins = [{ name: 'kit', dir: plugin }]
      const { sessionId } = await createSession(core, project, { ...config(server.baseUrl), plugins })

      expect((await listSkills(core, project, plugins)).find((skill) => skill.name === 'kit-style')?.source).toBe('plugin')
      expect((await listCommands(core, project, plugins)).find((command) => command.name === 'kit:greet')?.body).toBe('跟 $ARGUMENTS 打招呼')
      const [status] = await mcpStatus(core, { sessionId })
      expect(status).toMatchObject({ name: 'kit-demo', state: 'connected' })

      await sendPrompt(core, sessionId, 'turn-1', '你好', { skills: ['kit-style'] })
      expect(server.bodies[0]).toContain('插件说明 KIT-OK')
      expect(server.bodies[0]).toContain('mcp__kit-demo__echo')
    } finally {
      await pool.closeAll()
    }
  })
})

describe('图片输入', () => {
  // 1x1 的 PNG
  const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  test('模型没打开图片时不开始这一轮；打开了就把图片发给模型，记在这一轮里', async () => {
    server = await startScriptedServer([{ text: '看到了一个像素' }])
    const core = await startCore()
    const plain = await createSession(core, project, config(server.baseUrl))
    await expect(sendPrompt(core, plain.sessionId, 'turn-1', '看看这张图', { images: [{ mimeType: 'image/png', data: PIXEL }] })).rejects.toThrow(
      '没有打开图片输入',
    )

    const base = config(server.baseUrl)
    const { sessionId } = await createSession(core, project, { ...base, model: { ...base.model, supportsImages: true } })
    await sendPrompt(core, sessionId, 'turn-1', '看看这张图', { images: [{ mimeType: 'image/png', data: PIXEL }] })
    expect(server.bodies[0]).toContain('看看这张图')
    expect(server.bodies[0]).toContain(`data:image/png;base64,${PIXEL}`)

    const loaded = await loadSession(core, sessionId, project, { ...base, model: { ...base.model, supportsImages: true } })
    expect(loaded.turns[0]).toMatchObject({ prompt: '看看这张图', images: [{ mimeType: 'image/png', data: PIXEL }] })
  })
})
