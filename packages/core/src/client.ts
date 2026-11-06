import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { EXT_METHODS, type ListModelsResult, type ModelEndpoint, type TestModelResult } from './models/types.js'
import { type CheckpointChange, SESSION_EXT_METHODS, type SessionConfig, type SessionInfo } from './protocol.js'

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
  const response = await connection.agent.request(
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
  return connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text }],
    _meta: { diffra: { turnId } },
  })
}

export function cancelSession(connection: acp.ClientConnection, sessionId: string): Promise<void> {
  return connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
}

export function previewCheckpoint(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<CheckpointChange[]> {
  return connection.agent.request<CheckpointChange[], { sessionId: string; turnId: string }>(
    SESSION_EXT_METHODS.checkpointPreview,
    { sessionId, turnId },
    extRequestOptions(),
  )
}

export function restoreCheckpoint(connection: acp.ClientConnection, sessionId: string, turnId: string): Promise<CheckpointChange[]> {
  return connection.agent.request<CheckpointChange[], { sessionId: string; turnId: string }>(
    SESSION_EXT_METHODS.checkpointRestore,
    { sessionId, turnId },
    extRequestOptions(),
  )
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
    response = await connection.agent.request(
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
  return connection.agent.request<ListModelsResult, { endpoint: ModelEndpoint }>(
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
  return connection.agent.request<TestModelResult, { endpoint: ModelEndpoint; modelId: string }>(
    EXT_METHODS.testModel,
    { endpoint, modelId },
    extRequestOptions(),
  )
}

function extRequestOptions(): acp.SendRequestOptions {
  return { cancellationSignal: AbortSignal.timeout(EXT_REQUEST_TIMEOUT_MS), stopWaitingOnCancel: true }
}
