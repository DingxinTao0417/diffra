import { PERMISSION_OPTIONS, PROMPT_IMAGE_TYPES, REASONING_EFFORTS } from '@diffra/core/types'
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
const deviceId = z.string().regex(/^[0-9a-f]{32}$/)
const isoTime = z.iso.datetime({ offset: true })
// 32 字节的 base64 正好 44 个字符、末尾一个 =
const key32 = z.base64().refine((value) => value.length === 44 && value.endsWith('=') && !value.endsWith('=='), '要 32 字节')
const skills = z.array(z.string().min(1).max(100)).max(20)
const promptText = z.string().trim().min(1).max(100_000)
// 远程只能「允许一次」或「拒绝」，不给「始终允许」
// 确认里远程能选的：允许一次、拒绝；提问（ask_user，第 673 步起可操作的设备也能答）的选项、提交、不答
const remotePermissionOption = z.union([z.enum([PERMISSION_OPTIONS.allowOnce, PERMISSION_OPTIONS.reject]), z.string().regex(/^ask-user-(?:option-\d{1,2}|submit|skip)$/)])
// 提问的答案：这里只限形状和大小，内容由 core 按问题逐个校验
export const askAnswersSchema = z
  .array(z.union([z.object({ choice: z.array(z.number().int().nonnegative().max(99)).max(10) }), z.object({ value: z.number().finite() }), z.object({ files: z.array(z.string().min(1).max(1000)).max(20) })]))
  .max(4)
const turnId = z.string().min(1).max(128)
const terminalId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const terminalSize = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) }
const modelRef = z.object({ providerId: z.string().min(1).max(200), modelId: z.string().min(1).max(200), reasoningEffort: z.enum(REASONING_EFFORTS).optional() })
// 远程发消息带的图片：连接端界面已经压成长边 1600 的 WebP（和本机发给模型的一样）
const promptImage = z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.base64().max(1_000_000) })

// ACP 的会话更新：只认外层
const sessionUpdate = z.looseObject({ sessionUpdate: z.string().min(1).max(64) })
// 同步过去的提问图片：被连接端压缩过（长边 1024 的 WebP），一张最多这么多 base64 字。界面拿它拼 data: 地址，类型只认图片
export const REMOTE_IMAGE_MAX_CHARS = 400_000
// 读取、执行、搜索这几类工具的文字输出，快照里只发开头这么多字；文字块的 _meta 里记全文多长（TOOL_PREVIEW_META_KEY），连接端展开时再要（session.toolOutput）
export const TOOL_PREVIEW_CHARS = 2000
const remoteImage = z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.base64().max(REMOTE_IMAGE_MAX_CHARS) })
const storedTurn = z.looseObject({
  id: z.string().min(1).max(128),
  kind: z.string().max(32),
  prompt: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  updates: z.array(sessionUpdate),
  images: z.array(remoteImage).max(6).optional(),
  // 没同步过去的图片张数（太大、超出这一页的额度、压不了）
  omittedImages: z.number().int().nonnegative().max(100).optional(),
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
  // 展开只发了开头的工具输出：turn 是这一轮在全部轮次里的位置，turnId 对不上（撤销、重新生成过）就不给
  z.object({ method: z.literal('session.toolOutput'), sessionId, turn: z.number().int().nonnegative(), turnId: z.string().min(1).max(128), toolCallId: z.string().min(1).max(128) }),
  // 任务页要的配置、模型、分支、检查命令（任务监控、输入框、底栏）
  z.object({ method: z.literal('session.details'), sessionId }),
  // 从某一轮开始到现在的文件改动（任务监控、审阅改动）
  z.object({ method: z.literal('session.diff'), sessionId, turnId }),
  // 以下是远程操作，项目要开放「可查看和操作」；权限模式切成 full（完全访问）要「完全控制」
  z.object({ method: z.literal('models.list') }),
  z.object({ method: z.literal('skills.list'), sessionId }),
  z.object({ method: z.literal('commands.list'), sessionId }),
  z.object({ method: z.literal('session.setModel'), sessionId, ref: modelRef }),
  z.object({ method: z.literal('session.setPermissionMode'), sessionId, mode: z.enum(['ask', 'auto', 'full']) }),
  z.object({ method: z.literal('session.compact'), sessionId }),
  z.object({ method: z.literal('session.regenerate'), sessionId, turnId }),
  z.object({ method: z.literal('session.restorePreview'), sessionId, turnId }),
  z.object({ method: z.literal('session.restore'), sessionId, turnId }),
  // 任务所在项目的本地分支、切换分支（对方有任务在跑、工作区有未提交的改动时不切）
  z.object({ method: z.literal('project.branches'), sessionId }),
  z.object({ method: z.literal('project.switchBranch'), sessionId, branch: z.string().min(1).max(200) }),
  // 以下要「完全控制」：在任务的项目目录里开终端（shell 本身不受项目限制）
  z.object({ method: z.literal('terminal.open'), sessionId, ...terminalSize }),
  z.object({ method: z.literal('terminal.input'), terminalId, data: z.string().min(1).max(64 * 1024) }),
  z.object({ method: z.literal('terminal.resize'), terminalId, ...terminalSize }),
  z.object({ method: z.literal('terminal.close'), terminalId }),
  z.object({ method: z.literal('session.unsubscribe'), sessionId }),
  // plan：先出计划；goal：按目标一直做到完成（和本机输入框一样）
  z.object({ method: z.literal('session.prompt'), sessionId, text: promptText, skills, plan: z.boolean().optional(), goal: z.boolean().optional(), images: z.array(promptImage).max(6).optional() }),
  z.object({ method: z.literal('session.create'), projectId, text: promptText, skills }),
  z.object({ method: z.literal('session.cancel'), sessionId }),
  z.object({ method: z.literal('permission.respond'), requestId, optionId: remotePermissionOption.nullable(), answers: askAnswersSchema.optional() }),
  // 连接端删除了这台设备：请被连接端也撤销对它的授权（只会收紧，照办）
  z.object({ method: z.literal('device.forget') }),
  // 待办同步（v2，接口版本 3 起）：连接端的待办和墓碑，被连接端合起来回整份。待办的格式由桌面端校验
  z.object({
    method: z.literal('todos.sync'),
    todos: z.array(z.unknown()).max(1000),
    deleted: z.array(z.object({ id: z.string().min(1).max(64), at: z.string().max(40) })).max(5000),
  }),
])

export const todosSyncResultSchema = z.object({
  todos: z.array(z.unknown()).max(1000),
  deleted: z.array(z.object({ id: z.string().min(1).max(64), at: z.string().max(40) })).max(5000),
})

export const requestSchema = z.object({ type: z.literal('request'), id: z.number().int().nonnegative(), call: requestCallSchema })

export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('response'), id: z.number().int().nonnegative(), ok: z.literal(true), value: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.number().int().nonnegative(), ok: z.literal(false), error: z.string().max(2000) }),
])

// 各请求成功时 value 的格式
export const sessionListSchema = z.object({
  // 被连接端的设备连接接口版本（shared/remote.ts 的 REMOTE_API），0.3.x 没有
  api: z.number().int().positive().optional(),
  // 「完全控制」的项目 level 也写 control，另带 full：0.3.x 的连接端只认 view、control，多一个值整张列表都会被它丢掉
  projects: z.array(z.object({ id: projectId, name: z.string().max(200), level: z.enum(['view', 'control']), full: z.boolean().optional() })).max(200),
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

// 带位置订阅、被连接端接得上时回它，之后补发缺的；接不上照常回一页快照
export const resumedSchema = z.object({ resumed: z.literal(true), sessionId, running: z.boolean() })
export const subscribeResultSchema = z.union([resumedSchema, snapshotSchema])

// 任务页要的配置：SessionInfo（bashPath 只说有没有 Git Bash，不发本机路径）、模型、权限模式、分支、项目的检查命令和禁止修改的目录（相对项目）
export const sessionDetailsSchema = z.object({
  info: z.looseObject({ bashPath: z.string().max(40).nullable(), checkpoints: z.boolean(), rulePacks: z.array(z.string().max(100)).max(50) }),
  modelLabel: z.string().max(200),
  modelRef: z.looseObject({}).optional(),
  planLabel: z.string().max(200).nullable(),
  fallbackLabel: z.string().max(200).nullable(),
  permissionMode: z.string().max(40),
  planMode: z.boolean(),
  branch: z.string().max(300).nullable(),
  project: z.object({ checks: z.looseObject({}), readOnlyPaths: z.array(z.string().max(1024)).max(200) }).nullable(),
})
// 任务改动的差异（git diff-tree -p 的输出，脱敏过；见 redact.ts 的 redactDiff）
export const MAX_DIFF_CHARS = 2_000_000
export const sessionDiffSchema = z.object({ diff: z.string().max(MAX_DIFF_CHARS + 200) })

export const terminalOpenedSchema = z.object({ terminalId })
export const branchesSchema = z.object({ current: z.string().max(300).nullable(), branches: z.array(z.string().max(200)).max(1000) })

// 对方的模型服务（不带地址和密钥提示）：切换模型用
export const modelsListSchema = z.object({ providers: z.array(z.looseObject({ id: z.string().max(200), name: z.string().max(200), models: z.array(z.looseObject({ id: z.string().max(200) })).max(500) })).max(100) })
// 斜杠菜单里对方的 Skill、自定义命令（不带本机目录）
export const skillsListSchema = z.object({ skills: z.array(z.looseObject({ name: z.string().max(200), description: z.string().max(4000) })).max(500) })
export const commandsListSchema = z.object({ commands: z.array(z.looseObject({ name: z.string().max(200), body: z.string().max(100_000) })).max(500) })
// 撤销之前列出会改回去的文件（相对项目）
export const restorePreviewSchema = z.object({ changes: z.array(z.object({ path: z.string().max(1024), change: z.enum(['added', 'modified', 'deleted']) })).max(5000) })

// 一个工具调用的全部内容（ACP 的 ToolCallContent，只校验外层）
export const toolOutputSchema = z.object({ content: z.array(z.looseObject({ type: z.string().min(1).max(32) })).max(100) })

export const okSchema = z.object({})
// 远程发消息：对方正在跑时排在这一轮后面
export const promptResultSchema = z.object({ queued: z.boolean() })
export const createResultSchema = z.object({ sessionId })

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
  // 一轮开始（会话更新里没有这一项，界面是自己建新一轮的）。from、remote：这一轮是别的任务、哪台远程设备发来的
  z.object({
    type: z.literal('event'),
    event: z.literal('turn.started'),
    sessionId,
    turnId: z.string().min(1).max(128),
    kind: z.string().max(32),
    prompt: z.string(),
    startedAt: isoTime,
    from: z.object({ sessionId, title: z.string().max(200) }).optional(),
    remote: z.object({ deviceId, name: z.string().max(60) }).optional(),
    // 提问带了几张图片：这一轮跑完重新取快照时图片才过来
    imageCount: z.number().int().min(1).max(6).optional(),
  }),
  // 撤销、重新生成这类改了整段记录的：重新订阅
  z.object({ type: z.literal('event'), event: z.literal('session.reset'), sessionId }),
  z.object({ type: z.literal('event'), event: z.literal('sessions.changed') }),
  z.object({
    type: z.literal('event'),
    event: z.literal('permission.request'),
    requestId,
    sessionId,
    toolCall: z.looseObject({ toolCallId: z.string().max(128), title: z.string().max(2000).optional() }),
    // 本机给的选项里远程能选的那几个（允许一次、拒绝；提问的选项、提交、不答），名字照本机的
    options: z.array(z.object({ optionId: remotePermissionOption, name: z.string().max(200) })).min(1).max(8),
  }),
  z.object({ type: z.literal('event'), event: z.literal('permission.settled'), requestId }),
  // 远程终端的输出（攒一小会儿一批）、结束（对方结束、通道断了、降级时 exitCode 是 null）
  z.object({ type: z.literal('event'), event: z.literal('terminal.data'), terminalId, data: z.string().max(256 * 1024) }),
  z.object({ type: z.literal('event'), event: z.literal('terminal.exit'), terminalId, exitCode: z.number().int().nullable() }),
  // 配对时被连接端的用户点了允许或拒绝
  z.object({ type: z.literal('event'), event: z.literal('pair.result'), approved: z.boolean() }),
  // 配对时连接端放弃了（取消、等太久）：被连接端收起确认弹窗
  z.object({ type: z.literal('event'), event: z.literal('pair.cancel') }),
  // 被连接端的待办改了（v2）：允许同步待办的连接端收到后马上同步一次（旧版不认识，丢掉，照样定时同步）
  z.object({ type: z.literal('event'), event: z.literal('todos.changed') }),
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
export type RemoteResumed = z.infer<typeof resumedSchema>
export type RemoteToolOutput = z.infer<typeof toolOutputSchema>
export type RemoteSessionDetails = z.infer<typeof sessionDetailsSchema>
