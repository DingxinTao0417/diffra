import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { AnalysisProgress, ArchitectureBundle, ArchitectureEvent, ArchitectureLayout, ArchitectureProject, ArchitectureProjectSummary, BlockDiagram, InterpretPart, ModuleNote, TargetArchitecture } from './architecture/model.js'
import { browserActionParamsSchema, designActionParamsSchema, devServerParamsSchema, taskActionParamsSchema } from './session/config.js'
import { taskProgressViewSchema } from './session/task-state.js'
import { EXT_METHODS, type ListModelsResult, type ModelEndpoint, type TestModelResult } from './models/types.js'
import {
  ACP_MAX_MESSAGE_BYTES,
  type CheckDetection,
  type CheckpointChange,
  type CheckRunResult,
  type BrowserActionParams,
  type BrowserActionResult,
  type BrowserSites,
  CLIENT_EXT_METHODS,
  CLIENT_EXT_NOTIFICATIONS,
  type CommandInfo,
  type DesignActionParams,
  type DesignActionResult,
  type TaskActionParams,
  type TaskActionResult,
  type TaskSource,
  type DevServerParams,
  type DevServerResult,
  type ListTarget,
  type LoadedSession,
  type McpServer,
  type McpServerStatus,
  type McpTarget,
  type PluginInfo,
  type PromptEnhancement,
  type PromptImage,
  type PermissionMode,
  type RemoteSnapshot,
  SESSION_EXT_METHODS,
  type SessionConfig,
  type SessionDesign,
  type SessionModel,
  type SessionInfo,
  type SessionSearchResult,
  type StoredSessionMeta,
  type SkillInfo,
  type StoredSessionSummary,
  type UsageQuery,
  type UsageSummary,
} from './protocol.js'

export * from './protocol.js'
export { parseRulePack, RulePackError } from './rules/pack.js'
export { isLocalHost, normalizeUrl } from './urls.js'
export { isProtectedFile } from './tools/protected.js'

// 客户端（桌面端）接收 core 推来的会话更新和权限请求
export interface CoreClientHandlers {
  onSessionUpdate(notification: acp.SessionNotification): void
  onPermissionRequest(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
  // 智能体操作内置浏览器、起开发服务器；不提供时会话里不要开 browser
  onBrowserAction?(params: BrowserActionParams): Promise<BrowserActionResult>
  onDevServer?(params: DevServerParams): Promise<DevServerResult>
  // 智能体调用设计面板的工具；不提供时不要给会话配置设计工具
  onDesignAction?(params: DesignActionParams): Promise<DesignActionResult>
  // 智能体给别的任务发消息、新建任务；不提供时任务互通的发送和新建会报错
  onTaskAction?(params: TaskActionParams): Promise<TaskActionResult>
  // 架构分析、解读的进度和结束
  onArchitectureEvent?(event: ArchitectureEvent): void
}

// core 对每次模型请求都设了超时，这里再兜一层，防止 core 自身卡住时调用方一直等
const EXT_REQUEST_TIMEOUT_MS = 60_000
const CHECK_RUN_TIMEOUT_MS = 310_000

export interface CoreHandshake {
  agentName: string
  agentVersion: string
  protocolVersion: number
}

export function connectToCore(coreStdin: Writable, coreStdout: Readable, handlers?: CoreClientHandlers): acp.ClientConnection {
  const app = acp.client({ name: 'diffra' })
  if (handlers) {
    app
      .onNotification(acp.methods.client.session.update, ({ params }) => handlers.onSessionUpdate(params))
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => handlers.onPermissionRequest(params))
    const onBrowserAction = handlers.onBrowserAction
    if (onBrowserAction) app.onRequest(CLIENT_EXT_METHODS.browserAction, browserActionParamsSchema, ({ params }) => onBrowserAction(params))
    const onDevServer = handlers.onDevServer
    if (onDevServer) app.onRequest(CLIENT_EXT_METHODS.devServer, devServerParamsSchema, ({ params }) => onDevServer(params))
    const onDesignAction = handlers.onDesignAction
    if (onDesignAction) app.onRequest(CLIENT_EXT_METHODS.designAction, designActionParamsSchema, ({ params }) => onDesignAction(params))
    const onTaskAction = handlers.onTaskAction
    if (onTaskAction) app.onRequest(CLIENT_EXT_METHODS.taskAction, taskActionParamsSchema, ({ params }) => onTaskAction(params))
    const onArchitectureEvent = handlers.onArchitectureEvent
    // core 自己发的通知，结构由 core 保证
    if (onArchitectureEvent) app.onNotification(CLIENT_EXT_NOTIFICATIONS.architectureEvent, (raw: unknown) => raw as ArchitectureEvent, ({ params }) => onArchitectureEvent(params))
  }
  return app.connect(acp.ndJsonStream(Writable.toWeb(coreStdin), Readable.toWeb(coreStdout), { maxMessageBytes: ACP_MAX_MESSAGE_BYTES }))
}

export async function createSession(
  connection: acp.ClientConnection,
  cwd: string,
  config: SessionConfig,
  mcpServers: McpServer[] = [],
): Promise<{ sessionId: string; info: SessionInfo }> {
  const response = await requestOf(connection)(
    acp.methods.agent.session.new,
    { cwd, mcpServers, _meta: { diffra: config } },
    extRequestOptions(),
  )
  return { sessionId: response.sessionId, info: readSessionInfo(response._meta) }
}

// 一轮任务可能跑很久，不设超时；用 cancelSession 停止
// skills：这一轮选的 Skill 名称；goal：目标模式，自主推进多轮
export interface PromptOptions {
  skills?: string[]
  goal?: boolean
  images?: PromptImage[]
  // 另一个任务发来的消息（任务互通）
  from?: TaskSource
}

export function sendPrompt(
  connection: acp.ClientConnection,
  sessionId: string,
  turnId: string,
  text: string,
  options: PromptOptions = {},
): Promise<acp.PromptResponse> {
  return requestOf(connection)(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text }, ...(options.images ?? []).map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data }))],
    _meta: { diffra: { turnId, skills: options.skills ?? [], goal: options.goal ?? false, ...(options.from ? { from: options.from } : {}) } },
  })
}

// 深度安全扫描和一轮任务一样可能跑很久，不设超时；用 cancelSession 停止
export function deepScan(
  connection: acp.ClientConnection,
  sessionId: string,
  turnId: string,
  scope: 'task' | 'project',
): Promise<{ stopReason: acp.StopReason }> {
  return requestOf(connection)<{ stopReason: acp.StopReason }, { sessionId: string; turnId: string; scope: 'task' | 'project' }>(
    SESSION_EXT_METHODS.deepScan,
    { sessionId, turnId, scope },
  )
}

// 先出计划：和一轮任务一样可能跑很久，不设超时；用 cancelSession 停止
export function plan(
  connection: acp.ClientConnection,
  sessionId: string,
  turnId: string,
  prompt: string,
  skills: string[] = [],
): Promise<{ stopReason: acp.StopReason }> {
  return requestOf(connection)<{ stopReason: acp.StopReason }, { sessionId: string; turnId: string; prompt: string; skills: string[] }>(
    SESSION_EXT_METHODS.plan,
    { sessionId, turnId, prompt, skills },
  )
}

// 定位问题：和出计划一样是一轮，可能要一会儿，不设超时；用 cancelSession 停止
export function diagnose(
  connection: acp.ClientConnection,
  sessionId: string,
  turnId: string,
  prompt: string,
  target: { turnId: string; cardId: string | null },
): Promise<{ stopReason: acp.StopReason }> {
  return requestOf(connection)<{ stopReason: acp.StopReason }, { sessionId: string; turnId: string; prompt: string; target: { turnId: string; cardId: string | null } }>(
    SESSION_EXT_METHODS.diagnose,
    { sessionId, turnId, prompt, target },
  )
}

// 优化输入框里的提示词。模型最多想 90 秒，等待时间比其他扩展请求长一点
export function enhancePrompt(
  connection: acp.ClientConnection,
  params: { model: SessionModel; text: string; cwd: string | null; sessionId: string | null; mentions: string[]; design: boolean },
): Promise<PromptEnhancement> {
  return requestOf(connection)<PromptEnhancement, typeof params>(SESSION_EXT_METHODS.promptEnhance, params, { cancellationSignal: AbortSignal.timeout(100_000), stopWaitingOnCancel: true })
}

// 模型很久没有输出时，让卡住的那一步重发；agent 是 main 或子智能体的 id
export function retryStep(connection: acp.ClientConnection, sessionId: string, agent: string): Promise<{ retried: boolean }> {
  return requestOf(connection)<{ retried: boolean }, { sessionId: string; agent: string }>(SESSION_EXT_METHODS.retryStep, { sessionId, agent }, extRequestOptions())
}

// 用户手动压缩，和任务一样可取消；限制请求等待时间，不自动重试模型操作。
export function compactSession(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<{ stopReason: acp.StopReason }> {
  return requestOf(connection)<{ stopReason: acp.StopReason }, { sessionId: string; turnId: string }>(SESSION_EXT_METHODS.compact, { sessionId, turnId }, { cancellationSignal: AbortSignal.timeout(CHECK_RUN_TIMEOUT_MS), stopWaitingOnCancel: true })
}

export function listSkills(connection: acp.ClientConnection, target: ListTarget): Promise<SkillInfo[]> {
  return requestOf(connection)<SkillInfo[], ListTarget>(SESSION_EXT_METHODS.skillsList, target, extRequestOptions())
}

export function listCommands(connection: acp.ClientConnection, target: ListTarget): Promise<CommandInfo[]> {
  return requestOf(connection)<CommandInfo[], ListTarget>(SESSION_EXT_METHODS.commandsList, target, extRequestOptions())
}

export function inspectPlugin(connection: acp.ClientConnection, dir: string): Promise<PluginInfo> {
  return requestOf(connection)<PluginInfo, { dir: string }>(SESSION_EXT_METHODS.pluginInspect, { dir }, extRequestOptions())
}

// 连 MCP 服务器（首次可能要下载）最多等 60 秒，再加上列 prompt
const MCP_REQUEST_TIMEOUT_MS = 120_000

export function mcpStatus(connection: acp.ClientConnection, target: McpTarget, retry = false): Promise<McpServerStatus[]> {
  return requestOf(connection)<McpServerStatus[], { target: McpTarget; retry: boolean }>(
    SESSION_EXT_METHODS.mcpStatus,
    { target, retry },
    { cancellationSignal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS), stopWaitingOnCancel: true },
  )
}

export function mcpPrompt(
  connection: acp.ClientConnection,
  target: McpTarget,
  server: string,
  prompt: string,
  args: Record<string, string>,
): Promise<string> {
  return requestOf(connection)<string, { target: McpTarget; server: string; prompt: string; arguments: Record<string, string> }>(
    SESSION_EXT_METHODS.mcpPrompt,
    { target, server, prompt, arguments: args },
    { cancellationSignal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS), stopWaitingOnCancel: true },
  )
}

export function cancelSession(connection: acp.ClientConnection, sessionId: string): Promise<void> {
  return connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
}

export function previewCheckpoint(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<CheckpointChange[]> {
  return requestOf(connection)<CheckpointChange[], { sessionId: string; turnId: string }>(
    SESSION_EXT_METHODS.checkpointPreview,
    { sessionId, turnId },
    extRequestOptions(),
  )
}

export function restoreCheckpoint(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<CheckpointChange[]> {
  return requestOf(connection)<CheckpointChange[], { sessionId: string; turnId: string }>(
    SESSION_EXT_METHODS.checkpointRestore,
    { sessionId, turnId },
    extRequestOptions(),
  )
}

// 加载会读项目语言、初始化检查点，和新建一样不设短超时
export async function loadSession(
  connection: acp.ClientConnection,
  sessionId: string,
  cwd: string,
  config: SessionConfig,
  mcpServers: McpServer[] = [],
): Promise<LoadedSession> {
  const response = await requestOf(connection)(acp.methods.agent.session.load, {
    sessionId,
    cwd,
    mcpServers,
    _meta: { diffra: config },
  })
  const diffra = response && typeof response._meta?.diffra === 'object' ? (response._meta.diffra as Partial<LoadedSession>) : null
  if (!diffra || !Array.isArray(diffra.turns)) throw new Error('core 的 session/load 响应缺少会话历史')
  const taskState = taskProgressViewSchema.safeParse(diffra.taskState)
  return {
    info: readSessionInfo({ diffra: diffra.info }),
    title: String(diffra.title ?? ''),
    turns: diffra.turns,
    ...(taskState.success ? { taskState: taskState.data } : {}),
    design: diffra.design === true,
    noProject: diffra.noProject === true,
  }
}

export async function listSessions(connection: acp.ClientConnection, cwd?: string): Promise<StoredSessionSummary[]> {
  const response = await requestOf(connection)(acp.methods.agent.session.list, { cwd: cwd ?? null }, extRequestOptions())
  return response.sessions.map((session) => {
    const meta = (session._meta?.diffra ?? {}) as Partial<StoredSessionMeta>
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title ?? '',
      updatedAt: session.updatedAt ?? '',
      createdAt: meta.createdAt ?? '',
      archived: meta.archived === true,
      turnCount: meta.turnCount ?? 0,
      design: meta.design === true,
      noProject: meta.noProject === true,
      running: meta.running === true,
    }
  })
}

export async function deleteSession(connection: acp.ClientConnection, sessionId: string): Promise<void> {
  await requestOf(connection)(acp.methods.agent.session.delete, { sessionId }, extRequestOptions())
}

export function updateSession(
  connection: acp.ClientConnection,
  sessionId: string,
  change: { title?: string; archived?: boolean },
): Promise<unknown> {
  return requestOf(connection)(SESSION_EXT_METHODS.sessionUpdate, { sessionId, ...change }, extRequestOptions())
}

export async function setBrowserSites(connection: acp.ClientConnection, sites: BrowserSites): Promise<void> {
  await requestOf(connection)(SESSION_EXT_METHODS.browserSites, sites, extRequestOptions())
}

export async function configureSession(
  connection: acp.ClientConnection,
  sessionId: string,
  change: { permissionMode?: PermissionMode; model?: SessionConfig['model']; design?: SessionDesign | null },
): Promise<void> {
  await requestOf(connection)(SESSION_EXT_METHODS.sessionConfigure, { sessionId, ...change }, extRequestOptions())
}

export function rewindSession(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<{ filesRestored: boolean }> {
  return requestOf(connection)<{ filesRestored: boolean }, { sessionId: string; turnId: string }>(
    SESSION_EXT_METHODS.sessionRewind,
    { sessionId, turnId },
    extRequestOptions(),
  )
}

export function checkpointDiff(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<string> {
  return requestOf(connection)<string, { sessionId: string; turnId: string }>(
    SESSION_EXT_METHODS.checkpointDiff,
    { sessionId, turnId },
    extRequestOptions(),
  )
}

// 设备连接读一个会话的一页轮次；before 不给是最后一页
export function remoteSnapshot(
  connection: acp.ClientConnection,
  params: { sessionId: string; before?: number; maxTurns?: number; maxChars?: number },
): Promise<RemoteSnapshot> {
  return requestOf(connection)<RemoteSnapshot, typeof params>(SESSION_EXT_METHODS.remoteSnapshot, params, extRequestOptions())
}

export function searchSessions(connection: acp.ClientConnection, query: string): Promise<SessionSearchResult[]> {
  return requestOf(connection)<SessionSearchResult[], { query: string }>(SESSION_EXT_METHODS.sessionSearch, { query }, extRequestOptions())
}

export function usageSummary(connection: acp.ClientConnection, query: UsageQuery): Promise<UsageSummary> {
  return requestOf(connection)<UsageSummary, UsageQuery>(SESSION_EXT_METHODS.usageSummary, query, extRequestOptions())
}

export function detectProjectChecks(connection: acp.ClientConnection, cwd: string): Promise<CheckDetection> {
  return requestOf(connection)<CheckDetection, { cwd: string }>(SESSION_EXT_METHODS.projectDetectChecks, { cwd }, extRequestOptions())
}

// 检查最长跑 300 秒，等待时间比其他扩展请求长
export function runProjectCheck(connection: acp.ClientConnection, cwd: string, command: string): Promise<CheckRunResult> {
  return requestOf(connection)<CheckRunResult, { cwd: string; command: string }>(
    SESSION_EXT_METHODS.projectRunCheck,
    { cwd, command },
    { cancellationSignal: AbortSignal.timeout(CHECK_RUN_TIMEOUT_MS), stopWaitingOnCancel: true },
  )
}

// ---------- 架构分析 ----------

// 模型解读、提目标架构一次调用最多 180 秒
const ARCHITECTURE_MODEL_TIMEOUT_MS = 200_000

export function architectureList(connection: acp.ClientConnection): Promise<ArchitectureProjectSummary[]> {
  return requestOf(connection)<ArchitectureProjectSummary[], Record<string, never>>(SESSION_EXT_METHODS.architectureList, {}, extRequestOptions())
}

export function architectureAdd(connection: acp.ClientConnection, path: string): Promise<ArchitectureProject> {
  return requestOf(connection)<ArchitectureProject, { path: string }>(SESSION_EXT_METHODS.architectureAdd, { path }, extRequestOptions())
}

export async function architectureRemove(connection: acp.ClientConnection, projectId: string): Promise<void> {
  await requestOf(connection)<object, { projectId: string }>(SESSION_EXT_METHODS.architectureRemove, { projectId }, extRequestOptions())
}

// 分析在 core 后台跑，这里只等它开始；进度和结果走 onArchitectureEvent
export async function architectureAnalyze(connection: acp.ClientConnection, projectId: string): Promise<void> {
  await requestOf(connection)<object, { projectId: string }>(SESSION_EXT_METHODS.architectureAnalyze, { projectId }, extRequestOptions())
}

export async function architectureCancel(connection: acp.ClientConnection, projectId: string): Promise<void> {
  await requestOf(connection)<object, { projectId: string }>(SESSION_EXT_METHODS.architectureCancel, { projectId }, extRequestOptions())
}

export function architectureRunning(connection: acp.ClientConnection): Promise<AnalysisProgress[]> {
  return requestOf(connection)<AnalysisProgress[], Record<string, never>>(SESSION_EXT_METHODS.architectureRunning, {}, extRequestOptions())
}

export function architectureBundle(connection: acp.ClientConnection, projectId: string): Promise<ArchitectureBundle> {
  return requestOf(connection)<ArchitectureBundle, { projectId: string }>(SESSION_EXT_METHODS.architectureBundle, { projectId }, extRequestOptions())
}

export function architectureStale(connection: acp.ClientConnection, projectId: string): Promise<{ stale: boolean | null }> {
  return requestOf(connection)<{ stale: boolean | null }, { projectId: string }>(SESSION_EXT_METHODS.architectureStale, { projectId }, extRequestOptions())
}

export async function architectureInterpret(connection: acp.ClientConnection, projectId: string, model: SessionModel, parts: InterpretPart[]): Promise<void> {
  await requestOf(connection)<object, { projectId: string; model: SessionModel; parts: InterpretPart[] }>(SESSION_EXT_METHODS.architectureInterpret, { projectId, model, parts }, extRequestOptions())
}

export async function architectureSaveDiagram(connection: acp.ClientConnection, projectId: string, diagram: BlockDiagram): Promise<void> {
  await requestOf(connection)<object, { projectId: string; diagram: BlockDiagram }>(SESSION_EXT_METHODS.architectureSaveDiagram, { projectId, diagram }, extRequestOptions())
}

export function architectureInterpretModule(connection: acp.ClientConnection, projectId: string, path: string, model: SessionModel): Promise<ModuleNote> {
  return requestOf(connection)<ModuleNote, { projectId: string; path: string; model: SessionModel }>(
    SESSION_EXT_METHODS.architectureInterpretModule,
    { projectId, path, model },
    { cancellationSignal: AbortSignal.timeout(ARCHITECTURE_MODEL_TIMEOUT_MS), stopWaitingOnCancel: true },
  )
}

export function architectureProposeTarget(connection: acp.ClientConnection, projectId: string, principles: string, model: SessionModel): Promise<{ target: TargetArchitecture; rationale: string }> {
  return requestOf(connection)<{ target: TargetArchitecture; rationale: string }, { projectId: string; principles: string; model: SessionModel }>(
    SESSION_EXT_METHODS.architectureProposeTarget,
    { projectId, principles, model },
    { cancellationSignal: AbortSignal.timeout(ARCHITECTURE_MODEL_TIMEOUT_MS), stopWaitingOnCancel: true },
  )
}

export async function architectureSaveTarget(connection: acp.ClientConnection, projectId: string, target: TargetArchitecture | null): Promise<void> {
  await requestOf(connection)<object, { projectId: string; target: TargetArchitecture | null }>(SESSION_EXT_METHODS.architectureSaveTarget, { projectId, target }, extRequestOptions())
}

export function architectureSource(connection: acp.ClientConnection, projectId: string, path: string): Promise<{ text: string; lines: number }> {
  return requestOf(connection)<{ text: string; lines: number }, { projectId: string; path: string }>(SESSION_EXT_METHODS.architectureSource, { projectId, path }, extRequestOptions())
}

export async function architectureSaveLayout(connection: acp.ClientConnection, projectId: string, layout: ArchitectureLayout): Promise<void> {
  await requestOf(connection)<object, { projectId: string; layout: ArchitectureLayout }>(SESSION_EXT_METHODS.architectureSaveLayout, { projectId, layout }, extRequestOptions())
}

function readSessionInfo(meta: unknown): SessionInfo {
  const diffra = typeof meta === 'object' && meta !== null && 'diffra' in meta ? meta.diffra : null
  if (typeof diffra !== 'object' || diffra === null) throw new Error('core 的 session/new 响应缺少 _meta.diffra')
  const bashPath = 'bashPath' in diffra && typeof diffra.bashPath === 'string' ? diffra.bashPath : null
  const checkpoints = 'checkpoints' in diffra && diffra.checkpoints === true
  const packs = 'rulePacks' in diffra && Array.isArray(diffra.rulePacks) ? diffra.rulePacks : []
  const security = 'security' in diffra && typeof diffra.security === 'object' && diffra.security !== null ? diffra.security : {}
  const checks = 'checks' in diffra && typeof diffra.checks === 'object' && diffra.checks !== null ? diffra.checks : null
  return {
    bashPath,
    checkpoints,
    rulePacks: packs.filter((name): name is string => typeof name === 'string'),
    security: {
      staticCheck: 'staticCheck' in security && security.staticCheck === true,
      lightScan: 'lightScan' in security && security.lightScan === true,
    },
    checks: checks && {
      afterEdit: 'afterEdit' in checks && typeof checks.afterEdit === 'string' ? checks.afterEdit : null,
      beforeFinish: 'beforeFinish' in checks && typeof checks.beforeFinish === 'string' ? checks.beforeFinish : null,
    },
  }
}

export async function handshake(connection: acp.ClientConnection, timeoutMs: number): Promise<CoreHandshake> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: acp.InitializeResponse
  try {
    response = await requestOf(connection)(
      acp.methods.agent.initialize,
      { protocolVersion: acp.PROTOCOL_VERSION },
      { cancellationSignal: timeout, stopWaitingOnCancel: true },
    )
  } catch (error) {
    if (timeout.aborted) throw new Error(`core 在 ${timeoutMs}ms 内没有响应握手`, { cause: error })
    throw error
  }
  if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(`core 返回的 ACP 协议版本 ${response.protocolVersion} 与客户端 ${acp.PROTOCOL_VERSION} 不一致`)
  }
  if (!response.agentInfo) throw new Error('core 握手响应缺少 agentInfo')
  return {
    agentName: response.agentInfo.name,
    agentVersion: response.agentInfo.version,
    protocolVersion: response.protocolVersion,
  }
}

export function requestListModels(connection: acp.ClientConnection, endpoint: ModelEndpoint): Promise<ListModelsResult> {
  return requestOf(connection)<ListModelsResult, { endpoint: ModelEndpoint }>(
    EXT_METHODS.listModels,
    { endpoint },
    extRequestOptions(),
  )
}

export function requestTestModel(
  connection: acp.ClientConnection,
  endpoint: ModelEndpoint,
  modelId: string,
): Promise<TestModelResult> {
  return requestOf(connection)<TestModelResult, { endpoint: ModelEndpoint; modelId: string }>(
    EXT_METHODS.testModel,
    { endpoint, modelId },
    extRequestOptions(),
  )
}

// core 的处理函数抛出的普通错误，ACP 会包成 Internal error，原文放在 data.details 里；
// 所有请求都从这里发，把原文取出来再抛，界面上才看得到具体原因
function requestOf(connection: acp.ClientConnection): acp.ClientConnection['agent']['request'] {
  const request = connection.agent.request.bind(connection.agent)
  return ((...args: Parameters<typeof request>) =>
    request(...args).catch((error: unknown) => {
      throw withCoreMessage(error)
    })) as typeof request
}

function withCoreMessage(error: unknown): unknown {
  if (!(error instanceof acp.RequestError)) return error
  const data: unknown = error.data
  const details = typeof data === 'object' && data !== null && 'details' in data ? data.details : null
  return typeof details === 'string' && details ? new Error(details, { cause: error }) : error
}

function extRequestOptions(): acp.SendRequestOptions {
  return { cancellationSignal: AbortSignal.timeout(EXT_REQUEST_TIMEOUT_MS), stopWaitingOnCancel: true }
}
