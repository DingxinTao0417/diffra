import { randomUUID } from 'node:crypto'
import type { McpServer, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { ArchitectureService } from '../architecture/service.js'
import type { Checkpoints } from '../checkpoint.js'
import type { McpPool, McpTurnTools } from '../mcp.js'
import { createLanguageModel } from '../models/operations.js'
import { type CheckpointChange, type PermissionMode, type PromptImage, type RemoteSource, restoreNotice, type RulePack, type SessionConfig, type SessionDesign, type StoredTurn, type TaskSource, type TurnKind, type UsageBreakdown } from '../protocol.js'
import { promptSections } from './prompt.js'
import { newTaskState, recordedTaskState, type TaskState } from './task-state.js'
import type { Compaction, SessionRecord } from './store.js'
import { delegateChars, DELEGATE_TOOL, delegateTool } from './agents.js'
import { SHOW_VISUAL_TOOL, showVisualTool, VISUAL_TOOL_CHARS } from './visual.js'
import { WAIT_COMMAND_TOOL, WAIT_TOOL_CHARS, waitCommandTool } from './wait.js'
import { TASK_TOOL_CHARS, TASK_TOOLS } from './tasks.js'
import { browserTools } from './browser.js'
import { designChars, designTools } from './design.js'
import { TOOL_DEFINITION_CHARS, toolDefinitionChars, TOOLS } from './tools.js'

// 会话标题默认取第一条提问的开头
const TITLE_CHARS = 40

// 图片在对话里是 base64，按字数算会大上百倍；估算上下文时每张按这么多字算（约一千多个 token）
export const IMAGE_CHARS = 6000

export function messagesChars(messages: ModelMessage[]): number {
  let images = 0
  const json = JSON.stringify(messages, (key, value: unknown) => {
    // 提问里的图片在 image 字段，工具结果里的截图在 data 字段
    if ((key === 'image' || key === 'data') && typeof value === 'string' && value.length > IMAGE_CHARS) {
      images++
      return ''
    }
    return value
  })
  return json.length + images * IMAGE_CHARS
}

export interface SessionEnvironment {
  bashPath: string | null
  rgPath: string
}

export interface UnresolvedCheck {
  command: string
  lines: string[]
}

export interface SessionOptions {
  cwd: string
  config: SessionConfig
  environment: SessionEnvironment
  checkpoints: Checkpoints | null
  // 按项目语言选中的规则包，写进了 systemPrompt，完成前的审查也用它
  rulePacks: RulePack[]
  systemPrompt: string
  // 项目外可以只读访问的目录（Skill 目录）
  readRoots?: string[]
  // 客户端给的 MCP 服务器，连接放在 pool 里，各任务共用
  mcpServers?: McpServer[]
  mcpPool?: McpPool | null
  // 测试时注入模拟模型；正常运行按 config 创建
  model?: LanguageModel
  reviewModel?: LanguageModel
  planModel?: LanguageModel
  fallbackModel?: LanguageModel
  // 从存储恢复时传入
  record?: SessionRecord
  // 架构功能的数据：项目有目标架构时，完成前检查这一轮新增的依赖
  architecture?: ArchitectureService | null
}

export class Session {
  readonly id: string
  readonly cwd: string
  readonly createdAt: string
  title: string
  archived: boolean
  // 设计任务：建会话时定下，存进记录
  readonly designTask: boolean
  // 设计任务的风格预设 id，没用预设时为 null
  readonly designStyle: string | null
  // 无项目任务：建会话时定下，存进记录
  readonly noProject: boolean
  readonly turns: StoredTurn[] = []
  // 模型和权限模式可以在会话中途切换，其余设置建会话时定下
  config: SessionConfig
  permissionMode: PermissionMode
  readonly environment: SessionEnvironment
  readonly checkpoints: Checkpoints | null
  readonly rulePacks: RulePack[]
  readonly readRoots: string[]
  readonly mcpServers: McpServer[]
  readonly mcpPool: McpPool | null
  readonly architecture: ArchitectureService | null
  // 最近一轮开始时取到的 MCP 工具
  mcpTools: McpTurnTools | null = null
  // 客户端配置的设计面板工具：设计任务每轮开始前由客户端配置，普通任务是 null
  design: SessionDesign | null = null
  readonly systemPrompt: string
  model: LanguageModel
  // 没有单独配置评审模型时用编码模型
  reviewModel: LanguageModel
  // 没有单独配置规划模型时用编码模型
  planModel: LanguageModel
  // 没有配置兜底模型时为 null，卡住了就停下
  readonly fallbackModel: LanguageModel | null
  readonly messages: ModelMessage[] = []
  readonly readHashes = new Map<string, string>()
  // 「本会话内允许同类命令」记下的命令键，见 permissions.commandKey
  readonly alwaysAllowed = new Set<string>()
  // turnId → 这一轮开始前的快照
  readonly turnCheckpoints = new Map<string, string>()
  // turnId → 这一轮里 Git 命令挪了 HEAD（拉取、切分支）之后的基线：开始前的快照，Git 带进来的文件换成带进来时的内容。没挪过的轮次没有
  readonly turnGitBases = new Map<string, string>()
  // turnId → 这一轮的提问在 messages 里的位置，重新生成时从这里截断对话
  readonly messageStarts = new Map<string, number>()
  // 上下文压缩的位置和摘要；messages 保留原文，重新生成、撤销照常按位置截断
  compaction: Compaction | null = null
  // 上一次模型调用的输入 token 数、当时发出去的字数和缓存用量，用来估算下一次调用有多大
  lastContext: { inputTokens: number; chars: number; cacheRead: number | null; cacheWrite: number | null } | null = null
  // 验证缓存仅存于内存，恢复后重新验证；Git 快照覆盖未跟踪文件。
  verifiedSnapshot: string | null = null
  // 提交前问深度扫描：上次深度扫描跑完时的工作区指纹（代码没再变就不问），和用户选了「这个任务不再问」。只在内存里，重新打开任务后会再问
  deepScannedFingerprint: string | null = null
  deepScanDeclined = false
  // 最近一次因检查卡住停下时还没修好的错误，下一个执行轮开始时交给模型一次；只在内存里，撤销后作废
  unresolvedCheck: UnresolvedCheck | null = null
  // turnId → 这一轮开始时交给模型的剩余错误；重新生成这一轮时放回去，重发的那一轮照样收到
  readonly consumedChecks = new Map<string, UnresolvedCheck>()
  taskState: TaskState = newTaskState()
  activeTurn: AbortController | null = null
  // 请求到了、这一轮还没开始（还在读 Skill、存盘）时点的停止：记下来开始时补上，不然这次停止会被吞掉
  private turnPending = false
  private stopPending = false
  // 这一轮里每个文件最近一次改完后的全文，压缩改动卡片用（见 edit-diff.ts）；只在内存里，每轮清空
  readonly editedTexts = new Map<string, string>()
  // 正在等模型输出的那一步：智能体（主智能体是 main，子智能体是它的 id）→ 让它重发请求
  readonly stepRetries = new Map<string, () => void>()

  constructor(options: SessionOptions) {
    const record = options.record
    this.architecture = options.architecture ?? null
    this.id = record?.id ?? randomUUID()
    this.createdAt = record?.createdAt ?? new Date().toISOString()
    this.title = record?.title ?? ''
    this.archived = record?.archived ?? false
    this.designTask = record?.design ?? options.config.design ?? false
    this.designStyle = record ? (record.designStyle ?? null) : (options.config.designStyle ?? null)
    this.noProject = record?.noProject ?? options.config.noProject ?? false
    if (record) {
      this.taskState = restoredTaskState(record)
      this.messages.push(...record.messages)
      this.compaction = record.compaction
      for (const { checkpoint, gitBase, messageStart, ...turn } of record.turns) {
        this.turns.push(turn)
        if (checkpoint) this.turnCheckpoints.set(turn.id, checkpoint)
        if (gitBase) this.turnGitBases.set(turn.id, gitBase)
        if (messageStart !== null) this.messageStarts.set(turn.id, messageStart)
      }
    }
    this.cwd = options.cwd
    this.config = options.config
    this.permissionMode = options.config.permissionMode
    this.environment = options.environment
    this.checkpoints = options.checkpoints
    this.rulePacks = options.rulePacks
    this.readRoots = options.readRoots ?? []
    this.mcpServers = options.mcpServers ?? []
    this.mcpPool = options.mcpPool ?? null
    this.systemPrompt = options.systemPrompt
    const coder = options.config.model
    this.model = options.model ?? createLanguageModel(coder.endpoint, coder.modelId, coder.reasoningEffort, coder.maxOutputTokens)
    const review = options.config.reviewModel
    this.reviewModel = options.reviewModel ?? (review ? createLanguageModel(review.endpoint, review.modelId) : this.model)
    const plan = options.config.planModel
    this.planModel = options.planModel ?? (plan ? createLanguageModel(plan.endpoint, plan.modelId, undefined, plan.maxOutputTokens) : this.model)
    const fallback = options.config.fallbackModel
    this.fallbackModel = options.fallbackModel ?? (fallback ? createLanguageModel(fallback.endpoint, fallback.modelId, undefined, fallback.maxOutputTokens) : null)
  }

  // 从下一轮开始用新模型；评审、规划没有单独配置时跟着换
  setModel(model: SessionConfig['model'], languageModel?: LanguageModel): void {
    if (this.running) throw new Error('任务还在进行中，结束后再切换模型')
    this.config = { ...this.config, model }
    this.model = languageModel ?? createLanguageModel(model.endpoint, model.modelId, model.reasoningEffort, model.maxOutputTokens)
    if (this.config.reviewModel === null) this.reviewModel = this.model
    if (this.config.planModel === null) this.planModel = this.model
  }

  get running(): boolean {
    return this.activeTurn !== null
  }

  // 发给编码模型的对话：压缩过的话，摘要代替压缩点之前的部分
  contextMessages(): ModelMessage[] {
    if (!this.compaction) return this.messages
    return [{ role: 'user', content: this.compaction.summary }, ...this.messages.slice(this.compaction.upTo)]
  }

  get trustedCommands(): string[] {
    return [this.config.checks.afterEdit, this.config.checks.beforeFinish].filter((item): item is string => item !== null)
  }

  cancel(): void {
    if (this.activeTurn) this.activeTurn.abort()
    else if (this.turnPending) this.stopPending = true
  }

  // 每种轮次的请求一到、第一个 await 之前调
  turnRequested(): void {
    this.turnPending = true
    this.stopPending = false
  }

  // 这一轮开始：登记它的 AbortController；开始前已经点了停止的，一开始就是停止状态
  activateTurn(): AbortController {
    const controller = new AbortController()
    if (this.stopPending) controller.abort()
    this.turnPending = false
    this.stopPending = false
    this.activeTurn = controller
    return controller
  }

  startTurn(id: string, prompt: string, kind: TurnKind = 'prompt', skills: string[] = [], images: PromptImage[] = [], from?: TaskSource, remote?: RemoteSource): void {
    if (!this.title) {
      const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
      this.title = firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS)}…` : firstLine
    }
    this.messageStarts.set(id, this.messages.length)
    this.editedTexts.clear()
    this.turns.push({ id, kind, prompt, startedAt: new Date().toISOString(), endedAt: null, stopReason: null, updates: [], skills, images, ...(from ? { from } : {}), ...(remote ? { remote } : {}) })
  }

  // 流式文字会拆成很多小块，存的时候把连续的同类块合并；上下文用量只留最后一次
  recordUpdate(update: SessionUpdate): void {
    const turn = this.turns.at(-1)
    if (!turn || turn.endedAt) return
    const last = turn.updates.at(-1)
    if (
      (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') &&
      last?.sessionUpdate === update.sessionUpdate &&
      last.content.type === 'text' &&
      update.content.type === 'text'
    ) {
      turn.updates[turn.updates.length - 1] = { ...last, content: { ...last.content, text: last.content.text + update.content.text } }
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      const previous = turn.updates.findIndex((item) => item.sessionUpdate === 'usage_update')
      if (previous >= 0) turn.updates.splice(previous, 1)
    }
    turn.updates.push(update)
  }

  endTurn(stopReason: StopReason): void {
    const turn = this.turns.at(-1)
    if (!turn || turn.endedAt) return
    turn.endedAt = new Date().toISOString()
    turn.stopReason = stopReason
  }

  toRecord(): SessionRecord {
    return {
      version: 1,
      taskState: this.taskState,
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      archived: this.archived,
      design: this.designTask,
      designStyle: this.designStyle,
      noProject: this.noProject,
      turns: this.turns.map((turn) => ({
        ...turn,
        checkpoint: this.turnCheckpoints.get(turn.id) ?? null,
        ...(this.turnGitBases.has(turn.id) ? { gitBase: this.turnGitBases.get(turn.id) } : {}),
        messageStart: this.messageStarts.get(turn.id) ?? null,
      })),
      messages: this.messages,
      compaction: this.compaction,
    }
  }

  // 发给编码模型的工具：内置的加上这一轮的 MCP 工具，配置了设计工具时再加上
  toolSet(): ToolSet {
    return { ...TOOLS, [DELEGATE_TOOL]: delegateTool(Boolean(this.design)), [SHOW_VISUAL_TOOL]: showVisualTool, [WAIT_COMMAND_TOOL]: waitCommandTool, ...TASK_TOOLS, ...browserTools(this), ...designTools(this), ...(this.mcpTools?.tools ?? {}) }
  }

  toolChars(): number {
    return TOOL_DEFINITION_CHARS + VISUAL_TOOL_CHARS + WAIT_TOOL_CHARS + TASK_TOOL_CHARS + delegateChars(Boolean(this.design)) + toolDefinitionChars(browserTools(this)) + designChars(this) + (this.mcpTools?.chars ?? 0)
  }

  // 估算上下文里各部分占多少：按字数比例分摊模型实际返回的输入 token 数
  usageBreakdown(used: number): UsageBreakdown {
    const prompt = promptSections(this.systemPrompt)
    const chars = {
      system: prompt.base,
      rules: prompt.rules,
      tools: this.toolChars(),
      messages: messagesChars(this.contextMessages()),
    }
    const total = chars.system + chars.rules + chars.tools + chars.messages
    const share = (value: number) => (total > 0 ? Math.round((value / total) * used) : 0)
    return { system: share(chars.system), rules: share(chars.rules), tools: share(chars.tools), messages: share(chars.messages) }
  }

  // 算「智能体从某一轮开始改了什么」的基线：这一轮开始前的快照，再把这一轮及之后 Git 命令带进来的文件（拉取、切分支）换成带进来时的内容。
  // 看改动、撤销、重新生成、完成门禁都以它为准，拉下来的代码不算智能体的改动，撤销也只退回它改的。没有 Git 挪过 HEAD 时就是这一轮的快照
  async changeBase(turnId: string): Promise<string | undefined> {
    const commit = this.turnCheckpoints.get(turnId)
    if (!this.checkpoints || !commit) return undefined
    const index = this.turns.findIndex((turn) => turn.id === turnId)
    // 进行中的这一轮在核心的循环测试里可能没记进 turns，自己也要算上
    const ids = [turnId, ...(index >= 0 ? this.turns.slice(index + 1).map((turn) => turn.id) : [])]
    let base = commit
    for (const id of ids) {
      const start = this.turnCheckpoints.get(id)
      const gitBase = this.turnGitBases.get(id)
      if (!start || !gitBase) continue
      base = base === start ? gitBase : (await this.checkpoints.overlay(base, gitBase, await this.checkpoints.changedPaths(start, gitBase))).commit
    }
    return base
  }

  // 某一轮开始之后智能体的改动，unified diff
  async checkpointDiff(turnId: string): Promise<string> {
    const base = await this.changeBase(turnId)
    if (this.checkpoints && base) return this.checkpoints.diffSince(base)
    // 进行中的这一轮快照还没打好：快照在任何工具运行之前打，这时还没有改动
    if (this.checkpoints && this.running && this.turns.at(-1)?.id === turnId) return ''
    throw new Error('这一轮没有检查点，看不了改动')
  }

  // 本任务从第一轮之前到现在智能体的改动（深度扫描「本任务改动」的范围），unified diff；没有检查点时返回 null
  async taskDiff(): Promise<string | null> {
    const first = this.turns.find((turn) => turn.kind === 'prompt')
    const base = first ? await this.changeBase(first.id) : undefined
    return this.checkpoints && base ? this.checkpoints.diffSince(base) : null
  }

  // 重新生成：把这一轮及之后的文件改动和对话一起撤掉，调用方再用同样的提问发一轮
  async rewind(turnId: string): Promise<{ filesRestored: boolean }> {
    if (this.running) throw new Error('任务还在进行中，先停止再重新生成')
    const index = this.turns.findIndex((turn) => turn.id === turnId)
    const start = this.messageStarts.get(turnId)
    if (index < 0 || start === undefined) throw new Error('这一轮不能重新生成')
    const base = await this.changeBase(turnId)
    let filesRestored = false
    if (this.checkpoints && base) {
      await this.checkpoints.restore(base, await this.checkpoints.changesSince(base))
      filesRestored = true
    }
    // 文件回到这一轮开始时，待验证也取那时的值，和撤销一样；没有检查点、文件没回滚时工作区没变，保留现在的值
    const before = taskStateBefore(this.turns, index)
    const needsVerification = filesRestored ? before.needsVerification : this.taskState.needsVerification
    // 完成条件定下后改不了，这一轮里才定的随对话一起撤掉，否则写错的条件再也摆脱不了；之前定的保留，证据作废
    const keptRequirements = new Set(before.requirementIds)
    this.messages.splice(start)
    // 压缩点在截掉的部分里，摘要也就作废了；下次超限时再压
    if (this.compaction && this.compaction.upTo > start) this.compaction = null
    this.unresolvedCheck = this.consumedChecks.get(turnId) ?? null
    for (const turn of this.turns.splice(index)) {
      this.turnCheckpoints.delete(turn.id)
      this.turnGitBases.delete(turn.id)
      this.messageStarts.delete(turn.id)
      this.consumedChecks.delete(turn.id)
    }
    this.readHashes.clear()
    this.verifiedSnapshot = null
    this.taskState = {
      ...newTaskState(),
      needsVerification,
      contractRequired: this.taskState.contractRequired,
      releaseVersion: this.taskState.releaseVersion,
      requirements: this.taskState.requirements.filter((item) => keptRequirements.has(item.id)).map((item) => ({ ...item, receiptId: null })),
    }
    return { filesRestored }
  }

  async checkpointChanges(turnId: string): Promise<CheckpointChange[]> {
    const base = await this.changeBase(turnId)
    if (!this.checkpoints || !base) throw new Error('这一轮没有检查点，无法撤销')
    return this.checkpoints.changesSince(base)
  }

  // 还原到某一轮开始前：这一轮以及之后所有轮次智能体改的文件都撤掉；Git 带进来的文件（拉取、切分支）留着，提交本来也不会退回
  async restoreCheckpoint(turnId: string): Promise<CheckpointChange[]> {
    if (this.running) throw new Error('任务还在进行中，先停止再撤销')
    const base = await this.changeBase(turnId)
    if (!this.checkpoints || !base) throw new Error('这一轮没有检查点，无法撤销')
    const changes = await this.checkpoints.changesSince(base)
    await this.checkpoints.restore(base, changes)
    // 文件已经变了，之前读过的内容和验证证据都作废，并告诉模型
    this.readHashes.clear()
    this.verifiedSnapshot = null
    this.unresolvedCheck = null
    const index = this.turns.findIndex((turn) => turn.id === turnId)
    const target = this.turns[index]
    const needsVerification = target ? needsVerificationBefore(this.turns, index) : false
    const reason = this.taskState.requirements.length > 0 || this.taskState.contractRequired ?'文件已撤销，需要重新验证完成条件。' : needsVerification ? '文件已撤销，之前轮次的改动还没验证。' : '文件已撤销，原来的结论不再算数。'
    this.taskState = { ...this.taskState, status: 'blocked', needsVerification, reason, receipts: [], requirements: this.taskState.requirements.map((item) => ({ ...item, receiptId: null })) }
    this.messages.push({
      role: 'user',
      content:
        '[Note from Diffra] The user reverted all file changes made since an earlier point in this conversation. ' +
        'Files may differ from what you saw before; read them again before editing.',
    })
    if (target) {
      const restoredAt = new Date().toISOString()
      for (const turn of this.turns.slice(index)) turn.restoredAt = restoredAt
      // 这一轮早已结束，recordUpdate 不再收，直接记进去
      target.updates.push({ sessionUpdate: 'notice', severity: 'info', ...restoreNotice(changes) })
    }
    return changes
  }
}

// 从记录恢复任务状态：只有最后一轮没写结束时间才是中途退出；其余 running 是还没跑过任务或撤销后的初始值
export function restoredTaskState(record: SessionRecord): TaskState {
  const state = record.taskState ?? newTaskState()
  if (state.status === 'running' && record.turns.at(-1)?.endedAt === null) return { ...state, status: 'blocked', reason: '应用退出时任务未完成，请继续执行剩余步骤。' }
  return state
}

// 撤销、重新生成到某一轮之前，工作区回到这一轮开始时的快照，待验证也回到那时的值：主循环、出计划、深度扫描开始时都把任务状态记进这一轮，取第一份。
// 以前的记录里计划和深度扫描轮没有，就取更早轮次最后记下的。撤销的文件是用户自己退回的，不能一律当成智能体没验证的改动
function taskStateBefore(turns: StoredTurn[], index: number): { needsVerification: boolean; requirementIds: string[] } {
  for (const update of turns[index]!.updates) {
    const recorded = recordedTaskState(update._meta)
    if (recorded) return recorded
  }
  for (let i = index - 1; i >= 0; i--) {
    const updates = turns[i]!.updates
    for (let j = updates.length - 1; j >= 0; j--) {
      const recorded = recordedTaskState(updates[j]!._meta)
      if (recorded) return recorded
    }
  }
  return { needsVerification: false, requirementIds: [] }
}

function needsVerificationBefore(turns: StoredTurn[], index: number): boolean {
  return taskStateBefore(turns, index).needsVerification
}
