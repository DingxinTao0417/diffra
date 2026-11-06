import { useSyncExternalStore } from 'react'
import type { PermissionMode, SessionInfo, StoredSessionSummary } from '@diffra/core/types'
import type { PermissionRequestEvent } from '../../../shared/ipc'
import type { SettingsView } from '../../../shared/settings'
import type { Turn, Usage } from '../features/session/transcript'

export type SettingsSection = 'general' | 'appearance' | 'models' | 'rules' | 'permissions' | 'storage' | 'usage' | 'about'

export type Route =
  | { name: 'home'; project: string | null }
  | { name: 'task'; sessionId: string }
  | { name: 'settings'; section: SettingsSection }

export type SidePanel = 'monitor' | 'review' | null

// 打开过的任务在界面这边的状态；切走再切回来不用重新加载
export interface LiveTask {
  sessionId: string
  project: string
  title: string
  modelLabel: string
  permissionMode: PermissionMode
  info: SessionInfo
  turns: Turn[]
  running: boolean
  usage: Usage | null
  permission: PermissionRequestEvent | null
  // 运行中发的消息，这一轮结束后依次发出
  queue: Array<{ id: string; text: string }>
  // 文件可能变了就加一，任务监控和审阅面板据此刷新
  changeVersion: number
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
  tasks: StoredSessionSummary[]
  // 侧栏显示的项目：有任务的项目和最近选过的项目
  projects: string[]
  live: Record<string, LiveTask>
  settings: SettingsView | null
  sidebarOpen: boolean
  searchOpen: boolean
  panel: SidePanel
  terminalOpen: boolean
  terminals: TerminalTab[]
  activeTerminal: string | null
  toast: { id: number; text: string } | null
}

const initialState: AppState = {
  route: { name: 'home', project: null },
  lastWorkRoute: { name: 'home', project: null },
  tasks: [],
  projects: [],
  live: {},
  settings: null,
  sidebarOpen: true,
  searchOpen: false,
  panel: 'monitor',
  terminalOpen: false,
  terminals: [],
  activeTerminal: null,
  toast: null,
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

export function updateLive(sessionId: string, change: (task: LiveTask) => LiveTask): void {
  store.set((state) => {
    const task = state.live[sessionId]
    return task ? { ...state, live: { ...state.live, [sessionId]: change(task) } } : state
  })
}

export function showToast(text: string): void {
  store.set((state) => ({ ...state, toast: { id: Date.now(), text } }))
}
