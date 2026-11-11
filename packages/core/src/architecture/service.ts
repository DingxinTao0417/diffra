import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { keepPinned, staticDiagram, thumbnailOf, verifyDiagram } from './diagrams.js'
import { AnalysisCancelled, analyzeProject, currentFingerprint, digestOf, type ParseCache } from './engine.js'
import {
  type AnalysisDigest,
  type AnalysisPhase,
  type AnalysisProgress,
  ARCHITECTURE_VERSION,
  type ArchitectureAnalysis,
  type ArchitectureBundle,
  type ArchitectureDiagrams,
  type ArchitectureEvent,
  type ArchitectureInterpretation,
  type ArchitectureLayout,
  type ArchitectureProject,
  type ArchitectureProjectSummary,
  type ArchitectureThumbnail,
  type BlockDiagram,
  DIAGRAM_KINDS,
  evaluateTarget,
  type TargetArchitecture,
  targetGapCount,
} from './model.js'

const PROJECTS_FILE = 'projects.json'
const MAX_PROJECTS = 200

// 卡片页要的东西单独存一份小文件，列项目时不用读几十 MB 的分析结果
interface ProjectSummaryFile {
  digest: AnalysisDigest | null
  thumbnail: ArchitectureThumbnail | null
  interpretedAt: string | null
  target: { violations: number; gaps: number } | null
}

export function projectIdOf(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return createHash('sha1')
    .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
    .digest('hex')
    .slice(0, 16)
}

// 架构功能的数据：项目列表、每个项目的分析结果、解析缓存、模型解读、目标架构、手动布局，都在一个目录下。
// 一个项目同一时间只跑一次分析；分析和模型解读的进度通过 onEvent 推给客户端
export class ArchitectureService {
  private readonly runs = new Map<string, { controller: AbortController; progress: AnalysisProgress }>()
  private projectsCache: ArchitectureProject[] | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly rgPath: () => Promise<string>,
    private readonly onEvent: (event: ArchitectureEvent) => void,
  ) {}

  private projectDir(id: string): string {
    return join(this.dir, id)
  }

  private async readJson<T>(path: string): Promise<T | null> {
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (text === null) return null
    try {
      return JSON.parse(text) as T
    } catch (error) {
      console.error(`[architecture] ${path} 不是有效的 JSON，按没有处理`, error)
      return null
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, JSON.stringify(value), 'utf8')
    await rename(temp, path)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => {})
    return result
  }

  private async loadProjects(): Promise<ArchitectureProject[]> {
    if (this.projectsCache) return this.projectsCache
    const file = await this.readJson<{ version: number; projects: ArchitectureProject[] }>(join(this.dir, PROJECTS_FILE))
    this.projectsCache = file?.projects ?? []
    return this.projectsCache
  }

  async project(id: string): Promise<ArchitectureProject> {
    const project = (await this.loadProjects()).find((item) => item.id === id)
    if (!project) throw new Error('架构列表里没有这个项目')
    return project
  }

  async list(): Promise<ArchitectureProjectSummary[]> {
    const projects = await this.loadProjects()
    return Promise.all(
      projects.map(async (project) => {
        const summary = await this.readJson<ProjectSummaryFile>(join(this.projectDir(project.id), 'summary.json'))
        return {
          ...project,
          analysis: summary?.digest ?? null,
          thumbnail: summary?.thumbnail ?? null,
          interpretedAt: summary?.interpretedAt ?? null,
          target: summary?.target ?? null,
          exists: existsSync(project.path),
        }
      }),
    )
  }

  add(path: string): Promise<ArchitectureProject> {
    return this.enqueue(async () => {
      const absolute = resolve(path)
      const info = await stat(absolute).catch(() => null)
      if (!info?.isDirectory()) throw new Error(`找不到文件夹：${absolute}`)
      const projects = await this.loadProjects()
      const id = projectIdOf(absolute)
      const existing = projects.find((item) => item.id === id)
      if (existing) return existing
      if (projects.length >= MAX_PROJECTS) throw new Error(`架构列表最多 ${MAX_PROJECTS} 个项目，先移除一些`)
      const project: ArchitectureProject = { id, path: absolute, name: basename(absolute) || absolute, addedAt: new Date().toISOString() }
      const next = [...projects, project]
      await this.writeJson(join(this.dir, PROJECTS_FILE), { version: ARCHITECTURE_VERSION, projects: next })
      this.projectsCache = next
      return project
    })
  }

  // 只从列表移除；分析结果和目标架构留在磁盘上，再加回来时还在
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.runs.get(id)?.controller.abort()
      const next = (await this.loadProjects()).filter((item) => item.id !== id)
      await this.writeJson(join(this.dir, PROJECTS_FILE), { version: ARCHITECTURE_VERSION, projects: next })
      this.projectsCache = next
    })
  }

  running(): AnalysisProgress[] {
    return [...this.runs.values()].map((run) => run.progress)
  }

  isRunning(id: string): boolean {
    return this.runs.has(id)
  }

  cancel(id: string): void {
    this.runs.get(id)?.controller.abort()
  }

  // 开始一次后台任务（分析、解读）；同一个项目已经在跑时报错。进度和结果走 onEvent
  start(id: string, phase: AnalysisPhase, work: (signal: AbortSignal, report: (phase: AnalysisPhase, done: number, total: number) => void) => Promise<void>): void {
    if (this.runs.has(id)) throw new Error('这个项目正在分析，等它结束或先取消')
    const controller = new AbortController()
    const progress: AnalysisProgress = { projectId: id, phase, done: 0, total: 0, startedAt: new Date().toISOString() }
    this.runs.set(id, { controller, progress })
    this.onEvent({ projectId: id, progress })
    const report = (next: AnalysisPhase, done: number, total: number) => {
      Object.assign(progress, { phase: next, done, total })
      this.onEvent({ projectId: id, progress: { ...progress } })
    }
    work(controller.signal, report).then(
      () => {
        this.runs.delete(id)
        this.onEvent({ projectId: id, progress: null, outcome: 'done' })
      },
      (error: unknown) => {
        this.runs.delete(id)
        if (error instanceof AnalysisCancelled || controller.signal.aborted) {
          this.onEvent({ projectId: id, progress: null, outcome: 'cancelled' })
          return
        }
        console.error(`[architecture] ${id} 失败`, error)
        this.onEvent({ projectId: id, progress: null, outcome: 'failed', error: error instanceof Error ? error.message : String(error) })
      },
    )
  }

  analyze(id: string): Promise<void> {
    return this.project(id).then((project) => {
      if (!existsSync(project.path)) throw new Error(`找不到文件夹：${project.path}`)
      this.start(id, 'listing', async (signal, report) => {
        const dir = this.projectDir(id)
        const cache = await this.readJson<ParseCache>(join(dir, 'cache.json'))
        const { analysis, cache: nextCache } = await analyzeProject({ projectId: id, root: project.path, rgPath: await this.rgPath(), cache, signal, onProgress: report })
        report('saving', 0, 0)
        await this.writeJson(join(dir, 'analysis.json'), analysis)
        await this.writeJson(join(dir, 'cache.json'), nextCache)
        await this.refreshDiagrams(id, analysis)
        await this.updateSummary(id, analysis)
      })
    })
  }

  async analysis(id: string): Promise<ArchitectureAnalysis | null> {
    return this.readJson<ArchitectureAnalysis>(join(this.projectDir(id), 'analysis.json'))
  }

  async interpretation(id: string): Promise<ArchitectureInterpretation | null> {
    return this.readJson<ArchitectureInterpretation>(join(this.projectDir(id), 'interpretation.json'))
  }

  async target(id: string): Promise<TargetArchitecture | null> {
    return this.readJson<TargetArchitecture>(join(this.projectDir(id), 'target.json'))
  }

  // 任务里检查用：这个目录有目标架构、打开了「任务里检查」、也分析过
  async enforcedTarget(root: string): Promise<{ analysis: ArchitectureAnalysis; target: TargetArchitecture } | null> {
    const id = projectIdOf(root)
    const target = await this.target(id)
    if (!target?.enforceInTasks) return null
    const analysis = await this.analysis(id)
    return analysis ? { analysis, target } : null
  }

  async bundle(id: string): Promise<ArchitectureBundle> {
    const project = await this.project(id)
    const dir = this.projectDir(id)
    const [analysis, interpretation, diagrams, target, layout] = await Promise.all([
      this.analysis(id),
      this.interpretation(id),
      this.diagrams(id),
      this.target(id),
      this.readJson<ArchitectureLayout>(join(dir, 'layout.json')),
    ])
    return { project, analysis, interpretation, diagrams, target, layout: layout ?? {} }
  }

  // 代码在分析之后变过没有；从没分析过、文件夹不在了为 null
  async stale(id: string): Promise<boolean | null> {
    const project = await this.project(id)
    const summary = await this.readJson<ProjectSummaryFile>(join(this.projectDir(id), 'summary.json'))
    if (!summary?.digest || !existsSync(project.path)) return null
    return (await currentFingerprint(project.path, await this.rgPath())) !== summary.digest.fingerprint
  }

  async saveInterpretation(id: string, interpretation: ArchitectureInterpretation): Promise<void> {
    await this.writeJson(join(this.projectDir(id), 'interpretation.json'), interpretation)
    await this.updateSummary(id)
  }

  async saveTarget(id: string, target: TargetArchitecture | null): Promise<void> {
    const path = join(this.projectDir(id), 'target.json')
    if (target) await this.writeJson(path, target)
    else if (existsSync(path)) await rename(path, `${path}.removed-${Date.now()}`)
    await this.updateSummary(id)
  }

  // 只读分析里列出的代码文件，路径不会跑出项目目录
  async source(id: string, path: string): Promise<{ text: string; lines: number }> {
    const project = await this.project(id)
    const analysis = await this.analysis(id)
    if (!analysis?.files.some((file) => file.path === path)) throw new Error(`分析结果里没有 ${path}，重新分析后再看`)
    const text = await readFile(join(project.path, path), 'utf8')
    return { text, lines: text.split('\n').length }
  }

  async saveLayout(id: string, layout: ArchitectureLayout): Promise<void> {
    await this.writeJson(join(this.projectDir(id), 'layout.json'), layout)
  }

  async diagrams(id: string): Promise<ArchitectureDiagrams> {
    return (await this.readJson<{ diagrams: ArchitectureDiagrams }>(join(this.projectDir(id), 'diagrams.json')))?.diagrams ?? {}
  }

  async saveDiagram(id: string, diagram: BlockDiagram): Promise<void> {
    await this.enqueue(async () => {
      const diagrams = await this.diagrams(id)
      await this.writeJson(join(this.projectDir(id), 'diagrams.json'), { version: ARCHITECTURE_VERSION, diagrams: { ...diagrams, [diagram.kind]: diagram } })
    })
    if (diagram.kind === 'application') await this.updateSummary(id)
  }

  // 每次分析完：还没让模型画过的图按新的分析重排（手改的方块留着）；模型画的图只重新核对路径
  private async refreshDiagrams(id: string, analysis: ArchitectureAnalysis): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.diagrams(id)
      const next: ArchitectureDiagrams = {}
      for (const kind of DIAGRAM_KINDS) {
        const existing = current[kind]
        next[kind] = existing?.source === 'model' ? verifyDiagram(analysis, existing) : keepPinned(existing, staticDiagram(kind, analysis))
      }
      await this.writeJson(join(this.projectDir(id), 'diagrams.json'), { version: ARCHITECTURE_VERSION, diagrams: next })
    })
  }

  private async updateSummary(id: string, fresh?: ArchitectureAnalysis): Promise<void> {
    const dir = this.projectDir(id)
    const analysis = fresh ?? (await this.analysis(id))
    const interpretation = await this.interpretation(id)
    const target = await this.target(id)
    const summary: ProjectSummaryFile = {
      digest: analysis ? digestOf(analysis) : null,
      thumbnail: thumbnailOf((await this.diagrams(id)).application),
      interpretedAt: interpretation?.generatedAt ?? null,
      target: analysis && target ? targetGapCount(analysis, evaluateTarget(analysis, target)) : null,
    }
    await this.writeJson(join(dir, 'summary.json'), summary)
  }
}
