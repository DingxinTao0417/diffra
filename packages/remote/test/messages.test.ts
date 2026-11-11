import { describe, expect, test } from 'vitest'
import {
  createResultSchema,
  eventSchema,
  helloSchema,
  promptResultSchema,
  REMOTE_PROLOGUE,
  remoteMessageSchema,
  requestSchema,
  responseSchema,
  sessionListSchema,
  snapshotSchema,
  subscribeResultSchema,
} from '../src/messages.js'
import { seeded } from './random.js'

const KEY = Buffer.alloc(32, 1).toString('base64')
const SESSION = '3f2b6c1e-8a4d-4f1a-9c3b-2d7e5f6a8b9c'
const turn = { id: 'turn-1', kind: 'prompt', prompt: '你好', startedAt: '2026-11-10T08:00:00.000Z', endedAt: null, stopReason: null, updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } }], skills: [], images: [] }

describe('应用层消息', () => {
  test('协议版本写在 prologue 里', () => {
    expect(new TextDecoder().decode(REMOTE_PROLOGUE)).toBe('diffra-remote/1')
  })

  test('每种消息的正常样子都能通过', () => {
    const valid = [
      { type: 'hello', protocol: 1, appVersion: '0.3.0', name: '艾特的台式机', signingKey: KEY },
      { type: 'request', id: 1, call: { method: 'sessions.list' } },
      { type: 'request', id: 2, call: { method: 'session.subscribe', sessionId: SESSION } },
      { type: 'request', id: 3, call: { method: 'session.subscribe', sessionId: SESSION, resume: { epoch: 'e1', seq: 12 } } },
      { type: 'request', id: 4, call: { method: 'session.page', sessionId: SESSION, before: 10 } },
      { type: 'request', id: 5, call: { method: 'session.unsubscribe', sessionId: SESSION } },
      { type: 'request', id: 6, call: { method: 'session.prompt', sessionId: SESSION, text: '继续', skills: [] } },
      { type: 'request', id: 7, call: { method: 'session.create', projectId: 'p_1', text: '新任务', skills: ['review'] } },
      { type: 'request', id: 8, call: { method: 'session.cancel', sessionId: SESSION } },
      { type: 'request', id: 9, call: { method: 'permission.respond', requestId: 'r-1', optionId: 'allow_once' } },
      { type: 'request', id: 10, call: { method: 'permission.respond', requestId: 'r-1', optionId: null } },
      { type: 'response', id: 1, ok: true, value: { anything: true } },
      { type: 'response', id: 2, ok: false, error: '没有授权' },
      { type: 'event', event: 'session.updates', sessionId: SESSION, epoch: 'e1', updates: [{ seq: 13, update: { sessionUpdate: 'tool_call', toolCallId: 't1' } }] },
      { type: 'event', event: 'turn.started', sessionId: SESSION, turnId: 'turn-2', kind: 'prompt', prompt: '继续', startedAt: '2026-11-10T08:01:00.000Z' },
      { type: 'event', event: 'turn.started', sessionId: SESSION, turnId: 'turn-3', kind: 'prompt', prompt: '远程发的', startedAt: '2026-11-10T08:02:00.000Z', remote: { deviceId: 'ab'.repeat(16), name: '同事的电脑' } },
      { type: 'event', event: 'turn.started', sessionId: SESSION, turnId: 'turn-4', kind: 'prompt', prompt: '别的任务发的', startedAt: '2026-11-10T08:03:00.000Z', from: { sessionId: SESSION, title: '上游' } },
      { type: 'event', event: 'session.reset', sessionId: SESSION },
      { type: 'event', event: 'sessions.changed' },
      {
        type: 'event',
        event: 'permission.request',
        requestId: 'r-1',
        sessionId: SESSION,
        toolCall: { toolCallId: 't1', title: '执行 pnpm test', kind: 'execute' },
        options: [
          { optionId: 'allow_once', name: '允许一次' },
          { optionId: 'reject', name: '拒绝' },
        ],
      },
      { type: 'event', event: 'permission.settled', requestId: 'r-1' },
      { type: 'event', event: 'pair.result', approved: true },
      { type: 'event', event: 'pair.cancel' },
      { type: 'request', id: 11, call: { method: 'device.forget' } },
    ]
    for (const message of valid) expect(remoteMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true)
    expect(sessionListSchema.safeParse({ projects: [{ id: 'p_1', name: 'diffra', level: 'control' }], sessions: [{ sessionId: SESSION, projectId: 'p_1', title: '任务', updatedAt: '2026-11-10T08:00:00.000Z', running: false, turnCount: 3 }] }).success).toBe(true)
    expect(snapshotSchema.safeParse({ sessionId: SESSION, projectId: 'p_1', title: '任务', running: true, taskState: { status: 'running', reason: null, requirements: [] }, totalTurns: 1, start: 0, turns: [turn], epoch: 'e1', seq: 5 }).success).toBe(true)
    expect(promptResultSchema.safeParse({ queued: true }).success).toBe(true)
    expect(subscribeResultSchema.safeParse({ resumed: true, sessionId: SESSION, running: false }).success).toBe(true)
    expect(subscribeResultSchema.safeParse({ resumed: false, sessionId: SESSION, running: false }).success).toBe(false)
    expect(createResultSchema.safeParse({ sessionId: SESSION }).success).toBe(true)
    expect(createResultSchema.safeParse({ sessionId: '../x' }).success).toBe(false)
  })

  test('越权、越界、格式不对的都拒绝', () => {
    const invalid = [
      // 会话 id 里带路径
      { type: 'request', id: 1, call: { method: 'session.cancel', sessionId: '../secrets' } },
      // 远程不给「始终允许」
      { type: 'request', id: 1, call: { method: 'permission.respond', requestId: 'r-1', optionId: 'allow_always' } },
      // 不认识的方法（比如想撤销）
      { type: 'request', id: 1, call: { method: 'session.rewind', sessionId: SESSION } },
      // 新建任务只收项目 id，不收路径
      { type: 'request', id: 1, call: { method: 'session.create', projectId: 'C:\\Users\\me\\repo', text: '新任务', skills: [] } },
      { type: 'request', id: 1, call: { method: 'session.prompt', sessionId: SESSION, text: '   ', skills: [] } },
      { type: 'request', id: 1, call: { method: 'session.prompt', sessionId: SESSION, text: 'x'.repeat(100_001), skills: [] } },
      { type: 'request', id: -1, call: { method: 'sessions.list' } },
      { type: 'hello', protocol: 1, appVersion: '0.3.0', name: '台式机', signingKey: Buffer.alloc(16).toString('base64') },
      { type: 'hello', protocol: 1, appVersion: '0.3.0', name: '', signingKey: KEY },
      { type: 'event', event: 'session.updates', sessionId: SESSION, epoch: 'e1', updates: [{ seq: 0, update: { sessionUpdate: 'tool_call' } }] },
      { type: 'event', event: 'session.updates', sessionId: SESSION, epoch: 'e1', updates: [{ seq: 1, update: { content: 'no kind' } }] },
      { type: 'event', event: 'session.updates', sessionId: SESSION, epoch: 'e1', updates: [] },
      // 权限请求只能给「允许一次」「拒绝」两个选项，至少一个
      { type: 'event', event: 'permission.request', requestId: 'r-1', sessionId: SESSION, toolCall: { toolCallId: 't1' }, options: [{ optionId: 'allow_always', name: '始终允许' }] },
      { type: 'event', event: 'permission.request', requestId: 'r-1', sessionId: SESSION, toolCall: { toolCallId: 't1' }, options: [] },
      { type: 'event', event: 'turn.started', sessionId: SESSION, turnId: 't', kind: 'prompt', prompt: 'x', startedAt: '2026-11-10T08:01:00.000Z', remote: { deviceId: 'not-a-device', name: 'x' } },
      { type: 'event', event: 'unknown' },
      { type: 'bye' },
    ]
    for (const message of invalid) expect(remoteMessageSchema.safeParse(message).success, JSON.stringify(message).slice(0, 120)).toBe(false)
    expect(snapshotSchema.safeParse({ sessionId: SESSION, projectId: 'p_1', title: '任务', running: false, totalTurns: 51, start: 0, turns: Array(51).fill(turn), epoch: 'e1', seq: 0 }).success).toBe(false)
    expect(responseSchema.safeParse({ type: 'response', id: 1, ok: false, value: 1 }).success).toBe(false)
  })

  test('随机 JSON 只会校验不过，不会抛错', () => {
    const next = seeded(7)
    const randomValue = (depth: number): unknown => {
      const pick = Math.floor(next() * 7)
      if (depth > 3 || pick === 0) return null
      if (pick === 1) return next() > 0.5
      if (pick === 2) return Math.floor(next() * 2000) - 1000
      if (pick === 3) return ['hello', 'request', 'response', 'event', SESSION, '../x', ''][Math.floor(next() * 7)]
      if (pick === 4) return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(depth + 1))
      const keys = ['type', 'id', 'call', 'method', 'event', 'sessionId', 'ok', 'value', 'update', 'seq', 'epoch']
      return Object.fromEntries(Array.from({ length: Math.floor(next() * 6) }, () => [keys[Math.floor(next() * keys.length)]!, randomValue(depth + 1)]))
    }
    for (let round = 0; round < 3000; round++) {
      const value = randomValue(0)
      for (const schema of [remoteMessageSchema, helloSchema, requestSchema, responseSchema, eventSchema, sessionListSchema, snapshotSchema]) expect(() => schema.safeParse(value)).not.toThrow()
    }
  })
})
