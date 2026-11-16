import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Core from '@diffra/core'
import type { ModelEndpoint, RulePack, SessionConfig } from '@diffra/core/types'
import type * as CoreTypes from '@diffra/core/types'
import { apiKeyOf, type EvalModel } from './config.ts'
import { CORE_DIST, EVAL_ENV } from './proc.ts'

// 用 core 构建好的 dist，和 node packages/core/dist/index.js 跑的是同一份代码；类型来自源码
export const core = (await import(pathToFileURL(join(CORE_DIST, 'client.js')).href)) as typeof Core
// 结束 core 时连它起的命令、服务一起结束：Windows 上 child.kill() 只结束 core 本身，core 的退出钩子不会跑
const { killTreeSync } = (await import(pathToFileURL(join(CORE_DIST, 'process.js')).href)) as { killTreeSync(pid: number | undefined): void }
// 统计和费用（v2）：core 里的纯计算，和桌面端的「评测结果」页用同一份
export const coreTypes = (await import(pathToFileURL(join(CORE_DIST, 'protocol.js')).href)) as typeof CoreTypes

const MAX_STDERR_CHARS = 20_000
const BUILTIN_PACKS_DIR = resolve(CORE_DIST, '../rules/packs')

export interface CoreProcess {
  connection: ReturnType<typeof Core.connectToCore>
  stderr(): string
  stop(): void
}

// 每道题起一个独立的 core 进程，会话记录和用量记录写到这道题的临时目录
export async function startCore(dataDir: string, handlers: Core.CoreClientHandlers): Promise<CoreProcess> {
  const child = spawn(process.execPath, [join(CORE_DIST, 'index.js')], {
    env: { ...EVAL_ENV, DIFFRA_SESSIONS_DIR: join(dataDir, 'sessions'), DIFFRA_USAGE_DIR: join(dataDir, 'usage') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS)
  })
  const connection = core.connectToCore(child.stdin, child.stdout, handlers)
  try {
    await core.handshake(connection, 15_000)
  } catch (error) {
    child.kill()
    throw new Error(`core 没有启动起来：${error instanceof Error ? error.message : String(error)}\n${stderr}`)
  }
  return {
    connection,
    stderr: () => stderr,
    stop: () => {
      if (child.exitCode === null) killTreeSync(child.pid)
    },
  }
}

function endpointOf(model: EvalModel): ModelEndpoint {
  return { protocol: model.protocol, baseUrl: model.baseUrl, apiKey: apiKeyOf(model) }
}

// 和应用的默认值一致：内置规则包全部启用，只放强制级规则
export function builtinRulePacks(): RulePack[] {
  return readdirSync(BUILTIN_PACKS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => core.parseRulePack(readFileSync(join(BUILTIN_PACKS_DIR, name), 'utf8')))
    .map((pack) => ({ ...pack, rules: pack.rules.filter((rule) => rule.level === 'required') }))
    .filter((pack) => pack.rules.length > 0)
}

export function sessionConfig(
  model: EvalModel,
  reviewer: EvalModel | null,
  options: Pick<SessionConfig, 'checks' | 'readOnlyPaths' | 'security'> & {
    review: boolean
    checkpointDir: string
    permissionMode?: SessionConfig['permissionMode']
    // 题目要逼出上下文压缩时改小窗口
    contextWindow?: number
  },
): SessionConfig {
  return {
    model: {
      endpoint: endpointOf(model),
      modelId: model.modelId,
      contextWindow: options.contextWindow ?? model.contextWindow,
      provider: { id: model.name, name: model.name },
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    },
    reviewModel: reviewer ? { endpoint: endpointOf(reviewer), modelId: reviewer.modelId, provider: { id: reviewer.name, name: reviewer.name } } : null,
    // 评测只量编码模型本身：不出计划，也不换兜底模型
    planModel: null,
    fallbackModel: null,
    checks: options.checks,
    readOnlyPaths: options.readOnlyPaths,
    rules: { packs: builtinRulePacks(), review: options.review },
    // 评测里没人点确认：默认普通命令自动执行，剩下要确认的按题目的权限策略答
    permissionMode: options.permissionMode ?? 'auto',
    security: options.security,
    // 和应用设置的默认值一致
    limits: { compactAtPercent: 70, maxSteps: 100, goalMaxRounds: 5 },
    plugins: [],
    checkpointDir: options.checkpointDir,
  }
}
