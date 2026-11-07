import { randomUUID } from 'node:crypto'
import type { McpServer, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { Checkpoints } from '../checkpoint.js'
import type { McpPool, McpTurnTools } from '../mcp.js'
import { createLanguageModel } from '../models/operations.js'
import type { CheckpointChange, PermissionMode, RulePack, SessionConfig, StoredTurn, TurnKind, UsageBreakdown } from '../protocol.js'
import { promptSections } from './prompt.js'
import type { Compaction, SessionRecord } from './store.js'
import { TOOL_DEFINITION_CHARS, TOOLS } from './tools.js'

// 会话标题默认取第一条提问的开头
const TITLE_CHARS = 40

export interface SessionEnvironment {
  bashPath: string | null
  rgPath: string
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
}

export class Session {
  readonly id: string
  readonly cwd: string
  readonly createdAt: string
  title: string
  archived: boolean
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
  // 最近一轮开始时取到的 MCP 工具
  mcpTools: McpTurnTools | null = null
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
  // turnId → 这一轮的提问在 messages 里的位置，重新生成时从这里截断对话
  readonly messageStarts = new Map<string, number>()
  // 上下文压缩的位置和摘要；messages 保留原文，重新生成、撤销照常按位置截断
  compaction: Compaction | null = null
  // 上一次模型调用的输入 token 数和当时发出去的字数，用来估算下一次调用有多大
  lastContext: { inputTokens: number; chars: number } | null = null
  activeTurn: AbortController | null = null

  constructor(options: SessionOptions) {
    const record = options.record
    this.id = record?.id ?? randomUUID()
    this.createdAt = record?.createdAt ?? new Date().toISOString()
    this.title = record?.title ?? ''
    this.archived = record?.archived ?? false
    if (record) {
      this.messages.push(...record.messages)
      this.compaction = record.compaction
      for (const { checkpoint, messageStart, ...turn } of record.turns) {
        this.turns.push(turn)
        if (checkpoint) this.turnCheckpoints.set(turn.id, checkpoint)
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
    this.model = options.model ?? createLanguageModel(options.config.model.endpoint, options.config.model.modelId)
    const review = options.config.reviewModel
    this.reviewModel = options.reviewModel ?? (review ? createLanguageModel(review.endpoint, review.modelId) : this.model)
    const plan = options.config.planModel
    this.planModel = options.planModel ?? (plan ? createLanguageModel(plan.endpoint, plan.modelId) : this.model)
    const fallback = options.config.fallbackModel
    this.fallbackModel = options.fallbackModel ?? (fallback ? createLanguageModel(fallback.endpoint, fallback.modelId) : null)
  }

  // 从下一轮开始用新模型；评审、规划没有单独配置时跟着换
  setModel(model: SessionConfig['model'], languageModel?: LanguageModel): void {
    if (this.running) throw new Error('任务还在进行中，结束后再切换模型')
    this.config = { ...this.config, model }
    this.model = languageModel ?? createLanguageModel(model.endpoint, model.modelId)
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
    this.activeTurn?.abort()
  }

  startTurn(id: string, prompt: string, kind: TurnKind = 'prompt', skills: string[] = []): void {
    if (!this.title) {
      const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
      this.title = firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS)}…` : firstLine
    }
    this.messageStarts.set(id, this.messages.length)
    this.turns.push({ id, kind, prompt, startedAt: new Date().toISOString(), endedAt: null, stopReason: null, updates: [], skills })
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
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      archived: this.archived,
      turns: this.turns.map((turn) => ({
        ...turn,
        checkpoint: this.turnCheckpoints.get(turn.id) ?? null,
        messageStart: this.messageStarts.get(turn.id) ?? null,
      })),
      messages: this.messages,
      compaction: this.compaction,
    }
  }

  // 发给编码模型的工具：内置的加上这一轮的 MCP 工具
  toolSet(): ToolSet {
    return this.mcpTools ? { ...TOOLS, ...this.mcpTools.tools } : TOOLS
  }

  toolChars(): number {
    return TOOL_DEFINITION_CHARS + (this.mcpTools?.chars ?? 0)
  }

  // 估算上下文里各部分占多少：按字数比例分摊模型实际返回的输入 token 数
  usageBreakdown(used: number): UsageBreakdown {
    const prompt = promptSections(this.systemPrompt)
    const chars = {
      system: prompt.base,
      rules: prompt.rules,
      tools: this.toolChars(),
      messages: JSON.stringify(this.contextMessages()).length,
    }
    const total = chars.system + chars.rules + chars.tools + chars.messages
    const share = (value: number) => (total > 0 ? Math.round((value / total) * used) : 0)
    return { system: share(chars.system), rules: share(chars.rules), tools: share(chars.tools), messages: share(chars.messages) }
  }

  // 某一轮开始之后的改动，unified diff
  async checkpointDiff(turnId: string): Promise<string> {
    const commit = this.turnCheckpoints.get(turnId)
    if (this.checkpoints && commit) return this.checkpoints.diffSince(commit)
    // 进行中的这一轮快照还没打好：快照在任何工具运行之前打，这时还没有改动
    if (this.checkpoints && this.running && this.turns.at(-1)?.id === turnId) return ''
    throw new Error('这一轮没有检查点，看不了改动')
  }

  // 重新生成：把这一轮及之后的文件改动和对话一起撤掉，调用方再用同样的提问发一轮
  async rewind(turnId: string): Promise<{ filesRestored: boolean }> {
    if (this.running) throw new Error('任务还在进行中，先停止再重新生成')
    const index = this.turns.findIndex((turn) => turn.id === turnId)
    const start = this.messageStarts.get(turnId)
    if (index < 0 || start === undefined) throw new Error('这一轮不能重新生成')
    const commit = this.turnCheckpoints.get(turnId)
    let filesRestored = false
    if (this.checkpoints && commit) {
      await this.checkpoints.restore(commit, await this.checkpoints.changesSince(commit))
      filesRestored = true
    }
    this.messages.splice(start)
    // 压缩点在截掉的部分里，摘要也就作废了；下次超限时再压
    if (this.compaction && this.compaction.upTo > start) this.compaction = null
    for (const turn of this.turns.splice(index)) {
      this.turnCheckpoints.delete(turn.id)
      this.messageStarts.delete(turn.id)
    }
    this.readHashes.clear()
    return { filesRestored }
  }

  async checkpointChanges(turnId: string): Promise<CheckpointChange[]> {
    const commit = this.turnCheckpoints.get(turnId)
    if (!this.checkpoints || !commit) throw new Error('这一轮没有检查点，无法撤销')
    return this.checkpoints.changesSince(commit)
  }

  // 还原到某一轮开始前：这一轮以及之后所有轮次的文件改动都会撤掉
  async restoreCheckpoint(turnId: string): Promise<CheckpointChange[]> {
    if (this.running) throw new Error('任务还在进行中，先停止再撤销')
    const commit = this.turnCheckpoints.get(turnId)
    if (!this.checkpoints || !commit) throw new Error('这一轮没有检查点，无法撤销')
    const changes = await this.checkpoints.changesSince(commit)
    await this.checkpoints.restore(commit, changes)
    // 文件已经变了，之前读过的内容都作废，并告诉模型
    this.readHashes.clear()
    this.messages.push({
      role: 'user',
      content:
        '[Note from Diffra] The user reverted all file changes made since an earlier point in this conversation. ' +
        'Files may differ from what you saw before; read them again before editing.',
    })
    return changes
  }
}
