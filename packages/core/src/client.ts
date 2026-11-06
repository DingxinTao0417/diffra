import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { EXT_METHODS, type ListModelsResult, type ModelEndpoint, type TestModelResult } from './models/types.js'
import {
  type CheckpointChange,
  type LoadedSession,
  type PermissionMode,
  SESSION_EXT_METHODS,
  type SessionConfig,
  type SessionInfo,
  type SessionSearchResult,
  type StoredSessionMeta,
  type StoredSessionSummary,
  type UsageQuery,
  type UsageSummary,
} from './protocol.js'

export * from './protocol.js'
export { parseRulePack, RulePackError } from './rules/pack.js'

// 客户端（桌面端）接收 core 推来的会话更新和权限请求
export interface CoreClientHandlers {
  onSessionUpdate(notification: acp.SessionNotification): void
  onPermissionRequest(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
}

// core 对每次模型请求都设了超时，这里再兜一层，防止 core 自身卡住时调用方一直等
const EXT_REQUEST_TIMEOUT_MS = 60_000

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
  }
  return app.connect(acp.ndJsonStream(Writable.toWeb(coreStdin), Readable.toWeb(coreStdout)))
}

export async function createSession(
  connection: acp.ClientConnection,
  cwd: string,
  config: SessionConfig,
): Promise<{ sessionId: string; info: SessionInfo }> {
  const response = await requestOf(connection)(
    acp.methods.agent.session.new,
    { cwd, mcpServers: [], _meta: { diffra: config } },
    extRequestOptions(),
  )
  return { sessionId: response.sessionId, info: readSessionInfo(response._meta) }
}

// 一轮任务可能跑很久，不设超时；用 cancelSession 停止
export function sendPrompt(
  connection: acp.ClientConnection,
  sessionId: string,
  turnId: string,
  text: string,
): Promise<acp.PromptResponse> {
  return requestOf(connection)(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text }],
    _meta: { diffra: { turnId } },
  })
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
): Promise<LoadedSession> {
  const response = await requestOf(connection)(acp.methods.agent.session.load, {
    sessionId,
    cwd,
    mcpServers: [],
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

function readSessionInfo(meta: unknown): SessionInfo {
  const diffra = typeof meta === 'object' && meta !== null && 'diffra' in meta ? meta.diffra : null
  if (typeof diffra !== 'object' || diffra === null) throw new Error('core 的 session/new 响应缺少 _meta.diffra')
  const bashPath = 'bashPath' in diffra && typeof diffra.bashPath === 'string' ? diffra.bashPath : null
  const checkpoints = 'checkpoints' in diffra && diffra.checkpoints === true
  const packs = 'rulePacks' in diffra && Array.isArray(diffra.rulePacks) ? diffra.rulePacks : []
  return { bashPath, checkpoints, rulePacks: packs.filter((name): name is string => typeof name === 'string') }
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
