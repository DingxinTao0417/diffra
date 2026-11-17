import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolResultPart } from 'ai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PERMISSION_OPTIONS, type StoredTurn, type TaskSource } from '../src/protocol.js'
import type { Session } from '../src/session/session.js'
import type { StepToolCall, TurnIO } from '../src/session/loop.js'
import { MAX_PENDING_TASK_MESSAGES, MAX_PENDING_TASK_MESSAGES_PER_SESSION, MAX_TASK_MESSAGE_CHARS, MAX_TASK_MESSAGE_ERROR_CHARS, MAX_TASK_MESSAGE_TITLE_CHARS, TaskMailbox, type TaskMessageInput } from '../src/session/task-mailbox.js'
import { MAX_TASK_ACTIONS_PER_TURN, runTaskTool, type TaskBridge, type TASK_TOOLS } from '../src/session/tasks.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

// 只测试任务工具，不加载模型循环、检查点和其他工具。
vi.mock('../src/session/loop.js', () => ({
  textResult: (call: StepToolCall, text: string): ToolResultPart => ({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: text } }),
  errorResult: (call: StepToolCall, text: string): ToolResultPart => ({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'error-text', value: text } }),
}))

let dir: string
let root: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffra-task-mailbox-'))
  root = join(dir, 'mailbox')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function input(id = 'message-1', targetSessionId = 'target'): TaskMessageInput {
  return { id, sourceSessionId: 'source', targetSessionId, text: '完成定向测试后回复', from: { sessionId: 'source', title: '调用方任务' } }
}

function deferred() {
  let release: () => void = () => { throw new Error('Deferred promise is not initialized') }
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: release }
}

describe('持久任务邮箱', () => {
  test('消息和稳定轮次独立保存，重开可读；回复来源保留且不带配置', async () => {
    const mailbox = new TaskMailbox(root)
    const message = await mailbox.enqueue({ ...input(), from: { sessionId: 'source', title: '发送者', reply: true } })
    expect(message).toMatchObject({ id: 'message-1', status: 'pending', sourceSessionId: 'source', targetSessionId: 'target', from: { sessionId: 'source', title: '发送者', reply: true } })
    expect(message.turnId).toMatch(/^[a-z0-9-]+$/)
    expect(readdirSync(root)).toEqual(['message-1.json'])
    const persisted: unknown = JSON.parse(readFileSync(join(root, 'message-1.json'), 'utf8'))
    expect(persisted).toEqual(message)
    expect(await new TaskMailbox(root).get(message.id)).toEqual(message)
    expect(await new TaskMailbox(root).pending('target')).toEqual([message])
    expect(await mailbox.pending('other')).toEqual([])
    expect(Object.keys(message).sort()).toEqual(['createdAt', 'from', 'id', 'sourceSessionId', 'status', 'targetSessionId', 'text', 'turnId', 'updatedAt', 'version'])
    if (process.platform !== 'win32') expect(lstatSync(join(root, 'message-1.json')).mode & 0o777).toBe(0o600)
  })

  test('省略消息 id 时生成独立 id；返回值不能修改已保存数据', async () => {
    const { id: _id, ...withoutId } = input()
    const mailbox = new TaskMailbox(root)
    const first = await mailbox.enqueue(withoutId)
    const second = await mailbox.enqueue(withoutId)
    expect(first.id).not.toBe(second.id)
    expect(first.turnId).not.toBe(second.turnId)
    first.from.title = '篡改内存'
    first.status = 'completed'
    expect(await mailbox.get(first.id)).toMatchObject({ status: 'pending', from: { title: '调用方任务' } })
  })

  test('相同 id 幂等，参数冲突拒绝；完成后重复提交不会重跑', async () => {
    const mailbox = new TaskMailbox(root)
    const first = await mailbox.enqueue(input())
    expect(await mailbox.enqueue(input())).toEqual(first)
    for (const changed of [
      { ...input(), text: '另一个消息' },
      { ...input(), targetSessionId: 'another-target' },
      { ...input(), sourceSessionId: 'another-source', from: { sessionId: 'another-source', title: '另一个发送者' } },
      { ...input(), from: { sessionId: 'source', title: '另一标题' } },
      { ...input(), from: { sessionId: 'source', title: '调用方任务', reply: true as const } },
    ]) await expect(mailbox.enqueue(changed)).rejects.toThrow(/different message/)
    await mailbox.claim(first.id)
    const completed = await mailbox.finish(first.id, { status: 'completed' })
    expect(await mailbox.enqueue(input())).toEqual(completed)
    expect(await mailbox.claim(first.id)).toBeNull()
    expect(await mailbox.pending()).toEqual([])
  })

  test('同目录多个实例串行去重和领取；只能领取一次且落盘为 running', async () => {
    const first = new TaskMailbox(root)
    const second = new TaskMailbox(root)
    const messages = await Promise.all([first.enqueue(input()), second.enqueue(input()), first.enqueue(input())])
    expect(new Set(messages.map((message) => message.turnId)).size).toBe(1)
    const claims = await Promise.all([first.claim('message-1'), second.claim('message-1'), first.claim('message-1')])
    expect(claims.filter((message) => message !== null)).toHaveLength(1)
    expect(await second.get('message-1')).toMatchObject({ status: 'running', turnId: messages[0]?.turnId })
    expect(await first.pending()).toEqual([])
  })

  test('状态转换严格，取消排队消息不执行；终态仅允许相同 finish 幂等', async () => {
    const mailbox = new TaskMailbox(root)
    expect(await mailbox.get('missing')).toBeNull()
    expect(await mailbox.claim('missing')).toBeNull()
    await expect(mailbox.finish('missing', { status: 'failed' })).rejects.toThrow(/No task message/)
    await mailbox.enqueue(input())
    await expect(mailbox.finish('message-1', { status: 'completed' })).rejects.toThrow(/claimed/)
    const cancelled = await mailbox.finish('message-1', { status: 'cancelled', error: '用户撤销' })
    expect(await new TaskMailbox(root).get('message-1')).toEqual(cancelled)
    expect(await mailbox.finish('message-1', { status: 'cancelled', error: '用户撤销' })).toEqual(cancelled)
    await expect(mailbox.finish('message-1', { status: 'completed' })).rejects.toThrow(/already ended/)
    await expect(mailbox.finish('message-1', { status: 'cancelled', error: '改写原因' })).rejects.toThrow(/already ended/)
    expect(await mailbox.claim('message-1')).toBeNull()
  })

  test('重启恢复只将 running 标失败，保留 pending 和终态，不自动重放有副作用的消息', async () => {
    const mailbox = new TaskMailbox(root)
    const running = await mailbox.enqueue(input('running'))
    await mailbox.claim(running.id)
    await mailbox.enqueue(input('pending'))
    await mailbox.enqueue(input('completed'))
    await mailbox.claim('completed')
    await mailbox.finish('completed', { status: 'completed' })
    await mailbox.enqueue(input('cancelled'))
    await mailbox.finish('cancelled', { status: 'cancelled' })
    const restarted = new TaskMailbox(root)
    const recovered = await restarted.recover()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: running.id, turnId: running.turnId, status: 'failed', error: expect.stringMatching(/interrupted.*Side effects.*explicitly retrying/) })
    expect(await restarted.pending()).toMatchObject([{ id: 'pending' }])
    expect(await restarted.get('completed')).toMatchObject({ status: 'completed' })
    expect(await restarted.get('cancelled')).toMatchObject({ status: 'cancelled' })
    expect(await restarted.claim('running')).toBeNull()
    expect(await restarted.enqueue(input('running'))).toMatchObject({ status: 'failed', turnId: running.turnId })
    expect(await new TaskMailbox(root).recover()).toEqual([])
    const retry = await restarted.enqueue(input('explicit-retry'))
    expect(retry.status).toBe('pending')
    expect(retry.turnId).not.toBe(running.turnId)
  })

  test('写入原子替换成功才确认，等待中的读取不会看见未保存的消息', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const hold = deferred()
    const entered = deferred()
    vi.mocked(rename).mockImplementationOnce(async (source, target) => {
      entered.resolve()
      await hold.promise
      await actual.rename(source, target)
    })
    const mailbox = new TaskMailbox(root)
    let acknowledged = false
    const saving = mailbox.enqueue(input()).then((message) => { acknowledged = true; return message })
    try {
      await entered.promise
      expect(acknowledged).toBe(false)
      expect(existsSync(join(root, 'message-1.json'))).toBe(false)
      const reading = new TaskMailbox(root).get('message-1')
      hold.resolve()
      const saved = await saving
      expect(await reading).toEqual(saved)
      expect(acknowledged).toBe(true)
      expect(readdirSync(root)).toEqual(['message-1.json'])
    } finally {
      hold.resolve()
      await saving
    }
  })

  test('enqueue、claim、finish 保存失败都抛出，不污染原状态，后续操作仍可保存', async () => {
    const mailbox = new TaskMailbox(root)
    vi.mocked(rename).mockRejectedValueOnce(new Error('enqueue disk full'))
    await expect(mailbox.enqueue(input())).rejects.toThrow('enqueue disk full')
    expect(await mailbox.get('message-1')).toBeNull()
    expect(readdirSync(root)).toEqual([])
    await mailbox.enqueue(input())
    vi.mocked(rename).mockRejectedValueOnce(new Error('claim disk full'))
    await expect(mailbox.claim('message-1')).rejects.toThrow('claim disk full')
    expect(await mailbox.get('message-1')).toMatchObject({ status: 'pending' })
    await mailbox.claim('message-1')
    vi.mocked(rename).mockRejectedValueOnce(new Error('finish disk full'))
    await expect(mailbox.finish('message-1', { status: 'completed' })).rejects.toThrow('finish disk full')
    expect(await mailbox.get('message-1')).toMatchObject({ status: 'running' })
    expect(await mailbox.finish('message-1', { status: 'completed' })).toMatchObject({ status: 'completed' })
    expect(readdirSync(root)).toEqual(['message-1.json'])
  })

  test('恢复结果无法保存时不谎报已恢复', async () => {
    const mailbox = new TaskMailbox(root)
    await mailbox.enqueue(input())
    await mailbox.claim('message-1')
    vi.mocked(rename).mockRejectedValueOnce(new Error('recover disk full'))
    await expect(new TaskMailbox(root).recover()).rejects.toThrow('recover disk full')
    expect(await mailbox.get('message-1')).toMatchObject({ status: 'running' })
    expect(await mailbox.recover()).toMatchObject([{ id: 'message-1', status: 'failed' }])
  })

  test.each(['', '../outside', 'a/b', 'a\\b', '.', '..', 'a.json', 'a:b', 'a b', 'a\0b', 'a'.repeat(65), 'CON', 'nul', 'LPT1'])('拒绝非法消息及会话 id：%j', async (id) => {
    const mailbox = new TaskMailbox(root)
    await expect(mailbox.enqueue({ ...input(), id })).rejects.toThrow()
    await expect(mailbox.enqueue({ ...input(), sourceSessionId: id, from: { sessionId: id, title: '来源' } })).rejects.toThrow()
    await expect(mailbox.enqueue({ ...input(), targetSessionId: id })).rejects.toThrow()
    await expect(mailbox.get(id)).rejects.toThrow()
    await expect(mailbox.claim(id)).rejects.toThrow()
    await expect(mailbox.finish(id, { status: 'cancelled' })).rejects.toThrow()
    await expect(mailbox.pending(id)).rejects.toThrow()
    expect(existsSync(root)).toBe(false)
  })

  test('验证正文、标题、来源及错误长度，拒绝配置字段，最大转义正文仍可重开', async () => {
    const mailbox = new TaskMailbox(root)
    for (const text of ['', '  \n', 'x'.repeat(MAX_TASK_MESSAGE_CHARS + 1)]) await expect(mailbox.enqueue({ ...input(), text })).rejects.toThrow()
    await expect(mailbox.enqueue({ ...input(), from: { sessionId: 'source', title: 'x'.repeat(MAX_TASK_MESSAGE_TITLE_CHARS + 1) } })).rejects.toThrow()
    await expect(mailbox.enqueue({ ...input(), from: { sessionId: 'different', title: '错误来源' } })).rejects.toThrow()
    await expect(mailbox.enqueue({ ...input(), targetSessionId: 'source' })).rejects.toThrow()
    const withConfig = { ...input(), model: { apiKey: 'must-not-save' } }
    await expect(mailbox.enqueue(withConfig)).rejects.toThrow()
    expect(existsSync(root)).toBe(false)
    const maximal = { ...input(), text: `a${'\0'.repeat(MAX_TASK_MESSAGE_CHARS - 1)}`, from: { sessionId: 'source', title: '\0'.repeat(MAX_TASK_MESSAGE_TITLE_CHARS) } }
    await mailbox.enqueue(maximal)
    await mailbox.claim('message-1')
    await expect(mailbox.finish('message-1', { status: 'failed', error: 'x'.repeat(MAX_TASK_MESSAGE_ERROR_CHARS + 1) })).rejects.toThrow()
    const failed = await mailbox.finish('message-1', { status: 'failed', error: '\0'.repeat(MAX_TASK_MESSAGE_ERROR_CHARS) })
    expect(await new TaskMailbox(root).get('message-1')).toEqual(failed)
  })

  test('单目标队列上限计算 running；满时幂等不受影响，结束后释放名额', async () => {
    const mailbox = new TaskMailbox(root)
    await Promise.all(Array.from({ length: MAX_PENDING_TASK_MESSAGES_PER_SESSION }, (_, index) => mailbox.enqueue(input(`message-${index}`))))
    await mailbox.claim('message-0')
    await expect(mailbox.enqueue(input('over-limit'))).rejects.toThrow(/queue.*full/)
    expect(await mailbox.enqueue(input('message-0'))).toMatchObject({ status: 'running' })
    await mailbox.finish('message-0', { status: 'completed' })
    expect(await mailbox.enqueue(input('over-limit'))).toMatchObject({ status: 'pending' })
    expect(await mailbox.enqueue(input('other-target', 'other'))).toMatchObject({ status: 'pending' })
  }, 15_000)

  test('全局队列上限跨目标生效', async () => {
    const mailbox = new TaskMailbox(root)
    const seed = await mailbox.enqueue(input('seed', 'target-0'))
    for (let index = 1; index < MAX_PENDING_TASK_MESSAGES; index += 1) {
      const message = { ...seed, id: `seed-${index}`, turnId: `turn-${index}`, targetSessionId: `target-${Math.floor(index / MAX_PENDING_TASK_MESSAGES_PER_SESSION)}` }
      writeFileSync(join(root, `${message.id}.json`), JSON.stringify(message))
    }
    await expect(mailbox.enqueue(input('one-more', 'fresh-target'))).rejects.toThrow(/queue is full/)
    expect(await mailbox.enqueue(input('seed', 'target-0'))).toEqual(seed)
    await mailbox.finish('seed', { status: 'cancelled' })
    expect(await mailbox.enqueue(input('one-more', 'fresh-target'))).toMatchObject({ status: 'pending' })
  }, 15_000)

  test('损坏消息或文件名不匹配时拒绝读取和恢复，不当成空队列', async () => {
    const mailbox = new TaskMailbox(root)
    await mailbox.enqueue(input())
    const file = join(root, 'message-1.json')
    writeFileSync(file, '{broken')
    await expect(mailbox.get('message-1')).rejects.toThrow()
    await expect(mailbox.pending()).rejects.toThrow()
    await expect(mailbox.recover()).rejects.toThrow()
    writeFileSync(file, JSON.stringify({ ...input(), version: 1, status: 'pending', turnId: 't1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), id: 'wrong' }))
    await expect(mailbox.get('message-1')).rejects.toThrow(/file name/)
  })

  test('拒绝目录链接、父目录链接、消息链接与硬链接，不改动链接目标', async () => {
    const destination = join(dir, 'destination')
    mkdirSync(destination)
    const sentinel = join(destination, 'sentinel.txt')
    writeFileSync(sentinel, 'untouched')
    const linked = join(dir, 'linked')
    symlinkSync(destination, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new TaskMailbox(linked).enqueue(input())).rejects.toThrow(/links/)
    await expect(new TaskMailbox(join(linked, 'nested')).enqueue(input())).rejects.toThrow(/links/)
    expect(readdirSync(destination)).toEqual(['sentinel.txt'])
    mkdirSync(root)
    const messagePath = join(root, 'message-1.json')
    // Windows 文件符号链接需要额外权限；junction 也走同一拒绝 reparse point 的分支。
    symlinkSync(process.platform === 'win32' ? destination : sentinel, messagePath, process.platform === 'win32' ? 'junction' : 'file')
    await expect(new TaskMailbox(root).get('message-1')).rejects.toThrow(/regular/)
    await expect(new TaskMailbox(root).enqueue(input())).rejects.toThrow(/regular/)
    rmSync(messagePath)
    linkSync(sentinel, messagePath)
    await expect(new TaskMailbox(root).get('message-1')).rejects.toThrow(/regular/)
    await expect(new TaskMailbox(root).enqueue(input())).rejects.toThrow(/regular/)
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched')
  })
})

function storedTurn(id = 'target-turn', reply = '指定消息的结果'): StoredTurn {
  return { id, kind: 'prompt', prompt: `执行 ${id}`, startedAt: '2026-11-17T00:00:00.000Z', endedAt: '2026-11-17T00:01:00.000Z', stopReason: 'end_turn', skills: [], images: [], updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }] }
}

function taskSession(id = 'source', from?: TaskSource): Session {
  // runTaskTool 只读取这些会话字段；无需启动模型或真实 Session 环境。
  return { id, title: id, cwd: dir, noProject: false, permissionMode: 'ask', turns: [{ ...storedTurn(`${id}-turn`), ...(from ? { from } : {}) }] } as Session
}

function taskIO(tasks: TaskBridge, choice: string | null = PERMISSION_OPTIONS.allowOnce) {
  return {
    tasks,
    update: vi.fn<TurnIO['update']>().mockResolvedValue(undefined),
    requestPermission: vi.fn<TurnIO['requestPermission']>().mockResolvedValue(choice),
    recordUsage: vi.fn<TurnIO['recordUsage']>().mockResolvedValue(undefined),
  } satisfies TurnIO
}

function taskBridge(): TaskBridge {
  const result = { ok: true as const, sessionId: 'target', title: '目标任务', queued: true, messageId: 'receipt-1', turnId: 'target-turn' }
  return {
    list: async () => [],
    record: vi.fn<TaskBridge['record']>().mockResolvedValue({ title: '目标任务', cwd: dir, running: false, turns: [storedTurn()] }),
    act: vi.fn<TaskBridge['act']>().mockResolvedValue(result),
  }
}

async function taskCall(session: Session, io: TurnIO, toolName: keyof typeof TASK_TOOLS, input: unknown, signal = new AbortController().signal): Promise<ToolResultPart> {
  return (await runTaskTool(session, { toolCallId: `${toolName}-call`, toolName, input, invalid: null }, signal, io)).result
}

function resultText(result: ToolResultPart): string {
  expect(result.output.type === 'text' || result.output.type === 'error-text').toBe(true)
  if (result.output.type === 'text' || result.output.type === 'error-text') return result.output.value
  throw new Error('Expected a task tool text result')
}

describe('持久消息任务工具', () => {
  test.each(['task_send', 'task_create', 'task_reply'] as const)('%s 在确认后发出，返回消息 id、轮次 id 和精确等待方式', async (name) => {
    const session = taskSession('source', name === 'task_reply' ? { sessionId: 'target', title: '发送者' } : undefined)
    const bridge = taskBridge()
    const io = taskIO(bridge)
    const result = await taskCall(session, io, name, { task_id: 'target', message: '请完成测试' })
    expect(result.output.type).toBe('text')
    expect(resultText(result)).toContain('Message id: receipt-1')
    expect(resultText(result)).toContain('Turn id: target-turn')
    expect(resultText(result)).toContain('task_id="target" and message_id="receipt-1"')
    expect(io.requestPermission).toHaveBeenCalledOnce()
    expect(bridge.act).toHaveBeenCalledOnce()
    expect(io.requestPermission.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bridge.act).mock.invocationCallOrder[0] ?? 0)
    expect(bridge.act).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'source', action: name === 'task_create' ? 'create' : 'send', from: { sessionId: 'source', title: 'source', ...(name === 'task_reply' ? { reply: true } : {}) } }))
  })

  test('旧 act 返回值不带消息 id 仍可发送；拒绝权限不产生消息', async () => {
    const bridge = taskBridge()
    vi.mocked(bridge.act).mockResolvedValue({ ok: true, sessionId: 'target', title: '目标任务', queued: false })
    const allowed = await taskCall(taskSession(), taskIO(bridge), 'task_send', { task_id: 'target', message: '旧桥接' })
    expect(allowed.output.type).toBe('text')
    expect(resultText(allowed)).not.toContain('Message id:')
    vi.mocked(bridge.act).mockClear()
    const rejected = await taskCall(taskSession(), taskIO(bridge, PERMISSION_OPTIONS.reject), 'task_send', { task_id: 'target', message: '不发送' })
    expect(rejected.output.type).toBe('error-text')
    expect(bridge.act).not.toHaveBeenCalled()
  })

  test('完整权限下已经取消的工具也不发送', async () => {
    const session = taskSession()
    session.permissionMode = 'full'
    const bridge = taskBridge()
    const controller = new AbortController()
    controller.abort()
    const result = await taskCall(session, taskIO(bridge), 'task_send', { task_id: 'target', message: '不能发送' }, controller.signal)
    expect(resultText(result)).toContain('Cancelled')
    expect(bridge.act).not.toHaveBeenCalled()
  })

  test('receipt 完成后只读绑定 turnId，即使目标又在运行或已有更新结果', async () => {
    const bridge = taskBridge()
    vi.mocked(bridge.record).mockResolvedValue({ title: '目标任务', cwd: dir, running: true, turns: [storedTurn(), storedTurn('newer-turn', '无关的最新回复')] })
    bridge.receipt = vi.fn<NonNullable<TaskBridge['receipt']>>().mockResolvedValue({ id: 'receipt-1', targetSessionId: 'target', turnId: 'target-turn', status: 'completed' })
    const result = await taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target', message_id: 'receipt-1' })
    expect(result.output.type).toBe('text')
    expect(resultText(result)).toContain('指定消息的结果')
    expect(resultText(result)).not.toContain('无关的最新回复')
    expect(bridge.receipt).toHaveBeenCalledWith('receipt-1')
  })

  test('pending 回执不会因目标空闲而误判完成，之后读取该消息对应轮次', async () => {
    vi.useFakeTimers()
    const bridge = taskBridge()
    const receipt = vi.fn<NonNullable<TaskBridge['receipt']>>()
      .mockResolvedValueOnce({ id: 'receipt-1', targetSessionId: 'target', turnId: 'target-turn', status: 'pending' })
      .mockResolvedValue({ id: 'receipt-1', targetSessionId: 'target', turnId: 'target-turn', status: 'completed' })
    bridge.receipt = receipt
    const waiting = taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target', message_id: 'receipt-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(receipt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(resultText(await waiting)).toContain('指定消息的结果')
    expect(receipt).toHaveBeenCalledTimes(2)
  })

  test.each(['failed', 'cancelled', 'interrupted'])('消息终态 %s 明确失败，不返回最新回复', async (status) => {
    const bridge = taskBridge()
    bridge.receipt = async () => ({ id: 'receipt-1', targetSessionId: 'target', turnId: 'target-turn', status, error: '不能自动重试' })
    const result = await taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target', message_id: 'receipt-1' })
    expect(result.output.type).toBe('error-text')
    expect(resultText(result)).toContain(status)
    expect(resultText(result)).toContain('不能自动重试')
    expect(resultText(result)).not.toContain('指定消息的结果')
  })

  test('有 message_id 但无 receipt 支持、回执缺失或目标不匹配时拒绝降级', async () => {
    for (const receipt of [
      undefined,
      async () => null,
      async () => ({ id: 'wrong', targetSessionId: 'target', turnId: 'target-turn', status: 'completed' }),
      async () => ({ id: 'receipt-1', targetSessionId: 'another-target', turnId: 'target-turn', status: 'completed' }),
      async () => ({ id: 'receipt-1', targetSessionId: 'target', turnId: '', status: 'completed' }),
    ]) {
      const bridge = { ...taskBridge(), receipt }
      const result = await taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target', message_id: 'receipt-1' })
      expect(result.output.type).toBe('error-text')
      expect(resultText(result)).not.toContain('指定消息的结果')
    }
  })

  test('回执对应轮次缺失或未结束时不读其他轮次', async () => {
    for (const turns of [[storedTurn('other-turn', '不能返回的回复')], [{ ...storedTurn(), endedAt: null }, storedTurn('other-turn', '不能返回的回复')]]) {
      const bridge = taskBridge()
      vi.mocked(bridge.record).mockResolvedValue({ title: '目标任务', cwd: dir, running: false, turns })
      bridge.receipt = async () => ({ id: 'receipt-1', targetSessionId: 'target', turnId: 'target-turn', status: 'completed' })
      const result = await taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target', message_id: 'receipt-1' })
      expect(result.output.type).toBe('error-text')
      expect(resultText(result)).toContain('no other turn was read')
      expect(resultText(result)).not.toContain('不能返回的回复')
    }
  })

  test('等待时轮次 id 发生变化会拒绝，不将回执换绑到其他轮次', async () => {
    vi.useFakeTimers()
    const bridge = taskBridge()
    bridge.receipt = vi.fn<NonNullable<TaskBridge['receipt']>>()
      .mockResolvedValueOnce({ id: 'receipt-1', targetSessionId: 'target', turnId: 'target-turn', status: 'running' })
      .mockResolvedValue({ id: 'receipt-1', targetSessionId: 'target', turnId: 'other-turn', status: 'completed' })
    const waiting = taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target', message_id: 'receipt-1' })
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await waiting
    expect(result.output.type).toBe('error-text')
    expect(resultText(result)).toContain('does not match')
  })

  test('不带 message_id 保留旧轮询兼容，读目标最新一轮', async () => {
    const bridge = taskBridge()
    vi.mocked(bridge.record).mockResolvedValueOnce({ title: '目标任务', cwd: dir, running: true, turns: [] })
    bridge.receipt = vi.fn()
    const result = await taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'target' })
    expect(result.output.type).toBe('text')
    expect(resultText(result)).toContain('指定消息的结果')
    expect(bridge.receipt).not.toHaveBeenCalled()
  })

  test('拒绝等待自己，不访问桥接', async () => {
    const bridge = taskBridge()
    const result = await taskCall(taskSession(), taskIO(bridge), 'task_wait', { task_id: 'source' })
    expect(resultText(result)).toContain('cannot wait for yourself')
    expect(bridge.record).not.toHaveBeenCalled()
  })

  test('检测多任务等待循环，取消后 finally 释放边', async () => {
    const bridge = taskBridge()
    const firstRead = deferred()
    vi.mocked(bridge.record).mockImplementation(async () => {
      firstRead.resolve()
      return { title: '忙碌任务', cwd: dir, running: true, turns: [] }
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = taskCall(taskSession('a'), taskIO(bridge), 'task_wait', { task_id: 'b' }, firstController.signal)
    let second: Promise<ToolResultPart> | undefined
    try {
      await firstRead.promise
      second = taskCall(taskSession('b'), taskIO(bridge), 'task_wait', { task_id: 'c' }, secondController.signal)
      const cycle = await taskCall(taskSession('c'), taskIO(bridge), 'task_wait', { task_id: 'a' })
      expect(resultText(cycle)).toContain('task_wait cycle')
    } finally {
      firstController.abort()
      secondController.abort()
      expect(resultText(await first)).toContain('Cancelled')
      if (second) expect(resultText(await second)).toContain('Cancelled')
    }
    vi.mocked(bridge.record).mockResolvedValue({ title: '已结束', cwd: dir, running: false, turns: [storedTurn()] })
    bridge.receipt = async () => ({ id: 'receipt-1', targetSessionId: 'a', turnId: 'target-turn', status: 'completed' })
    expect((await taskCall(taskSession('b'), taskIO(bridge), 'task_wait', { task_id: 'a', message_id: 'receipt-1' })).output.type).toBe('text')
  })

  test('等待超时和读取异常都会释放图的边', async () => {
    vi.useFakeTimers()
    const bridge = taskBridge()
    vi.mocked(bridge.record).mockResolvedValue({ title: '等待中', cwd: dir, running: true, turns: [] })
    const waiting = taskCall(taskSession('a'), taskIO(bridge), 'task_wait', { task_id: 'b', max_minutes: 1 })
    await vi.advanceTimersByTimeAsync(62_000)
    expect(resultText(await waiting)).toContain('has not finished')
    vi.mocked(bridge.record).mockRejectedValueOnce(new Error('record failed'))
    expect(resultText(await taskCall(taskSession('a'), taskIO(bridge), 'task_wait', { task_id: 'b' }))).toContain('record failed')
    vi.mocked(bridge.record).mockResolvedValue({ title: '结束', cwd: dir, running: false, turns: [storedTurn()] })
    bridge.receipt = async () => ({ id: 'receipt-1', targetSessionId: 'a', turnId: 'target-turn', status: 'completed' })
    expect((await taskCall(taskSession('b'), taskIO(bridge), 'task_wait', { task_id: 'a', message_id: 'receipt-1' })).output.type).toBe('text')
  })

  test('同一个任务并行等待相同目标时，一次取消不能释放仍在使用的等待边', async () => {
    const bridge = taskBridge()
    const entered = deferred()
    vi.mocked(bridge.record).mockImplementation(async () => {
      entered.resolve()
      return { title: '运行中', cwd: dir, running: true, turns: [] }
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = taskCall(taskSession('a'), taskIO(bridge), 'task_wait', { task_id: 'b' }, firstController.signal)
    const second = taskCall(taskSession('a'), taskIO(bridge), 'task_wait', { task_id: 'b' }, secondController.signal)
    try {
      await entered.promise
      firstController.abort()
      expect(resultText(await first)).toContain('Cancelled')
      expect(resultText(await taskCall(taskSession('b'), taskIO(bridge), 'task_wait', { task_id: 'a' }))).toContain('task_wait cycle')
    } finally {
      firstController.abort()
      secondController.abort()
      await first
      await second
    }
  })

  test('每轮发送上限、来源限制和只回复一次保持不变', async () => {
    const bridge = taskBridge()
    const session = taskSession()
    const io = taskIO(bridge)
    for (let index = 0; index < MAX_TASK_ACTIONS_PER_TURN; index += 1) expect((await taskCall(session, io, 'task_send', { task_id: 'target', message: '限额内' })).output.type).toBe('text')
    expect(resultText(await taskCall(session, io, 'task_send', { task_id: 'target', message: '超限' }))).toContain(`At most ${MAX_TASK_ACTIONS_PER_TURN}`)
    expect(bridge.act).toHaveBeenCalledTimes(MAX_TASK_ACTIONS_PER_TURN)
    const received = taskSession('recipient', { sessionId: 'target', title: '发送者' })
    expect(resultText(await taskCall(received, io, 'task_send', { task_id: 'target', message: '不能转发' }))).toContain('cannot send to or create tasks')
    expect(resultText(await taskCall(received, io, 'task_create', { message: '不能新建' }))).toContain('cannot send to or create tasks')
    expect((await taskCall(received, io, 'task_reply', { message: '回复一次' })).output.type).toBe('text')
    expect(resultText(await taskCall(received, io, 'task_reply', { message: '再次回复' }))).toContain('already replied')
    const replyTurn = taskSession('reply-recipient', { sessionId: 'target', title: '发送者', reply: true })
    expect(resultText(await taskCall(replyTurn, io, 'task_reply', { message: '回复的回复' }))).toContain('do not reply to a reply')
  })

  test('目标仍在运行时不发送 task_reply，保留旧防重复启发式', async () => {
    const bridge = taskBridge()
    vi.mocked(bridge.record).mockResolvedValue({ title: '正在等待', cwd: dir, running: true, turns: [] })
    const result = await taskCall(taskSession('source', { sessionId: 'target', title: '发送者' }), taskIO(bridge), 'task_reply', { message: '多余回复' })
    expect(resultText(result)).toContain('most likely waiting')
    expect(bridge.act).not.toHaveBeenCalled()
  })
})
