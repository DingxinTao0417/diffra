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
  limits: z.object({ compactAtPercent: z.number().int().min(50).max(90), maxSteps: z.number().int().positive().nullable() }),
  checkpointDir: z.string().min(1).nullable(),
}) satisfies z.ZodType<SessionConfig>

export const newSessionMetaSchema = z.object({ diffra: sessionConfigSchema })

export const promptMetaSchema = z.object({ diffra: z.object({ turnId: z.string().min(1) }) })
