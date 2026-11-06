import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgent } from '../src/agent.js'
import {
  checkpointDiff,
  configureSession,
  connectToCore,
  createSession,
  deleteSession,
  handshake,
  listSessions,
  loadSession,
  previewCheckpoint,
  rewindSession,
  searchSessions,
  sendPrompt,
  updateSession,
} from '../src/client.js'
import type { SessionConfig } from '../src/protocol.js'
import { SessionStore } from '../src/session/store.js'
import { type ScriptedServer, startScriptedServer } from './scripted-server.js'

let project: string
let dataDir: string
let server: ScriptedServer | null = null

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-sessions-project-'))
  dataDir = mkdtempSync(join(tmpdir(), 'diffra-sessions-data-'))
})

afterEach(async () => {
  await server?.close()
  server = null
  rmSync(project, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

// 在同一个进程里起一个 core 和一个客户端；每调用一次相当于重启一次 core
async function startCore() {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  createAgent({ sessionsDir: join(dataDir, 'sessions') }).connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
  const connection = connectToCore(toAgent, toClient, {
    onSessionUpdate: () => {},
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  await handshake(connection, 5000)
  return connection
}

function config(baseUrl: string): SessionConfig {
  return {
    model: { endpoint: { protocol: 'openai-compatible', baseUrl, apiKey: 'secret-key-should-not-be-saved' }, modelId: 'scripted', contextWindow: 100_000, provider: { id: 'p1', name: '脚本供应商' } },
    reviewModel: null,
    checks: { afterEdit: null, beforeFinish: null },
    readOnlyPaths: [],
    rules: { packs: [], review: false },
    permissionMode: 'ask',
    checkpointDir: join(dataDir, 'checkpoints'),
  }
}

describe('会话持久化', () => {
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

    expect(await rewindSession(core, sessionId, 'turn-2')).toEqual({ filesRestored: true })
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
