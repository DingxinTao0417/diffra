import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as acp from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { Checkpoints } from './checkpoint.js'
import { findBash, findRipgrep } from './environment.js'
import { listModels, testModel } from './models/operations.js'
import { EXT_METHODS } from './models/types.js'
import {
  type BrowserActionParams,
  type BrowserActionResult,
  CLIENT_EXT_METHODS,
  type DesignActionParams,
  type DesignActionResult,
  type DevServerParams,
  type DevServerResult,
  type LoadedSession,
  PROMPT_IMAGE_TYPES,
  type PromptImage,
  SESSION_EXT_METHODS,
  MANUAL_COMPACTION_PROMPT,
  type SessionInfo,
  type StoredSessionMeta,
  type TurnKind,
} from './protocol.js'
import { countLanguages, listProjectFiles } from './rules/languages.js'
import { selectRulePacks } from './rules/select.js'
import { commandRoots, loadCommands } from './commands.js'
import { McpPool } from './mcp.js'
import { inspectPlugin, pluginMcpServers, pluginSkillRoots } from './plugins.js'
import {
  endpointSchema,
  mcpServerSchema,
  modelConfigSchema,
  newSessionMetaSchema,
  pluginRefSchema,
  promptMetaSchema,
  sessionDesignSchema,
} from './session/config.js'
import { DEEP_SCAN_TITLES, runDeepScan } from './security/deep.js'
import { runPlan } from './session/plan.js'
import { compactManually } from './session/compact.js'
import type { Session as SessionType } from './session/session.js'
import { loadSkills, type Skill, skillRoots, withSkills } from './skills.js'
import { CHECK_TIMEOUT_SECONDS, runTurn, taskStateUpdate, taskStateView, type TurnIO } from './session/loop.js'
import { buildSystemPrompt } from './session/prompt.js'
import { detectChecks, hasFrontend } from './project/detect.js'
import { runShell } from './tools/command.js'
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
  // 测试时注入，用完自己关掉；正常运行时 core 退出，stdio 服务器读到输入结束自行退出
  mcpPool?: McpPool
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
  // 设计面板的工具；null 是收回
  design: sessionDesignSchema.nullable().optional(),
})

const deepScanParams = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1), scope: z.enum(['task', 'project']) })
const planParams = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  prompt: z.string().trim().min(1),
  skills: z.array(z.string().min(1)).default([]),
})

const mcpTargetParams = z.union([
  z.object({ sessionId: z.string().min(1) }),
  z.object({ cwd: z.string().min(1), servers: z.array(mcpServerSchema), plugins: z.array(pluginRefSchema).default([]) }),
])

const listTargetParams = z.union([
  z.object({ sessionId: z.string().min(1) }),
  z.object({ cwd: z.string().min(1), plugins: z.array(pluginRefSchema).default([]) }),
])

// 一次最多汇总 400 天，避免一个请求扫完所有历史
const MAX_USAGE_RANGE_MS = 400 * 86_400_000
const usageQueryParams = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime(), timeZone: z.string().refine(isTimeZone, '无效的时区') })
  .refine((query) => Date.parse(query.from) < Date.parse(query.to), '开始时间要早于结束时间')
  .refine((query) => Date.parse(query.to) - Date.parse(query.from) <= MAX_USAGE_RANGE_MS, '一次最多统计 400 天')

const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

// 客户端处理请求时抛的错，原文在 data.details 里
function clientErrorMessage(error: unknown): string {
  const data = error instanceof acp.RequestError ? error.data : null
  const details = typeof data === 'object' && data !== null && 'details' in data ? data.details : null
  if (typeof details === 'string' && details) return details
  return error instanceof Error ? error.message : String(error)
}

// 用户选的 Skill 按名字取出来；有一个找不到就不开始这一轮，免得悄悄少了说明
async function selectedSkills(session: SessionType, names: string[]): Promise<Skill[]> {
  if (names.length === 0) return []
  const skills = await loadSkills(skillRoots(session.cwd, pluginSkillRoots(session.config.plugins)))
  const missing = names.filter((name) => !skills.some((skill) => skill.name === name))
  if (missing.length > 0) throw new Error(`找不到 Skill：${missing.join('、')}`)
  return names.flatMap((name) => skills.filter((skill) => skill.name === name))
}

export function createAgent(options: AgentOptions = {}): acp.AgentApp {
  const sessions = new Map<string, Session>()
  const infos = new Map<string, SessionInfo>()
  const store = options.sessionsDir ? new SessionStore(options.sessionsDir) : null
  const usageLog = options.usageDir ? new UsageLog(options.usageDir) : null
  const mcpPool = options.mcpPool ?? new McpPool()

  // 只留还开着的任务用到的 MCP 连接
  const retainMcp = () =>
    mcpPool.retain([...sessions.values()].map((session) => ({ cwd: session.cwd, servers: session.mcpServers }))).catch((error: unknown) =>
      console.error('[mcp] 清理连接失败', error),
    )

  const mcpTarget = async (params: z.infer<typeof mcpTargetParams>) => {
    if (!('sessionId' in params)) return { cwd: params.cwd, servers: [...params.servers, ...(await pluginMcpServers(params.plugins))] }
    const session = sessionOf(params.sessionId)
    return { cwd: session.cwd, servers: session.mcpServers }
  }

  // 任务里按建任务时开着的插件列，和选 Skill 一致
  const listTarget = (params: z.infer<typeof listTargetParams>) => {
    if (!('sessionId' in params)) return params
    const session = sessionOf(params.sessionId)
    return { cwd: session.cwd, plugins: session.config.plugins }
  }

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
  const openSession = async (cwd: string, rawMeta: unknown, mcpServers: acp.McpServer[], record?: SessionRecord) => {
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
    const files = await listProjectFiles(cwd, environment.rgPath)
    const rulePacks = config.rules.packs.length > 0 ? selectRulePacks(config.rules.packs, countLanguages(files)) : []
    const roots = skillRoots(cwd, pluginSkillRoots(config.plugins))
    const skills = (await loadSkills(roots)).map(({ body: _body, ...info }) => info)
    const frontend = hasFrontend(files) ? { browser: config.browser, screenshots: config.browser && config.model.supportsImages } : null
    const session = new Session({
      cwd,
      config,
      environment,
      checkpoints,
      rulePacks,
      systemPrompt: await buildSystemPrompt(cwd, environment.bashPath, config, rulePacks, { skills, frontend }),
      readRoots: roots.map((root) => root.dir),
      mcpServers: [...mcpServers, ...(await pluginMcpServers(config.plugins))],
      mcpPool,
      record,
    })
    const info: SessionInfo = {
      bashPath: environment.bashPath,
      checkpoints: checkpoints !== null,
      rulePacks: rulePacks.map((pack) => pack.name),
      security: config.security,
      checks: config.checks,
    }
    sessions.set(session.id, session)
    infos.set(session.id, info)
    void retainMcp()
    mcpPool.warmUp(cwd, session.mcpServers)
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

  // 开始一轮、保存、跑完后再保存；过程中的会话更新同时记进这一轮并推给界面
  const runRecordedTurn = async (
    session: Session,
    client: acp.AgentContext,
    turnId: string,
    text: string,
    kind: TurnKind,
    skills: string[],
    images: PromptImage[],
    run: (io: TurnIO) => Promise<acp.StopReason>,
  ): Promise<acp.StopReason> => {
    const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update })
    session.startTurn(turnId, text, kind, skills, images)
    await persist(session, notify)
    let stopReason: acp.StopReason = 'end_turn'
    try {
      stopReason = await run({
        update: async (update) => {
          session.recordUpdate(update)
          await notify(update)
          if (update.sessionUpdate === 'session_info_update' && update._meta && 'diffra' in update._meta) await persist(session, notify)
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
        browser: (action, signal) =>
          client
            .request<BrowserActionResult, BrowserActionParams>(
              CLIENT_EXT_METHODS.browserAction,
              { sessionId: session.id, ...action },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            )
            .catch((error: unknown) => {
              throw new Error(clientErrorMessage(error))
            }),
        devServer: (params, signal) =>
          client
            .request<DevServerResult, DevServerParams>(
              CLIENT_EXT_METHODS.devServer,
              { sessionId: session.id, ...params },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            )
            .catch((error: unknown) => {
              throw new Error(clientErrorMessage(error))
            }),
        design: (tool, args, signal) =>
          client
            .request<DesignActionResult, DesignActionParams>(
              CLIENT_EXT_METHODS.designAction,
              { sessionId: session.id, tool, args },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            )
            .catch((error: unknown) => {
              throw new Error(clientErrorMessage(error))
            }),
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
    return stopReason
  }

  return acp
    .agent({ name: AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: store !== null,
        sessionCapabilities: store ? { list: {}, delete: {} } : {},
        mcpCapabilities: { http: true, sse: false },
      },
      agentInfo: { name: AGENT_NAME, version: CORE_VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const { session, info } = await openSession(params.cwd, params._meta, params.mcpServers)
      return { sessionId: session.id, _meta: { diffra: info } }
    })
    // Diffra 的界面一次拿到整段历史，所以历史放在响应的 _meta 里，不逐条回放 session/update
    .onRequest(acp.methods.agent.session.load, async ({ params }) => {
      const live = sessions.get(params.sessionId)
      const liveInfo = infos.get(params.sessionId)
      if (live?.running && liveInfo) {
        const loaded: LoadedSession = { info: liveInfo, title: live.title, turns: live.turns, taskState: taskStateView(live), design: live.designTask, noProject: live.noProject }
        return { _meta: { diffra: loaded } }
      }
      const record = live ? live.toRecord() : await requireStore().load(params.sessionId)
      if (!sameDir(record.cwd, params.cwd)) throw acp.RequestError.invalidParams(undefined, '项目目录和会话记录不一致')
      const { session, info } = await openSession(record.cwd, params._meta, params.mcpServers ?? [], record)
      // 没在运行却是 running，说明还没有确定的任务状态，交给界面按轮次推导
      const loaded: LoadedSession = { info, title: session.title, turns: session.turns, ...(session.taskState.status === 'running' ? {} : { taskState: taskStateView(session) }), design: session.designTask, noProject: session.noProject }
      return { _meta: { diffra: loaded } }
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }) => ({
      sessions: (await requireStore().list(params.cwd ?? undefined)).map((entry) => {
        const meta: StoredSessionMeta = {
          createdAt: entry.createdAt,
          archived: entry.archived,
          turnCount: entry.turnCount,
          design: entry.design,
          noProject: entry.noProject,
        }
        return { sessionId: entry.id, cwd: entry.cwd, title: entry.title, updatedAt: entry.updatedAt, _meta: { diffra: meta } }
      }),
    }))
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      if (sessions.get(params.sessionId)?.running) throw new Error('任务还在进行中，先停止再删除')
      sessions.delete(params.sessionId)
      infos.delete(params.sessionId)
      // 等 stdio 服务器退出再返回：Windows 上它们的当前目录就是任务目录，调用方接着要删这个目录
      await retainMcp()
      await requireStore().remove(params.sessionId)
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      const meta = promptMetaSchema.safeParse(params._meta)
      const turnId = meta.success ? meta.data.diffra.turnId : randomUUID()
      const text = params.prompt
        .flatMap((block) => (block.type === 'text' ? [block.text] : block.type === 'image' ? [] : [`[${block.type} content is not supported yet]`]))
        .join('\n')
      const images = params.prompt.flatMap((block): PromptImage[] => {
        if (block.type !== 'image') return []
        const mimeType = PROMPT_IMAGE_TYPES.find((type) => type === block.mimeType)
        if (!mimeType) throw new Error(`不支持的图片格式：${block.mimeType}`)
        return [{ mimeType, data: block.data }]
      })
      // 模型不支持图片时 API 会直接报错，先在这里说明去哪里改
      if (images.length > 0 && !session.config.model.supportsImages) {
        throw new Error(`这个任务用的模型 ${session.config.model.modelId} 没有打开「视觉」，发不了图片。确认模型支持视觉后，到「设置 → 模型与角色」里，在这个模型的「配置能力」中打开「视觉」。设置里改过的，要新建任务或在输入框里重新选一次这个模型才生效`)
      }
      const skillNames = meta.success ? meta.data.diffra.skills : []
      const goal = meta.success && meta.data.diffra.goal
      const skills = await selectedSkills(session, skillNames)
      const stopReason = await runRecordedTurn(session, client, turnId, text, goal ? 'goal' : 'prompt', skillNames, images, (io) =>
        runTurn(session, { id: turnId, text: withSkills(text, skills), images }, io, goal ? { goalMaxRounds: session.config.limits.goalMaxRounds } : {}),
      )
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.compact, checkpointParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('任务还在进行中，结束后再压缩上下文')
      const stopReason = await runRecordedTurn(session, client, params.turnId, MANUAL_COMPACTION_PROMPT, 'compact', [], [], (io) => compactManually(session, io))
      return { stopReason }
    })
    // 深度安全扫描作为一轮记进会话：进度实时显示、能停止、存进历史
    .onRequest(SESSION_EXT_METHODS.deepScan, deepScanParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      const stopReason = await runRecordedTurn(session, client, params.turnId, DEEP_SCAN_TITLES[params.scope], 'deep-scan', [], [], (io) =>
        runDeepScan(session, { id: params.turnId }, params.scope, io),
      )
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.mcpStatus, z.object({ target: mcpTargetParams, retry: z.boolean().default(false) }), async ({ params }) => {
      const { cwd, servers } = await mcpTarget(params.target)
      return mcpPool.status(cwd, servers, params.retry)
    })
    .onRequest(
      SESSION_EXT_METHODS.mcpPrompt,
      z.object({ target: mcpTargetParams, server: z.string().min(1), prompt: z.string().min(1), arguments: z.record(z.string(), z.string()) }),
      async ({ params }) => {
        const { cwd, servers } = await mcpTarget(params.target)
        const server = servers.find((item) => item.name === params.server)
        if (!server) throw new Error(`没有名为「${params.server}」的 MCP 服务器`)
        return mcpPool.promptText(cwd, server, params.prompt, params.arguments)
      },
    )
    .onRequest(SESSION_EXT_METHODS.skillsList, listTargetParams, async ({ params }) => {
      const { cwd, plugins } = listTarget(params)
      return (await loadSkills(skillRoots(cwd, pluginSkillRoots(plugins)))).map(({ body: _body, ...info }) => info)
    })
    .onRequest(SESSION_EXT_METHODS.commandsList, listTargetParams, ({ params }) => {
      const { cwd, plugins } = listTarget(params)
      return loadCommands(commandRoots(cwd, plugins))
    })
    .onRequest(SESSION_EXT_METHODS.pluginInspect, z.object({ dir: z.string().min(1) }), ({ params }) => inspectPlugin(params.dir))
    // 先出计划也作为一轮记进会话，和深度扫描一样
    .onRequest(SESSION_EXT_METHODS.plan, planParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      const skills = await selectedSkills(session, params.skills)
      const stopReason = await runRecordedTurn(session, client, params.turnId, params.prompt, 'plan', params.skills, [], (io) =>
        runPlan(session, { id: params.turnId, text: withSkills(params.prompt, skills) }, io),
      )
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
      const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update })
      const changes = await session.restoreCheckpoint(params.turnId)
      await persist(session, notify)
      await notify(taskStateUpdate(session))
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
      if (params.design !== undefined) session.design = params.design
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.sessionRewind, checkpointParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: session.id, update })
      const result = await session.rewind(params.turnId)
      await persist(session, notify)
      await notify(taskStateUpdate(session))
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
    .onRequest(SESSION_EXT_METHODS.projectDetectChecks, z.object({ cwd: z.string().min(1) }), async ({ params }) => {
      if (!(await stat(params.cwd).catch(() => null))?.isDirectory()) throw new Error(`项目目录不存在：${params.cwd}`)
      return detectChecks(params.cwd)
    })
    // 用户在项目设置里点「试运行」；和任务里的检查一样用 Git Bash、同样的超时
    .onRequest(SESSION_EXT_METHODS.projectRunCheck, z.object({ cwd: z.string().min(1), command: z.string().trim().min(1) }), async ({ params }) => {
      const result = await runShell({ cwd: params.cwd, bashPath: await findBash(), signal: new AbortController().signal }, params.command, CHECK_TIMEOUT_SECONDS)
      return { passed: result.exitCode === 0 && !result.timedOut && !result.aborted, summary: result.summary }
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
