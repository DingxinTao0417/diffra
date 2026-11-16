import { createHash } from 'node:crypto'
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { keepPinned, staticDiagram, thumbnailOf, verifyDiagram } from './diagrams.js'
import { sameDefinition, SHARED_DIR, SHARED_FORMAT, SHARED_JSON, SHARED_MARKDOWN, type SharedArchitecture, sharedMarkdown, sharedSchema, type SharedStatus } from './share.js'
import { AnalysisCancelled, analyzeProject, codeLanguage, currentFingerprint, digestOf, type ParseCache } from './engine.js'
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

// 监听文件变化（v2 · M9）：同时最多盯几个项目；改动停下多久后核对一次指纹；自动重新分析再多等一会儿
const MAX_WATCHED = 4
const SETTLE_MS = 800
const AUTO_DELAY_MS = 1500
// 依赖、构建产物、版本库这些目录里的变化不算（分析本来就跳过它们）
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage', '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.vscode', 'vendor', 'Pods', '.dart_tool', 'bin', 'obj'])
const MANIFESTS = new Set(['package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'pyproject.toml', 'setup.py', 'setup.cfg', 'composer.json', 'Gemfile', 'pubspec.yaml', 'Package.swift'])

// 一次文件变化值不值得看：代码文件或清单，不在依赖和构建目录里
export function watchedChange(file: string | null): boolean {
  if (file === null) return true
  const parts = file.split(/[\\/]/)
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return false
  const name = parts[parts.length - 1]!
  return MANIFESTS.has(name) || /^tsconfig\..*json$/.test(name) || codeLanguage(name) !== null
}

interface Watching {
  watcher: FSWatcher
  auto: boolean
  settle: NodeJS.Timeout | null
  refresh: NodeJS.Timeout | null
}

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
  private readonly watching = new Map<string, Watching>()
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

  // 打开着一个项目时盯着它的文件（v2 · M9）：代码改了就告诉界面过期，开了自动更新就在改动停下后重新分析（增量，只解析改过的文件）。
  // 界面离开项目时关掉；同时最多盯几个，多了关最早的。auto 记在项目列表里，下次打开照旧
  async watch(id: string, enabled: boolean, auto: boolean): Promise<void> {
    this.unwatch(id)
    if (!enabled) return
    const project = await this.project(id)
    if (!!project.autoRefresh !== auto) await this.setAutoRefresh(id, auto)
    if (!existsSync(project.path)) return
    while (this.watching.size >= MAX_WATCHED) this.unwatch(this.watching.keys().next().value!)
    let watcher: FSWatcher
    try {
      watcher = watch(project.path, { recursive: true, persistent: false })
    } catch (error) {
      this.onEvent({ projectId: id, progress: this.runs.get(id)?.progress ?? null, watchError: error instanceof Error ? error.message : String(error) })
      return
    }
    const entry: Watching = { watcher, auto, settle: null, refresh: null }
    this.watching.set(id, entry)
    watcher.on('change', (_type, file) => {
      if (!watchedChange(typeof file === 'string' ? file : null)) return
      if (entry.settle) clearTimeout(entry.settle)
      entry.settle = setTimeout(() => void this.settled(id, entry), SETTLE_MS)
    })
    watcher.on('error', (error) => {
      console.error(`[architecture] 监听 ${project.path} 出错，停止监听`, error)
      this.unwatch(id)
      this.onEvent({ projectId: id, progress: this.runs.get(id)?.progress ?? null, watchError: error.message })
    })
  }

  unwatch(id: string): void {
    const entry = this.watching.get(id)
    if (!entry) return
    this.watching.delete(id)
    if (entry.settle) clearTimeout(entry.settle)
    if (entry.refresh) clearTimeout(entry.refresh)
    entry.watcher.close()
  }

  dispose(): void {
    for (const id of [...this.watching.keys()]) this.unwatch(id)
  }

  // 改动停下了：按指纹核对一次（.gitignore 里的、只改了时间的不算），真变了才说过期
  private async settled(id: string, entry: Watching): Promise<void> {
    entry.settle = null
    if (this.watching.get(id) !== entry) return
    const stale = await this.stale(id).catch((error: unknown) => {
      console.error('[architecture] 判断是否过期失败', error)
      return null
    })
    if (stale === null || this.watching.get(id) !== entry) return
    this.onEvent({ projectId: id, progress: this.runs.get(id)?.progress ?? null, stale })
    if (!stale || !entry.auto) return
    if (entry.refresh) clearTimeout(entry.refresh)
    entry.refresh = setTimeout(() => {
      entry.refresh = null
      if (this.watching.get(id) !== entry) return
      // 正在分析（或解读）：等它完了再看一次
      if (this.runs.has(id)) {
        entry.settle = setTimeout(() => void this.settled(id, entry), AUTO_DELAY_MS)
        return
      }
      this.analyze(id).catch((error: unknown) => console.error('[architecture] 自动重新分析失败', error))
    }, AUTO_DELAY_MS)
  }

  private async setAutoRefresh(id: string, auto: boolean): Promise<void> {
    await this.enqueue(async () => {
      const projects = await this.loadProjects()
      const next = projects.map((project) => (project.id === id ? { ...project, autoRefresh: auto } : project))
      await this.writeJson(join(this.dir, PROJECTS_FILE), { version: ARCHITECTURE_VERSION, projects: next })
      this.projectsCache = next
    })
  }

  // ---------- 导出到仓库、从仓库导入（v2 · M9，见 share.ts） ----------

  // 用户点了「导出到仓库」才写：项目根的 .diffra/architecture.json 和 .md，已有的覆盖
  async exportShared(id: string): Promise<{ files: string[] }> {
    const project = await this.project(id)
    if (!existsSync(project.path)) throw new Error(`找不到文件夹：${project.path}`)
    const [diagrams, target] = await Promise.all([this.diagrams(id), this.target(id)])
    if (Object.keys(diagrams).length === 0 && !target) throw new Error('还没有架构图和目标架构，先分析')
    const shared: SharedArchitecture = { format: SHARED_FORMAT, version: 1, exportedAt: new Date().toISOString(), project: project.name, diagrams, target }
    await mkdir(join(project.path, SHARED_DIR), { recursive: true })
    const json = join(project.path, SHARED_JSON)
    const markdown = join(project.path, SHARED_MARKDOWN)
    await writeFile(json, `${JSON.stringify(shared, null, 2)}\n`)
    await writeFile(markdown, sharedMarkdown(shared))
    return { files: [json, markdown] }
  }

  private async readShared(id: string): Promise<{ shared: SharedArchitecture } | { error: string } | null> {
    const project = await this.project(id)
    const text = await readFile(join(project.path, SHARED_JSON), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (text === null) return null
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { error: `${SHARED_JSON} 不是有效的 JSON` }
    }
    const parsed = sharedSchema.safeParse(raw)
    if (!parsed.success) return { error: `${SHARED_JSON} 的格式不对（可能是更新版本的 Diffra 导出的）` }
    return { shared: parsed.data }
  }

  // 打开项目时看仓库里有没有共享的定义、和本机的一样不一样
  async sharedStatus(id: string): Promise<SharedStatus> {
    const read = await this.readShared(id)
    if (!read) return { state: 'none' }
    if ('error' in read) return { state: 'invalid', error: read.error }
    const { shared } = read
    const [diagrams, target] = await Promise.all([this.diagrams(id), this.target(id)])
    return { state: 'present', exportedAt: shared.exportedAt, diagrams: Object.keys(shared.diagrams).length, hasTarget: shared.target !== null, matches: sameDefinition(shared, diagrams, target) }
  }

  // 用仓库里的换掉本机的架构图和目标架构；本机原来的改名留底（和删目标架构一样，不直接删）
  async importShared(id: string): Promise<void> {
    const read = await this.readShared(id)
    if (!read) throw new Error(`仓库里没有 ${SHARED_JSON}`)
    if ('error' in read) throw new Error(read.error)
    const { shared } = read
    await this.enqueue(async () => {
      const dir = this.projectDir(id)
      const stamp = Date.now()
      for (const name of ['diagrams.json', 'target.json']) {
        const path = join(dir, name)
        if (existsSync(path)) await rename(path, `${path}.before-import-${stamp}`)
      }
      await this.writeJson(join(dir, 'diagrams.json'), { version: ARCHITECTURE_VERSION, diagrams: shared.diagrams })
      if (shared.target) await this.writeJson(join(dir, 'target.json'), shared.target)
    })
    await this.updateSummary(id)
  }

  // 任务里的智能体查架构（v2 · M9）：这个目录分析过没有。列工具时同步调，只看文件在不在
  hasAnalysis(root: string): boolean {
    return existsSync(join(this.projectDir(projectIdOf(root)), 'analysis.json'))
  }

  async queryData(root: string): Promise<{ analysis: ArchitectureAnalysis; target: TargetArchitecture | null } | null> {
    const id = projectIdOf(root)
    const [analysis, target] = await Promise.all([this.analysis(id), this.target(id)])
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
