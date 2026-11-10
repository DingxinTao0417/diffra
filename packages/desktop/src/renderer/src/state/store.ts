import { useSyncExternalStore } from 'react'
import type { PermissionMode, PromptImage, SessionInfo, StoredSessionSummary, TaskProgressView, TaskSource } from '@diffra/core/types'
import type { BridgeStatus, BrowserState, PermissionRequestEvent } from '../../../shared/ipc'
import type { ModelRef, SettingsView } from '../../../shared/settings'
import type { Todo } from '../../../shared/todos'
import type { Turn, Usage } from '../features/session/transcript'

export type SettingsSection = 'general' | 'appearance' | 'models' | 'permissions' | 'security' | 'execution' | 'browser' | 'mcp' | 'plugins' | 'storage' | 'usage' | 'about'

export type Route =
  | { name: 'home'; project: string | null }
  | { name: 'design'; project: string | null }
  | { name: 'task'; sessionId: string }
  | { name: 'todos' }
  | { name: 'settings'; section: SettingsSection }

export type SidePanel = 'monitor' | 'review' | 'browser' | 'design' | null

// 一条消息怎么发：plan 先出计划；goal 目标模式，没达成就自动接着做；skills 这一轮带上的 Skill 名字
export interface MessageOptions {
  plan: boolean
  goal: boolean
  skills: string[]
  images: PromptImage[]
  // 另一个任务的智能体发来的（任务互通）
  from?: TaskSource
}

// 打开过的任务在界面这边的状态；切走再切回来不用重新加载
export interface LiveTask {
  progress?: TaskProgressView
  sessionId: string
  // 任务的目录；无项目任务是主进程替它建的文件夹
  project: string
  noProject: boolean
  title: string
  modelLabel: string
  modelRef?: ModelRef
  planLabel: string | null
  fallbackLabel: string | null
  permissionMode: PermissionMode
  // 设计任务：打开任务时切到设计面板
  design: boolean
  // 输入框里「先出计划」开着：发的消息先由规划模型出计划
  planMode: boolean
  info: SessionInfo
  turns: Turn[]
  running: boolean
  usage: Usage | null
  permission: PermissionRequestEvent | null
  // 运行中发的消息，这一轮结束后依次发出
  queue: Array<{ id: string; text: string; options: MessageOptions }>
  // 文件可能变了就加一，任务监控和审阅面板据此刷新
  changeVersion: number
  // 一轮在用户没看着这个任务时结束，侧栏标「完成未读」；打开任务后清掉，只在内存里
  unread: boolean
}

// 底部终端面板里的一个终端；进程退出后标签留着，exitCode 不为 null
export interface TerminalTab {
  id: string
  cwd: string
  shell: string
  exitCode: number | null
}

export interface AppState {
  route: Route
  // 从设置页返回时回到哪里
  lastWorkRoute: Route
  // 后退、前进用：去过的首页、设计首页和任务页（设置页不记）
  history: Route[]
  historyIndex: number
  tasks: StoredSessionSummary[]
  // 侧栏显示的项目：有任务的项目和最近选过的项目
  projects: string[]
  live: Record<string, LiveTask>
  // 各任务内置浏览器标签页的状态
  browsers: Record<string, BrowserState>
  // 连着的 Diffra 浏览器扩展（用户自己的 Chrome、Edge）
  bridge: BridgeStatus
  settings: SettingsView | null
  sidebarOpen: boolean
  // 窄窗口自动收起是布局上的派生结果，不写回 sidebarOpen：宽度回来后侧栏自己出现，用户自己收起的除外。
  // sidebarKeepOpen：窄窗口下用户主动展开的侧栏照常显示，宽度回来后清掉
  sidebarNarrow: boolean
  sidebarKeepOpen: boolean
  // 侧栏收起的项目、展开了全部任务的项目（按项目路径）；侧栏会随 Ctrl+B 和设置页卸载，所以放这里，只在内存里
  collapsedProjects: ReadonlySet<string>
  expandedProjects: ReadonlySet<string>
  searchOpen: boolean
  panel: SidePanel
  terminalOpen: boolean
  // 往输入框塞文字：target 是任务 id 或 home。append 接在末尾（附加终端内容）；fill 空着就填、有字就空一行接上，带撤销（定位结果的「填入输入框」）
  composerInsert?: { target: string; text: string; mode: 'append' | 'fill' }
  terminals: TerminalTab[]
  activeTerminal: string | null
  toast: { id: number; text: string } | null
  // 待办：启动时读一次，之后改了整份存回去；读到之前为 null
  todos: Todo[] | null
  // 快速记待办的小窗口（Ctrl+J）
  quickTodoOpen: boolean
  // 待办页：列表还是日历；点系统通知时要定位的那条待办
  todosView: 'list' | 'calendar'
  todoFocus: string | null
}

const initialState: AppState = {
  route: { name: 'home', project: null },
  lastWorkRoute: { name: 'home', project: null },
  history: [{ name: 'home', project: null }],
  historyIndex: 0,
  tasks: [],
  projects: [],
  live: {},
  browsers: {},
  bridge: { connections: [] },
  settings: null,
  sidebarOpen: true,
  sidebarNarrow: false,
  sidebarKeepOpen: false,
  collapsedProjects: new Set(),
  expandedProjects: new Set(),
  searchOpen: false,
  panel: 'monitor',
  terminalOpen: false,
  terminals: [],
  activeTerminal: null,
  toast: null,
  todos: null,
  quickTodoOpen: false,
  todosView: 'list',
  todoFocus: null,
}

type Listener = () => void

class Store {
  private state = initialState
  private readonly listeners = new Set<Listener>()

  get = (): AppState => this.state

  set(change: (state: AppState) => AppState): void {
    const next = change(this.state)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const store = new Store()

// selector 要返回 state 里已有的引用或基本类型；需要计算的派生数据在组件里用 useMemo
export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}

// 宽面板（浏览器、审阅）按主区一半取宽，收起侧栏省出的宽度一半让面板吃掉，对话列在默认 1200 窗口下也到不了阈值，
// 收了只会让侧栏一开面板就消失，所以开着宽面板时不自动收起
export function hasWidePanel(state: AppState): boolean {
  return state.route.name === 'task' && (state.panel === 'browser' || state.panel === 'review' || state.panel === 'design')
}

export function isSidebarShown(state: AppState): boolean {
  return state.sidebarOpen && (!state.sidebarNarrow || state.sidebarKeepOpen || hasWidePanel(state))
}

export function updateLive(sessionId: string, change: (task: LiveTask) => LiveTask): void {
  store.set((state) => {
    const task = state.live[sessionId]
    return task ? { ...state, live: { ...state.live, [sessionId]: change(task) } } : state
  })
}

export function showToast(text: string): void {
  store.set((state) => ({ ...state, toast: { id: Date.now(), text } }))
}
