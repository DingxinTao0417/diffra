import { z } from 'zod'
import { PROTOCOLS } from '../models/types.js'
import type { SessionConfig } from '../protocol.js'

export const endpointSchema = z.object({
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().min(1),
})

const checkCommandSchema = z.string().trim().min(1).nullable()

const ruleSchema = z.object({
  id: z.string().min(1),
  level: z.enum(['required', 'recommended']),
  section: z.string().nullable(),
  text: z.string().min(1),
})

const rulePackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  languages: z.array(z.string().min(1)).min(1),
  source: z.string(),
  license: z.string(),
  rules: z.array(ruleSchema),
})

const providerSchema = z.object({ id: z.string().min(1), name: z.string().min(1) }).nullable()

export const modelConfigSchema = z.object({
  endpoint: endpointSchema,
  modelId: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  provider: providerSchema,
})

export const sessionConfigSchema = z.object({
  model: modelConfigSchema,
  reviewModel: z.object({ endpoint: endpointSchema, modelId: z.string().min(1), provider: providerSchema }).nullable(),
  planModel: modelConfigSchema.nullable(),
  fallbackModel: modelConfigSchema.nullable(),
  checks: z.object({ afterEdit: checkCommandSchema, beforeFinish: checkCommandSchema }),
  readOnlyPaths: z.array(z.string().trim().min(1)),
  rules: z.object({ packs: z.array(rulePackSchema), review: z.boolean() }),
  permissionMode: z.enum(['ask', 'auto', 'full']),
  security: z.object({ staticCheck: z.boolean(), lightScan: z.boolean() }),
  limits: z.object({
    compactAtPercent: z.number().int().min(50).max(90),
    maxSteps: z.number().int().positive().nullable(),
    goalMaxRounds: z.number().int().min(1).max(50),
  }),
  plugins: z.array(z.object({ name: z.string().min(1), dir: z.string().min(1) })).default([]),
  checkpointDir: z.string().min(1).nullable(),
}) satisfies z.ZodType<SessionConfig>

export const newSessionMetaSchema = z.object({ diffra: sessionConfigSchema })

export const pluginRefSchema = z.object({ name: z.string().min(1), dir: z.string().min(1) })

const nameValueSchema = z.object({ name: z.string().min(1), value: z.string() })

// ACP 的 McpServer：stdio 或 HTTP（SSE 不支持）
export const mcpServerSchema = z.union([
  z.object({ type: z.literal('http'), name: z.string().min(1), url: z.url(), headers: z.array(nameValueSchema) }),
  z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()), env: z.array(nameValueSchema) }),
])

// skills：用户给这一轮选的 Skill 名称；goal：目标模式，自主推进多轮
export const promptMetaSchema = z.object({
  diffra: z.object({ turnId: z.string().min(1), skills: z.array(z.string().min(1)).default([]), goal: z.boolean().default(false) }),
})
