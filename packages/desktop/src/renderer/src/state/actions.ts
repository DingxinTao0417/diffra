import { type AskAnswer, type CandidateSpec, DEEP_SCAN_TITLES, MANUAL_COMPACTION_PROMPT, type PermissionMode, type PromptImage, type RemoteSource, restoreNotice, type StopReason, type StoredSessionSummary, type TaskActionParams, type TaskActionResult, type TaskSource, type TurnKind } from '@diffra/core/types'
import type { SessionHandle, SessionOptions } from '../../../shared/ipc'
import type { Layout, ModelRef } from '../../../shared/settings'
import { REMOTE_DEVICE_CONNECTION_ENABLED, type RemoteAction, type RemoteActionResult, type RemoteTaskCall, type RemoteTaskCallResult, type RemoteTaskDetails } from '../../../shared/remote'
import { type FileReference, MAX_PROMPT_FILE_REFERENCES, promptWithFileReferences } from '../../../shared/attachments'
import { normalizeTodoTags, type Todo, todoAttachments, TODO_MAX_IMAGES, type TodoPriority, type TodoRepeatKind, type TodoSchedule } from '../../../shared/todos'
import { applySilence, applyUpdate, lastUsage, modelSilenceOf, newTurn, taskProgressOf, type Turn, turnFromStored, turnOutcomeOf, usageOf, visualSnapshotOf, withCandidatesUpdate, withVisualSnapshot } from '../features/session/transcript'
import { applyRemoteEvent } from '@/features/devices/remote-tasks'
import { applyAppearance } from '../lib/appearance'
import { shrinkImage } from '../lib/images'
import { errorMessage } from '../lib/errors'
import { folderName } from '../lib/format'
import { sameProjectPath } from '../lib/projects'
import { hasWidePanel, isSidebarShown, type ExtensionsTab, type LiveTask, type MessageOptions, type Route, type SettingsSection, showToast, store, updateLive } from './store'

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

// 当前页面有没保存的改动时（模型与角色页展开的面板），离开前问它：返回 true 直接走；
// 返回 false 表示它先拦下来问用户，用户确认放弃后调 proceed，照原来要去的地方继续
type LeaveGuard = (proceed: () => void) => boolean
let leaveGuard: LeaveGuard | null = null

export function setLeaveGuard(guard: LeaveGuard | null): void {
  leaveGuard = guard
}

// 所有页面切换都走这里：返回、换设置分区、后退前进、快捷键、菜单、搜索结果、通知
export function navigate(route: Route, record = true): void {
  if (leaveGuard && !sameRoute(store.get().route, route) && !leaveGuard(() => go(route, record))) return
  go(route, record)
}

// record 为 false 时不记进后退历史（后退、前进本身）。连着换同一种首页的项目只改当前这一条，不算新的一页
function go(route: Route, record: boolean): void {
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

// 只改当前这一页的状态（比如架构图里选中的节点），不新增后退记录
export function replaceRoute(route: Route): void {
  store.set((state) => ({
    ...state,
    route,
    lastWorkRoute: route.name === 'settings' ? state.lastWorkRoute : route,
    history: state.history.map((item, index) => (index === state.historyIndex ? route : item)),
  }))
}

export function openArchitecture(projectId: string | null = null): void {
  navigate({ name: 'architecture', projectId, tab: projectId ? 'diagram' : 'overview', diagram: 'application', section: 'graph', scope: 'project', focus: null })
}

// 换分栏不新增后退记录
export function openExtensions(tab: ExtensionsTab = 'recommended'): void {
  if (store.get().route.name === 'extensions') replaceRoute({ name: 'extensions', tab })
  else navigate({ name: 'extensions', tab })
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
    store.set((state) => {
      const archived = state.settings?.archivedProjects ?? []
      const active = state.projects.filter((path) => !archived.some((item) => sameProjectPath(item, path)))
      return {
        ...state,
        tasks,
        projects: tasks.reduce((projects, task) => (task.noProject || archived.some((item) => sameProjectPath(item, task.cwd)) ? projects : addProject(projects, task.cwd)), active),
      }
    })
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
  const archived = store.get().settings?.archivedProjects ?? []
  if (last && !archived.some((path) => sameProjectPath(path, last.path))) {
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
      if (visualSnapshotOf(update).visualSnapshot) return { ...task, turns: withVisualSnapshot(task.turns, update) }
      // 候选方案卡片在生成它的那一轮，应用、放弃后的更新补到那一轮
      const candidateTurns = withCandidatesUpdate(task.turns, update)
      if (candidateTurns) return { ...task, turns: candidateTurns }
      const last = task.turns.at(-1)
      if (!last) return task
      if (silence) return { ...task, turns: [...task.turns.slice(0, -1), { ...last, silence: applySilence(last.silence, silence) }] }
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
  // 远程设备答了（或者不用答了）：收起这张确认卡片
  const offPermissionSettled = window.diffra.onPermissionSettled(({ requestId, sessionId }) =>
    updateLive(sessionId, (task) => (task.permission?.requestId === requestId ? { ...task, permission: null } : task)),
  )
  // 本机是被连接端：提问图片压成发给远程设备看的小图（主进程解不了 WebP），压不了的回 null
  const offRemoteCompress = window.diffra.onRemoteCompress(({ requestId, images }) => {
    Promise.all(images.map((image) => shrinkImage(image).catch(() => null)))
      .then((result) => window.diffra.respondRemoteCompress(requestId, result))
      .catch((error: unknown) => console.error('[remote] 回复图片压缩失败', error))
  })
  const offRemoteTaskCall = window.diffra.onRemoteTaskCall(({ requestId, call }) => {
    handleRemoteTaskCall(call)
      .then(
        (value): RemoteTaskCallResult => ({ ok: true, value }),
        (error: unknown): RemoteTaskCallResult => ({ ok: false, error: errorMessage(error) }),
      )
      .then((result) => window.diffra.respondRemoteTaskCall(requestId, result))
      .catch((error: unknown) => console.error('[remote] 回复远程任务请求失败', error))
  })
  const offRemoteAction = window.diffra.onRemoteAction(({ requestId, action }) => {
    handleRemoteAction(action)
      .catch((error: unknown): RemoteActionResult => ({ ok: false, error: errorMessage(error) }))
      .then((result) => window.diffra.respondRemoteAction(requestId, result))
      .catch((error: unknown) => console.error('[remote] 回复远程操作失败', error))
  })
  const offTaskAction = window.diffra.onTaskAction(({ requestId, params }) => {
    handleTaskAction(params)
      .catch((error: unknown): TaskActionResult => ({ ok: false, error: errorMessage(error) }))
      .then((result) => window.diffra.respondTaskAction(requestId, result))
      .catch((error: unknown) => console.error('[tasks] 回复任务互通请求失败', error))
  })
  const offBrowserState = window.diffra.onBrowserState((state) =>
    store.set((current) => ({ ...current, browsers: { ...current.browsers, [state.sessionId]: state } })),
  )
  // 智能体在用浏览器：正在看这个任务时把浏览器面板打开
  // 智能体在用浏览器：在看这个任务、右侧栏关着或开着任务监控时切到浏览器；用户自己打开的终端、审阅、文件这些不抢（第 541 步），浏览器在后台照常操作
  const offBrowserActivity = window.diffra.onBrowserActivity(({ sessionId }) => {
    const { route, panel } = store.get()
    if (route.name === 'task' && route.sessionId === sessionId && (panel === null || panel === 'monitor')) store.set((current) => ({ ...current, panel: 'browser' }))
  })
  // 智能体在用设计面板：同样在看这个任务时打开，只有设计任务有设计面板
  const offDesignActivity = window.diffra.onDesignActivity(({ sessionId }) => {
    const { route, panel, live } = store.get()
    if (route.name === 'task' && route.sessionId === sessionId && live[sessionId]?.design && panel !== 'design') store.set((current) => ({ ...current, panel: 'design' }))
  })
  // 用户自己的浏览器：扩展连上、断开；扩展里点了停止；扩展弹窗里能选的任务
  window.diffra.getBrowserBridgeStatus().then(
    (bridge) => store.set((current) => ({ ...current, bridge })),
    (error: unknown) => console.error('[browser] 读取扩展连接状态失败', error),
  )
  const offBridge = window.diffra.onBrowserBridgeStatus((bridge) => store.set((current) => ({ ...current, bridge })))
  const offStopRequest = window.diffra.onBrowserStopRequest(({ sessionId }) => {
    if (store.get().live[sessionId]?.running) cancelTask(sessionId)
  })
  const offTasks = syncBridgeTasks()
  // 设备连接已下线：不读取状态、不订阅远程事件；恢复时见 shared/remote.ts 的开关
  let offRemote: (() => void) | null = null
  let offRemoteEvent: (() => void) | null = null
  if (REMOTE_DEVICE_CONNECTION_ENABLED) {
    // 配对请求要在任何页面都能弹出来，状态放全局
    window.diffra.getRemoteState().then(
      (remote) => store.set((current) => ({ ...current, remote })),
      (error: unknown) => console.error('[remote] 读取设备连接状态失败', error),
    )
    offRemote = window.diffra.onRemoteState((remote) => store.set((current) => ({ ...current, remote })))
    offRemoteEvent = window.diffra.onRemoteEvent(applyRemoteEvent)
  }
  const offProcesses = window.diffra.onSessionProcesses(({ sessionId, processes }) => store.set((current) => ({ ...current, processes: { ...current.processes, [sessionId]: processes } })))
  return () => {
    offProcesses()
    offUpdate()
    offPermission()
    offPermissionSettled()
    offRemoteAction()
    offRemoteTaskCall()
    offRemoteCompress()
    offTaskAction()
    offBrowserState()
    offBrowserActivity()
    offDesignActivity()
    offBridge()
    offStopRequest()
    offTasks()
    offRemote?.()
    offRemoteEvent?.()
  }
}

const BRIDGE_TASKS = 30
const BRIDGE_SYNC_MS = 300

// 扩展弹窗里「交给 Diffra」列出最近的任务（没归档的，运行中的排前面）；任务标题也用作浏览器里分组的名字
function syncBridgeTasks(): () => void {
  let last = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const push = () => {
    timer = null
    const { tasks, live } = store.get()
    // 刚建的任务可能还不在任务列表里，先从正在开着的任务里补上
    const stored = new Set(tasks.map((task) => task.sessionId))
    const fresh = Object.values(live).filter((task) => !stored.has(task.sessionId))
    const list = [
      ...fresh.map((task) => ({ sessionId: task.sessionId, title: task.title, running: task.running })),
      ...tasks.filter((task) => !task.archived).map((task) => ({ sessionId: task.sessionId, title: live[task.sessionId]?.title ?? task.title, running: live[task.sessionId]?.running ?? false })),
    ]
      .slice(0, BRIDGE_TASKS)
      .sort((a, b) => Number(b.running) - Number(a.running))
    const key = JSON.stringify(list)
    if (key === last) return
    last = key
    window.diffra.setBrowserBridgeTasks(list)
  }
  const off = store.subscribe(() => {
    if (!timer) timer = setTimeout(push, BRIDGE_SYNC_MS)
  })
  push()
  return () => {
    off()
    if (timer) clearTimeout(timer)
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
    ...(handle.agent ? { agent: handle.agent } : {}),
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

// 把任务载入界面（不切过去）：别的任务的智能体给它发消息时在后台起一轮
async function loadLive(task: Pick<StoredSessionSummary, 'sessionId' | 'cwd'>): Promise<LiveTask> {
  const existing = store.get().live[task.sessionId]
  if (existing) return existing
  const loaded = await window.diffra.loadSession(task.sessionId, task.cwd)
  const live: LiveTask = {
    ...liveFrom(loaded, loaded.title),
    progress: loaded.taskState ?? loaded.turns.flatMap((turn) => turn.updates).map(taskProgressOf).filter((item) => item !== null).at(-1),
    turns: loaded.turns.map(turnFromStored),
    usage: lastUsage(loaded.turns),
  }
  store.set((state) => ({ ...state, live: { ...state.live, [task.sessionId]: state.live[task.sessionId] ?? live } }))
  return store.get().live[task.sessionId]!
}

// 任务互通：另一个任务的智能体要给某个任务发消息，或新建任务。在后台载入、起一轮，不把用户从正在看的任务切走
async function handleTaskAction(params: TaskActionParams): Promise<TaskActionResult> {
  const text = `来自任务「${params.from.title}」的消息：\n\n${params.message}`
  if (params.action === 'send') {
    const sent = await sendInBackground(params.target, text, { from: params.from })
    if (!sent) return { ok: false, error: `没有找到任务 ${params.target}` }
    return { ok: true, sessionId: params.target, ...sent }
  }
  const created = await startInBackground(params.project, text, { title: params.title?.trim() || titleOf(params.message), design: params.design }, { from: params.from })
  return { ok: true, ...created, queued: false }
}

// 设备连接：授权的远程设备要发消息、新建任务、停止（主进程已经查过授权）。和任务互通一样在后台做，不把用户从正在看的页面切走
async function handleRemoteAction(action: RemoteAction): Promise<RemoteActionResult> {
  if (action.kind === 'cancel') {
    // 已经停了（比如刚好跑完）就当停好了
    if (store.get().live[action.sessionId]?.running) await window.diffra.cancelSession(action.sessionId)
    return { ok: true, sessionId: action.sessionId, queued: false }
  }
  const options = { skills: action.skills, remote: action.source, ...(action.kind === 'send' ? { plan: action.plan ?? false, goal: action.goal ?? false, images: action.images ?? [] } : {}) }
  if (action.kind === 'send') {
    const sent = await sendInBackground(action.sessionId, action.text, options)
    if (!sent) return { ok: false, error: '没有这个会话，或者读不出来' }
    return { ok: true, sessionId: action.sessionId, queued: sent.queued }
  }
  const created = await startInBackground(action.project, action.text, { design: false }, options)
  return { ok: true, sessionId: created.sessionId, queued: false }
}

// 设备连接：授权的远程设备读、操作任务（主进程已经查过授权和级别）。在后台载入任务、用本机的逻辑，不把用户从正在看的页面切走
async function handleRemoteTaskCall(call: RemoteTaskCall): Promise<unknown> {
  if (call.kind === 'models') return store.get().settings?.providers ?? (await window.diffra.getSettings()).providers
  const summary = store.get().tasks.find((task) => task.sessionId === call.sessionId)
  if (!summary) throw new Error('没有这个会话，或者读不出来')
  const live = await loadLive(summary)
  switch (call.kind) {
    case 'details': {
      const [project, branch] = await Promise.all([window.diffra.getProject(live.project).catch(() => null), window.diffra.projectBranch(live.project)])
      const details: RemoteTaskDetails = {
        info: live.info,
        modelLabel: live.modelLabel,
        ...(live.modelRef ? { modelRef: live.modelRef } : {}),
        planLabel: live.planLabel,
        fallbackLabel: live.fallbackLabel,
        permissionMode: live.permissionMode,
        planMode: live.planMode,
        branch,
        project,
      }
      return details
    }
    case 'diff':
      return window.diffra.checkpointDiff(call.sessionId, call.turnId)
    case 'skills':
      return window.diffra.listSkills({ sessionId: call.sessionId })
    case 'commands':
      return window.diffra.listCommands({ sessionId: call.sessionId })
    case 'restorePreview':
      return window.diffra.previewCheckpoint(call.sessionId, call.turnId)
    case 'setModel':
      if (!(await setTaskModel(call.sessionId, call.ref))) throw new Error('切换模型失败，原因提示在对方电脑上')
      return {}
    case 'setPermissionMode':
      await setPermissionMode(call.sessionId, call.mode)
      return {}
    case 'restore':
      await restoreTurn(call.sessionId, call.turnId)
      return {}
    // 压缩、重新生成会起一轮，不等它跑完；出错在本机提示
    case 'compact':
      compactTask(call.sessionId).catch((error: unknown) => showToast(`远程设备要求的压缩失败：${errorMessage(error)}`))
      return {}
    case 'regenerate':
      regenerate(call.sessionId, call.turnId).catch((error: unknown) => showToast(`远程设备要求的重新生成失败：${errorMessage(error)}`))
      return {}
  }
}

// 在后台给任务发一条消息：载入任务、起一轮（正在跑就排队），不把用户从正在看的页面切走。任务不在了返回 null
export async function sendInBackground(sessionId: string, text: string, options: Partial<MessageOptions> = {}): Promise<{ title: string; queued: boolean } | null> {
  const summary = store.get().tasks.find((task) => task.sessionId === sessionId)
  const target = store.get().live[sessionId] ?? (summary ? await loadLive(summary) : null)
  if (!target) return null
  const queued = target.running
  void sendMessage(sessionId, text, options)
  return { title: target.title, queued }
}

// 在后台新建任务并发第一条消息，不切过去；没给标题就取消息第一行
export async function startInBackground(project: string | null, text: string, task: { title?: string; design: boolean }, options: Partial<MessageOptions> = {}): Promise<{ sessionId: string; title: string }> {
  const title = task.title || titleOf(text)
  const handle = await window.diffra.createSession(project, { title, ...(task.design ? { design: true } : {}) })
  // 先定标题：不然第一轮会拿消息第一行（比如「来自任务…的消息：」）当标题
  await window.diffra.updateSession(handle.sessionId, { title })
  store.set((state) => ({
    ...state,
    projects: handle.noProject ? state.projects : addProject(state.projects, handle.cwd),
    live: { ...state.live, [handle.sessionId]: liveFrom(handle, title) },
  }))
  void sendMessage(handle.sessionId, text, options)
  return { sessionId: handle.sessionId, title }
}

export async function openTask(task: Pick<StoredSessionSummary, 'sessionId' | 'cwd'>, record = true): Promise<void> {
  const existing = store.get().live[task.sessionId]
  if (existing) {
    if (existing.design) store.set((state) => ({ ...state, panel: 'design' }))
    navigate({ name: 'task', sessionId: task.sessionId }, record)
    return
  }
  try {
    const live = await loadLive(task)
    if (live.design) store.set((state) => ({ ...state, panel: 'design' }))
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
    await runTurnOnCore(
      sessionId,
      text,
      message.goal ? 'goal' : 'prompt',
      skills,
      images,
      (turnId) =>
        window.diffra.sendPrompt(sessionId, turnId, text, {
          skills,
          goal: message.goal,
          images,
          ...(message.from ? { from: message.from } : {}),
          ...(message.remote ? { remote: message.remote } : {}),
          ...(message.fromPlan ? { fromPlan: message.fromPlan } : {}),
        }),
      message.from,
      message.remote,
      message.fromPlan?.turnId,
    )
}

// 多候选方案（v2）：生成是一轮（和出计划一样），项目不动
export async function generateCandidates(sessionId: string, params: { request: string; plan: string | null; candidates: CandidateSpec[] }): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  const title = `生成 ${params.candidates.length} 个候选方案`
  await runTurnOnCore(sessionId, title, 'plan', [], [], (turnId) => window.diffra.generateCandidates(sessionId, turnId, { title, ...params }))
}

// 应用一个候选：一轮 apply，能撤销；冲突时 core 什么都不改、在卡片上列出冲突
export async function applyCandidate(sessionId: string, runTurnId: string, candidate: { id: string; name: string }): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  const title = `应用候选方案「${candidate.name}」`
  await runTurnOnCore(sessionId, title, 'apply', [], [], (turnId) => window.diffra.applyCandidate(sessionId, turnId, { title, runTurnId, candidateId: candidate.id }))
}

export async function discardCandidates(sessionId: string, runTurnId: string): Promise<void> {
  try {
    await window.diffra.discardCandidates(sessionId, runTurnId)
  } catch (error) {
    showToast(`放弃候选方案失败：${errorMessage(error)}`)
  }
}

export function setPlanMode(sessionId: string, planMode: boolean): void {
  updateLive(sessionId, (task) => ({ ...task, planMode }))
}


// 深度安全扫描在界面上也是一轮：和 core 记下的标题一致
export async function runDeepScan(sessionId: string, scope: 'task' | 'project'): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  await runTurnOnCore(sessionId, DEEP_SCAN_TITLES[scope], 'deep-scan', [], [], (turnId) => window.diffra.deepScan(sessionId, turnId, scope))
}

export function openTodos(): void {
  navigate({ name: 'todos' })
  if (store.get().todos === null) void loadTodos()
}

export async function loadTodos(): Promise<void> {
  try {
    const todos = await window.diffra.listTodos()
    store.set((state) => ({ ...state, todos }))
  } catch (error) {
    showToast(`读取待办失败：${errorMessage(error)}`)
  }
}

// 改一条待办的定时；null 是取消定时。改了时间就是新的一次，之前的处理结果清掉
export function setTodoSchedule(id: string, schedule: TodoSchedule | null): Promise<void> {
  return saveTodos((todos) => todos.map((todo) => (todo.id === id ? { ...todo, schedule } : todo)))
}

// 先改界面再存；存失败时提示，界面上的改动留着，下次改动会连同它一起再存
// 改过的、新加的记下改动时间（v2，局域网同步按它决定谁新）；存的时候带上改之前有哪些，主进程据此分清删掉的和同步进来的
export async function saveTodos(change: (todos: Todo[]) => Todo[]): Promise<void> {
  const current = store.get().todos ?? (await window.diffra.listTodos())
  const before = new Map(current.map((todo) => [todo.id, JSON.stringify(todo)]))
  const now = new Date().toISOString()
  const next = change(current).map((todo) => (before.get(todo.id) === JSON.stringify(todo) ? todo : { ...todo, updatedAt: now }))
  store.set((state) => ({ ...state, todos: next }))
  try {
    await window.diffra.saveTodos(
      next,
      current.map((todo) => todo.id),
    )
  } catch (error) {
    showToast(`保存待办失败：${errorMessage(error)}`)
  }
}

// 记一条待办；不传 project 时带上所在页面当前的项目，at 有值时到时提醒
// body：对话框里写的正文（可以是空字符串，表示按新格式存、不再从标题里拆）；快速记不带
export function addTodo(
  text: string,
  at?: Date,
  options: { project?: string | null; tags?: string[]; body?: string; priority?: TodoPriority | null; images?: string[]; files?: FileReference[]; repeat?: TodoRepeatKind } = {},
): Promise<void> {
  const todo: Todo = {
    id: crypto.randomUUID(),
    text: text.trim(),
    ...(options.body === undefined ? {} : { body: options.body.trim() }),
    ...(options.priority === undefined || options.priority === null ? {} : { priority: options.priority }),
    project: options.project === undefined ? currentProject() : options.project,
    tags: normalizeTodoTags(options.tags ?? []),
    createdAt: new Date().toISOString(),
    done: false,
    sentTo: null,
    ...(at ? { schedule: { at: at.toISOString(), action: { kind: 'remind' as const }, result: null, ...(options.repeat ? { repeat: { every: options.repeat, interval: 1, start: at.toISOString() } } : {}) } } : {}),
    ...(options.images?.length ? { images: options.images } : {}),
    ...(options.files?.length ? { files: options.files } : {}),
  }
  return saveTodos((todos) => [todo, ...todos])
}

// 对话框里改一条待办：标题、正文、优先级、标签、项目、时间、附件
export function updateTodo(id: string, change: Pick<Todo, 'text' | 'body' | 'priority' | 'tags' | 'project' | 'images' | 'files'> & { schedule: TodoSchedule | null }): Promise<void> {
  return saveTodos((todos) => todos.map((todo) => (todo.id === id ? { ...todo, ...change, text: change.text.trim(), body: change.body?.trim(), tags: normalizeTodoTags(change.tags) } : todo)))
}

// 验收派给任务的待办：标记完成并记下验收时间，待办从待验收列表里消失
export function acceptTodos(ids: string[]): Promise<void> {
  const acceptedAt = new Date().toISOString()
  return saveTodos((todos) => todos.map((todo) => (ids.includes(todo.id) && !todo.done ? { ...todo, done: true, acceptedAt } : todo)))
}

// 把几条待办派给任务：新任务直接发出去；已有任务发送（运行中排队）或只填进输入框。记下派给了谁
export async function dispatchTodos(
  ids: string[],
  text: string,
  target: { kind: 'new'; project: string | null; design: boolean } | { kind: 'existing'; sessionId: string; cwd: string; mode: 'send' | 'fill' },
): Promise<void> {
  let sessionId: string
  const todos = (store.get().todos ?? []).filter((todo) => ids.includes(todo.id))
  if (target.kind === 'existing' && target.mode === 'fill') {
    const { images, files } = todoAttachments(todos)
    checkTodoAttachments(images, files)
    const pictures = await Promise.all(images.map((id) => window.diffra.readTodoImage(id)))
    await openTask({ sessionId: target.sessionId, cwd: target.cwd })
    if (!store.get().live[target.sessionId]) return
    sessionId = target.sessionId
    fillComposer(sessionId, text, { images: pictures, files })
  } else if (target.kind === 'new') {
    const message = await todoMessageWithAttachments(todos, text)
    // 模型和权限模式按设置里的默认来，和首页没选时一样
    await startTask(target.project, message.text, target.design ? { design: true } : {}, { images: message.images })
    const route = store.get().route
    if (route.name !== 'task') return
    sessionId = route.sessionId
  } else {
    const message = await todoMessageWithAttachments(todos, text)
    await openTask({ sessionId: target.sessionId, cwd: target.cwd })
    if (!store.get().live[target.sessionId]) return
    sessionId = target.sessionId
    await sendMessage(sessionId, message.text, { images: message.images })
  }
  const title = store.get().live[sessionId]?.title ?? ''
  const at = new Date().toISOString()
  await saveTodos((todos) => todos.map((todo) => (ids.includes(todo.id) ? { ...todo, sentTo: { sessionId, title, at } } : todo)))
}

// 待办附件超出一条消息能带的数量就不发，免得悄悄少发
function checkTodoAttachments(images: string[], files: FileReference[]): void {
  if (images.length > TODO_MAX_IMAGES) throw new Error(`一条消息最多带 ${TODO_MAX_IMAGES} 张图片，这几条待办一共 ${images.length} 张`)
  if (files.length > MAX_PROMPT_FILE_REFERENCES) throw new Error(`一条消息最多引用 ${MAX_PROMPT_FILE_REFERENCES} 个文件或文件夹，这几条待办一共 ${files.length} 个`)
}

// 派给任务的消息带上待办的附件：图片作为提问图片，文件和输入框里加的一样写成路径引用
export async function todoMessageWithAttachments(todos: readonly Pick<Todo, 'images' | 'files'>[], text: string): Promise<{ text: string; images: PromptImage[] }> {
  const { images, files } = todoAttachments(todos)
  checkTodoAttachments(images, files)
  return { text: promptWithFileReferences(text, files), images: await Promise.all(images.map((id) => window.diffra.readTodoImage(id))) }
}

// 把一段话填进这个任务的输入框：空着就直接填，有字就空一行接在后面；输入框上有「撤销」恢复原来的草稿。附件加在输入框的附件里
export function fillComposer(sessionId: string, text: string, attachments?: { images: PromptImage[]; files: FileReference[] }): void {
  store.set((state) => ({ ...state, composerInsert: { target: sessionId, text, mode: 'fill', ...(attachments ? attachments : {}) } }))
}

// 定位问题：停下的那一轮，或者其中一个子智能体（cardId 是它的卡片）。在界面上也是一轮，只读地查，不改文件
export async function diagnose(sessionId: string, target: { turnId: string; cardId?: string; agent?: string }): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  const text = target.agent ? `定位问题：子智能体「${target.agent}」为什么没做完` : '定位问题：上一轮为什么停下'
  await runTurnOnCore(sessionId, text, 'diagnose', [], [], (turnId) => window.diffra.diagnose(sessionId, turnId, text, { turnId: target.turnId, cardId: target.cardId ?? null }))
}

// 直接应用回答里的 diff（第 686 步）：记成一轮 apply，走和模型改文件一样的权限、检查点和改动卡片
export async function applyAnswerDiff(sessionId: string, diff: string, files: string[]): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  const text = `应用回答里的改动：${files.join('、') || '补丁'}`
  await runTurnOnCore(sessionId, text, 'apply', [], [], (turnId) => window.diffra.applyDiff(sessionId, turnId, text, diff))
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
  from?: TaskSource,
  remote?: RemoteSource,
  fromPlan?: string,
): Promise<void> {
  const turnId = crypto.randomUUID()
  updateLive(sessionId, (current) => ({ ...current, running: true, turns: [...current.turns, newTurn(turnId, text, kind, skills, images, from, remote, fromPlan)] }))
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
    // 智能体提交前用户选了先做深度扫描：接着扫本任务的改动，排队的消息等扫完再发
    const scanFirst = store.get().live[sessionId]?.turns.find((turn) => turn.id === turnId)?.outcome?.stop === 'deep-scan'
    updateLive(sessionId, (current) => {
      next = scanFirst ? undefined : current.queue[0]
      return { ...current, running: false, permission: null, queue: scanFirst ? current.queue : current.queue.slice(1), changeVersion: current.changeVersion + 1, unread: current.unread || !viewing }
    })
    await refreshTasks()
    if (scanFirst) void runDeepScan(sessionId, 'task')
    else if (next) void sendMessage(sessionId, next.text, next.options)
  }
}

export function dequeue(sessionId: string, id: string): void {
  updateLive(sessionId, (task) => ({ ...task, queue: task.queue.filter((item) => item.id !== id) }))
}

export function cancelTask(sessionId: string): void {
  window.diffra.cancelSession(sessionId).catch((error: unknown) => showToast(errorMessage(error)))
}

export function respondPermission(sessionId: string, optionId: string | null, answers?: AskAnswer[]): void {
  const request = store.get().live[sessionId]?.permission
  if (!request) return
  updateLive(sessionId, (task) => ({ ...task, permission: null }))
  window.diffra.respondPermission(request.requestId, optionId, answers).catch((error: unknown) => showToast(errorMessage(error)))
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
    const { filesRestored, edited } = await window.diffra.rewindSession(sessionId, turnId)
    if (!filesRestored) showToast('这一轮没有检查点，文件改动没有撤销，只重新生成了回答')
    updateLive(sessionId, (current) => ({
      ...current,
      changeVersion: current.changeVersion + 1,
      turns: current.turns.slice(0, current.turns.findIndex((item) => item.id === turnId)),
    }))
    // 撤掉的这一轮留成「上一次」（第 676 步），挂到马上开始的那一轮上（core 记录里也挂了，重新打开时从记录读）
    const { versions: earlier, ...replaced } = turn
    const versions = [...(earlier ?? []), { turn: replaced, edited }]
    const sending = sendMessage(sessionId, turn.prompt, { goal: turn.kind === 'goal', skills: turn.skills, images: turn.images })
    updateLive(sessionId, (current) => {
      const last = current.turns.at(-1)
      return last && last.id !== turnId && last.prompt === turn.prompt && !last.versions ? { ...current, turns: [...current.turns.slice(0, -1), { ...last, versions }] } : current
    })
    await sending
  } catch (error) {
    showToast(`重新生成失败：${errorMessage(error)}`)
  }
}

// 换回重新生成之前的那一次（第 676 步）：core 换好后界面照样换，不重新载入任务（重新载入会重建 core 里的会话，本会话的授权这些就没了）
export async function switchTurnVersion(sessionId: string, turnId: string, index: number): Promise<void> {
  const task = store.get().live[sessionId]
  if (!task || task.running) return
  try {
    const { filesRestored } = await window.diffra.useTurnVersion(sessionId, turnId, index)
    updateLive(sessionId, (current) => ({
      ...current,
      changeVersion: current.changeVersion + 1,
      turns: current.turns.map((turn) => (turn.id === turnId ? swapVersion(turn, index, filesRestored) : turn)),
    }))
    showToast(filesRestored ? '换回了那一次，这一次改的文件已经撤销' : '换回了那一次')
  } catch (error) {
    showToast(`切换失败：${errorMessage(error)}`)
  }
}

function swapVersion(turn: Turn, index: number, filesRestored: boolean): Turn {
  const chosen = turn.versions?.[index]
  if (!chosen) return turn
  const { versions: _versions, ...current } = turn
  const edited = filesRestored || current.items.some((item) => item.kind === 'tool' && item.content.some((content) => content.type === 'diff'))
  const versions = [...turn.versions!.filter((_, position) => position !== index), { turn: current, edited }].sort((a, b) => (a.turn.startedAt ?? 0) - (b.turn.startedAt ?? 0))
  return { ...chosen.turn, id: turn.id, versions }
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

// 输入框里给模型选了思考程度：记进设置，新任务、重开的任务按它（第 531 步）
export async function rememberReasoning(ref: ModelRef): Promise<void> {
  if (!ref.reasoningEffort) return
  try {
    const settings = await window.diffra.savePreferences({ reasoningChoice: { providerId: ref.providerId, modelId: ref.modelId, effort: ref.reasoningEffort } })
    store.set((state) => ({ ...state, settings }))
  } catch (error) {
    showToast(`记住思考程度失败：${errorMessage(error)}`)
  }
}

// 拖动分栏时只改内存，松手后 saveLayout 再存；设置还没读到时不动
export function setLayout(change: Partial<Layout>): void {
  store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, layout: { ...state.settings.layout, ...change } } } : state))
}

// 不拿返回的设置覆盖内存：存的时候可能又拖过一次
export async function saveLayout(change: Partial<Layout>): Promise<void> {
  setLayout(change)
  const layout = store.get().settings?.layout
  if (!layout) return
  try {
    await window.diffra.savePreferences({ layout })
  } catch (error) {
    showToast(`保存布局失败：${errorMessage(error)}`)
  }
}

// 换成功返回 true；失败时提示原因
export async function setTaskModel(sessionId: string, model: ModelRef): Promise<boolean> {
  try {
    const { modelLabel } = await window.diffra.configureSession(sessionId, { model })
    if (modelLabel) updateLive(sessionId, (task) => ({ ...task, modelLabel, modelRef: model }))
    return true
  } catch (error) {
    showToast(errorMessage(error))
    return false
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
  const wasArchived = store.get().settings?.archivedProjects.some((path) => sameProjectPath(path, picked.path)) ?? false
  if (wasArchived) await setProjectArchived(picked.path, false)
  store.set((state) => ({
    ...state,
    projects: addProject(state.projects, picked.path),
    settings: state.settings ? { ...state.settings, archivedProjects: state.settings.archivedProjects.filter((path) => !sameProjectPath(path, picked.path)) } : state.settings,
  }))
  return picked.path
}

// 归档项目：项目下的会话由主进程一起归档。侧边栏立即隐藏，设置里的归档列表可以恢复
export async function setProjectArchived(projectPath: string, archived: boolean): Promise<void> {
  try {
    await window.diffra.setProjectArchived(projectPath, archived)
    const route = store.get().route
    if (archived) {
      if (route.name === 'task' && !store.get().live[route.sessionId]?.noProject && sameProjectPath(store.get().live[route.sessionId]?.project, projectPath)) {
        const design = store.get().live[route.sessionId]?.design
        if (design) openDesign(null)
        else openHome(null)
      } else if ((route.name === 'home' || route.name === 'design') && sameProjectPath(route.project, projectPath)) {
        navigate({ name: route.name, project: null })
      }
    }
    store.set((state) => ({
      ...state,
      projects: archived ? state.projects.filter((path) => !sameProjectPath(path, projectPath)) : addProject(state.projects, projectPath),
      settings: state.settings
        ? {
            ...state.settings,
            archivedProjects: archived
              ? state.settings.archivedProjects.some((path) => sameProjectPath(path, projectPath))
                ? state.settings.archivedProjects
                : [...state.settings.archivedProjects, projectPath]
              : state.settings.archivedProjects.filter((path) => !sameProjectPath(path, projectPath)),
          }
        : state.settings,
    }))
    await refreshTasks()
  } catch (error) {
    showToast(errorMessage(error))
  }
}

// 删除项目：主进程删掉项目下的会话记录，项目文件夹留在磁盘上。界面同步移除项目和会话
export async function deleteProject(projectPath: string): Promise<void> {
  try {
    const { sessionIds } = await window.diffra.deleteProject(projectPath)
    const removed = new Set(sessionIds)
    const route = store.get().route
    if (route.name === 'task' && (removed.has(route.sessionId) || (!store.get().live[route.sessionId]?.noProject && sameProjectPath(store.get().live[route.sessionId]?.project, projectPath)))) {
      const design = store.get().live[route.sessionId]?.design
      if (design) openDesign(null)
      else openHome(null)
    } else if ((route.name === 'home' || route.name === 'design') && sameProjectPath(route.project, projectPath)) {
      navigate({ name: route.name, project: null })
    }
    store.set((state) => ({
      ...state,
      projects: state.projects.filter((path) => !sameProjectPath(path, projectPath)),
      tasks: state.tasks.filter((task) => task.noProject || !sameProjectPath(task.cwd, projectPath)),
      live: Object.fromEntries(Object.entries(state.live).filter(([sessionId, task]) => !removed.has(sessionId) && (task.noProject || !sameProjectPath(task.project, projectPath)))),
      settings: state.settings ? { ...state.settings, archivedProjects: state.settings.archivedProjects.filter((path) => !sameProjectPath(path, projectPath)) } : state.settings,
    }))
    await refreshTasks()
    showToast(`已删除项目「${folderName(projectPath)}」的记录，项目文件夹保留在磁盘上`)
  } catch (error) {
    showToast(errorMessage(error))
  }
}
