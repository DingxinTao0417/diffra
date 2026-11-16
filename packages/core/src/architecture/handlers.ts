import type * as acp from '@agentclientprotocol/sdk'
import type { LanguageModelUsage } from 'ai'
import { z } from 'zod'
import { ARCHITECTURE_USAGE_ID, CLIENT_EXT_NOTIFICATIONS, SESSION_EXT_METHODS, type SessionModel } from '../protocol.js'
import { modelConfigSchema } from '../session/config.js'
import { toUsageRecord, type UsageLog } from '../usage/log.js'
import { generateDiagram, generateFlowChart, interpretArchitecture, interpretModule, proposeTarget } from './interpret.js'
import { ARCHITECTURE_VERSION, type ArchitectureEvent, type ArchitectureLayout, DIAGRAM_KINDS, INTERPRET_PARTS, type InterpretPart } from './model.js'
import { diagramSchema, targetSchema } from './schemas.js'

const PART_NAMES: Record<InterpretPart, string> = { overview: '系统简介和流程', application: '应用架构图', technology: '技术架构图', system: '系统架构图' }
import type { ArchitectureService } from './service.js'

const projectParams = z.object({ projectId: z.string().min(1).max(64) })


const point = z.object({ x: z.number().finite(), y: z.number().finite() })
const layoutSchema = z.record(z.string().max(600), z.record(z.string().max(600), point)) satisfies z.ZodType<ArchitectureLayout>

// 架构分析的请求；分析和全局解读在后台跑，进度和结果用通知推给客户端（最近一次发请求的那个客户端）
export function registerArchitecture(app: acp.AgentApp, service: ArchitectureService, usageLog: UsageLog | null, setNotifier: (notify: (event: ArchitectureEvent) => void) => void): acp.AgentApp {
  const remember = (client: acp.AgentContext) => setNotifier((event) => void client.notify(CLIENT_EXT_NOTIFICATIONS.architectureEvent, event).catch(() => {}))

  const logUsage = async (model: SessionModel, usage: LanguageModelUsage | null, cwd: string) => {
    if (!usageLog || !usage) return
    const call = { role: 'planner' as const, provider: model.provider, modelId: model.modelId, usage }
    await usageLog.append(toUsageRecord(call, { id: ARCHITECTURE_USAGE_ID, cwd }, new Date())).catch((error: unknown) => console.error('[usage] 架构解读的用量记录写入失败', error))
  }

  const requireAnalysis = async (projectId: string) => {
    const analysis = await service.analysis(projectId)
    if (!analysis) throw new Error('这个项目还没有分析过，先点「分析」')
    return analysis
  }

  return app
    .onRequest(SESSION_EXT_METHODS.architectureList, z.object({}), ({ client }) => {
      remember(client)
      return service.list()
    })
    .onRequest(SESSION_EXT_METHODS.architectureAdd, z.object({ path: z.string().min(1).max(4096) }), ({ params }) => service.add(params.path))
    .onRequest(SESSION_EXT_METHODS.architectureRemove, projectParams, async ({ params }) => {
      await service.remove(params.projectId)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureAnalyze, projectParams, async ({ params, client }) => {
      remember(client)
      await service.analyze(params.projectId)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureCancel, projectParams, ({ params }) => {
      service.cancel(params.projectId)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureRunning, z.object({}), ({ client }) => {
      remember(client)
      return service.running()
    })
    .onRequest(SESSION_EXT_METHODS.architectureBundle, projectParams, ({ params }) => service.bundle(params.projectId))
    .onRequest(SESSION_EXT_METHODS.architectureStale, projectParams, async ({ params }) => ({ stale: await service.stale(params.projectId) }))
    .onRequest(SESSION_EXT_METHODS.architectureExport, projectParams, ({ params }) => service.exportShared(params.projectId))
    .onRequest(SESSION_EXT_METHODS.architectureShared, projectParams, ({ params }) => service.sharedStatus(params.projectId))
    .onRequest(SESSION_EXT_METHODS.architectureImport, projectParams, async ({ params }) => {
      await service.importShared(params.projectId)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureWatch, projectParams.extend({ watch: z.boolean(), auto: z.boolean() }), async ({ params, client }) => {
      remember(client)
      await service.watch(params.projectId, params.watch, params.auto)
      return {}
    })
    // 全局解读在后台跑：一次模型调用要一两分钟，进度显示在项目上
    // 全局解读和三张架构图各一次模型调用，并行跑；每样做完就存，一样失败不影响别的
    .onRequest(SESSION_EXT_METHODS.architectureInterpret, projectParams.extend({ model: modelConfigSchema, parts: z.array(z.enum(INTERPRET_PARTS)).min(1).max(INTERPRET_PARTS.length) }), async ({ params, client }) => {
      remember(client)
      const analysis = await requireAnalysis(params.projectId)
      const project = await service.project(params.projectId)
      const parts = [...new Set(params.parts)]
      service.start(params.projectId, 'interpreting', async (signal, report) => {
        let done = 0
        report('interpreting', 0, parts.length)
        const run = async (part: InterpretPart) => {
          if (part === 'overview') {
            const previous = await service.interpretation(params.projectId)
            const { value, usage } = await interpretArchitecture(analysis, params.model, previous?.notes ?? {}, signal)
            await logUsage(params.model, usage, project.path)
            // 流程名还在的，画过的流程图留着
            const charts = Object.fromEntries(Object.entries(previous?.charts ?? {}).filter(([name]) => value.flows.some((flow) => flow.name === name)))
            await service.saveInterpretation(params.projectId, { ...value, charts })
          } else {
            const previous = (await service.diagrams(params.projectId))[part]
            const { value, usage } = await generateDiagram(analysis, part, params.model, previous, signal)
            await logUsage(params.model, usage, project.path)
            await service.saveDiagram(params.projectId, value)
          }
          report('interpreting', ++done, parts.length)
        }
        const results = await Promise.allSettled(parts.map(run))
        const failed = results.flatMap((result, at) => (result.status === 'rejected' ? [`${PART_NAMES[parts[at]!]}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []))
        if (failed.length > 0) throw new Error(failed.join('；'))
      })
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureSaveDiagram, projectParams.extend({ diagram: diagramSchema }), async ({ params }) => {
      await service.saveDiagram(params.projectId, params.diagram)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureInterpretModule, projectParams.extend({ model: modelConfigSchema, path: z.string().max(4096) }), async ({ params }) => {
      const analysis = await requireAnalysis(params.projectId)
      const project = await service.project(params.projectId)
      const { value, usage } = await interpretModule(analysis, params.path, params.model)
      await logUsage(params.model, usage, project.path)
      const interpretation = await service.interpretation(params.projectId)
      // 还没有全局解读时也能存单个目录的解读：先放一份空的
      const next = interpretation ?? {
        version: ARCHITECTURE_VERSION,
        generatedAt: '',
        model: value.model,
        fingerprint: analysis.fingerprint,
        summary: '',
        techStack: [],
        entryPoints: [],
        readingOrder: [],
        layers: [],
        modules: [],
        externalSystems: [],
        flows: [],
        notes: {},
        dropped: 0,
      }
      await service.saveInterpretation(params.projectId, { ...next, notes: { ...next.notes, [params.path]: value } })
      return value
    })
    .onRequest(SESSION_EXT_METHODS.architectureFlowChart, projectParams.extend({ model: modelConfigSchema, flow: z.string().min(1).max(500) }), async ({ params }) => {
      const analysis = await requireAnalysis(params.projectId)
      const project = await service.project(params.projectId)
      const flow = (await service.interpretation(params.projectId))?.flows.find((item) => item.name === params.flow)
      if (!flow) throw new Error(`没有「${params.flow}」这条流程，先重新解读一遍`)
      const { value, usage } = await generateFlowChart(analysis, flow, params.model)
      await logUsage(params.model, usage, project.path)
      // 画的这一两分钟里解读可能重新生成过：存进最新的那份，这条流程已经没了就不存
      const latest = await service.interpretation(params.projectId)
      if (latest?.flows.some((item) => item.name === params.flow)) await service.saveInterpretation(params.projectId, { ...latest, charts: { ...latest.charts, [params.flow]: value } })
      return value
    })
    .onRequest(SESSION_EXT_METHODS.architectureProposeTarget, projectParams.extend({ model: modelConfigSchema, principles: z.string().max(10_000) }), async ({ params }) => {
      const analysis = await requireAnalysis(params.projectId)
      const project = await service.project(params.projectId)
      const { value, usage } = await proposeTarget(analysis, await service.target(params.projectId), params.principles, params.model)
      await logUsage(params.model, usage, project.path)
      return value
    })
    .onRequest(SESSION_EXT_METHODS.architectureSaveTarget, projectParams.extend({ target: targetSchema.nullable() }), async ({ params }) => {
      await service.saveTarget(params.projectId, params.target)
      return {}
    })
    .onRequest(SESSION_EXT_METHODS.architectureSource, projectParams.extend({ path: z.string().min(1).max(4096) }), ({ params }) => service.source(params.projectId, params.path))
    .onRequest(SESSION_EXT_METHODS.architectureSaveLayout, projectParams.extend({ layout: layoutSchema }), async ({ params }) => {
      await service.saveLayout(params.projectId, params.layout)
      return {}
    })
}
