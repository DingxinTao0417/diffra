import { PERMISSION_OPTIONS } from '@diffra/core/types'
import { z } from 'zod'

// 设备连接的应用层协议（加密通道里跑的 JSON）。对方发来的一律按这里校验，不合格就断开；
// 轮次、会话更新是 ACP 的结构，只校验外层和大小，内容交给界面原有的渲染逻辑。
// 被连接端 = host，连接端 = 看和操作的那一台。版本号写进 Noise 的 prologue，版本不一致握手就失败

export const REMOTE_PROTOCOL = 1
// 界面也引用这个文件（只用类型），不用 Node 的 Buffer
export const REMOTE_PROLOGUE = new TextEncoder().encode(`diffra-remote/${REMOTE_PROTOCOL}`)

// 会话 id 的格式和会话存储一致（packages/core/src/session/store.ts）
const sessionId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
// 项目在两端之间只用不透明的 id，不发本机路径
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const requestId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const isoTime = z.iso.datetime({ offset: true })
// 32 字节的 base64 正好 44 个字符、末尾一个 =
const key32 = z.base64().refine((value) => value.length === 44 && value.endsWith('=') && !value.endsWith('=='), '要 32 字节')
const skills = z.array(z.string().min(1).max(100)).max(20)
const promptText = z.string().trim().min(1).max(100_000)
// 远程只能「允许一次」或「拒绝」，不给「始终允许」
const remotePermissionOption = z.enum([PERMISSION_OPTIONS.allowOnce, PERMISSION_OPTIONS.reject])

// ACP 的会话更新：只认外层
const sessionUpdate = z.looseObject({ sessionUpdate: z.string().min(1).max(64) })
const storedTurn = z.looseObject({
  id: z.string().min(1).max(128),
  kind: z.string().max(32),
  prompt: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  updates: z.array(sessionUpdate),
})
const taskState = z.object({
  status: z.enum(['running', 'waiting', 'blocked', 'cancelled', 'completed']),
  reason: z.string().max(2000).nullable(),
  requirements: z.array(z.object({ id: z.string().max(80), title: z.string().max(300), receiptId: z.string().nullable() })).max(20),
  needsVerification: z.boolean().optional(),
})

// 握手完成后两边各先发一条
export const helloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  appVersion: z.string().max(40),
  name: z.string().trim().min(1).max(60),
  // Ed25519 公钥：和握手里的 X25519 长期公钥一起算出设备 ID
  signingKey: key32,
})

// 连接端发的请求
export const requestCallSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('sessions.list') }),
  // 带上次看到的位置时，被连接端能续传就只补发缺的，否则给快照
  z.object({ method: z.literal('session.subscribe'), sessionId, resume: z.object({ epoch: z.string().max(64), seq: z.number().int().nonnegative() }).optional() }),
  z.object({ method: z.literal('session.page'), sessionId, before: z.number().int().nonnegative() }),
  z.object({ method: z.literal('session.unsubscribe'), sessionId }),
  z.object({ method: z.literal('session.prompt'), sessionId, text: promptText, skills }),
  z.object({ method: z.literal('session.create'), projectId, text: promptText, skills }),
  z.object({ method: z.literal('session.cancel'), sessionId }),
  z.object({ method: z.literal('permission.respond'), requestId, optionId: remotePermissionOption.nullable() }),
])

export const requestSchema = z.object({ type: z.literal('request'), id: z.number().int().nonnegative(), call: requestCallSchema })

export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('response'), id: z.number().int().nonnegative(), ok: z.literal(true), value: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.number().int().nonnegative(), ok: z.literal(false), error: z.string().max(2000) }),
])

// 各请求成功时 value 的格式
export const sessionListSchema = z.object({
  projects: z.array(z.object({ id: projectId, name: z.string().max(200), level: z.enum(['view', 'control']) })).max(200),
  sessions: z
    .array(z.object({ sessionId, projectId, title: z.string().max(200), updatedAt: z.string(), running: z.boolean(), turnCount: z.number().int().nonnegative() }))
    .max(2000),
})

// 一页轮次（订阅、往前翻页都回它）；对应 core 的 RemoteSnapshot，cwd 换成项目 id
export const snapshotSchema = z.object({
  sessionId,
  projectId,
  title: z.string().max(200),
  running: z.boolean(),
  taskState: taskState.optional(),
  totalTurns: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  turns: z.array(storedTurn).max(50),
  epoch: z.string().max(64),
  seq: z.number().int().nonnegative(),
})

export const okSchema = z.object({})

// 被连接端主动推的
export const eventSchema = z.discriminatedUnion('event', [
  // 实时更新按批发：中转限每台设备每秒 50 帧，流式输出一秒几十个片段，逐条发会超限被断开
  z.object({
    type: z.literal('event'),
    event: z.literal('session.updates'),
    sessionId,
    epoch: z.string().max(64),
    updates: z.array(z.object({ seq: z.number().int().positive(), update: sessionUpdate })).min(1).max(500),
  }),
  // 一轮开始（会话更新里没有这一项，界面是自己建新一轮的）
  z.object({ type: z.literal('event'), event: z.literal('turn.started'), sessionId, turnId: z.string().min(1).max(128), kind: z.string().max(32), prompt: z.string(), startedAt: isoTime }),
  // 撤销、重新生成这类改了整段记录的：重新订阅
  z.object({ type: z.literal('event'), event: z.literal('session.reset'), sessionId }),
  z.object({ type: z.literal('event'), event: z.literal('sessions.changed') }),
  z.object({
    type: z.literal('event'),
    event: z.literal('permission.request'),
    requestId,
    sessionId,
    toolCall: z.looseObject({ toolCallId: z.string().max(128), title: z.string().max(2000).optional() }),
  }),
  z.object({ type: z.literal('event'), event: z.literal('permission.settled'), requestId }),
  // 配对时被连接端的用户点了允许或拒绝
  z.object({ type: z.literal('event'), event: z.literal('pair.result'), approved: z.boolean() }),
])

export const remoteMessageSchema = z.union([helloSchema, requestSchema, responseSchema, eventSchema])

export type Hello = z.infer<typeof helloSchema>
export type RequestCall = z.infer<typeof requestCallSchema>
export type RemoteRequest = z.infer<typeof requestSchema>
export type RemoteResponse = z.infer<typeof responseSchema>
export type RemoteEvent = z.infer<typeof eventSchema>
export type RemoteMessage = z.infer<typeof remoteMessageSchema>
export type SessionList = z.infer<typeof sessionListSchema>
export type RemoteSnapshotPage = z.infer<typeof snapshotSchema>
