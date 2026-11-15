import { useSyncExternalStore } from 'react'
import { type AnalysisProgress, type ArchitectureBundle, type ArchitectureEvent, type ArchitectureLayout, type ArchitectureProjectSummary, type BlockDiagram, INTERPRET_PARTS, type InterpretPart, type TargetArchitecture } from '@diffra/core/architecture'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

// 架构页的数据单独一个小 store：分析结果可能有几十 MB，不放进全局状态，只缓存最近打开的几个项目
interface ArchitectureState {
  projects: ArchitectureProjectSummary[] | null
  listError: string | null
  running: Record<string, AnalysisProgress>
  // 代码在分析之后变过没有；null 是没法判断（没分析过、文件夹不在了）
  stale: Record<string, boolean | null>
  bundles: Record<string, ArchitectureBundle>
  bundleErrors: Record<string, string>
  // 最近一次分析或解读失败的原因，下次开始时清掉
  failures: Record<string, string>
}

const MAX_BUNDLES = 3

let state: ArchitectureState = { projects: null, listError: null, running: {}, stale: {}, bundles: {}, bundleErrors: {}, failures: {} }
const listeners = new Set<() => void>()

function set(change: (current: ArchitectureState) => ArchitectureState): void {
  state = change(state)
  for (const listener of listeners) listener()
}

export function useArchitecture<T>(selector: (current: ArchitectureState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => selector(state),
  )
}

export function architectureState(): ArchitectureState {
  return state
}

let wired = false

// 第一次进架构页时订阅 core 的进度，并取回已经在跑的分析（切走再回来、刷新页面）
export function wireArchitecture(): void {
  if (wired) return
  wired = true
  window.diffra.onArchitectureEvent(onEvent)
  window.diffra
    .runningArchitecture()
    .then((running) => set((current) => ({ ...current, running: Object.fromEntries(running.map((item) => [item.projectId, item])) })))
    .catch((error: unknown) => console.error('[architecture] 读取进行中的分析失败', error))
}

function onEvent(event: ArchitectureEvent): void {
  if (event.progress) {
    const progress = event.progress
    set((current) => ({ ...current, running: { ...current.running, [event.projectId]: progress } }))
    return
  }
  const phase = state.running[event.projectId]?.phase
  set((current) => {
    const { [event.projectId]: _done, ...running } = current.running
    const failures = { ...current.failures }
    if (event.outcome === 'failed') failures[event.projectId] = event.error ?? '失败了'
    else delete failures[event.projectId]
    return { ...current, running, failures }
  })
  const name = state.projects?.find((item) => item.id === event.projectId)?.name ?? '项目'
  const what = phase === 'interpreting' ? '模型解读' : '架构分析'
  if (event.outcome === 'failed') showToast(`「${name}」${what}失败：${event.error ?? ''}`)
  // 模型几样一起做时可能只失败一部分，做完的已经存了，也要重新读
  if (event.outcome === 'done' || (event.outcome === 'failed' && phase === 'interpreting')) {
    void loadProjects()
    if (state.bundles[event.projectId]) void loadBundle(event.projectId)
  }
  // 刚分析完的代码不会过期；模型解读不改分析结果
  if (event.outcome === 'done' && phase !== 'interpreting') {
    set((current) => ({ ...current, stale: { ...current.stale, [event.projectId]: false } }))
  }
}

export async function loadProjects(): Promise<void> {
  try {
    const projects = await window.diffra.listArchitectureProjects()
    set((current) => ({ ...current, projects, listError: null }))
  } catch (error) {
    set((current) => ({ ...current, listError: errorMessage(error) }))
  }
}

export async function checkStale(projectId: string): Promise<void> {
  try {
    const stale = await window.diffra.isArchitectureStale(projectId)
    set((current) => ({ ...current, stale: { ...current.stale, [projectId]: stale } }))
  } catch (error) {
    console.error('[architecture] 判断是否过期失败', error)
  }
}

export async function loadBundle(projectId: string): Promise<void> {
  try {
    const bundle = await window.diffra.getArchitecture(projectId)
    set((current) => {
      // 只留最近打开的几个，免得几个大项目的分析结果一直占着内存
      const kept = Object.entries(current.bundles).filter(([id]) => id !== projectId).slice(-(MAX_BUNDLES - 1))
      const { [projectId]: _error, ...bundleErrors } = current.bundleErrors
      return { ...current, bundles: { ...Object.fromEntries(kept), [projectId]: bundle }, bundleErrors }
    })
  } catch (error) {
    set((current) => ({ ...current, bundleErrors: { ...current.bundleErrors, [projectId]: errorMessage(error) } }))
  }
}

function updateBundle(projectId: string, change: (bundle: ArchitectureBundle) => ArchitectureBundle): void {
  set((current) => {
    const bundle = current.bundles[projectId]
    return bundle ? { ...current, bundles: { ...current.bundles, [projectId]: change(bundle) } } : current
  })
}

async function run(projectId: string, start: () => Promise<void>): Promise<void> {
  set((current) => {
    const { [projectId]: _failure, ...failures } = current.failures
    return { ...current, failures }
  })
  try {
    await start()
  } catch (error) {
    showToast(errorMessage(error))
  }
}

export function analyze(projectId: string): Promise<void> {
  return run(projectId, () => window.diffra.analyzeArchitecture(projectId))
}

export function interpret(projectId: string, parts: InterpretPart[] = [...INTERPRET_PARTS]): Promise<void> {
  return run(projectId, () => window.diffra.interpretArchitecture(projectId, parts))
}

export async function saveDiagram(projectId: string, diagram: BlockDiagram): Promise<boolean> {
  const previous = state.bundles[projectId]?.diagrams[diagram.kind]
  updateBundle(projectId, (bundle) => ({ ...bundle, diagrams: { ...bundle.diagrams, [diagram.kind]: diagram } }))
  try {
    await window.diffra.saveArchitectureDiagram(projectId, diagram)
    if (diagram.kind === 'application') void loadProjects()
    return true
  } catch (error) {
    updateBundle(projectId, (bundle) => ({ ...bundle, diagrams: { ...bundle.diagrams, [diagram.kind]: previous } }))
    showToast(`保存架构图失败：${errorMessage(error)}`)
    return false
  }
}

export async function cancelRun(projectId: string): Promise<void> {
  await window.diffra.cancelArchitecture(projectId).catch((error: unknown) => showToast(errorMessage(error)))
}

export async function addProject(path: string | null): Promise<string | null> {
  try {
    const project = path ? await window.diffra.addArchitectureProject(path) : await window.diffra.pickArchitectureProject()
    if (!project) return null
    await loadProjects()
    return project.id
  } catch (error) {
    showToast(errorMessage(error))
    return null
  }
}

export async function removeProject(projectId: string): Promise<void> {
  try {
    await window.diffra.removeArchitectureProject(projectId)
    set((current) => {
      const { [projectId]: _bundle, ...bundles } = current.bundles
      return { ...current, bundles, projects: current.projects?.filter((item) => item.id !== projectId) ?? null }
    })
  } catch (error) {
    showToast(errorMessage(error))
  }
}

export async function interpretModule(projectId: string, path: string): Promise<void> {
  const note = await window.diffra.interpretArchitectureModule(projectId, path)
  // 单目录解读存进了解读文件；整份重新读太重，界面这边直接合进去
  updateBundle(projectId, (bundle) => ({
    ...bundle,
    interpretation: bundle.interpretation
      ? { ...bundle.interpretation, notes: { ...bundle.interpretation.notes, [path]: note } }
      : {
          version: 1,
          generatedAt: '',
          model: note.model,
          fingerprint: bundle.analysis?.fingerprint ?? '',
          summary: '',
          techStack: [],
          entryPoints: [],
          readingOrder: [],
          externalSystems: [],
          flows: [],
          notes: { [path]: note },
          dropped: 0,
        },
  }))
}

export async function drawFlowChart(projectId: string, flow: string): Promise<void> {
  const chart = await window.diffra.drawArchitectureFlowChart(projectId, flow)
  // 和单目录解读一样直接合进来；流程图只在有解读、有这条流程时才画得出来
  updateBundle(projectId, (bundle) => (bundle.interpretation ? { ...bundle, interpretation: { ...bundle.interpretation, charts: { ...bundle.interpretation.charts, [flow]: chart } } } : bundle))
}

export async function saveTarget(projectId: string, target: TargetArchitecture | null): Promise<void> {
  const previous = state.bundles[projectId]?.target ?? null
  updateBundle(projectId, (bundle) => ({ ...bundle, target }))
  try {
    await window.diffra.saveTargetArchitecture(projectId, target)
    void loadProjects()
  } catch (error) {
    updateBundle(projectId, (bundle) => ({ ...bundle, target: previous }))
    showToast(`保存目标架构失败：${errorMessage(error)}`)
  }
}

let layoutTimer: ReturnType<typeof setTimeout> | undefined

// 拖动节点很频繁，停下半秒再存
export function saveLayout(projectId: string, view: string, positions: Record<string, { x: number; y: number }> | null): void {
  updateBundle(projectId, (bundle) => {
    const layout: ArchitectureLayout = { ...bundle.layout }
    if (positions) layout[view] = positions
    else delete layout[view]
    return { ...bundle, layout }
  })
  clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    const layout = state.bundles[projectId]?.layout
    if (layout) window.diffra.saveArchitectureLayout(projectId, layout).catch((error: unknown) => console.error('[architecture] 保存布局失败', error))
  }, 500)
}
