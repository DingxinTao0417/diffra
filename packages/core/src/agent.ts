import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as acp from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { Checkpoints } from './checkpoint.js'
import { findBash, findRipgrep } from './environment.js'
import { listModels, testModel } from './models/operations.js'
import { EXT_METHODS } from './models/types.js'
import { SESSION_EXT_METHODS, type SessionInfo } from './protocol.js'
import { endpointSchema, newSessionMetaSchema, promptMetaSchema } from './session/config.js'
import { runTurn } from './session/loop.js'
import { buildSystemPrompt } from './session/prompt.js'
import { Session } from './session/session.js'
import { CORE_VERSION } from './version.js'

export const AGENT_NAME = 'diffra-core'

const checkpointParams = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) })

export function createAgent(): acp.AgentApp {
  const sessions = new Map<string, Session>()

  const sessionOf = (sessionId: string): Session => {
    const session = sessions.get(sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(sessionId)
    return session
  }

  return acp
    .agent({ name: AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      agentInfo: { name: AGENT_NAME, version: CORE_VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const meta = newSessionMetaSchema.safeParse(params._meta)
      if (!meta.success) throw acp.RequestError.invalidParams(meta.error.issues, '缺少或无效的 _meta.diffra 会话配置')
      const info = await stat(params.cwd).catch(() => null)
      if (!info?.isDirectory()) throw acp.RequestError.invalidParams(undefined, `项目目录不存在：${params.cwd}`)

      const config = meta.data.diffra
      const environment = { bashPath: await findBash(), rgPath: await findRipgrep() }
      const checkpoints = config.checkpointDir
        ? await Checkpoints.open(config.checkpointDir, params.cwd).catch((error: unknown) => {
            console.error('[session] 检查点仓库初始化失败', error)
            return null
          })
        : null
      const session = new Session({
        cwd: params.cwd,
        config,
        environment,
        checkpoints,
        systemPrompt: await buildSystemPrompt(params.cwd, environment.bashPath, config.checks),
      })
      sessions.set(session.id, session)
      const sessionInfo: SessionInfo = { bashPath: environment.bashPath, checkpoints: checkpoints !== null }
      return { sessionId: session.id, _meta: { diffra: sessionInfo } }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const meta = promptMetaSchema.safeParse(params._meta)
      const turnId = meta.success ? meta.data.diffra.turnId : randomUUID()
      const text = params.prompt
        .map((block) => (block.type === 'text' ? block.text : `[${block.type} content is not supported yet]`))
        .join('\n')
      const stopReason = await runTurn(session, { id: turnId, text }, {
        update: (update) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update }),
        requestPermission: async (toolCall, options) => {
          try {
            const response = await client.request(
              acp.methods.client.session.requestPermission,
              { sessionId: session.id, toolCall, options },
              // 用户点「停止」时不再等确认结果
              session.activeTurn ? { cancellationSignal: session.activeTurn.signal, stopWaitingOnCancel: true } : undefined,
            )
            return response.outcome.outcome === 'selected' ? response.outcome.optionId : null
          } catch (error) {
            console.error('[session] 权限请求失败', error)
            return null
          }
        },
      })
      return { stopReason }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.cancel()
    })
    .onRequest(SESSION_EXT_METHODS.checkpointPreview, checkpointParams, ({ params }) =>
      sessionOf(params.sessionId).checkpointChanges(params.turnId),
    )
    .onRequest(SESSION_EXT_METHODS.checkpointRestore, checkpointParams, ({ params }) =>
      sessionOf(params.sessionId).restoreCheckpoint(params.turnId),
    )
    .onRequest(EXT_METHODS.listModels, z.object({ endpoint: endpointSchema }), ({ params }) =>
      listModels(params.endpoint),
    )
    .onRequest(
      EXT_METHODS.testModel,
      z.object({ endpoint: endpointSchema, modelId: z.string().min(1) }),
      ({ params }) => testModel(params.endpoint, params.modelId),
    )
}
