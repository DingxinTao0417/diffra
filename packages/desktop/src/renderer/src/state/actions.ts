import { MANUAL_COMPACTION_PROMPT, type PermissionMode, type PromptImage, restoreNotice, type StopReason, type StoredSessionSummary, type TurnKind } from '@diffra/core/types'
import type { SessionHandle, SessionOptions } from '../../../shared/ipc'
import type { ModelRef } from '../../../shared/settings'
import { applyUpdate, lastUsage, modelSilenceOf, newTurn, taskProgressOf, turnFromStored, turnOutcomeOf, usageOf } from '../features/session/transcript'
import { applyAppearance } from '../lib/appearance'
import { errorMessage } from '../lib/errors'
import { hasWidePanel, isSidebarShown, type LiveTask, type MessageOptions, type Route, type SettingsSection, showToast, store, updateLive } from './store'

const TITLE_CHARS = 40

function addProject(projects: string[], path: string): string[] {
  const exists = projects.some((item) => item.toLowerCase() === path.toLowerCase())
  return exists ? projects : [path, ...projects]
}

function titleOf(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? ''
  return firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS)}…` : firstLine
}

const MAX_HISTORY = 50

const sameRoute = (a: Route | undefined, b: Route) => JSON.stringify(a) === JSON.stringify(b)

// record 为 false 时不记进后退历史（后退、前进本身）。连着换同一种首页的项目只改当前这一条，不算新的一页
export function navigate(route: Route, record = true): void {
  // 离开设置页时重新读设置：模型、角色可能改过，输入框要用新的
  if (store.get().route.name === 'settings' && route.name !== 'settings') {
    refreshSettings().catch((error: unknown) => showToast(`读取设置失败：${errorMessage(error)}`))
  }
  store.set((state) => {
    let { history, historyIndex } = state
    const current = history[historyIndex]
    if (record && route.name !== 'settings' && !sameRoute(current, route)) {
      if ((route.name === 'home' || route.name === 'design') && current?.name === route.name) history = history.map((item, index) => (index === historyIndex ? route : item))
      else {
        history = [...history.slice(0, historyIndex + 1), route].slice(-MAX_HISTORY)
        historyIndex = history.length - 1
      }
    }
    const opened = route.name === 'task' ? state.live[route.sessionId] : undefined
    const live = opened?.unread ? { ...state.live, [opened.sessionId]: { ...opened, unread: false } } : state.live
    // 设计面板只有设计任务有；设计任务切到设计面板由 openTask、startTask 显式设置
    const panel = opened && !opened.design && state.panel === 'design' ? 'monitor' : state.panel
    return { ...state, route, lastWorkRoute: route.name === 'settings' ? state.lastWorkRoute : route, history, historyIndex, live, panel }
  })
}

// 后退、前进；在设置页里后退就是回到进设置前的那页。删掉了的任务跳过
export async function moveHistory(step: -1 | 1): Promise<void> {
  const state = store.get()
  if (state.route.name === 'settings') {
    if (step === -1) leaveSettings()
    return
  }
  const exists = (route: Route) => route.name !== 'task' || state.live[route.sessionId] !== undefined || state.tasks.some((task) => task.sessionId === route.sessionId)
  let index = state.historyIndex + step
  while (index >= 0 && index < state.history.length && !exists(state.history[index]!)) index += step
  const target = state.history[index]
  if (!target) return
  store.set((current) => ({ ...current, historyIndex: index }))
  const stored = target.name === 'task' && !state.live[target.sessionId] ? state.tasks.find((task) => task.sessionId === target.sessionId) : undefined
  if (stored) await openTask(stored, false)
  else navigate(target, false)
}

export function openSettings(section: SettingsSection = 'general'): void {
  navigate({ name: 'settings', section })
}

export function leaveSettings(): void {
  navigate(store.get().lastWorkRoute)
}

// 不指定项目时沿用当前的：任务页取任务的项目（无项目任务取 null，不取它的文件夹），首页和设计首页取选着的项目
function currentProject(): string | null {
  const { route, live } = store.get()
  if (route.name === 'task') {
    const task = live[route.sessionId]
    return task && !task.noProject ? task.project : null
  }
  return route.name === 'home' || route.name === 'design' ? route.project : null
}

export function openHome(project?: string | null): void {
  navigate({ name: 'home', project: project === undefined ? currentProject() : project })
}

export function openDesign(project?: string | null): void {
  navigate({ name: 'design', project: project === undefined ? currentProject() : project })
}

// 删除、归档正在看的任务后回到它那种首页
function leaveTask(sessionId: string): void {
  if (store.get().live[sessionId]?.design) openDesign()
  else openHome()
}

// Ctrl+B、菜单和顶栏开关共用；设置页没有侧栏
export function toggleSidebar(): void {
  store.set((state) => {
    if (state.route.name === 'settings') return state
    // 侧栏被窄窗口收起时是想看侧栏，直接展开，而不是把 sidebarOpen 关掉
    if (state.sidebarOpen && !isSidebarShown(state)) return { ...state, sidebarKeepOpen: true }
    const sidebarOpen = !state.sidebarOpen
    // 开着宽面板时 sidebarNarrow 被压成 false，窗口其实可能是窄的；这时主动展开的也记下，关掉面板后不被自动收起。
    // 窗口真的变宽后 setSidebarNarrow(false) 会清掉它
    return { ...state, sidebarOpen, sidebarKeepOpen: sidebarOpen && (state.sidebarNarrow || hasWidePanel(state)) }
  })
}

export function setSidebarNarrow(narrow: boolean): void {
  store.set((state) => {
    // 宽面板开着时不算窄，但保留 keepOpen：切回窄面板时用户展开过的侧栏不被收掉
    const keepOpen = narrow || hasWidePanel(state) ? state.sidebarKeepOpen : false
    if (state.sidebarNarrow === narrow && state.sidebarKeepOpen === keepOpen) return state
    return { ...state, sidebarNarrow: narrow, sidebarKeepOpen: keepOpen }
  })
}

export async function refreshTasks(): Promise<void> {
  try {
    const tasks = await window.diffra.listSessions(null)
    // 无项目任务的文件夹不算项目，不进首页的项目下拉和侧栏的项目分组
    store.set((state) => ({ ...state, tasks, projects: tasks.reduce((projects, task) => (task.noProject ? projects : addProject(projects, task.cwd)), state.projects) }))
  } catch (error) {
    console.error('读取任务列表失败', error)
  }
}

export async function refreshSettings(): Promise<void> {
  const settings = await window.diffra.getSettings()
  applyAppearance(settings.appearance)
  store.set((state) => ({ ...state, settings }))
}

export async function initialize(): Promise<void> {
  await refreshSettings().catch((error: unknown) => showToast(`读取设置失败：${errorMessage(error)}`))
  const last = await window.diffra.getLastProject().catch(() => null)
  if (last) {
    store.set((state) => ({ ...state, projects: addProject(state.projects, last.path) }))
    navigate({ name: 'home', project: last.path })
  }
  await refreshTasks()
}

// 会话更新和权限请求只注册一次，按会话 id 分给对应的任务
export function wireCoreEvents(): () => void {
  const offUpdate = window.diffra.onSessionUpdate(({ sessionId, update }) => {
    const usage = usageOf(update)
    const silence = modelSilenceOf(update)
    updateLive(sessionId, (task) => {
      if (usage) return { ...task, usage }
      if (silence) {
        // 又有输出了就去掉这个智能体的那一条
        const { [silence.key]: _previous, ...rest } = task.modelSilence ?? {}
        return { ...task, modelSilence: silence.since === null ? rest : { ...rest, [silence.key]: { agent: silence.agent, since: silence.since } } }
      }
      const last = task.turns.at(-1)
      if (!last) return task
      // 读文件、搜索不改项目文件，完成时不用重读改动
      const filesMayChange = update.sessionUpdate === 'tool_call_update' && update.status === 'completed' && !last.items.some((item) => item.kind === 'tool' && item.id === update.toolCallId && (item.toolKind === 'read' || item.toolKind === 'search'))
      return {
        ...task,
        progress: taskProgressOf(update) ?? task.progress,
        turns: [...task.turns.slice(0, -1), { ...last, items: applyUpdate(last.items, update), outcome: turnOutcomeOf(update) ?? last.outcome }],
        changeVersion: filesMayChange ? task.changeVersion + 1 : task.changeVersion,
      }
    })
  })
  const offPermission = window.diffra.onPermissionRequest((request) => {
    if (!store.get().live[request.sessionId]) {
      // 界面不认识的会话（比如页面重新加载过）没法让用户确认，按取消答复，免得 core 一直等
      window.diffra.respondPermission(request.requestId, null).catch((error: unknown) => console.error(error))
      return
    }
    updateLive(request.sessionId, (task) => ({ ...task, permission: request }))
  })
  const offBrowserState = window.diffra.onBrowserState((state) =>
    store.set((current) => ({ ...current, browsers: { ...current.browsers, [state.sessionId]: state } })),
  )
  // 智能体在用浏览器：正在看这个任务时把浏览器面板打开
  const offBrowserActivity = window.diffra.onBrowserActivity(({ sessionId }) => {
    const { route, panel } = store.get()
    if (route.name === 'task' && route.sessionId === sessionId && panel !== 'browser') store.set((current) => ({ ...current, panel: 'browser' }))
  })
  // 智能体在用设计面板：同样在看这个任务时打开，只有设计任务有设计面板
  const offDesignActivity = window.diffra.onDesignActivity(({ sessionId }) => {
    const { route, panel, live } = store.get()
    if (route.name === 'task' && route.sessionId === sessionId && live[sessionId]?.design && panel !== 'design') store.set((current) => ({ ...current, panel: 'design' }))
  })
  return () => {
    offUpdate()
    offPermission()
    offBrowserState()
    offBrowserActivity()
    offDesignActivity()
  }
}

function liveFrom(handle: SessionHandle, title: string, planMode = false): LiveTask {
  return {
    sessionId: handle.sessionId,
    project: handle.cwd,
    noProject: handle.noProject,
    title,
    modelLabel: handle.modelLabel,
    modelRef: handle.modelRef,
    planLabel: handle.planLabel,
    fallbackLabel: handle.fallbackLabel,
    permissionMode: handle.permissionMode,
    design: handle.design,
    planMode,
    info: handle.info,
    turns: [],
    running: false,
    usage: null,
    permission: null,
    queue: [],
    changeVersion: 0,
    unread: false,
  }
}

// 首页输入框的「先出计划」开着时，第一条消息先出计划，新任务也保持开着。project 为 null 时建无项目任务
export async function startTask(project: string | null, text: string, options: SessionOptions, message: Partial<MessageOptions> = {}): Promise<void> {
  const title = titleOf(text)
  const handle = await window.diffra.createSession(project, { ...options, title })
  store.set((state) => ({
    ...state,
    projects: handle.noProject ? state.projects : addProject(state.projects, handle.cwd),
    live: { ...state.live, [handle.sessionId]: liveFrom(handle, title, message.plan ?? false) },
    ...(handle.design ? { panel: 'design' as const } : {}),
  }))
  navigate({ name: 'task', sessionId: handle.sessionId })
  void sendMessage(handle.sessionId, text, message)
}

export async function openTask(task: Pick<StoredSessionSummary, 'sessionId' | 'cwd'>, record = true): Promise<void> {
  const existing = store.get().live[task.sessionId]
  if (existing) {
    if (existing.design) store.set((state) => ({ ...state, panel: 'design' }))
    navigate({ name: 'task', sessionId: task.sessionId }, record)
    return
  }
  try {
    const loaded = await window.diffra.loadSession(task.sessionId, task.cwd)
    const live: LiveTask = {
      ...liveFrom(loaded, loaded.title),
      progress: loaded.taskState ?? loaded.turns.flatMap((turn) => turn.updates).map(taskProgressOf).filter((item) => item !== null).at(-1),
      turns: loaded.turns.map(turnFromStored),
      usage: lastUsage(loaded.turns),
    }
    store.set((state) => ({ ...state, live: { ...state.live, [task.sessionId]: live }, ...(live.design ? { panel: 'design' as const } : {}) }))
    navigate({ name: 'task', sessionId: task.sessionId }, record)
  } catch (error) {
    showToast(`打不开这个任务：${errorMessage(error)}`)
  }
}

// 运行中发的消息先排队，这一轮结束后再发
export async function sendMessage(sessionId: string, text: string, options: Partial<MessageOptions> = {}): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task) return
  const message: MessageOptions = { plan: false, goal: false, skills: [], images: [], ...options }
  if (task.running) {
    updateLive(sessionId, (current) => ({ ...current, queue: [...current.queue, { id: crypto.randomUUID(), text, options: message }] }))
    return
  }
  const { skills, images } = message
  if (message.plan) await runTurnOnCore(sessionId, text, 'plan', skills, [], (turnId) => window.diffra.plan(sessionId, turnId, text, skills))
  else
    await runTurnOnCore(sessionId, text, message.goal ? 'goal' : 'prompt', skills, images, (turnId) =>
      window.diffra.sendPrompt(sessionId, turnId, text, { skills, goal: message.goal, images }),
    )
}

export function setPlanMode(sessionId: string, planMode: boolean): void {
  updateLive(sessionId, (task) => ({ ...task, planMode }))
}

const DEEP_SCAN_TITLES = { task: '深度安全扫描 · 本任务改动', project: '深度安全扫描 · 整个项目' } as const

// 深度安全扫描在界面上也是一轮：和 core 记下的标题一致
export async function runDeepScan(sessionId: string, scope: 'task' | 'project'): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  await runTurnOnCore(sessionId, DEEP_SCAN_TITLES[scope], 'deep-scan', [], [], (turnId) => window.diffra.deepScan(sessionId, turnId, scope))
}

export async function compactTask(sessionId: string): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  await runTurnOnCore(sessionId, MANUAL_COMPACTION_PROMPT, 'compact', [], [], (turnId) => window.diffra.compactSession(sessionId, turnId))
}

async function runTurnOnCore(
  sessionId: string,
  text: string,
  kind: TurnKind,
  skills: string[],
  images: PromptImage[],
  run: (turnId: string) => Promise<StopReason>,
): Promise<void> {
  const turnId = crypto.randomUUID()
  updateLive(sessionId, (current) => ({ ...current, running: true, turns: [...current.turns, newTurn(turnId, text, kind, skills, images)] }))
  const patchTurn = (change: (turn: LiveTask['turns'][number]) => LiveTask['turns'][number]) =>
    updateLive(sessionId, (current) => ({ ...current, turns: current.turns.map((turn) => (turn.id === turnId ? change(turn) : turn)) }))
  // 第一轮开始后 core 才保存会话，这时再刷新侧栏
  const refresh = setTimeout(() => void refreshTasks(), 800)
  try {
    const stopReason = await run(turnId)
    patchTurn((turn) => ({ ...turn, stopReason, endedAt: Date.now() }))
  } catch (error) {
    patchTurn((turn) => ({ ...turn, error: errorMessage(error), endedAt: Date.now() }))
  } finally {
    clearTimeout(refresh)
    let next: LiveTask['queue'][number] | undefined
    const route = store.get().route
    const viewing = route.name === 'task' && route.sessionId === sessionId
    updateLive(sessionId, (current) => {
      next = current.queue[0]
      return { ...current, running: false, permission: null, modelSilence: undefined, queue: current.queue.slice(1), changeVersion: current.changeVersion + 1, unread: current.unread || !viewing }
    })
    await refreshTasks()
    if (next) void sendMessage(sessionId, next.text, next.options)
  }
}

export function dequeue(sessionId: string, id: string): void {
  updateLive(sessionId, (task) => ({ ...task, queue: task.queue.filter((item) => item.id !== id) }))
}

export function cancelTask(sessionId: string): void {
  window.diffra.cancelSession(sessionId).catch((error: unknown) => showToast(errorMessage(error)))
}

export function respondPermission(sessionId: string, optionId: string | null): void {
  const request = store.get().live[sessionId]?.permission
  if (!request) return
  updateLive(sessionId, (task) => ({ ...task, permission: null }))
  window.diffra.respondPermission(request.requestId, optionId).catch((error: unknown) => showToast(errorMessage(error)))
}

export async function restoreTurn(sessionId: string, turnId: string): Promise<void> {
  const restored = await window.diffra.restoreCheckpoint(sessionId, turnId)
  const restoredAt = Date.now()
  updateLive(sessionId, (task) => {
    const start = task.turns.findIndex((turn) => turn.id === turnId)
    return {
      ...task,
      changeVersion: task.changeVersion + 1,
      turns: task.turns.map((turn, index) => {
        if (start < 0 || index < start) return turn
        if (index > start) return { ...turn, restoredAt }
        return {
          ...turn,
          restoredAt,
          items: [
            ...turn.items,
            {
              kind: 'notice',
              id: crypto.randomUUID(),
              severity: 'info',
              ...restoreNotice(restored),
            },
          ],
        }
      }),
    }
  })
}

// 重新生成：撤掉这一轮及之后的文件改动和对话，再用同样的提问发一轮
export async function regenerate(sessionId: string, turnId: string): Promise<void> {
  const task = store.get().live[sessionId]
  const turn = task?.turns.find((item) => item.id === turnId)
  // 深度扫描和出计划的那一轮没有「重新生成」，要重来就再发起一次
  if (!task || !turn || task.running || (turn.kind !== 'prompt' && turn.kind !== 'goal')) return
  try {
    const { filesRestored } = await window.diffra.rewindSession(sessionId, turnId)
    if (!filesRestored) showToast('这一轮没有检查点，文件改动没有撤销，只重新生成了回答')
    updateLive(sessionId, (current) => ({
      ...current,
      changeVersion: current.changeVersion + 1,
      turns: current.turns.slice(0, current.turns.findIndex((item) => item.id === turnId)),
    }))
    await sendMessage(sessionId, turn.prompt, { goal: turn.kind === 'goal', skills: turn.skills, images: turn.images })
  } catch (error) {
    showToast(`重新生成失败：${errorMessage(error)}`)
  }
}

export async function setPermissionMode(sessionId: string | null, mode: PermissionMode): Promise<void> {
  try {
    if (sessionId) {
      await window.diffra.configureSession(sessionId, { permissionMode: mode })
      updateLive(sessionId, (task) => ({ ...task, permissionMode: mode }))
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, defaultPermissionMode: mode } } : state))
    } else {
      const settings = await window.diffra.savePreferences({ defaultPermissionMode: mode })
      store.set((state) => ({ ...state, settings }))
    }
  } catch (error) {
    showToast(errorMessage(error))
  }
}

export async function setTaskModel(sessionId: string, model: ModelRef): Promise<void> {
  try {
    const { modelLabel } = await window.diffra.configureSession(sessionId, { model })
    if (modelLabel) updateLive(sessionId, (task) => ({ ...task, modelLabel, modelRef: model }))
  } catch (error) {
    showToast(errorMessage(error))
  }
}

export async function renameTask(sessionId: string, title: string): Promise<void> {
  try {
    await window.diffra.updateSession(sessionId, { title })
    updateLive(sessionId, (task) => ({ ...task, title }))
    await refreshTasks()
  } catch (error) {
    showToast(errorMessage(error))
  }
}

export async function setArchived(sessionId: string, archived: boolean): Promise<void> {
  try {
    await window.diffra.updateSession(sessionId, { archived })
    await refreshTasks()
    const route = store.get().route
    if (archived && route.name === 'task' && route.sessionId === sessionId) leaveTask(sessionId)
  } catch (error) {
    showToast(errorMessage(error))
  }
}

// trashFolder：无项目任务连文件夹一起移到回收站。删掉了才离开任务页，失败时留在原任务
export async function deleteTask(sessionId: string, trashFolder = false): Promise<void> {
  try {
    const { keptFolder } = await window.diffra.deleteSession(sessionId, { trashFolder })
    const route = store.get().route
    if (route.name === 'task' && route.sessionId === sessionId) leaveTask(sessionId)
    store.set((state) => {
      const { [sessionId]: _removed, ...live } = state.live
      return { ...state, live }
    })
    if (keptFolder) {
      showToast(keptFolder.reason === 'shared' ? `记录已删除，文件夹还有其他任务在用，保留在 ${keptFolder.path}` : `记录已删除，文件夹保留在 ${keptFolder.path}`)
    }
    await refreshTasks()
  } catch (error) {
    showToast(errorMessage(error))
  }
}

export async function pickProject(): Promise<string | null> {
  const picked = await window.diffra.pickProject()
  if (!picked) return null
  store.set((state) => ({ ...state, projects: addProject(state.projects, picked.path) }))
  return picked.path
}
