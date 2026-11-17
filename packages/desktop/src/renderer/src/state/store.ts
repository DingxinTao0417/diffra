import { useSyncExternalStore } from 'react'
import type { DiagramKind } from '@diffra/core/architecture'
import type { BackgroundProcess, PermissionMode, PromptImage, RemoteSource, SessionAgentRef, SessionInfo, StoredSessionSummary, TaskProgressView, TaskSource } from '@diffra/core/types'
import type { FileReference } from '../../../shared/attachments'
import type { BridgeStatus, BrowserState, PermissionRequestEvent } from '../../../shared/ipc'
import type { RemoteView } from '../../../shared/remote'
import type { RemoteListState, RemoteTask } from '@/features/devices/remote-tasks'
import type { ModelRef, SettingsView } from '../../../shared/settings'
import type { Todo } from '../../../shared/todos'
import type { Turn, Usage } from '../features/session/transcript'

export type SettingsSection = 'general' | 'appearance' | 'models' | 'agents' | 'permissions' | 'security' | 'execution' | 'browser' | 'design' | 'devices' | 'storage' | 'usage' | 'eval' | 'about'

// 扩展页的分栏：推荐、MCP 目录、插件目录、已安装（第 595 步）
export type ExtensionsTab = 'recommended' | 'mcp' | 'plugins' | 'installed'

export type Route =
  | { name: 'home'; project: string | null }
  | { name: 'design'; project: string | null }
  | { name: 'task'; sessionId: string }
  // 别的设备授权给本机看的会话（设备连接，只读）
  | { name: 'remote-task'; deviceId: string; sessionId: string }
  | { name: 'todos' }
  | { name: 'extensions'; tab: ExtensionsTab }
  // 架构：projectId 为 null 是项目卡片页；diagram 是看哪张架构图，section 是依赖页的哪一块，
  // scope 是依赖图看到哪一层（见 features/architecture/graph.ts），focus 是选中的方块、节点或依赖线
  | { name: 'architecture'; projectId: string | null; tab: ArchitectureTab; diagram: DiagramKind; section: DependencySection; scope: string; focus: string | null }
  | { name: 'settings'; section: SettingsSection }

export type ArchitectureTab = 'overview' | 'diagram' | 'dependencies' | 'flows' | 'hotspots' | 'target' | 'runtime'
export type DependencySection = 'graph' | 'matrix' | 'cycles' | 'externals'

export type SidePanel = 'monitor' | 'review' | 'browser' | 'design' | 'terminal' | 'file' | 'visuals' | null

// 一条消息怎么发：plan 先出计划；goal 目标模式，没达成就自动接着做；skills 这一轮带上的 Skill 名字
export interface MessageOptions {
  plan: boolean
  goal: boolean
  skills: string[]
  images: PromptImage[]
  // 另一个任务的智能体发来的（任务互通）
  from?: TaskSource
  // 配对的远程设备发来的（设备连接）
  remote?: RemoteSource
  // 计划卡片上点「按计划执行」（v2）：出计划那一轮的 id 和计划的步骤
  fromPlan?: { turnId: string; steps: string[] }
}

// 打开过的任务在界面这边的状态；切走再切回来不用重新加载
export interface LiveTask {
  collaboration?: import('@diffra/core/types').CollaborationView
  progress?: TaskProgressView
  sessionId: string
  // 任务的目录；无项目任务是主进程替它建的文件夹
  project: string
  noProject: boolean
  title: string
  modelLabel: string
  modelRef?: ModelRef
  // 外接智能体的任务（v2）：用它自己的模型，没有 Diffra 的出计划、目标、压缩、深度扫描、重新生成
  agent?: SessionAgentRef
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
  // 下一句建议：只对当前这一轮有效，输入后或新一轮开始就清掉；只在内存里
  suggestion: { turnId: string; text: string } | null
}

// 底部终端面板里的一个终端；进程退出后标签留着，exitCode 不为 null
export interface TerminalTab {
  id: string
  cwd: string
  shell: string
  exitCode: number | null
  // 智能体起的开发服务器：哪个任务的、什么命令、输出里看到的本地地址
  devServer?: { sessionId: string; command: string; url: string | null }
}

// 固定到白板的东西（第 668 步起可视化，第 677 步起回答里的富块和过程卡片），按任务分。from 是「第 N 轮」，跨轮对比时看得出来自哪一轮
export type PinnedItem =
  // 可视化卡片（工具调用）的 id；同一张卡片切到别的版本时固定的是当时看的那一版
  | { kind: 'visual'; sessionId: string; id: string; title: string; code: string; from?: string }
  // 回答里的富块：存它的 Markdown 围栏，白板里照样渲染、照样能交互
  | { kind: 'block'; sessionId: string; id: string; title: string; text: string; from?: string }
  // 过程卡片：固定当时的样子（静态渲染去掉按钮后的 HTML，static-html.tsx 的 snapshotHtml）
  | { kind: 'card'; sessionId: string; id: string; title: string; html: string; from?: string }

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
  // 设备连接：主进程推来的状态；读到之前为 null
  remote: RemoteView | null
  // 自己连接的设备授权给本机的会话列表（按设备）、正在看的远程会话（按「设备/会话」）；都只在内存里
  remoteLists: Record<string, RemoteListState>
  remoteTasks: Record<string, RemoteTask>
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
  // 往输入框塞文字：target 是任务 id 或 home。append 接在末尾（附加终端内容）；fill 空着就填、有字就空一行接上，带撤销（定位结果的「填入输入框」）
  // images、files：派待办时填入输入框带上的附件
  composerInsert?: { target: string; text: string; mode: 'append' | 'fill'; images?: PromptImage[]; files?: FileReference[] }
  terminals: TerminalTab[]
  activeTerminal: string | null
  // 各任务转到后台的命令（内核推来的整份列表），只在内存里
  processes: Record<string, BackgroundProcess[]>
  // 审阅面板打开后滚到这个文件（任务监控「产出」、回答里的文件引用点的），滚到后清掉
  reviewFile: string | null
  // 右侧栏文件预览看的文件（回答里点了这个任务没改过的文件，第 536 步）：项目、相对项目的路径、要定位的行
  filePreview: { project: string; path: string; line: number | null } | null
  // 固定到白板的东西（第 668、677 步），按任务分；只在内存里，退出应用就没了
  pinned: PinnedItem[]
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
  remote: null,
  remoteLists: {},
  remoteTasks: {},
  settings: null,
  sidebarOpen: true,
  sidebarNarrow: false,
  sidebarKeepOpen: false,
  collapsedProjects: new Set(),
  expandedProjects: new Set(),
  searchOpen: false,
  panel: 'monitor',
  terminals: [],
  activeTerminal: null,
  processes: {},
  reviewFile: null,
  filePreview: null,
  pinned: [],
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
  private notifyQueued = false
  private readonly notifyChannel = new MessageChannel()

  constructor() {
    this.notifyChannel.port1.onmessage = () => {
      this.notifyQueued = false
      for (const listener of this.listeners) listener()
    }
  }

  get = (): AppState => this.state

  set(change: (state: AppState) => AppState): void {
    const next = change(this.state)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  // 状态马上改（同步读到的都是最新的），订阅者等已经排着的消息处理完再一起通知一次。给会话的流式更新用：
  // 每次通知都让组件同步重画一次，一条消息一通知时重画跟不上消息，越积越多，界面卡住，React 连着提交超过 50 次还会报 #185。
  // 用 MessageChannel 排：窗口藏到托盘时不像定时器那样被节流
  setBatched(change: (state: AppState) => AppState): void {
    const next = change(this.state)
    if (next === this.state) return
    this.state = next
    if (this.notifyQueued) return
    this.notifyQueued = true
    this.notifyChannel.port2.postMessage(null)
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
  return state.route.name === 'task' && (state.panel === 'browser' || state.panel === 'review' || state.panel === 'design' || state.panel === 'terminal' || state.panel === 'file')
}

export function isSidebarShown(state: AppState): boolean {
  return state.sidebarOpen && (!state.sidebarNarrow || state.sidebarKeepOpen || hasWidePanel(state))
}

function withLive(state: AppState, sessionId: string, change: (task: LiveTask) => LiveTask): AppState {
  const task = state.live[sessionId]
  return task ? { ...state, live: { ...state.live, [sessionId]: change(task) } } : state
}

export function updateLive(sessionId: string, change: (task: LiveTask) => LiveTask): void {
  store.set((state) => withLive(state, sessionId, change))
}

// 会话的流式更新：通知攒成一批，见 Store.setBatched
export function updateLiveBatched(sessionId: string, change: (task: LiveTask) => LiveTask): void {
  store.setBatched((state) => withLive(state, sessionId, change))
}

export function showToast(text: string): void {
  store.set((state) => ({ ...state, toast: { id: Date.now(), text } }))
}
