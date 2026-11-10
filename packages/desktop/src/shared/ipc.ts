import type {
  CheckDetection,
  CheckpointChange,
  CheckRunResult,
  CommandInfo,
  ListModelsResult,
  McpServerStatus,
  PromptEnhancement,
  PromptImage,
  PermissionMode,
  PermissionOption,
  RequestPermissionRequest,
  SessionChecks,
  SessionSearchResult,
  SkillInfo,
  StoredSessionSummary,
  StoredTurn,
  SessionInfo,
  SessionNotification,
  StopReason,
  TaskActionParams,
  TaskActionResult,
  TaskProgressView,
  TaskSource,
  TestModelResult,
  UsageQuery,
  UsageSummary,
} from '@diffra/core/types'
import type {
  Appearance,
  Layout,
  BrowserSettings,
  AgentBrowser,
  ExecutionSettings,
  McpServerInput,
  ModelRef,
  PluginView,
  ProviderInput,
  Role,
  SecuritySettings,
  SettingsView,
} from './settings'
import type { FileReference } from './attachments'
import type { Todo } from './todos'

export const IPC_CHANNELS = {
  coreStatus: 'core:status',
  appVersion: 'app:version',
  updateStatus: 'update:status',
  updateStatusChanged: 'update:status-changed',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  settingsGet: 'settings:get',
  providerSave: 'settings:provider-save',
  providerDelete: 'settings:provider-delete',
  roleSet: 'settings:role-set',
  modelsList: 'models:list',
  modelsTest: 'models:test',
  modelsValidate: 'models:validate',
  projectPick: 'project:pick',
  projectLast: 'project:last',
  projectGet: 'project:get',
  projectDetectChecks: 'project:detect-checks',
  projectRunCheck: 'project:run-check',
  projectSave: 'project:save',
  sessionsList: 'sessions:list',
  sessionsSearch: 'sessions:search',
  sessionLoad: 'session:load',
  sessionMetaUpdate: 'session:update-meta',
  sessionDelete: 'session:delete',
  sessionCreate: 'session:create',
  sessionConfigure: 'session:configure',
  sessionRewind: 'session:rewind',
  checkpointDiff: 'session:checkpoint-diff',
  projectBranch: 'project:branch',
  projectOpenFolder: 'project:open-folder',
  sessionFolderState: 'session:folder-state',
  attachmentDescribe: 'attachment:describe',
  sessionsStorage: 'sessions:storage',
  usageSummary: 'usage:summary',
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalOpened: 'terminal:opened',
  preferencesSave: 'settings:preferences-save',
  workspacePick: 'settings:workspace-pick',
  workspaceReset: 'settings:workspace-reset',
  workspaceOpen: 'settings:workspace-open',
  openExternal: 'shell:open-external',
  sessionPrompt: 'session:prompt',
  sessionDeepScan: 'session:deep-scan',
  sessionPlan: 'session:plan',
  sessionRetryStep: 'session:retry-step',
  sessionDiagnose: 'session:diagnose',
  promptEnhance: 'prompt:enhance',
  todosList: 'todos:list',
  visualSavePng: 'visual:save-png',
  todosSave: 'todos:save',
  todosNotify: 'todos:notify',
  todosFocus: 'todos:focus',
  sessionCompact: 'session:compact',
  skillsList: 'skills:list',
  mcpSave: 'mcp:save',
  mcpDelete: 'mcp:delete',
  mcpStatus: 'mcp:status',
  mcpPrompt: 'mcp:prompt',
  commandsList: 'commands:list',
  pluginsList: 'plugins:list',
  pluginInstallFolder: 'plugins:install-folder',
  pluginInstallGit: 'plugins:install-git',
  pluginSetEnabled: 'plugins:set-enabled',
  pluginDelete: 'plugins:delete',
  windowChrome: 'window:chrome',
  menuPopup: 'menu:popup',
  menuCommand: 'menu:command',
  browserBounds: 'browser:bounds',
  browserNavigate: 'browser:navigate',
  browserCommand: 'browser:command',
  browserTab: 'browser:tab',
  browserSetBackend: 'browser:set-backend',
  browserResume: 'browser:resume',
  browserFrame: 'browser:frame',
  browserStopRequest: 'browser:stop-request',
  browserBridgeStatus: 'browser:bridge-status',
  browserBridgeGetStatus: 'browser:bridge-get-status',
  browserBridgeTasks: 'browser:bridge-tasks',
  browserGetState: 'browser:get-state',
  browserState: 'browser:state',
  browserActivity: 'browser:activity',
  designBounds: 'design:bounds',
  designActivity: 'design:activity',
  designChanged: 'design:changed',
  designOpenFile: 'design:open-file',
  designSaveFile: 'design:save-file',
  sessionCancel: 'session:cancel',
  sessionUpdate: 'session:update',
  sessionPermission: 'session:permission',
  sessionPermissionRespond: 'session:permission-respond',
  sessionTaskAction: 'session:task-action',
  sessionTaskActionRespond: 'session:task-action-respond',
  checkpointPreview: 'session:checkpoint-preview',
  checkpointRestore: 'session:checkpoint-restore',
} as const

// 内置浏览器面板在窗口里的位置（CSS 像素，相对窗口内容区）
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

// 一个任务的浏览器：当前标签页的状态，还没打开过网页时 url 为空；tabs 是这个任务的所有标签页，activeTab 从 0 开始
export interface BrowserState {
  sessionId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabs: Array<{ title: string; url: string }>
  activeTab: number
  // 这个任务的智能体用哪个浏览器；用户的 Chrome、Edge 时 external 是扩展连没连上、用户有没有在浏览器里点过取消
  backend: AgentBrowser
  external: { connected: boolean; paused: string | null } | null
}

export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop' | 'external'

// 连着的 Diffra 浏览器扩展（每个浏览器的每个配置文件一条）
export interface BridgeStatus {
  connections: Array<{ id: number; browser: 'chrome' | 'edge' | 'chromium'; version: string; outdated: boolean }>
}

// 中文菜单里交给页面处理的命令
export type MenuCommand =
  | 'new-task'
  | 'open-project'
  | 'settings'
  | 'toggle-sidebar'
  | 'search'
  | 'terminal'
  | 'back'
  | 'forward'
  | 'check-updates'
  | 'about'
  | 'quick-todo'

export type CoreStatus =
  | { state: 'connected'; agentName: string; agentVersion: string; protocolVersion: number }
  | { state: 'failed'; error: string }

export type UpdateStatus =
  // 未打包运行（开发模式、e2e）时 electron-updater 不工作
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface ProjectState {
  path: string
  checks: SessionChecks
  readOnlyPaths: string[]
}

export interface SessionHandle {
  modelRef?: ModelRef
  sessionId: string
  info: SessionInfo
  // 这个会话用的模型，显示在输入框上
  modelLabel: string
  // 「规划」「兜底」角色的模型，显示在任务监控里；null 表示规划用编码模型、没有兜底
  planLabel: string | null
  fallbackLabel: string | null
  permissionMode: PermissionMode
  // 设计任务：任务页打开设计面板，画布占主区
  design: boolean
  // 任务的目录：项目任务就是项目，无项目任务是主进程在默认保存位置下替它建的文件夹
  cwd: string
  noProject: boolean
}

export interface SessionOptions {
  permissionMode?: PermissionMode
  model?: ModelRef
  design?: boolean
  // 设计任务的风格预设 id（DESIGN_STYLES）；不填是不用预设。只在新建设计任务时有效
  designStyle?: string
  // 任务标题，无项目任务用它给文件夹起名；只在新建时有效
  title?: string
}

// 无项目任务的文件夹：删除确认框据此决定怎么说。shared 是还有别的任务（含已归档）用着它或它下面的目录，只删记录；
// unknown 是任务记录不在索引里，不知道文件夹在哪，也只删记录
export type TaskFolderState = 'empty' | 'nonEmpty' | 'missing' | 'shared' | 'unknown'

// 删除任务后没动的文件夹：shared 是别的任务还在用，failed 是删除或移到回收站没成功；用户自己选了保留时为 null
export interface SessionDeleteResult {
  keptFolder: { path: string; reason: 'shared' | 'failed' } | null
}

// 新建任务失败的原因。ipcMain.handle 抛出的错误过 IPC 后只剩 message，所以原因写在 message 开头的「[code] 」里
export type StartTaskErrorCode = 'model-missing' | 'model-auth' | 'project-missing' | 'workspace-missing' | 'unknown'
const START_TASK_ERROR_CODES = ['model-missing', 'model-auth', 'project-missing', 'workspace-missing'] as const

export function encodeStartTaskError(code: (typeof START_TASK_ERROR_CODES)[number], message: string): string {
  return `[${code}] ${message}`
}

export function decodeStartTaskError(message: string): { code: StartTaskErrorCode; message: string } {
  const match = /^\[([a-z-]+)\] /.exec(message)
  const code = START_TASK_ERROR_CODES.find((item) => item === match?.[1])
  return match && code ? { code, message: message.slice(match[0].length) } : { code: 'unknown', message }
}

// 查哪些 MCP 服务器：某个任务用的，或者设置里开着的（projectPath 为 null 时在最近的项目或用户目录里启动，
// noProject 时在默认保存位置里启动）；也决定斜杠菜单列哪些 Skill 和命令
export type McpStatusTarget = { sessionId: string } | { projectPath: string | null } | { noProject: true }

// 这一轮带上的 Skill（按名字）；goal 为目标模式，没达成就自动接着做
export interface PromptOptions {
  skills: string[]
  goal: boolean
  images: PromptImage[]
}

// 打开历史任务时多带标题和每轮的记录
export interface LoadedSessionHandle extends SessionHandle {
  title: string
  turns: StoredTurn[]
  taskState?: TaskProgressView
}

// 任务之间互通：智能体要给别的任务发消息、新建任务，界面载入任务、起一轮后回复
export interface TaskActionEvent {
  requestId: string
  params: TaskActionParams
}

export interface PermissionRequestEvent {
  requestId: string
  sessionId: string
  toolCall: RequestPermissionRequest['toolCall']
  options: PermissionOption[]
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface DiffraApi {
  getCoreStatus(): Promise<CoreStatus>
  getAppVersion(): Promise<string>
  getUpdateStatus(): Promise<UpdateStatus>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  getSettings(): Promise<SettingsView>
  saveProvider(input: ProviderInput): Promise<SettingsView>
  deleteProvider(providerId: string): Promise<SettingsView>
  setRole(role: Role, ref: ModelRef | null): Promise<SettingsView>
  listProviderModels(providerId: string): Promise<ListModelsResult>
  testProviderModel(providerId: string, modelId: string): Promise<TestModelResult>
  validateProviderModel(input: ProviderInput, modelId: string): Promise<TestModelResult>
  pickProject(): Promise<ProjectState | null>
  getLastProject(): Promise<ProjectState | null>
  getProject(path: string): Promise<ProjectState>
  // 只读项目文件，识别可以用的检查命令；不保存
  detectChecks(path: string): Promise<CheckDetection>
  // 在项目目录试跑一条检查命令
  runCheck(path: string, command: string): Promise<CheckRunResult>
  saveProject(path: string, settings: { checks: SessionChecks; readOnlyPaths: string[] }): Promise<ProjectState>
  // projectPath 为 null 时建无项目任务
  createSession(projectPath: string | null, options?: SessionOptions): Promise<SessionHandle>
  // 返回新的模型名（换了模型时）
  configureSession(sessionId: string, options: SessionOptions): Promise<{ modelLabel: string | null }>
  rewindSession(sessionId: string, turnId: string): Promise<{ filesRestored: boolean }>
  checkpointDiff(sessionId: string, turnId: string): Promise<string>
  projectBranch(projectPath: string): Promise<string | null>
  openProjectFolder(projectPath: string): Promise<void>
  // 删除无项目任务前，看它的文件夹是空的、不空、已经不在，还是别的任务也在用
  taskFolderState(sessionId: string): Promise<TaskFolderState>
  describeAttachments(paths: string[]): Promise<FileReference[]>
  getPathForFile(file: File): string
  sessionsStorage(): Promise<{ bytes: number; dir: string }>
  usageSummary(query: UsageQuery): Promise<UsageSummary>
  // 在项目目录开一个终端；返回终端 id 和 shell 名
  createTerminal(cwd: string, size: TerminalSize): Promise<{ id: string; shell: string }>
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, size: TerminalSize): void
  killTerminal(id: string): Promise<void>
  onTerminalData(listener: (event: { id: string; data: string }) => void): () => void
  onTerminalExit(listener: (event: { id: string; exitCode: number }) => void): () => void
  // 主进程开的终端（智能体起的开发服务器），界面加一个标签页
  onTerminalOpened(listener: (event: { id: string; cwd: string; shell: string }) => void): () => void
  savePreferences(change: {
    appearance?: Appearance
    layout?: Layout
    browser?: BrowserSettings
    defaultPermissionMode?: PermissionMode
    security?: SecuritySettings
    execution?: ExecutionSettings
  }): Promise<SettingsView>
  // 无项目任务的默认保存位置：弹出文件夹选择框，取消时返回 null；恢复默认；在资源管理器里打开（还没建就先建）
  pickWorkspace(): Promise<SettingsView | null>
  resetWorkspace(): Promise<SettingsView>
  openWorkspace(): Promise<void>
  // 只打开 http(s) 链接
  openExternal(url: string): Promise<void>
  // 不给项目就列出所有项目的任务
  listSessions(projectPath: string | null): Promise<StoredSessionSummary[]>
  searchSessions(query: string): Promise<SessionSearchResult[]>
  loadSession(sessionId: string, projectPath: string): Promise<LoadedSessionHandle>
  updateSession(sessionId: string, change: { title?: string; archived?: boolean }): Promise<void>
  // trashFolder：无项目任务连文件夹一起移到回收站；项目任务忽略
  deleteSession(sessionId: string, options?: { trashFolder: boolean }): Promise<SessionDeleteResult>
  sendPrompt(sessionId: string, turnId: string, text: string, options: PromptOptions): Promise<StopReason>
  // 深度安全扫描作为一轮记进任务，像 sendPrompt 一样等它跑完
  deepScan(sessionId: string, turnId: string, scope: 'task' | 'project'): Promise<StopReason>
  // 先出计划：规划模型只读地出一份计划，作为一轮记进任务
  plan(sessionId: string, turnId: string, text: string, skills: string[]): Promise<StopReason>
  // 对话里的可视化另存为 PNG：截主窗口里 rect 这块（CSS 像素），弹保存框
  saveVisualPng(rect: { x: number; y: number; width: number; height: number }, title: string): Promise<void>
  // 待办：整份读、整份存
  listTodos(): Promise<Todo[]>
  saveTodos(todos: Todo[]): Promise<Todo[]>
  // 待办到时间的系统通知；点通知把窗口调到前面，onTodoFocus 收到这条待办的 id
  notifyTodo(notice: { todoId: string; title: string; body: string }): Promise<void>
  onTodoFocus(listener: (todoId: string) => void): () => void
  // 优化输入框里的提示词：用「规划」角色的模型，没配就用 model（输入框选的），再没有就用「编码」角色
  enhancePrompt(request: { text: string; project: string | null; sessionId: string | null; model?: ModelRef; mentions: string[]; design: boolean }): Promise<PromptEnhancement>
  // 定位问题：停下的那一轮（target.turnId），或其中一个子智能体（target.cardId 是它的卡片）
  diagnose(sessionId: string, turnId: string, text: string, target: { turnId: string; cardId: string | null }): Promise<StopReason>
  // 模型很久没有输出时让卡住的那一步重发；agent 是 main 或子智能体的 id
  retryStep(sessionId: string, agent: string): Promise<{ retried: boolean }>
  compactSession(sessionId: string, turnId: string): Promise<StopReason>
  // 项目、用户目录、插件和兼容的 Claude/Codex 目录里的 Skill，同名的只列优先的那个；任务里按建任务时开着的插件，首页按设置里开着的插件
  listSkills(target: McpStatusTarget): Promise<SkillInfo[]>
  saveMcpServer(input: McpServerInput): Promise<SettingsView>
  deleteMcpServer(serverId: string): Promise<SettingsView>
  // retry 为 true 时连不上的马上重连
  mcpStatus(target: McpStatusTarget, retry: boolean): Promise<McpServerStatus[]>
  // 把 MCP prompt 展开成文字
  mcpPrompt(target: McpStatusTarget, server: string, prompt: string, args: Record<string, string>): Promise<string>
  // 项目、用户目录、插件和兼容目录里的自定义命令；插件和 listSkills 一样按任务或设置
  listCommands(target: McpStatusTarget): Promise<CommandInfo[]>
  listPlugins(): Promise<PluginView[]>
  // 页面套用外观后告诉主进程顶栏颜色和深浅色：Windows 的窗口按钮和原生菜单跟着变
  setWindowChrome(chrome: { color: string; symbolColor: string; theme: Appearance['theme'] }): Promise<void>
  // 在窗口坐标 (x, y) 弹出主菜单
  popupMenu(position: { x: number; y: number }): Promise<void>
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  // 内置浏览器：面板位置（null 表示不显示）、用户在地址栏打开网页、前进后退刷新、标签页状态
  setBrowserBounds(sessionId: string, rect: BrowserRect | null): void
  browserNavigate(sessionId: string, url: string): Promise<void>
  browserCommand(sessionId: string, command: BrowserCommand): void
  // 面板上的标签条：切到、关闭第几个标签页（从 0 开始）
  browserTab(sessionId: string, op: 'select' | 'close', index: number): void
  // 给这个任务换浏览器：内置、用户的 Chrome 或 Edge
  browserSetBackend(sessionId: string, backend: AgentBrowser): void
  // 用户在浏览器的调试提示条上点了取消之后，在面板上点「继续」
  browserResume(sessionId: string): void
  // 用户 Chrome、Edge 里智能体那个标签页的画面（JPEG base64）
  onBrowserFrame(listener: (event: { sessionId: string; data: string }) => void): () => void
  // 用户在扩展里停下某个任务
  onBrowserStopRequest(listener: (event: { sessionId: string }) => void): () => void
  getBrowserBridgeStatus(): Promise<BridgeStatus>
  onBrowserBridgeStatus(listener: (status: BridgeStatus) => void): () => void
  // 扩展弹窗里「交给 Diffra」能选的任务
  setBrowserBridgeTasks(tasks: Array<{ sessionId: string; title: string; running: boolean }>): void
  getBrowserState(sessionId: string): Promise<BrowserState | null>
  onBrowserState(listener: (state: BrowserState) => void): () => void
  // 智能体在用某个任务的浏览器，界面把面板打开
  onBrowserActivity(listener: (event: { sessionId: string }) => void): () => void
  // 设计面板：位置（null 表示不显示，和浏览器共用矩形类型）、打开和保存 .fig；取消时返回 null，否则返回文件路径
  setDesignBounds(sessionId: string, rect: BrowserRect | null): void
  designOpenFile(sessionId: string): Promise<string | null>
  // 另存为 .fig，默认放在项目文件夹里
  designSaveFile(sessionId: string, projectPath: string): Promise<string | null>
  // 智能体在用某个任务的设计面板，界面把面板打开
  onDesignActivity(listener: (event: { sessionId: string }) => void): () => void
  // 弹出文件夹选择框；取消时返回 null
  installPluginFromFolder(): Promise<PluginView[] | null>
  installPluginFromGit(url: string): Promise<PluginView[]>
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginView[]>
  deletePlugin(pluginId: string): Promise<PluginView[]>
  cancelSession(sessionId: string): Promise<void>
  onSessionUpdate(listener: (notification: SessionNotification) => void): () => void
  onPermissionRequest(listener: (request: PermissionRequestEvent) => void): () => void
  respondPermission(requestId: string, optionId: string | null): Promise<void>
  onTaskAction(listener: (event: TaskActionEvent) => void): () => void
  respondTaskAction(requestId: string, result: TaskActionResult): Promise<void>
  previewCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
  restoreCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
}
