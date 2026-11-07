import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Core from '@diffra/core'
import type { ModelEndpoint, RulePack, SessionConfig } from '@diffra/core/types'
import { apiKeyOf, type EvalModel } from './config.ts'
import { CORE_DIST } from './proc.ts'

// 用 core 构建好的 dist，和 node packages/core/dist/index.js 跑的是同一份代码；类型来自源码
export const core = (await import(pathToFileURL(join(CORE_DIST, 'client.js')).href)) as typeof Core

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
    env: { ...process.env, DIFFRA_SESSIONS_DIR: join(dataDir, 'sessions'), DIFFRA_USAGE_DIR: join(dataDir, 'usage') },
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
  return { connection, stderr: () => stderr, stop: () => child.kill() }
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
  options: Pick<SessionConfig, 'checks' | 'readOnlyPaths' | 'security'> & { review: boolean; checkpointDir: string },
): SessionConfig {
  return {
    model: { endpoint: endpointOf(model), modelId: model.modelId, contextWindow: model.contextWindow, provider: { id: model.name, name: model.name } },
    reviewModel: reviewer ? { endpoint: endpointOf(reviewer), modelId: reviewer.modelId, provider: { id: reviewer.name, name: reviewer.name } } : null,
    // 评测只量编码模型本身：不出计划，也不换兜底模型
    planModel: null,
    fallbackModel: null,
    checks: options.checks,
    readOnlyPaths: options.readOnlyPaths,
    rules: { packs: builtinRulePacks(), review: options.review },
    // 评测里没人点确认：普通命令自动执行，剩下要确认的按题目的权限策略答
    permissionMode: 'auto',
    security: options.security,
    // 和应用设置的默认值一致
    limits: { compactAtPercent: 70, maxSteps: 100 },
    checkpointDir: options.checkpointDir,
  }
}
