import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { browserActionParamsSchema, devServerParamsSchema } from './session/config.js'
import { EXT_METHODS, type ListModelsResult, type ModelEndpoint, type TestModelResult } from './models/types.js'
import {
  type CheckDetection,
  type CheckpointChange,
  type CheckRunResult,
  type BrowserActionParams,
  type BrowserActionResult,
  CLIENT_EXT_METHODS,
  type CommandInfo,
  type DevServerParams,
  type DevServerResult,
  type LoadedSession,
  type McpServer,
  type McpServerStatus,
  type McpTarget,
  type PluginInfo,
  type PluginRef,
  type PromptImage,
  type PermissionMode,
  SESSION_EXT_METHODS,
  type SessionConfig,
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

// 客户端（桌面端）接收 core 推来的会话更新和权限请求
export interface CoreClientHandlers {
  onSessionUpdate(notification: acp.SessionNotification): void
  onPermissionRequest(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
  // 智能体操作内置浏览器、起开发服务器；不提供时会话里不要开 browser
  onBrowserAction?(params: BrowserActionParams): Promise<BrowserActionResult>
  onDevServer?(params: DevServerParams): Promise<DevServerResult>
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
  }
  return app.connect(acp.ndJsonStream(Writable.toWeb(coreStdin), Readable.toWeb(coreStdout)))
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
    _meta: { diffra: { turnId, skills: options.skills ?? [], goal: options.goal ?? false } },
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

export function listSkills(connection: acp.ClientConnection, cwd: string, plugins: PluginRef[] = []): Promise<SkillInfo[]> {
  return requestOf(connection)<SkillInfo[], { cwd: string; plugins: PluginRef[] }>(SESSION_EXT_METHODS.skillsList, { cwd, plugins }, extRequestOptions())
}

export function listCommands(connection: acp.ClientConnection, cwd: string, plugins: PluginRef[] = []): Promise<CommandInfo[]> {
  return requestOf(connection)<CommandInfo[], { cwd: string; plugins: PluginRef[] }>(SESSION_EXT_METHODS.commandsList, { cwd, plugins }, extRequestOptions())
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
  return { info: readSessionInfo({ diffra: diffra.info }), title: String(diffra.title ?? ''), turns: diffra.turns }
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

export async function configureSession(
  connection: acp.ClientConnection,
  sessionId: string,
  change: { permissionMode?: PermissionMode; model?: SessionConfig['model'] },
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

function readSessionInfo(meta: unknown): SessionInfo {
  const diffra = typeof meta === 'object' && meta !== null && 'diffra' in meta ? meta.diffra : null
  if (typeof diffra !== 'object' || diffra === null) throw new Error('core 的 session/new 响应缺少 _meta.diffra')
  const bashPath = 'bashPath' in diffra && typeof diffra.bashPath === 'string' ? diffra.bashPath : null
  const checkpoints = 'checkpoints' in diffra && diffra.checkpoints === true
  const packs = 'rulePacks' in diffra && Array.isArray(diffra.rulePacks) ? diffra.rulePacks : []
  const security = 'security' in diffra && typeof diffra.security === 'object' && diffra.security !== null ? diffra.security : {}
  return {
    bashPath,
    checkpoints,
    rulePacks: packs.filter((name): name is string => typeof name === 'string'),
    security: {
      staticCheck: 'staticCheck' in security && security.staticCheck === true,
      lightScan: 'lightScan' in security && security.lightScan === true,
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
