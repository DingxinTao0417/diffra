import { readFileSync } from 'node:fs'
import { z } from 'zod'

// 评测用的模型配置。密钥不写进文件：apiKeyEnv 写环境变量名，运行时从环境变量读
const modelSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(['anthropic', 'anthropic-compatible', 'openai-responses', 'openai-compatible', 'gemini']),
  baseUrl: z.url(),
  modelId: z.string().min(1),
  contextWindow: z.number().int().positive().nullable().default(null),
  apiKeyEnv: z.string().min(1),
  // 思考强度，和模型设置里的一样；不写就是模型默认
  reasoningEffort: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
})

const configSchema = z.object({
  models: z.array(modelSchema).min(1),
  // 规范审查、轻量扫描、深度扫描用的模型（models 里的名字）；不填就用被评测的模型
  reviewer: z.string().nullable().default(null),
})

export type EvalModel = z.infer<typeof modelSchema>
export type EvalConfig = z.infer<typeof configSchema>

export function loadConfig(path: string): EvalConfig {
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) throw new Error(`评测配置 ${path} 不对：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
  return parsed.data
}

export function apiKeyOf(model: EvalModel): string {
  const key = process.env[model.apiKeyEnv]
  if (!key) throw new Error(`环境变量 ${model.apiKeyEnv} 没有设置，模型 ${model.name} 拿不到密钥`)
  return key
}
