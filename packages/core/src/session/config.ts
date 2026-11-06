import { z } from 'zod'
import { PROTOCOLS } from '../models/types.js'
import type { SessionConfig } from '../protocol.js'

export const endpointSchema = z.object({
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().min(1),
})

const checkCommandSchema = z.string().trim().min(1).nullable()

export const sessionConfigSchema = z.object({
  model: z.object({
    endpoint: endpointSchema,
    modelId: z.string().min(1),
    contextWindow: z.number().int().positive().nullable(),
  }),
  checks: z.object({ afterEdit: checkCommandSchema, beforeFinish: checkCommandSchema }),
  checkpointDir: z.string().min(1).nullable(),
}) satisfies z.ZodType<SessionConfig>

export const newSessionMetaSchema = z.object({ diffra: sessionConfigSchema })

export const promptMetaSchema = z.object({ diffra: z.object({ turnId: z.string().min(1) }) })
