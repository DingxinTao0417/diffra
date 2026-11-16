import { z } from 'zod'
import { PROTOCOLS } from '../models/types.js'
import {
  BROWSER_BACKENDS,
  BROWSER_KEY_HOLD_MAX_MS,
  BROWSER_KEY_REPEAT_MAX,
  BROWSER_MODIFIERS,
  BROWSER_UPLOAD_MAX_FILES,
  BROWSER_WAIT_MAX_SECONDS,
  REASONING_EFFORTS,
  SCREENSHOT_MAX_WIDTH,
  SCREENSHOT_MIN_WIDTH,
  TERMINAL_MAX_LINES,
  type ExternalAgentSpec,
  type SessionConfig,
  type SessionDesign,
} from '../protocol.js'

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

const securitySchema = z.object({ staticCheck: z.boolean(), lightScan: z.boolean(), deepScan: z.boolean().optional() })

export const checkSwitchesSchema = securitySchema.extend({ review: z.boolean() })

export const modelConfigSchema = z.object({
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  endpoint: endpointSchema,
  modelId: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  provider: providerSchema,
  supportsImages: z.boolean().default(false),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
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
  security: securitySchema,
  allowedCommands: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  memoryDir: z.string().min(1).nullable().optional(),
  hooks: z.object({ afterEdit: checkCommandSchema.optional(), beforeCommand: checkCommandSchema.optional(), turnEnd: checkCommandSchema.optional() }).optional(),
  limits: z.object({
    compactAtPercent: z.number().int().min(50).max(90),
    maxSteps: z.number().int().positive().nullable(),
    goalMaxRounds: z.number().int().min(1).max(50),
  }),
  plugins: z.array(z.object({ name: z.string().min(1), dir: z.string().min(1), hooks: z.string().min(1).optional() })).default([]),
  browser: z.boolean().default(false),
  design: z.boolean().default(false),
  designStyle: z.string().min(1).nullable().default(null),
  noProject: z.boolean().default(false),
  checkpointDir: z.string().min(1).nullable(),
}) satisfies z.ZodType<SessionConfig>

export const newSessionMetaSchema = z.object({ diffra: sessionConfigSchema })

// 外接智能体（ExternalAgentSpec）：设置里的一项，环境变量的值可能是密钥
export const externalAgentSpecSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(2000)).max(50),
  env: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(10_000) })).max(50),
}) satisfies z.ZodType<ExternalAgentSpec>

// 建外接智能体任务时 session/new 的 _meta.diffra（ExternalSessionConfig）
export const externalSessionMetaSchema = z.object({
  diffra: z.object({
    external: z.object({ agentId: z.string().min(1) }),
    permissionMode: z.enum(['ask', 'auto', 'full']),
    readOnlyPaths: z.array(z.string().trim().min(1)).default([]),
    noProject: z.boolean().default(false),
    checkpointDir: z.string().min(1).nullable(),
  }),
})

// 打开外接智能体的旧任务时客户端可能传的是普通会话配置：只取用得上的几项
export const externalLoadMetaSchema = z.object({
  diffra: z.object({
    permissionMode: z.enum(['ask', 'auto', 'full']),
    readOnlyPaths: z.array(z.string().trim().min(1)).default([]),
    noProject: z.boolean().default(false),
    checkpointDir: z.string().min(1).nullable().default(null),
  }),
})

const browserPointSchema = z.union([z.object({ ref: z.string().min(1) }), z.object({ x: z.number().finite(), y: z.number().finite() })])

export const browserActionParamsSchema = z.intersection(
  z.object({ sessionId: z.string().min(1) }),
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('navigate'), url: z.url() }),
    z.object({ action: z.literal('history'), direction: z.enum(['back', 'forward', 'reload']) }),
    z.object({ action: z.literal('tabs'), op: z.enum(['list', 'new', 'select', 'close']), url: z.url().nullable(), index: z.number().int().min(1).nullable() }),
    z.object({ action: z.literal('snapshot') }),
    z.object({ action: z.literal('find'), query: z.string().min(1).max(200) }),
    z.object({ action: z.literal('text') }),
    z.object({ action: z.literal('click'), at: browserPointSchema, button: z.enum(['left', 'right', 'middle']), double: z.boolean(), modifiers: z.array(z.enum(BROWSER_MODIFIERS)) }),
    z.object({ action: z.literal('hover'), at: browserPointSchema }),
    z.object({ action: z.literal('drag'), from: browserPointSchema, to: browserPointSchema }),
    z.object({ action: z.literal('scroll'), at: browserPointSchema.nullable(), deltaX: z.number().finite(), deltaY: z.number().finite() }),
    z.object({ action: z.literal('type'), ref: z.string().min(1).nullable(), text: z.string(), submit: z.boolean() }),
    z.object({ action: z.literal('press'), key: z.string().min(1).max(60), repeat: z.number().int().min(1).max(BROWSER_KEY_REPEAT_MAX), holdMs: z.number().int().min(0).max(BROWSER_KEY_HOLD_MAX_MS) }),
    z.object({ action: z.literal('select'), ref: z.string().min(1), values: z.array(z.string()).min(1) }),
    z.object({ action: z.literal('upload'), ref: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(BROWSER_UPLOAD_MAX_FILES) }),
    z.object({ action: z.literal('wait'), text: z.string().min(1).nullable(), textGone: z.string().min(1).nullable(), seconds: z.number().min(0).max(BROWSER_WAIT_MAX_SECONDS) }),
    z.object({ action: z.literal('dialog'), accept: z.boolean(), promptText: z.string().nullable() }),
    z.object({ action: z.literal('console') }),
    z.object({ action: z.literal('network'), filter: z.string().min(1).nullable(), failedOnly: z.boolean() }),
    z.object({ action: z.literal('evaluate'), expression: z.string().min(1).max(20_000) }),
    z.object({ action: z.literal('screenshot'), width: z.number().int().min(SCREENSHOT_MIN_WIDTH).max(SCREENSHOT_MAX_WIDTH).nullable(), fullPage: z.boolean() }),
    z.object({ action: z.literal('layout') }),
    z.object({ action: z.literal('images') }),
    z.object({ action: z.literal('switch'), browser: z.enum(BROWSER_BACKENDS) }),
  ]),
)

export const devServerParamsSchema = z.discriminatedUnion('action', [
  z.object({ sessionId: z.string().min(1), action: z.literal('terminal-list') }),
  z.object({ sessionId: z.string().min(1), action: z.literal('terminal-read'), terminalId: z.string().uuid(), lines: z.number().int().min(1).max(TERMINAL_MAX_LINES) }),
  z.object({ sessionId: z.string().min(1), action: z.literal('start'), command: z.string().trim().min(1).max(2000), cwd: z.string().min(1) }),
  z.object({ sessionId: z.string().min(1), action: z.literal('logs') }),
  z.object({ sessionId: z.string().min(1), action: z.literal('stop') }),
])

export const sessionDesignSchema = z.object({
  tools: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), description: z.string(), inputSchema: z.record(z.string(), z.unknown()), readOnly: z.boolean() })),
  instructions: z.string(),
}) satisfies z.ZodType<SessionDesign>

export const designActionParamsSchema = z.object({
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  args: z.unknown(),
  agent: z.object({ id: z.string().min(1), name: z.string().min(1), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).nullable().optional(),
})

export const pluginRefSchema = z.object({ name: z.string().min(1), dir: z.string().min(1), hooks: z.string().min(1).optional() })

const nameValueSchema = z.object({ name: z.string().min(1), value: z.string() })

// ACP 的 McpServer：stdio 或 HTTP（SSE 不支持）
export const mcpServerSchema = z.union([
  z.object({ type: z.literal('http'), name: z.string().min(1), url: z.url(), headers: z.array(nameValueSchema) }),
  z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()), env: z.array(nameValueSchema) }),
])

// skills：用户给这一轮选的 Skill 名称；goal：目标模式，自主推进多轮
export const taskSourceSchema = z.object({ sessionId: z.string().min(1), title: z.string() })
export const remoteSourceSchema = z.object({ deviceId: z.string().regex(/^[0-9a-f]{32}$/), name: z.string().min(1).max(60) })

export const promptMetaSchema = z.object({
  diffra: z.object({
    turnId: z.string().min(1),
    skills: z.array(z.string().min(1)).default([]),
    goal: z.boolean().default(false),
    from: taskSourceSchema.optional(),
    remote: remoteSourceSchema.optional(),
  }),
})

export const taskActionParamsSchema = z.discriminatedUnion('action', [
  z.object({ sessionId: z.string().min(1), action: z.literal('send'), target: z.string().min(1), message: z.string().min(1), from: taskSourceSchema }),
  z.object({
    sessionId: z.string().min(1),
    action: z.literal('create'),
    project: z.string().min(1).nullable(),
    title: z.string().nullable(),
    design: z.boolean(),
    message: z.string().min(1),
    from: taskSourceSchema,
  }),
])
