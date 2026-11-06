import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as acp from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { Checkpoints } from './checkpoint.js'
import { findBash, findRipgrep } from './environment.js'
import { listModels, testModel } from './models/operations.js'
import { EXT_METHODS } from './models/types.js'
import { type LoadedSession, SESSION_EXT_METHODS, type SessionInfo, type StoredSessionMeta } from './protocol.js'
import { detectLanguages } from './rules/languages.js'
import { selectRulePacks } from './rules/select.js'
import { endpointSchema, modelConfigSchema, newSessionMetaSchema, promptMetaSchema } from './session/config.js'
import { runTurn } from './session/loop.js'
import { buildSystemPrompt } from './session/prompt.js'
import { Session } from './session/session.js'
import { type SessionRecord, SessionStore } from './session/store.js'
import { toUsageRecord, UsageLog } from './usage/log.js'
import { isTimeZone, UsageAggregator } from './usage/summary.js'
import { CORE_VERSION } from './version.js'

export const AGENT_NAME = 'diffra-core'

export interface AgentOptions {
  // 会话记录存放的目录；不给就不保存，session/load、list、delete 都不可用
  sessionsDir?: string | null
  // 用量记录存放的目录；不给就不记录，用量汇总不可用
  usageDir?: string | null
}

const checkpointParams = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) })
const sessionUpdateParams = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(100).optional(),
  archived: z.boolean().optional(),
})

const sessionConfigureParams = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.enum(['ask', 'auto', 'full']).optional(),
  model: modelConfigSchema.optional(),
})

// 一次最多汇总 400 天，避免一个请求扫完所有历史
const MAX_USAGE_RANGE_MS = 400 * 86_400_000
const usageQueryParams = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime(), timeZone: z.string().refine(isTimeZone, '无效的时区') })
  .refine((query) => Date.parse(query.from) < Date.parse(query.to), '开始时间要早于结束时间')
  .refine((query) => Date.parse(query.to) - Date.parse(query.from) <= MAX_USAGE_RANGE_MS, '一次最多统计 400 天')

const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

export function createAgent(options: AgentOptions = {}): acp.AgentApp {
  const sessions = new Map<string, Session>()
  const infos = new Map<string, SessionInfo>()
  const store = options.sessionsDir ? new SessionStore(options.sessionsDir) : null
  const usageLog = options.usageDir ? new UsageLog(options.usageDir) : null

  const sessionOf = (sessionId: string): Session => {
    const session = sessions.get(sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(sessionId)
    return session
  }

  const requireStore = (): SessionStore => {
    if (!store) throw acp.RequestError.invalidRequest(undefined, '没有配置会话存储')
    return store
  }

  // 新建和加载共用：设置每次都用调用方传来的（模型、检查、规范可能已经改过），对话历史来自记录
  const openSession = async (cwd: string, rawMeta: unknown, record?: SessionRecord) => {
    const meta = newSessionMetaSchema.safeParse(rawMeta)
    if (!meta.success) throw acp.RequestError.invalidParams(meta.error.issues, '缺少或无效的 _meta.diffra 会话配置')
    const dir = await stat(cwd).catch(() => null)
    if (!dir?.isDirectory()) throw acp.RequestError.invalidParams(undefined, `项目目录不存在：${cwd}`)

    const config = meta.data.diffra
    const environment = { bashPath: await findBash(), rgPath: await findRipgrep() }
    const checkpoints = config.checkpointDir
      ? await Checkpoints.open(config.checkpointDir, cwd, config.readOnlyPaths).catch((error: unknown) => {
          console.error('[session] 检查点仓库初始化失败', error)
          return null
        })
      : null
    const rulePacks =
      config.rules.packs.length > 0 ? selectRulePacks(config.rules.packs, await detectLanguages(cwd, environment.rgPath)) : []
    const session = new Session({
      cwd,
      config,
      environment,
      checkpoints,
      rulePacks,
      systemPrompt: await buildSystemPrompt(cwd, environment.bashPath, config, rulePacks),
      record,
    })
    const info: SessionInfo = {
      bashPath: environment.bashPath,
      checkpoints: checkpoints !== null,
      rulePacks: rulePacks.map((pack) => pack.name),
    }
    sessions.set(session.id, session)
    infos.set(session.id, info)
    return { session, info }
  }

  // 还没开始过任务的会话不落盘，免得每次打开项目都留下一条空记录
  const persist = async (session: Session, notify: (update: acp.SessionUpdate) => Promise<void>) => {
    if (!store || session.turns.length === 0) return
    try {
      await store.save(session.toRecord())
    } catch (error) {
      console.error('[sessions] 会话记录保存失败', error)
      await notify({
        sessionUpdate: 'notice',
        severity: 'warning',
        title: '会话记录保存失败',
        description: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    }
  }

  return acp
    .agent({ name: AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: store !== null,
        sessionCapabilities: store ? { list: {}, delete: {} } : {},
      },
      agentInfo: { name: AGENT_NAME, version: CORE_VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const { session, info } = await openSession(params.cwd, params._meta)
      return { sessionId: session.id, _meta: { diffra: info } }
    })
    // Diffra 的界面一次拿到整段历史，所以历史放在响应的 _meta 里，不逐条回放 session/update
    .onRequest(acp.methods.agent.session.load, async ({ params }) => {
      const live = sessions.get(params.sessionId)
      const liveInfo = infos.get(params.sessionId)
      if (live?.running && liveInfo) {
        const loaded: LoadedSession = { info: liveInfo, title: live.title, turns: live.turns }
        return { _meta: { diffra: loaded } }
      }
      const record = live ? live.toRecord() : await requireStore().load(params.sessionId)
      if (!sameDir(record.cwd, params.cwd)) throw acp.RequestError.invalidParams(undefined, '项目目录和会话记录不一致')
      const { session, info } = await openSession(record.cwd, params._meta, record)
      const loaded: LoadedSession = { info, title: session.title, turns: session.turns }
      return { _meta: { diffra: loaded } }
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }) => ({
      sessions: (await requireStore().list(params.cwd ?? undefined)).map((entry) => {
        const meta: StoredSessionMeta = { createdAt: entry.createdAt, archived: entry.archived, turnCount: entry.turnCount }
        return { sessionId: entry.id, cwd: entry.cwd, title: entry.title, updatedAt: entry.updatedAt, _meta: { diffra: meta } }
      }),
    }))
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      if (sessions.get(params.sessionId)?.running) throw new Error('任务还在进行中，先停止再删除')
      sessions.delete(params.sessionId)
      infos.delete(params.sessionId)
      await requireStore().remove(params.sessionId)
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      const meta = promptMetaSchema.safeParse(params._meta)
      const turnId = meta.success ? meta.data.diffra.turnId : randomUUID()
      const text = params.prompt
        .map((block) => (block.type === 'text' ? block.text : `[${block.type} content is not supported yet]`))
        .join('\n')
      const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update })

      session.startTurn(turnId, text)
      await persist(session, notify)
      let stopReason: acp.StopReason = 'end_turn'
      try {
        stopReason = await runTurn(session, { id: turnId, text }, {
          update: async (update) => {
            session.recordUpdate(update)
            await notify(update)
          },
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
          // 用量只用于统计，写失败不打断任务
          recordUsage: async (call) => {
            if (!usageLog) return
            try {
              await usageLog.append(toUsageRecord(call, session, new Date()))
            } catch (error) {
              console.error(`[usage] 会话 ${session.id} 的用量记录写入失败`, error)
            }
          },
        })
      } finally {
        session.endTurn(stopReason)
        await persist(session, notify)
      }
      return { stopReason }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.cancel()
    })
    .onRequest(SESSION_EXT_METHODS.checkpointPreview, checkpointParams, ({ params }) =>
      sessionOf(params.sessionId).checkpointChanges(params.turnId),
    )
    .onRequest(SESSION_EXT_METHODS.checkpointRestore, checkpointParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const changes = await session.restoreCheckpoint(params.turnId)
      await persist(session, (update) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update }))
      return changes
    })
    .onRequest(SESSION_EXT_METHODS.sessionUpdate, sessionUpdateParams, async ({ params }) => {
      const entry = await requireStore().update(params.sessionId, { title: params.title, archived: params.archived })
      const live = sessions.get(params.sessionId)
      if (live) {
        live.title = entry.title
        live.archived = entry.archived
      }
      return entry
    })
    .onRequest(SESSION_EXT_METHODS.sessionSearch, z.object({ query: z.string() }), ({ params }) => requireStore().search(params.query))
    .onRequest(SESSION_EXT_METHODS.sessionConfigure, sessionConfigureParams, ({ params }) => {
      const session = sessionOf(params.sessionId)
      if (params.permissionMode) session.permissionMode = params.permissionMode
      if (params.model) session.setModel(params.model)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.sessionRewind, checkpointParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const result = await session.rewind(params.turnId)
      await persist(session, (update) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update }))
      return result
    })
    .onRequest(SESSION_EXT_METHODS.checkpointDiff, checkpointParams, ({ params }) =>
      sessionOf(params.sessionId).checkpointDiff(params.turnId),
    )
    .onRequest(SESSION_EXT_METHODS.usageSummary, usageQueryParams, async ({ params }) => {
      if (!usageLog) throw acp.RequestError.invalidRequest(undefined, '没有配置用量记录')
      const from = new Date(params.from)
      const to = new Date(params.to)
      const aggregator = new UsageAggregator(from, to, params.timeZone)
      const { skippedLines } = await usageLog.scan(from, to, (record) => aggregator.add(record))
      return aggregator.result(skippedLines)
    })
    .onRequest(EXT_METHODS.listModels, z.object({ endpoint: endpointSchema }), ({ params }) =>
      listModels(params.endpoint),
    )
    .onRequest(
      EXT_METHODS.testModel,
      z.object({ endpoint: endpointSchema, modelId: z.string().min(1) }),
      ({ params }) => testModel(params.endpoint, params.modelId),
    )
}
