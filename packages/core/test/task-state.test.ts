import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { taskStateView } from '../src/session/loop.js'
import { SessionStore } from '../src/session/store.js'
import { newTaskState, recordedTaskState, taskProgressViewSchema, taskStateSchema } from '../src/session/task-state.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffra-task-state-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 旧格式（version 1）的会话文件，taskState 原样写进去
function writeOldRecord(id: string, taskState: unknown) {
  mkdirSync(dir, { recursive: true })
  const record = { version: 1, id, cwd: dir, title: '发布', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false, turns: [], messages: [], compaction: null, taskState }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record))
}

test('新任务状态：运行中、没有待验证、没有原因', () => {
  expect(newTaskState()).toEqual({ status: 'running', needsVerification: false, reason: null })
})

test('旧会话文件里的完成条件、证据、发版契约读进来时丢掉，状态、原因和待验证保留', async () => {
  writeOldRecord('legacy', {
    status: 'waiting',
    reason: '等待 CI 123',
    needsVerification: true,
    requirements: [{ id: 'ci', title: '等待 CI', commandIncludes: 'gh run view', outputIncludes: 'success', receiptId: 'receipt' }],
    receipts: [{ id: 'receipt', command: 'gh run view 123', output: 'running' }],
    contractRequired: true,
    releaseVersion: '0.1.2',
  })
  const store = new SessionStore(dir)
  const loaded = await store.load('legacy')
  expect(loaded.taskState).toEqual({ status: 'waiting', reason: '等待 CI 123', needsVerification: true })

  // 再存一次，文件里也不再有这些字段
  await store.save(loaded)
  expect((await new SessionStore(dir).load('legacy')).taskState).toEqual({ status: 'waiting', reason: '等待 CI 123', needsVerification: true })
})

test('更早的记录没有待验证时按 false 读；没有 taskState 的记录照样能读', async () => {
  writeOldRecord('no-verification', { status: 'blocked', reason: '这一轮没有走完就停了', requirements: [] })
  const store = new SessionStore(dir)
  expect((await store.load('no-verification')).taskState).toEqual({ status: 'blocked', reason: '这一轮没有走完就停了', needsVerification: false })

  writeOldRecord('no-state', undefined)
  expect((await store.load('no-state')).taskState).toBeUndefined()

  // 状态不认识的整条记录算损坏，不是悄悄换成别的状态
  expect(taskStateSchema.safeParse({ status: 'released', reason: null }).success).toBe(false)
})

test('轮次里记下的任务状态更新：取出待验证；旧记录没有这个字段算 false；别的更新不是任务状态', () => {
  expect(recordedTaskState({ diffra: { taskState: { status: 'running', reason: null, requirements: [], needsVerification: true } } })).toEqual({ needsVerification: true })
  expect(recordedTaskState({ diffra: { taskState: { status: 'running', reason: null, requirements: [], needsVerification: false } } })).toEqual({ needsVerification: false })
  expect(recordedTaskState({ diffra: { taskState: { status: 'completed', reason: null, requirements: [] } } })).toEqual({ needsVerification: false })

  expect(recordedTaskState({ diffra: { turnOutcome: { finish: null, stop: null } } })).toBeNull()
  expect(recordedTaskState({ diffra: {} })).toBeNull()
  expect(recordedTaskState({})).toBeNull()
  expect(recordedTaskState(null)).toBeNull()
  expect(recordedTaskState(undefined)).toBeNull()
})

test('发给客户端的任务状态：完成条件恒为空，旧客户端按原来的形状校验能通过', () => {
  const view = taskStateView({ taskState: { status: 'blocked', reason: '文件已撤销，之前轮次的改动还没验证。', needsVerification: true } })
  expect(view).toEqual({ status: 'blocked', reason: '文件已撤销，之前轮次的改动还没验证。', requirements: [], needsVerification: true })
  expect(taskProgressViewSchema.parse(view)).toEqual(view)

  // 内存里的状态就算还带着旧字段（比如直接从旧对象拷过来），也不会发出去
  const legacy = { status: 'running' as const, reason: null, needsVerification: false, requirements: [{ id: 'ci', title: 'CI', receiptId: null }] }
  expect(taskStateView({ taskState: legacy })).toEqual({ status: 'running', reason: null, requirements: [], needsVerification: false })
})
