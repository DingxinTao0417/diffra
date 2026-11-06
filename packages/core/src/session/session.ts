import { randomUUID } from 'node:crypto'
import type { LanguageModel, ModelMessage } from 'ai'
import type { Checkpoints } from '../checkpoint.js'
import { createLanguageModel } from '../models/operations.js'
import type { CheckpointChange, SessionConfig } from '../protocol.js'

export interface SessionEnvironment {
  bashPath: string | null
  rgPath: string
}

export interface SessionOptions {
  cwd: string
  config: SessionConfig
  environment: SessionEnvironment
  checkpoints: Checkpoints | null
  systemPrompt: string
  // 测试时注入模拟模型；正常运行按 config 创建
  model?: LanguageModel
}

export class Session {
  readonly id = randomUUID()
  readonly cwd: string
  readonly config: SessionConfig
  readonly environment: SessionEnvironment
  readonly checkpoints: Checkpoints | null
  readonly systemPrompt: string
  readonly model: LanguageModel
  readonly messages: ModelMessage[] = []
  readonly readHashes = new Map<string, string>()
  // 「本会话内允许同类命令」记下的命令键，见 permissions.commandKey
  readonly alwaysAllowed = new Set<string>()
  // turnId → 这一轮开始前的快照
  readonly turnCheckpoints = new Map<string, string>()
  activeTurn: AbortController | null = null

  constructor(options: SessionOptions) {
    this.cwd = options.cwd
    this.config = options.config
    this.environment = options.environment
    this.checkpoints = options.checkpoints
    this.systemPrompt = options.systemPrompt
    this.model = options.model ?? createLanguageModel(options.config.model.endpoint, options.config.model.modelId)
  }

  get running(): boolean {
    return this.activeTurn !== null
  }

  get trustedCommands(): string[] {
    return [this.config.checks.afterEdit, this.config.checks.beforeFinish].filter((item): item is string => item !== null)
  }

  cancel(): void {
    this.activeTurn?.abort()
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
