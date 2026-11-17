import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { findBash } from '../src/environment.js'
import { ExecSessions, execCommandTool, writeStdinTool } from '../src/tools/exec.js'
import type { ToolContext } from '../src/tools/types.js'

let project: string
let sessions: ExecSessions
let context: ToolContext

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'diffra-exec-owner-'))
  sessions = new ExecSessions()
  context = {
    cwd: project,
    bashPath: await findBash(),
    rgPath: '',
    signal: new AbortController().signal,
    execSessions: sessions,
    trustedCommands: [],
    readOnlyPaths: [],
    readRoots: [],
    requestCommandPermission: async () => ({ allowed: true }),
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessions.killAll(true)
  rmSync(project, { recursive: true, force: true })
})

async function start(owner?: string) {
  const result = await execCommandTool(
    { ...context, processOwner: owner },
    { cmd: 'echo ready; while IFS= read -r line; do printf "got:%s\\n" "$line"; done', stdin: true, yield_time_ms: 250 },
  )
  const id = Number(/session ID (\d+)/.exec(result.text)?.[1])
  expect(Number.isInteger(id)).toBe(true)
  const entry = sessions.get(id)
  if (!entry) throw new Error('命令没有返回有效进程')
  return entry
}

describe('工人进程归属', () => {
  test('exec_command 记录工人 owner，未指定的主智能体进程 owner 为 null', async () => {
    const worker = await start('worker-a')
    const main = await start()
    expect(worker.owner).toBe('worker-a')
    expect(main.owner).toBeNull()
    expect(sessions.get(main.id, 'worker-a')).toBeUndefined()
    expect(sessions.ids('worker-a')).toEqual([worker.id])
  })

  test('不同工人不能 poll、type、stop 对方或主智能体的进程，错误不暴露其他会话号', async () => {
    const own = await start('worker-a')
    const other = await start('worker-b')
    const main = await start()
    const worker = { ...context, processOwner: 'worker-a' }
    const pending = other.pending.head
    const lastUsed = other.lastUsed
    for (const target of [other, main]) {
      for (const chars of ['', 'intrusion\n', '\u0003', '^C', '\u0004']) {
        await expect(writeStdinTool(worker, { session_id: target.id, chars })).rejects.toThrow(
          `No running process with session ID ${target.id}. Running sessions: ${own.id}.`,
        )
      }
      expect(target.stopped).toBe(false)
      expect(target.exited).toBe(false)
    }
    expect(other.pending.head).toBe(pending)
    expect(other.lastUsed).toBe(lastUsed)
    await expect(writeStdinTool({ ...context, processOwner: 'worker-without-processes' }, { session_id: -1 })).rejects.toThrow('Running sessions: none.')
  })

  test('工人能操作自己的进程；undefined 主智能体能 poll、type、stop 工人进程', async () => {
    const entry = await start('worker-a')
    const ownInput = await writeStdinTool({ ...context, processOwner: 'worker-a' }, { session_id: entry.id, chars: 'own\n', yield_time_ms: 250 })
    expect(ownInput.text).toContain('got:own')
    await expect(writeStdinTool(context, { session_id: entry.id, chars: '', yield_time_ms: 5000 })).resolves.toMatchObject({ title: expect.stringMatching(/^查看 /) })
    const mainInput = await writeStdinTool(context, { session_id: entry.id, chars: 'main\n', yield_time_ms: 250 })
    expect(mainInput.text).toContain('got:main')
    const stopped = await writeStdinTool(context, { session_id: entry.id, chars: '\u0003' })
    expect(stopped.text).toContain('Process stopped (Ctrl-C)')
    expect(entry.exited).toBe(true)
    expect(sessions.get(entry.id)).toBeUndefined()
  }, 15_000)

  test('killOwner 等进程退出，只清理指定工人，其他工人和主进程仍可使用', async () => {
    const first = await start('worker-a')
    const second = await start('worker-a')
    const other = await start('worker-b')
    const main = await start()
    const noOwnerCleanup = sessions.ids()
    await sessions.killOwner('unknown-worker')
    expect(sessions.ids()).toEqual(noOwnerCleanup)
    await sessions.killOwner('worker-a')
    for (const entry of [first, second]) {
      expect(entry.stopped).toBe(true)
      expect(entry.exited).toBe(true)
      expect(sessions.get(entry.id)).toBeUndefined()
    }
    expect(sessions.ids()).toEqual([other.id, main.id])
    for (const entry of [other, main]) {
      expect(entry.exited).toBe(false)
      expect(entry.stopped).toBe(false)
      const output = await writeStdinTool(context, { session_id: entry.id, chars: 'still-running\n', yield_time_ms: 250 })
      expect(output.text).toContain('got:still-running')
    }
    await sessions.killOwner('worker-a')
    sessions.killAll(true)
    expect(sessions.size).toBe(0)
  }, 15_000)

  test('killOwner 等待有上限，超时不丢进程句柄，之后仍能清理', async () => {
    const entry = await start('worker-a')
    const kill = vi.spyOn(sessions, 'kill').mockImplementation(() => {})
    vi.useFakeTimers()
    const cleanup = sessions.killOwner('worker-a')
    const rejected = expect(cleanup).rejects.toThrow('Timed out waiting for this worker\'s processes to stop.')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(sessions.get(entry.id)).toBe(entry)
    expect(entry.exited).toBe(false)
    vi.useRealTimers()
    kill.mockRestore()
    await sessions.killOwner('worker-a')
    expect(entry.exited).toBe(true)
    expect(sessions.size).toBe(0)
  })
})
