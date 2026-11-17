import { stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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
  type ComputerActionParams,
  type ComputerActionResult,
  ASK_ANSWERS_META_KEY,
  CLIENT_EXT_METHODS,
  CLIENT_EXT_NOTIFICATIONS,
  type DesignActionParams,
  type DesignActionResult,
  type StockPhotoParams,
  type StockPhotoResult,
  type DevServerParams,
  type DevServerResult,
  type ExternalAgentDetection,
  type ExternalAgentSpec,
  type LoadedSession,
  MAX_CANDIDATES,
  PROMPT_ENHANCE_USAGE_ID,
  PROMPT_IMAGE_TYPES,
  type PromptImage,
  TASK_PROGRESS_META_KEY,
  type RemoteSnapshot,
  SESSION_EXT_METHODS,
  MANUAL_COMPACTION_PROMPT,
  type SessionInfo,
  type StoredSessionMeta,
  type StoredTurn,
  type TaskActionParams,
  type TaskActionResult,
  type TodoActionParams,
  type TodoActionResult,
  type RemoteSource,
  type TaskSource,
  type TurnKind,
  UPDATE_SEQ_META_KEY,
  VISUAL_SNAPSHOT_MAX_CHARS,
  VISUAL_SNAPSHOT_TYPES,
} from './protocol.js'
import { countLanguages, listProjectFiles } from './rules/languages.js'
import { selectRulePacks } from './rules/select.js'
import { commandRoots, loadCommands } from './commands.js'
import { McpPool } from './mcp.js'
import { loadAgentTypes } from './subagents.js'
import { memoryPrompt, readMemory, rememberTurn } from './session/memory.js'
import { inspectPlugin, pluginBlocks, pluginHooks, pluginLspServers, pluginMcpServers, pluginSkillRoots } from './plugins.js'
import { LspPool } from './lsp/pool.js'
import { commandRisk } from './permissions.js'
import { sessionStartContext } from './session/plugin-hooks.js'
import { planStepsInstruction, presetSteps } from './session/interact.js'
import {
  checkSwitchesSchema,
  endpointSchema,
  externalAgentSpecSchema,
  externalLoadMetaSchema,
  externalSessionMetaSchema,
  mcpServerSchema,
  modelConfigSchema,
  newSessionMetaSchema,
  pluginRefSchema,
  promptMetaSchema,
  sessionDesignSchema,
} from './session/config.js'
import { setBrowserSites } from './session/browser.js'
import { DEEP_SCAN_TITLES, runDeepScan } from './security/deep.js'
import { enhancePrompt } from './prompt-enhance.js'
import { runDiagnose } from './session/diagnose.js'
import { runApplyDiff } from './session/apply-diff.js'
import { compactTurns } from './session/edit-diff.js'
import { runPlan } from './session/plan.js'
import { compactManually } from './session/compact.js'
import type { Session as SessionType } from './session/session.js'
import { loadSkills, type Skill, skillRoots, withSkills } from './skills.js'
import { CHECK_TIMEOUT_SECONDS, runTurn, taskStateUpdate, taskStateView, type TurnIO } from './session/loop.js'
import { buildSystemPrompt } from './session/prompt.js'
import { registerArchitecture } from './architecture/handlers.js'
import type { ArchitectureEvent } from './architecture/model.js'
import { ArchitectureService } from './architecture/service.js'
import { DYNAMIC_MAX_ROUTES } from './security/dynamic.js'
import { runSecurityTool, SECURITY_TOOLS, securityToolsInfo } from './security/tools.js'
import { detectChecks, hasFrontend } from './project/detect.js'
import { runShell } from './tools/command.js'
import { restoredTaskState, Session } from './session/session.js'
import { type SessionRecord, SessionStore, toEntry } from './session/store.js'
import { toUsageRecord, UsageLog } from './usage/log.js'
import { isTimeZone, UsageAggregator } from './usage/summary.js'
import { exportUsageCsv } from './usage/export.js'
import { PRICE_PATTERN } from './usage/pricing.js'
import { CORE_VERSION } from './version.js'
import { ExternalAgentError, ExternalAgentProcess } from './external/connection.js'
import { ExternalSession } from './external/session.js'
import { applyCandidate, type CandidateHost, candidateDiff, candidateRunOf, cleanupRun, discardCandidates, recoverRuns, runCandidates, runCardUpdate } from './session/candidates.js'
import { collaborationRuntime, collaborationView } from './session/collaboration.js'
import { TaskMailbox } from './session/task-mailbox.js'
import { disposeWorkerWorktree, restoreWorkerWorktree } from './session/collaboration-worktrees.js'

export const AGENT_NAME = 'diffra-core'

// 电脑操控的一步（截屏、点击、输入）最多等客户端这么久
const COMPUTER_REQUEST_TIMEOUT_MS = 30_000

export interface AgentOptions {
  // 会话记录存放的目录；不给就不保存，session/load、list、delete 都不可用
  sessionsDir?: string | null
  // 用量记录存放的目录；不给就不记录，用量汇总不可用
  usageDir?: string | null
  // 测试时注入，用完自己关掉；正常运行时 core 退出，stdio 服务器读到输入结束自行退出
  mcpPool?: McpPool
  // 插件的语言服务器（v2）；测试时注入以缩短等待。客户端断开时全部停掉
  lspPool?: LspPool
  // 架构分析的数据目录；不给就不提供架构功能
  architectureDir?: string | null
  // 多候选方案的 git worktree 放在这里；不给就用系统临时目录
  worktreesDir?: string | null
}

const checkpointParams = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) })
const processParams = z.object({ sessionId: z.string().min(1), id: z.number().int() })
const visualSnapshotParams = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  image: z.object({ mimeType: z.enum(VISUAL_SNAPSHOT_TYPES), data: z.base64().max(VISUAL_SNAPSHOT_MAX_CHARS) }),
})
const sessionUpdateParams = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(100).optional(),
  archived: z.boolean().optional(),
  // v2：无项目任务转成正式项目（原地转换：清掉标记，文件夹不动）
  promote: z.literal(true).optional(),
})

// 设备连接读一页轮次：before 是这一页取到第几轮之前（不含），不给是取到最后；超过 maxChars 就少取几轮，但至少一轮
const remoteSnapshotParams = z.object({
  sessionId: z.string().min(1),
  before: z.number().int().nonnegative().optional(),
  maxTurns: z.number().int().min(1).max(50).default(10),
  maxChars: z.number().int().min(1).default(1_000_000),
})

const browserSitesParams = z.object({ allow: z.array(z.string().trim().min(1).max(253)).max(500), block: z.array(z.string().trim().min(1).max(253)).max(500) })

const sessionConfigureParams = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.enum(['ask', 'auto', 'full']).optional(),
  model: modelConfigSchema.optional(),
  // 设计面板的工具；null 是收回
  design: sessionDesignSchema.nullable().optional(),
})

const deepScanParams = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1), scope: z.enum(['task', 'project']) })
const promptEnhanceParams = z.object({
  model: modelConfigSchema,
  text: z.string().trim().min(1),
  cwd: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  mentions: z.array(z.string()),
  design: z.boolean(),
})

const diagnoseParams = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  prompt: z.string().trim().min(1),
  target: z.object({ turnId: z.string().min(1), cardId: z.string().min(1).nullable() }),
})

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
const usagePriceSchema = z.object({
  providerId: z.string().max(200).nullable(),
  modelId: z.string().min(1).max(300),
  input: z.string().regex(PRICE_PATTERN),
  cachedInput: z.string().regex(PRICE_PATTERN).nullable().optional(),
  cacheWrite: z.string().regex(PRICE_PATTERN).nullable().optional(),
  output: z.string().regex(PRICE_PATTERN),
})

const usageQueryParams = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    timeZone: z.string().refine(isTimeZone, '无效的时区'),
    prices: z.array(usagePriceSchema).max(500).optional(),
    workspaceRoot: z.string().max(4096).nullable().optional(),
  })
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

function withSeq(update: acp.SessionUpdate, seq: number): acp.SessionUpdate {
  const diffra = update._meta?.diffra
  return { ...update, _meta: { ...update._meta, diffra: { ...(typeof diffra === 'object' && diffra !== null ? diffra : {}), [UPDATE_SEQ_META_KEY]: seq } } }
}

// 确认请求：选中的 optionId，提问还带回答案（_meta.diffra.askAnswers）；取消、出错是 null
async function askClient(session: Pick<Session, 'id' | 'activeTurn'>, client: acp.AgentContext, toolCall: acp.ToolCallUpdate, options: acp.PermissionOption[], signal?: AbortSignal): Promise<{ optionId: string; answers?: unknown } | null> {
  try {
    const response = await client.request(
      acp.methods.client.session.requestPermission,
      { sessionId: session.id, toolCall, options },
      // 用户点「停止」时不再等确认结果
      signal || session.activeTurn ? { cancellationSignal: AbortSignal.any([...(signal ? [signal] : []), ...(session.activeTurn ? [session.activeTurn.signal] : [])]), stopWaitingOnCancel: true } : undefined,
    )
    if (response.outcome.outcome !== 'selected') return null
    const diffra = response._meta?.diffra
    const answers = typeof diffra === 'object' && diffra !== null ? (diffra as Record<string, unknown>)[ASK_ANSWERS_META_KEY] : undefined
    return { optionId: response.outcome.optionId, ...(answers === undefined ? {} : { answers }) }
  } catch (error) {
    console.error('[session] 权限请求失败', error)
    return null
  }
}

// 从 before 往前取，最多 maxTurns 轮、压缩后最多 maxChars 字；一轮就超过时也给这一轮。
// 给的是当下的副本：正在跑的那一轮还会往 updates 里加，响应发出去之前加的不能混进这一页
function snapshotPage(all: StoredTurn[], before: number, maxTurns: number, maxChars: number): { start: number; turns: StoredTurn[] } {
  const turns: StoredTurn[] = []
  let chars = 0
  for (let index = before - 1; index >= 0 && turns.length < maxTurns; index--) {
    const text = JSON.stringify(compactTurns([all[index]!])[0])
    if (turns.length > 0 && chars + text.length > maxChars) break
    chars += text.length
    turns.unshift(JSON.parse(text) as StoredTurn)
  }
  return { start: before - turns.length, turns }
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
  // 更多安全检查（v2）正在跑的：runId → 取消用的控制器
  const securityRuns = new Map<string, AbortController>()
  const infos = new Map<string, SessionInfo>()
  // 外接智能体的任务（v2）：和 Diffra 自己的会话分开放，只支持提问、停止、撤销改动、看改动、改名归档
  const externals = new Map<string, ExternalSession>()
  // 设置里的外接智能体清单（SESSION_EXT_METHODS.externalAgents），按 id
  const externalAgents = new Map<string, ExternalAgentSpec>()
  const store = options.sessionsDir ? new SessionStore(options.sessionsDir) : null
  const mailbox = options.sessionsDir ? new TaskMailbox(join(options.sessionsDir, 'task-mailbox')) : null
  const mailboxReady = mailbox?.recover()
  void mailboxReady?.catch((error: unknown) => console.error('[tasks] 持久消息恢复失败，投递将保持关闭', error))
  const taskClients = new Map<string, acp.AgentContext>()
  const mailboxRunning = new Set<string>()
  const usageLog = options.usageDir ? new UsageLog(options.usageDir) : null
  const mcpPool = options.mcpPool ?? new McpPool()
  const lspPool = options.lspPool ?? new LspPool()
  let notifyArchitecture: (event: ArchitectureEvent) => void = () => {}
  const architecture = options.architectureDir ? new ArchitectureService(options.architectureDir, findRipgrep, (event) => notifyArchitecture(event)) : null
  // 会话更新的序号（见 UPDATE_SEQ_META_KEY）按会话 id 记，重新载入会话（换了 Session 对象）也接着往上数
  const epoch = randomUUID()
  const updateSeqs = new Map<string, number>()
  // 序号在发出的这一刻同步加上：和 recordUpdate 之间没有 await，读快照时轮次和序号对得上
  const notifier = (client: acp.AgentContext, sessionId: string) => (update: acp.SessionUpdate) => {
    const seq = (updateSeqs.get(sessionId) ?? 0) + 1
    updateSeqs.set(sessionId, seq)
    return client.notify(acp.methods.client.session.update, { sessionId, update: withSeq(update, seq) })
  }

  // 只留还开着的任务用到的 MCP 连接；语言服务器只留这些任务所在项目的
  const retainMcp = () =>
    Promise.all([
      mcpPool.retain([...sessions.values()].map((session) => ({ cwd: session.cwd, servers: session.mcpServers }))).catch((error: unknown) =>
        console.error('[mcp] 清理连接失败', error),
      ),
      lspPool.retain([...sessions.values()].map((session) => session.cwd)).catch((error: unknown) => console.error('[lsp] 清理语言服务器失败', error)),
    ])

  const mcpTarget = async (params: z.infer<typeof mcpTargetParams>) => {
    if (!('sessionId' in params)) return { cwd: params.cwd, servers: [...params.servers, ...(await pluginMcpServers(params.plugins))] }
    const external = externals.get(params.sessionId)
    if (external) return { cwd: external.cwd, servers: [] }
    const session = sessionOf(params.sessionId)
    return { cwd: session.cwd, servers: session.mcpServers }
  }

  // 任务里按建任务时开着的插件列，和选 Skill 一致
  const listTarget = (params: z.infer<typeof listTargetParams>) => {
    if (!('sessionId' in params)) return params
    // 外接智能体的任务：选的 Skill 照样放进提问；插件是 Diffra 的，不带
    const external = externals.get(params.sessionId)
    if (external) return { cwd: external.cwd, plugins: [] }
    const session = sessionOf(params.sessionId)
    return { cwd: session.cwd, plugins: session.config.plugins }
  }

  const sessionOf = (sessionId: string): Session => {
    const session = sessions.get(sessionId)
    if (!session) {
      const external = externals.get(sessionId)
      if (external) throw new Error(`这是 ${external.agent.name} 的任务，不支持这个操作`)
      throw acp.RequestError.resourceNotFound(sessionId)
    }
    return session
  }

  // 多候选方案：候选在 worktree 里起的会话和主会话同样的模型、规则、插件、权限模式，不带浏览器、设计、MCP 和记忆，检查点放在 worktree 旁边
  const worktreesDir = options.worktreesDir ?? join(tmpdir(), 'diffra-worktrees')
  const candidateHost = (parent: Session): CandidateHost => ({
    worktreesDir,
    child: async (cwd, checkpointDir, readOnlyPaths) => {
      const config = {
        ...parent.config,
        permissionMode: parent.permissionMode,
        browser: false,
        design: false,
        designStyle: null,
        memoryDir: null,
        checkpointDir,
        readOnlyPaths: [...parent.config.readOnlyPaths, ...readOnlyPaths],
      }
      const checkpoints = await Checkpoints.open(checkpointDir, cwd, config.readOnlyPaths).catch((error: unknown) => {
        console.error('[candidates] 候选的检查点仓库初始化失败', error)
        return null
      })
      return new Session({
        cwd,
        config,
        environment: parent.environment,
        checkpoints,
        rulePacks: parent.rulePacks,
        systemPrompt: parent.systemPrompt,
        workerPrompt: parent.workerPrompt,
        readRoots: parent.readRoots,
        outputRoot: null,
        agentTypes: parent.agentTypes,
        pluginHooks: parent.pluginHooks,
        pluginBlocks: parent.pluginBlocks,
        model: parent.model,
        reviewModel: parent.reviewModel,
        planModel: parent.planModel,
        ...(parent.fallbackModel ? { fallbackModel: parent.fallbackModel } : {}),
      })
    },
  })

  // 候选方案卡片在生成它的那一轮里：应用、放弃后补一条更新，推给界面、存盘（不改更新时间）
  const updateRunCard = async (session: Session, client: acp.AgentContext, runTurnId: string) => {
    const update = runCardUpdate(candidateRunOf(session, runTurnId), false)
    if (!session.appendToTurn(runTurnId, update)) return
    const notify = notifier(client, session.id)
    await notify(update)
    await persist(session, notify, false)
  }

  // 撤销改动、看改动这类两种任务都有的操作
  const anySessionOf = (sessionId: string): Session | ExternalSession => {
    const session = sessions.get(sessionId) ?? externals.get(sessionId)
    if (!session) throw acp.RequestError.resourceNotFound(sessionId)
    return session
  }

  const externalInfo = (session: ExternalSession): SessionInfo => ({
    bashPath: null,
    checkpoints: session.checkpoints !== null,
    rulePacks: [],
    security: {},
    checks: { afterEdit: null, beforeFinish: null },
  })

  // 外接智能体的任务：设置每次用客户端传来的（权限模式、检查点），对话历史来自记录。旧任务的智能体从设置里删掉了也能打开看，发消息时再说明
  const openExternal = async (cwd: string, rawMeta: unknown, record?: SessionRecord) => {
    const dir = await stat(cwd).catch(() => null)
    if (!dir?.isDirectory()) throw acp.RequestError.invalidParams(undefined, `项目目录不存在：${cwd}`)
    const created = externalSessionMetaSchema.safeParse(rawMeta)
    const loaded = created.success ? null : externalLoadMetaSchema.safeParse(rawMeta)
    const meta = created.success ? created.data.diffra : loaded?.success ? loaded.data.diffra : null
    if (!meta) throw acp.RequestError.invalidParams(undefined, '缺少或无效的 _meta.diffra 会话配置')
    const agentId = record?.agent?.id ?? (created.success ? created.data.diffra.external.agentId : null)
    const spec = agentId ? (externalAgents.get(agentId) ?? null) : null
    const agent = record?.agent ?? (spec ? { id: spec.id, name: spec.name } : null)
    if (!agent) throw acp.RequestError.invalidParams(undefined, `设置里没有这个外接智能体：${agentId ?? ''}`)
    const live = record ? externals.get(record.id) : undefined
    if (live) {
      live.permissionMode = meta.permissionMode
      live.spec = spec
      return { session: live, info: externalInfo(live) }
    }
    const checkpoints = meta.checkpointDir
      ? await Checkpoints.open(meta.checkpointDir, cwd, meta.readOnlyPaths).catch((error: unknown) => {
          console.error('[session] 检查点仓库初始化失败', error)
          return null
        })
      : null
    const session = new ExternalSession({ cwd, agent, spec, permissionMode: meta.permissionMode, checkpoints, noProject: meta.noProject, record })
    externals.set(session.id, session)
    return { session, info: externalInfo(session) }
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
    const blocks = await pluginBlocks(config.plugins)
    const promptContext = { skills, frontend, memory: memoryPrompt(await readMemory(config.memoryDir)), blocks }
    // 插件的 SessionStart 钩子在这里跑，输出放进主智能体的系统提示词；子智能体不带
    const hooks = await pluginHooks(config.plugins)
    const id = record?.id ?? randomUUID()
    const startContext = await sessionStartContext(hooks, { cwd, bashPath: environment.bashPath, sessionId: id })
    const systemPrompt = await buildSystemPrompt(environment.bashPath, config, rulePacks, promptContext)
    // 无项目任务从空文件夹开始，建会话时只有不分语言的规则包、没有前端做法（v2）：
    // 智能体在里面写了文件以后，下一轮开始时按新文件重新选一次（系统提示词只变这一次，提示词缓存只失效一次）
    const rebuildPrompt =
      config.noProject && files.length === 0
        ? async () => {
            const now = await listProjectFiles(cwd, environment.rgPath)
            if (now.length === 0) return null
            const packs = config.rules.packs.length > 0 ? selectRulePacks(config.rules.packs, countLanguages(now)) : []
            const context = { ...promptContext, frontend: hasFrontend(now) ? { browser: config.browser, screenshots: config.browser && config.model.supportsImages } : null }
            const main = await buildSystemPrompt(environment.bashPath, config, packs, context)
            return { rulePacks: packs, systemPrompt: startContext ? `${main}\n\n# Context from plugins\n\n${startContext}` : main, workerPrompt: await buildSystemPrompt(environment.bashPath, config, packs, { ...context, worker: true }) }
          }
        : undefined
    const session = new Session({
      worktreesRoot: options.worktreesDir ?? join(tmpdir(), 'diffra-worktrees'),
      id,
      cwd,
      config,
      environment,
      checkpoints,
      rulePacks,
      systemPrompt: startContext ? `${systemPrompt}\n\n# Context from plugins\n\n${startContext}` : systemPrompt,
      workerPrompt: await buildSystemPrompt(environment.bashPath, config, rulePacks, { ...promptContext, worker: true }),
      readRoots: roots.map((root) => root.dir),
      outputRoot: options.sessionsDir ?? null,
      agentTypes: await loadAgentTypes(cwd, config.plugins),
      pluginHooks: hooks,
      pluginBlocks: blocks,
      mcpServers: [...mcpServers, ...(await pluginMcpServers(config.plugins))],
      mcpPool,
      lsp: { pool: lspPool, servers: await pluginLspServers(config.plugins) },
      record,
      architecture,
      rebuildPrompt,
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
    // 上次生成候选方案到一半应用就退出了：清掉那些 worktree
    if (record && session.candidateRuns.some((run) => run.status === 'running')) {
      void recoverRuns(session)
        .then((changed) => (changed && store ? store.save(session.toRecord(false)) : undefined))
        .catch((error: unknown) => console.error('[candidates] 清理上次没跑完的候选方案失败', error))
    }
    void retainMcp()
    mcpPool.warmUp(cwd, session.mcpServers)
    return { session, info }
  }

  // 还没开始过任务的会话不落盘，免得每次打开项目都留下一条空记录
  const persist = async (session: Pick<Session, 'turns' | 'toRecord'>, notify: (update: acp.SessionUpdate) => Promise<void>, touch = true) => {
    if (!store || session.turns.length === 0) return
    try {
      await store.save(session.toRecord(touch))
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
    from?: TaskSource,
    remote?: RemoteSource,
    fromPlan?: string,
  ): Promise<acp.StopReason> => {
    taskClients.set(session.id, client)
    let permissionTail: Promise<unknown> = Promise.resolve()
    const notify = notifier(client, session.id)
    // 后台命令在一轮结束后还会退出：用这一轮的客户端推，不进会话记录（重开应用时进程已经不在了）
    session.execSessions.onChange = () =>
      void client.notify(CLIENT_EXT_NOTIFICATIONS.processes, { sessionId: session.id, processes: session.execSessions.background() }).catch(() => {})
    session.startTurn(turnId, text, kind, skills, images, from, remote, fromPlan)
    await persist(session, notify)
    let stopReason: acp.StopReason = 'end_turn'
    try {
      stopReason = await run({
        persist: async () => {
          if (store) await store.save(session.toRecord())
        },
        update: async (update) => {
          session.recordUpdate(update)
          await notify(update)
          if (update.sessionUpdate === 'session_info_update' && update._meta && 'diffra' in update._meta) await persist(session, notify)
        },
        requestPermission: (toolCall, options, signal) => {
          const asked = permissionTail.then(async () => {
            if (signal?.aborted || session.activeTurn?.signal.aborted) return null
            return (await askClient(session, client, toolCall, options, signal))?.optionId ?? null
          })
          permissionTail = asked.catch(() => null)
          return asked
        },
        requestAnswers: (toolCall, options) => askClient(session, client, toolCall, options),
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
        // 电脑操控（v2）：客户端那边每步有自己的时限，这里再兜 30 秒
        computer: (action, signal) =>
          client
            .request<ComputerActionResult, ComputerActionParams>(
              CLIENT_EXT_METHODS.computerAction,
              { sessionId: session.id, ...action },
              { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(COMPUTER_REQUEST_TIMEOUT_MS)]), stopWaitingOnCancel: true },
            )
            .catch((error: unknown) => {
              throw new Error(signal.aborted ? '已取消' : clientErrorMessage(error))
            }),
        tasks: {
          list: async () => (store ? store.list() : []),
          record: async (id) => {
            const live = sessions.get(id)
            if (live) return { title: live.title, cwd: live.cwd, running: live.running, turns: live.turns }
            if (!store) return null
            const stored = await store.load(id).catch(() => null)
            return stored ? { title: stored.title, cwd: stored.cwd, running: false, turns: stored.turns } : null
          },
          act: (params) =>
            dispatchTask(params, client),
          ...(mailbox ? { receipt: (id: string) => mailbox.get(id) } : {}),
        },
        todos: {
          act: (params) =>
            client
              .request<TodoActionResult, TodoActionParams>(CLIENT_EXT_METHODS.todoAction, { sessionId: session.id, ...params }, { cancellationSignal: AbortSignal.timeout(60_000), stopWaitingOnCancel: true })
              .catch((error: unknown): TodoActionResult => ({ ok: false, error: clientErrorMessage(error) })),
        },
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
        stockPhotos: (params, signal) =>
          client
            .request<StockPhotoResult, StockPhotoParams>(CLIENT_EXT_METHODS.stockPhotos, { sessionId: session.id, ...params }, { cancellationSignal: signal, stopWaitingOnCancel: true })
            .catch((error: unknown) => {
              throw new Error(clientErrorMessage(error))
            }),
        design: (tool, args, signal, agent) =>
          client
            .request<DesignActionResult, DesignActionParams>(
              CLIENT_EXT_METHODS.designAction,
              { sessionId: session.id, tool, args, agent: agent ?? null },
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
      if (mailbox) void drainMailbox(session.id).catch((error: unknown) => console.error(`[tasks] 会话 ${session.id} 排队投递失败`, error))
    }
    // 自动记忆：一轮正常结束后在后台挑出以后用得上的事记下来，不挡下一轮；出错只记日志
    const finished = session.turns.at(-1)
    if (session.config.memoryDir && finished && stopReason === 'end_turn' && (kind === 'prompt' || kind === 'goal')) {
      void rememberTurn(session, finished, async (call) => {
        if (usageLog) await usageLog.append(toUsageRecord(call, session, new Date()))
      }).catch((error: unknown) => console.error(`[memory] 会话 ${session.id} 的自动记忆失败`, error))
    }
    return stopReason
  }

  const drainMailbox = async (targetId: string): Promise<void> => {
    if (!mailbox) return
    await mailboxReady
    if (mailboxRunning.has(targetId)) return
    const target = sessions.get(targetId)
    const client = taskClients.get(targetId)
    if (!target || !client || target.running) return
    mailboxRunning.add(targetId)
    try {
      for (;;) {
        if (target.running) break
        const pending = (await mailbox.pending(targetId))[0]
        if (!pending) break
        const claimed = await mailbox.claim(pending.id)
        if (!claimed) continue
        try {
          const text = `来自任务「${claimed.from.title}」的${claimed.from.reply ? '回复' : '消息'}：\n\n${claimed.text}`
          target.turnRequested()
          await notifier(client, target.id)({ sessionUpdate: 'session_info_update', _meta: { diffra: { taskDelivery: { turnId: claimed.turnId, text, from: { ...claimed.from, messageId: claimed.id }, state: 'running' } } } })
          const result = await runRecordedTurn(target, client, claimed.turnId, text, 'prompt', [], [], (io) => runTurn(target, { id: claimed.turnId, text }, io), { ...claimed.from, messageId: claimed.id })
          if (store) await store.save(target.toRecord())
          await mailbox.finish(claimed.id, { status: result === 'cancelled' ? 'cancelled' : target.taskState.status === 'completed' ? 'completed' : 'failed', ...(target.taskState.reason ? { error: target.taskState.reason.slice(0, 4000) } : {}) })
          await notifier(client, target.id)({ sessionUpdate: 'session_info_update', _meta: { diffra: { taskDelivery: { turnId: claimed.turnId, text, from: { ...claimed.from, messageId: claimed.id }, state: 'ended', stopReason: result } } } })
        } catch (error) {
          await mailbox.finish(claimed.id, { status: 'failed', error: clientErrorMessage(error).slice(0, 4000) })
          console.error(`[tasks] 消息 ${claimed.id} 执行失败`, error)
        }
      }
    } finally {
      mailboxRunning.delete(targetId)
    }
  }

  const dispatchTask = async (params: TaskActionParams, client: acp.AgentContext): Promise<TaskActionResult> => {
    try {
      if (!mailbox) return await client.request<TaskActionResult, TaskActionParams>(CLIENT_EXT_METHODS.taskAction, params, { cancellationSignal: AbortSignal.timeout(60_000), stopWaitingOnCancel: true })
      await mailboxReady
      const prepared = await client.request<TaskActionResult, TaskActionParams>(CLIENT_EXT_METHODS.taskAction, { ...params, prepareOnly: true }, { cancellationSignal: AbortSignal.timeout(60_000), stopWaitingOnCancel: true })
      if (!prepared.ok) return prepared
      const target = sessions.get(prepared.sessionId)
      if (!target) return await client.request<TaskActionResult, TaskActionParams>(CLIENT_EXT_METHODS.taskAction, { ...params, ...(params.action === 'send' ? { target: prepared.sessionId } : {}), prepareOnly: false }, { cancellationSignal: AbortSignal.timeout(60_000), stopWaitingOnCancel: true })
      taskClients.set(target.id, client)
      if (store) await store.save(target.toRecord(false))
      const message = await mailbox.enqueue({ sourceSessionId: params.sessionId, targetSessionId: target.id, text: params.message, from: params.from })
      void drainMailbox(target.id).catch((error: unknown) => console.error(`[tasks] 消息 ${message.id} 调度失败`, error))
      return { ok: true, sessionId: target.id, title: target.title, queued: target.running, messageId: message.id, turnId: message.turnId }
    } catch (error) {
      return { ok: false, error: clientErrorMessage(error) }
    }
  }

  const resumePendingTasks = async (client: acp.AgentContext): Promise<void> => {
    if (!mailbox || !store) return
    await mailboxReady
    const targets = new Set((await mailbox.pending()).map((message) => message.targetSessionId))
    for (const target of targets) {
      const record = sessions.has(target) ? null : await store.load(target)
      await client.request<TaskActionResult, TaskActionParams>(CLIENT_EXT_METHODS.taskAction, { sessionId: target, action: 'send', target, message: '恢复此前已确认的待投递消息', from: { sessionId: target, title: record?.title ?? sessions.get(target)?.title ?? '' }, prepareOnly: true }, { cancellationSignal: AbortSignal.timeout(60_000), stopWaitingOnCancel: true })
      taskClients.set(target, client)
      await drainMailbox(target)
    }
  }

  // 外接智能体的一轮：提问原样（选了 Skill 就放在前面）转给它，过程记进这一轮并推给界面，确认请求转给客户端
  const runExternalTurn = async (session: ExternalSession, client: acp.AgentContext, params: acp.PromptRequest): Promise<acp.StopReason> => {
    if (session.running) throw new Error('上一个任务还没结束')
    session.turnRequested()
    const meta = promptMetaSchema.safeParse(params._meta)
    const turnId = meta.success ? meta.data.diffra.turnId : randomUUID()
    if (meta.success && meta.data.diffra.goal) throw new Error(`${session.agent.name} 的任务不支持目标模式`)
    const text = params.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const images = params.prompt.flatMap((block): PromptImage[] => {
      if (block.type !== 'image') return []
      const mimeType = PROMPT_IMAGE_TYPES.find((type) => type === block.mimeType)
      if (!mimeType) throw new Error(`不支持的图片格式：${block.mimeType}`)
      return [{ mimeType, data: block.data }]
    })
    const skillNames = meta.success ? meta.data.diffra.skills : []
    const skills = skillNames.length > 0 ? (await loadSkills(skillRoots(session.cwd, []))).filter((skill) => skillNames.includes(skill.name)) : []
    const missing = skillNames.filter((name) => !skills.some((skill) => skill.name === name))
    if (missing.length > 0) throw new Error(`找不到 Skill：${missing.join('、')}`)
    const notify = notifier(client, session.id)
    return session.runTurn(
      turnId,
      text,
      images,
      skillNames,
      {
        notify,
        persist: () => persist(session, notify),
        askClient: async (toolCall, options, signal) => {
          try {
            return await client.request(acp.methods.client.session.requestPermission, { sessionId: session.id, toolCall, options }, { cancellationSignal: signal, stopWaitingOnCancel: true })
          } catch (error) {
            if (!signal.aborted) console.error('[external] 权限请求失败', error)
            return { outcome: { outcome: 'cancelled' } }
          }
        },
      },
      meta.success ? meta.data.diffra.from : undefined,
      skills.length > 0 ? withSkills(text, skills) : undefined,
    )
  }

  const app = acp
    .agent({ name: AGENT_NAME })
    // 客户端断开（桌面端退出）时结束外接智能体的进程：它们不是 core 的一部分，不会跟着 core 的 stdio 一起收尾
    .onConnect((connection) => {
      void connection.closed.then(() => {
        for (const session of externals.values()) void session.dispose()
        void lspPool.dispose().catch((error: unknown) => console.error('[lsp] 停掉语言服务器失败', error))
        architecture?.dispose()
      })
    })
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
      if (externalSessionMetaSchema.safeParse(params._meta).success) {
        const { session, info } = await openExternal(params.cwd, params._meta)
        return { sessionId: session.id, _meta: { diffra: info } }
      }
      const { session, info } = await openSession(params.cwd, params._meta, params.mcpServers)
      return { sessionId: session.id, _meta: { diffra: info } }
    })
    // Diffra 的界面一次拿到整段历史，所以历史放在响应的 _meta 里，不逐条回放 session/update。
    // 旧记录的改动卡片带整份文件，发出去之前压缩（compactTurns），记录本身不动
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      taskClients.set(params.sessionId, client)
      const liveExternal = externals.get(params.sessionId)
      const externalRecord = liveExternal ? liveExternal.toRecord(false) : sessions.has(params.sessionId) ? null : await requireStore().load(params.sessionId)
      if (externalRecord?.agent) {
        if (!sameDir(externalRecord.cwd, params.cwd)) throw acp.RequestError.invalidParams(undefined, '项目目录和会话记录不一致')
        const { session, info } = await openExternal(externalRecord.cwd, params._meta, externalRecord)
        const loaded: LoadedSession = {
          info,
          title: session.title,
          turns: compactTurns(session.turns),
          ...(session.running || session.taskState.status !== 'running' ? { taskState: taskStateView(session) } : {}),
          design: false,
          noProject: session.noProject,
          agent: session.agent,
        }
        return { _meta: { diffra: loaded } }
      }
      const live = sessions.get(params.sessionId)
      const liveInfo = infos.get(params.sessionId)
      if (live?.running && liveInfo) {
        const loaded: LoadedSession = { info: liveInfo, title: live.title, turns: compactTurns(live.turns), taskState: taskStateView(live), design: live.designTask, noProject: live.noProject }
        return { _meta: { diffra: loaded } }
      }
      const record = live ? live.toRecord(false) : await requireStore().load(params.sessionId)
      if (!sameDir(record.cwd, params.cwd)) throw acp.RequestError.invalidParams(undefined, '项目目录和会话记录不一致')
      const { session, info } = await openSession(record.cwd, params._meta, params.mcpServers ?? [], record)
      // 没在运行却是 running，说明还没有确定的任务状态，交给界面按轮次推导
      const loaded: LoadedSession = { info, title: session.title, turns: compactTurns(session.turns), ...(session.taskState.status === 'running' ? {} : { taskState: taskStateView(session) }), design: session.designTask, noProject: session.noProject }
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
          running: (sessions.get(entry.id) ?? externals.get(entry.id))?.running ?? false,
          ...(entry.agent ? { agent: entry.agent } : {}),
        }
        return { sessionId: entry.id, cwd: entry.cwd, title: entry.title, updatedAt: entry.updatedAt, _meta: { diffra: meta } }
      }),
    }))
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      if ((sessions.get(params.sessionId) ?? externals.get(params.sessionId))?.running) throw new Error('任务还在进行中，先停止再删除')
      await externals.get(params.sessionId)?.dispose()
      externals.delete(params.sessionId)
      // 还留着的候选方案 worktree 一起清掉（不在内存里的从记录里读）
      const runs = sessions.get(params.sessionId)?.candidateRuns ?? (store ? ((await store.load(params.sessionId).catch(() => null))?.candidateRuns ?? []) : [])
      for (const run of runs) if (run.worktrees.length > 0) await cleanupRun(run)
      const collaborationOwner = sessions.get(params.sessionId)
      if (collaborationOwner) await collaborationRuntime(collaborationOwner).dispose()
      else if (store) {
        const record = await store.load(params.sessionId)
        for (const worker of record.collaboration?.workers ?? []) if (worker.worktree) {
          await restoreWorkerWorktree(worker.worktree, record.cwd, options.worktreesDir ?? join(tmpdir(), 'diffra-worktrees'))
          await disposeWorkerWorktree(worker.worktree)
        }
      }
      sessions.get(params.sessionId)?.execSessions.killAll()
      sessions.delete(params.sessionId)
      infos.delete(params.sessionId)
      updateSeqs.delete(params.sessionId)
      // 等 stdio 服务器退出再返回：Windows 上它们的当前目录就是任务目录，调用方接着要删这个目录
      await retainMcp()
      await requireStore().remove(params.sessionId)
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const external = externals.get(params.sessionId)
      if (external) return { stopReason: await runExternalTurn(external, client, params) }
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      session.turnRequested()
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
      const from = meta.success ? meta.data.diffra.from : undefined
      const remote = meta.success ? meta.data.diffra.remote : undefined
      const fromPlan = meta.success ? meta.data.diffra.fromPlan : undefined
      const stopReason = await runRecordedTurn(
        session,
        client,
        turnId,
        text,
        goal ? 'goal' : 'prompt',
        skillNames,
        images,
        async (io) => {
          if (fromPlan) await presetSteps(session, fromPlan.steps, io)
          const prompt = withSkills(text, skills) + (fromPlan ? planStepsInstruction(fromPlan.steps) : '')
          return runTurn(session, { id: turnId, text: prompt, images }, io, goal ? { goalMaxRounds: session.config.limits.goalMaxRounds } : {})
        },
        from,
        remote,
        fromPlan?.turnId,
      )
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.compact, checkpointParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('任务还在进行中，结束后再压缩上下文')
      session.turnRequested()
      const stopReason = await runRecordedTurn(session, client, params.turnId, MANUAL_COMPACTION_PROMPT, 'compact', [], [], (io) => compactManually(session, io))
      return { stopReason }
    })
    // 深度安全扫描作为一轮记进会话：进度实时显示、能停止、存进历史
    .onRequest(SESSION_EXT_METHODS.deepScan, deepScanParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      session.turnRequested()
      const stopReason = await runRecordedTurn(session, client, params.turnId, DEEP_SCAN_TITLES[params.scope], 'deep-scan', [], [], (io) =>
        runDeepScan(session, { id: params.turnId }, params.scope, io),
      )
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.mcpStatus, z.object({ target: mcpTargetParams, retry: z.boolean().default(false) }), async ({ params }) => {
      const { cwd, servers } = await mcpTarget(params.target)
      return mcpPool.status(cwd, servers, params.retry)
    })
    .onRequest(SESSION_EXT_METHODS.lspStatus, z.object({ sessionId: z.string() }), ({ params }) => {
      const session = sessionOf(params.sessionId)
      return session.lsp ? lspPool.status(session.cwd, session.lsp.servers) : []
    })
    .onRequest(
      SESSION_EXT_METHODS.lspControl,
      z.object({ sessionId: z.string(), server: z.string().min(1), action: z.enum(['start', 'stop', 'restart']) }),
      async ({ params }) => {
        const session = sessionOf(params.sessionId)
        const spec = session.lsp?.servers.find((item) => item.name === params.server)
        if (!spec) throw new Error(`这个任务没有名为「${params.server}」的语言服务器`)
        await lspPool.control(session.cwd, spec, params.action)
        return lspPool.status(session.cwd, session.lsp!.servers)
      },
    )
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
      session.turnRequested()
      const skills = await selectedSkills(session, params.skills)
      const stopReason = await runRecordedTurn(session, client, params.turnId, params.prompt, 'plan', params.skills, [], (io) =>
        runPlan(session, { id: params.turnId, text: withSkills(params.prompt, skills) }, io),
      )
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.diagnose, diagnoseParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      session.turnRequested()
      const stopReason = await runRecordedTurn(session, client, params.turnId, params.prompt, 'diagnose', [], [], (io) => runDiagnose(session, params.target, io))
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.promptEnhance, promptEnhanceParams, async ({ params }) => {
      const session = params.sessionId ? (sessions.get(params.sessionId) ?? null) : null
      const { usage, ...result } = await enhancePrompt(params, session)
      if (usageLog && usage) {
        // 首页还没有任务：记在固定的 id 下
        const owner = session ?? { id: PROMPT_ENHANCE_USAGE_ID, cwd: params.cwd ?? homedir() }
        const call = { role: 'planner' as const, provider: params.model.provider, modelId: params.model.modelId, usage }
        await usageLog.append(toUsageRecord(call, owner, new Date())).catch((error: unknown) => console.error('[usage] 优化提示词的用量记录写入失败', error))
      }
      return result
    })
    .onRequest(SESSION_EXT_METHODS.suggestNextPrompt, z.object({ sessionId: z.string().min(1), turnId: z.string().min(1).max(100) }), async ({ params }) => {
      if (externals.has(params.sessionId)) return null
      const session = sessionOf(params.sessionId)
      return session.suggestNextPrompt(params.turnId, async (call) => {
        if (!usageLog) return
        await usageLog.append(toUsageRecord(call, session, new Date()))
      })
    })
    .onRequest(SESSION_EXT_METHODS.retryStep, z.object({ sessionId: z.string().min(1), agent: z.string().min(1) }), ({ params }) => {
      // 那一步可能刚好已经有输出、结束了，这时什么也不做；外接智能体的请求由它自己管，重发不了
      if (externals.has(params.sessionId)) return { retried: false }
      const retry = sessionOf(params.sessionId).stepRetries.get(params.agent)
      retry?.()
      return { retried: retry !== undefined }
    })
    .onRequest(SESSION_EXT_METHODS.collaboration, z.object({ sessionId: z.string().min(1) }), ({ params }) => collaborationView(sessionOf(params.sessionId)))
    .onRequest(SESSION_EXT_METHODS.taskMessagesResume, z.object({}), async ({ client }) => {
      void resumePendingTasks(client).catch((error: unknown) => console.error('[tasks] 恢复排队消息失败', error))
      return { accepted: true }
    })
    .onRequest(SESSION_EXT_METHODS.collaborationControl, z.object({ sessionId: z.string().min(1), workerId: z.string().min(1).max(128), action: z.enum(['message', 'interrupt', 'retry', 'integrate']), message: z.string().trim().min(1).max(20_000).optional() }), async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running || params.action === 'interrupt') await collaborationRuntime(session).control(params)
      else {
        const turnId = randomUUID()
        const text = params.action === 'integrate' ? '整合指定队友的改动，并完成独立审查与测试验收。' : `继续与队友协作：${params.message ?? '恢复中断的工作，检查已有结果，避免重复副作用。'}`
        taskClients.set(session.id, client)
        session.turnRequested()
        await notifier(client, session.id)({ sessionUpdate: 'session_info_update', _meta: { diffra: { taskDelivery: { turnId, text, state: 'running' } } } })
        void runRecordedTurn(session, client, turnId, text, 'prompt', [], [], (io) => runTurn(session, { id: turnId, text }, io, { collaborationAction: params })).then(async (stopReason) => {
          await notifier(client, session.id)({ sessionUpdate: 'session_info_update', _meta: { diffra: { taskDelivery: { turnId, text, state: 'ended', stopReason } } } })
        }).catch((error: unknown) => console.error(`[collaboration] 会话 ${session.id} 继续协作失败`, error))
      }
      return collaborationView(session)
    })
    .onRequest(SESSION_EXT_METHODS.visualSnapshot, visualSnapshotParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const update = session.recordVisualSnapshot(params.toolCallId, params.image)
      if (!update) return { recorded: false }
      const notify = notifier(client, session.id)
      await notify(update)
      // 补一张图不算任务有新进展：不改更新时间，免得打开旧任务就把它顶到列表最前
      await persist(session, notify, false)
      return { recorded: true }
    })
    .onRequest(SESSION_EXT_METHODS.processStop, processParams, ({ params }) => {
      const exec = sessionOf(params.sessionId).execSessions
      const running = exec.background().some((process) => process.id === params.id)
      if (running) exec.kill(params.id, true)
      return { stopped: running }
    })
    .onRequest(SESSION_EXT_METHODS.processOutput, processParams, ({ params }) => {
      const output = sessionOf(params.sessionId).execSessions.recentOutput(params.id)
      if (!output) throw acp.RequestError.resourceNotFound(String(params.id))
      return output
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      ;(sessions.get(params.sessionId) ?? externals.get(params.sessionId))?.cancel()
    })
    .onRequest(SESSION_EXT_METHODS.checkpointPreview, checkpointParams, ({ params }) =>
      anySessionOf(params.sessionId).checkpointChanges(params.turnId),
    )
    .onRequest(SESSION_EXT_METHODS.checkpointRestore, checkpointParams, async ({ params, client }) => {
      const session = anySessionOf(params.sessionId)
      const notify = notifier(client, session.id)
      const changes = await session.restoreCheckpoint(params.turnId)
      await persist(session, notify)
      await notify(session instanceof Session ? taskStateUpdate(session) : { sessionUpdate: 'session_info_update', _meta: { diffra: { [TASK_PROGRESS_META_KEY]: taskStateView(session) } } })
      return changes
    })
    .onRequest(SESSION_EXT_METHODS.sessionUpdate, sessionUpdateParams, async ({ params }) => {
      const live = sessions.get(params.sessionId) ?? externals.get(params.sessionId)
      // 还没跑过一轮的任务没有存盘记录（比如任务互通刚新建的），只改内存里的，第一轮结束时一起存
      if (live && live.turns.length === 0) {
        live.title = params.title ?? live.title
        live.archived = params.archived ?? live.archived
        if (params.promote) live.noProject = false
        return toEntry(live.toRecord())
      }
      const entry = await requireStore().update(params.sessionId, { title: params.title, archived: params.archived, ...(params.promote ? { noProject: false as const } : {}) })
      if (live) {
        live.title = entry.title
        live.archived = entry.archived
        live.noProject = entry.noProject
      }
      return entry
    })
    // 不走 openSession：不建系统提示词、不连 MCP、不放进 sessions。不在内存里的读完文件再看一次，
    // 读的时候被载入、跑起来了就改取内存里的，免得文件里已有的更新又按序号补发一遍
    .onRequest(SESSION_EXT_METHODS.remoteSnapshot, remoteSnapshotParams, async ({ params }) => {
      const stored = sessions.has(params.sessionId) || externals.has(params.sessionId) ? null : await requireStore().load(params.sessionId)
      const live = sessions.get(params.sessionId) ?? externals.get(params.sessionId)
      const seq = updateSeqs.get(params.sessionId) ?? 0
      const source = live
        ? { cwd: live.cwd, title: live.title, archived: live.archived, design: live instanceof Session ? live.designTask : false, noProject: live.noProject, turns: live.turns, taskState: live.taskState, running: live.running }
        : stored && { cwd: stored.cwd, title: stored.title, archived: stored.archived, design: stored.design ?? false, noProject: stored.noProject ?? false, turns: stored.turns.map(({ checkpoint: _checkpoint, messageStart: _messageStart, ...turn }) => turn), taskState: restoredTaskState(stored), running: false }
      // 读文件的时候会话被删了
      if (!source) throw acp.RequestError.resourceNotFound(params.sessionId)
      const before = Math.min(params.before ?? source.turns.length, source.turns.length)
      const { start, turns } = snapshotPage(source.turns, before, params.maxTurns, params.maxChars)
      const snapshot: RemoteSnapshot = {
        sessionId: params.sessionId,
        cwd: source.cwd,
        title: source.title,
        archived: source.archived,
        design: source.design,
        noProject: source.noProject,
        running: source.running,
        // 和 session/load 一样：没在跑却是 running，说明还没有确定的任务状态，不带
        ...(source.running || source.taskState.status !== 'running' ? { taskState: taskStateView(source) } : {}),
        totalTurns: source.turns.length,
        start,
        turns,
        epoch,
        seq,
      }
      return snapshot
    })
    .onRequest(SESSION_EXT_METHODS.sessionSearch, z.object({ query: z.string() }), ({ params }) => requireStore().search(params.query))
    .onRequest(SESSION_EXT_METHODS.browserSites, browserSitesParams, ({ params }) => {
      setBrowserSites(params)
      return {}
    })
    // 已经打开的会话都换成新开关；正在跑的一轮从下一次提交起按新值。之后新建、载入的会话由客户端按设置传
    .onRequest(SESSION_EXT_METHODS.securityConfigure, checkSwitchesSchema, ({ params }) => {
      const { projects, ...global } = params
      // 按项目单独设的开关（v2）：会话所在目录在列表里就用它覆盖的那几项
      const key = (path: string) => (process.platform === 'win32' ? path.replace(/[\\/]+$/, '').toLowerCase() : path.replace(/\/+$/, ''))
      const overrides = new Map(Object.entries(projects ?? {}).map(([path, value]) => [key(path), value]))
      for (const session of sessions.values()) session.config = { ...session.config, security: { ...global, ...overrides.get(key(session.cwd)) } }
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.securityTools, z.object({ cwd: z.string().min(1).max(4096) }), async ({ params }) => securityToolsInfo(params.cwd, await findRipgrep()))
    .onRequest(
      SESSION_EXT_METHODS.securityRun,
      z.object({
        cwd: z.string().min(1).max(4096),
        runId: z.string().min(1).max(100),
        tool: z.enum(SECURITY_TOOLS),
        baseUrl: z.string().max(2000).optional(),
        routes: z.array(z.string().max(500)).max(DYNAMIC_MAX_ROUTES).optional(),
        codeqlLicensed: z.boolean().optional(),
      }),
      async ({ params }) => {
        const controller = new AbortController()
        securityRuns.set(params.runId, controller)
        try {
          return await runSecurityTool({ ...params, rgPath: await findRipgrep() }, controller.signal)
        } finally {
          securityRuns.delete(params.runId)
        }
      },
    )
    .onRequest(SESSION_EXT_METHODS.securityCancel, z.object({ runId: z.string().min(1).max(100) }), ({ params }) => {
      securityRuns.get(params.runId)?.abort()
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.sessionConfigure, sessionConfigureParams, ({ params }) => {
      const external = externals.get(params.sessionId)
      if (external) {
        if (params.model) throw new Error(`这是 ${external.agent.name} 的任务，用的是它自己的模型，在 Diffra 里换不了`)
        if (params.permissionMode) external.permissionMode = params.permissionMode
        return {}
      }
      const session = sessionOf(params.sessionId)
      if (params.permissionMode) session.permissionMode = params.permissionMode
      if (params.model) session.setModel(params.model)
      if (params.design !== undefined) session.design = params.design
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.sessionRewind, checkpointParams, async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const notify = notifier(client, session.id)
      const result = await session.rewind(params.turnId)
      await persist(session, notify)
      await notify(taskStateUpdate(session))
      return result
    })
    .onRequest(SESSION_EXT_METHODS.applyDiff, z.object({ sessionId: z.string().min(1), turnId: z.string().min(1), prompt: z.string().min(1).max(2000), diff: z.string().min(1).max(500_000) }), async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('上一个任务还没结束')
      session.turnRequested()
      const stopReason = await runRecordedTurn(session, client, params.turnId, params.prompt, 'apply', [], [], (io) => runApplyDiff(session, params.diff, io))
      return { stopReason }
    })
    .onRequest(SESSION_EXT_METHODS.commandRisk, z.object({ command: z.string().max(20_000) }), ({ params }) => commandRisk(params.command))
    .onRequest(SESSION_EXT_METHODS.sessionBlocks, z.object({ sessionId: z.string().min(1) }), ({ params }) => ({ blocks: externals.has(params.sessionId) ? [] : sessionOf(params.sessionId).pluginBlocks }))
    .onRequest(SESSION_EXT_METHODS.useTurnVersion, z.object({ sessionId: z.string().min(1), turnId: z.string().min(1), index: z.number().int().nonnegative() }), async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      const notify = notifier(client, session.id)
      const result = await session.useVersion(params.turnId, params.index)
      await persist(session, notify)
      await notify(taskStateUpdate(session))
      return result
    })
    .onRequest(SESSION_EXT_METHODS.checkpointDiff, checkpointParams, ({ params }) =>
      anySessionOf(params.sessionId).checkpointDiff(params.turnId),
    )
    .onRequest(SESSION_EXT_METHODS.usageSummary, usageQueryParams, async ({ params }) => {
      if (!usageLog) throw acp.RequestError.invalidRequest(undefined, '没有配置用量记录')
      const from = new Date(params.from)
      const to = new Date(params.to)
      const taskNoProject = params.workspaceRoot && store ? new Map((await store.list()).map((entry) => [entry.id, entry.noProject] as const)) : undefined
      const aggregator = new UsageAggregator(from, to, params.timeZone, { prices: params.prices, workspaceRoot: params.workspaceRoot, taskNoProject })
      const { skippedLines } = await usageLog.scan(from, to, (record) => aggregator.add(record))
      return aggregator.result(skippedLines)
    })
    // v2 · M11：导出 CSV（路径是用户在保存对话框里选的）、列出各月的记录文件、删掉某个月之前的
    .onRequest(SESSION_EXT_METHODS.usageExport, usageQueryParams.and(z.object({ path: z.string().min(1).max(4096) })), async ({ params }) => {
      if (!usageLog) throw acp.RequestError.invalidRequest(undefined, '没有配置用量记录')
      return exportUsageCsv(usageLog, { from: new Date(params.from), to: new Date(params.to), timeZone: params.timeZone, prices: params.prices ?? [] }, params.path)
    })
    .onRequest(SESSION_EXT_METHODS.usageFiles, z.object({}), async () => {
      if (!usageLog) throw acp.RequestError.invalidRequest(undefined, '没有配置用量记录')
      return usageLog.files()
    })
    .onRequest(SESSION_EXT_METHODS.usageCleanup, z.object({ before: z.string().regex(/^\d{4}-\d{2}$/) }), async ({ params }) => {
      if (!usageLog) throw acp.RequestError.invalidRequest(undefined, '没有配置用量记录')
      return { removed: await usageLog.removeBefore(params.before) }
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
    // 多候选方案：生成（一轮 plan，项目不改）
    .onRequest(
      SESSION_EXT_METHODS.candidates,
      z.object({
        sessionId: z.string().min(1),
        turnId: z.string().min(1),
        title: z.string().trim().min(1).max(200),
        request: z.string().trim().min(1).max(100_000),
        plan: z.string().trim().min(1).max(100_000).nullable(),
        candidates: z.array(z.object({ name: z.string().trim().min(1).max(40), approach: z.string().trim().min(1).max(2000) })).min(2).max(MAX_CANDIDATES),
      }),
      async ({ params, client }) => {
        const session = sessionOf(params.sessionId)
        if (session.running) throw new Error('上一个任务还没结束')
        session.turnRequested()
        const stopReason = await runRecordedTurn(session, client, params.turnId, params.title, 'plan', [], [], (io) =>
          runCandidates(session, candidateHost(session), { id: params.turnId, request: params.request, plan: params.plan, specs: params.candidates }, io),
        )
        return { stopReason }
      },
    )
    .onRequest(SESSION_EXT_METHODS.candidateDiff, z.object({ sessionId: z.string().min(1), runTurnId: z.string().min(1), candidateId: z.string().min(1) }), async ({ params }) => ({
      diff: await candidateDiff(candidateRunOf(sessionOf(params.sessionId), params.runTurnId), params.candidateId),
    }))
    // 应用一个候选：一轮 apply（能撤销）；冲突时什么都不改
    .onRequest(
      SESSION_EXT_METHODS.candidateApply,
      z.object({ sessionId: z.string().min(1), turnId: z.string().min(1), title: z.string().trim().min(1).max(200), runTurnId: z.string().min(1), candidateId: z.string().min(1) }),
      async ({ params, client }) => {
        const session = sessionOf(params.sessionId)
        if (session.running) throw new Error('上一个任务还没结束')
        const run = candidateRunOf(session, params.runTurnId)
        session.turnRequested()
        const stopReason = await runRecordedTurn(session, client, params.turnId, params.title, 'apply', [], [], (io) => applyCandidate(session, params.turnId, run, params.candidateId, io))
        await updateRunCard(session, client, params.runTurnId)
        return { stopReason }
      },
    )
    .onRequest(SESSION_EXT_METHODS.candidateDiscard, z.object({ sessionId: z.string().min(1), runTurnId: z.string().min(1) }), async ({ params, client }) => {
      const session = sessionOf(params.sessionId)
      if (session.running) throw new Error('任务还在进行中，结束后再放弃候选方案')
      await discardCandidates(candidateRunOf(session, params.runTurnId))
      await updateRunCard(session, client, params.runTurnId)
      return {}
    })
    // 设置里的外接智能体清单：整份替换；已经打开的任务下次起进程时用新的命令
    .onRequest(SESSION_EXT_METHODS.externalAgents, z.object({ agents: z.array(externalAgentSpecSchema).max(50) }), ({ params }) => {
      externalAgents.clear()
      for (const spec of params.agents) externalAgents.set(spec.id, spec)
      for (const session of externals.values()) session.spec = externalAgents.get(session.agent.id) ?? null
      return {}
    })
    // 检测：找命令、起进程、握手，拿到它的名字、版本和能力后结束进程
    .onRequest(SESSION_EXT_METHODS.externalDetect, z.object({ spec: externalAgentSpecSchema, cwd: z.string().min(1).nullable().default(null) }), async ({ params }): Promise<ExternalAgentDetection> => {
      try {
        const process = await ExternalAgentProcess.start(params.spec, params.cwd ?? homedir(), { update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) })
        await process.dispose()
        const { info } = process
        return {
          ok: true,
          path: process.path,
          agentName: info.agentInfo?.title ?? info.agentInfo?.name ?? null,
          agentVersion: info.agentInfo?.version ?? null,
          protocolVersion: info.protocolVersion,
          loadSession: process.loadSession,
          images: process.images,
          authMethods: (info.authMethods ?? []).map((method) => ({ id: method.id, name: method.name, description: method.description ?? null })),
        }
      } catch (error) {
        if (error instanceof ExternalAgentError) return { ok: false, kind: error.kind, message: error.message, detail: error.detail }
        return { ok: false, kind: 'start-failed', message: error instanceof Error ? error.message : String(error), detail: null }
      }
    })
    .onRequest(EXT_METHODS.listModels, z.object({ endpoint: endpointSchema }), ({ params }) =>
      listModels(params.endpoint),
    )
    .onRequest(
      EXT_METHODS.testModel,
      z.object({ endpoint: endpointSchema, modelId: z.string().min(1) }),
      ({ params }) => testModel(params.endpoint, params.modelId),
    )
  return architecture ? registerArchitecture(app, architecture, usageLog, (notify) => (notifyArchitecture = notify)) : app
}
