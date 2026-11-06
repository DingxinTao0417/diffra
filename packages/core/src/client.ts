import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { EXT_METHODS, type ListModelsResult, type ModelEndpoint, type TestModelResult } from './models/types.js'

export * from './models/types.js'

// core 对每次模型请求都设了超时，这里再兜一层，防止 core 自身卡住时调用方一直等
const EXT_REQUEST_TIMEOUT_MS = 60_000

export interface CoreHandshake {
  agentName: string
  agentVersion: string
  protocolVersion: number
}

export function connectToCore(coreStdin: Writable, coreStdout: Readable): acp.ClientConnection {
  return acp.client({ name: 'diffra' }).connect(acp.ndJsonStream(Writable.toWeb(coreStdin), Readable.toWeb(coreStdout)))
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
