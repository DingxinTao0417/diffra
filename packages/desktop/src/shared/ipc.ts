import type {
  CheckDetection,
  CheckpointChange,
  CheckRunResult,
  CommandInfo,
  ListModelsResult,
  McpServerStatus,
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
  TaskProgressView,
  TestModelResult,
  UsageQuery,
  UsageSummary,
} from '@diffra/core/types'
import type {
  Appearance,
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
  openExternal: 'shell:open-external',
  sessionPrompt: 'session:prompt',
  sessionDeepScan: 'session:deep-scan',
  sessionPlan: 'session:plan',
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
  browserGetState: 'browser:get-state',
  browserState: 'browser:state',
  browserActivity: 'browser:activity',
  sessionCancel: 'session:cancel',
  sessionUpdate: 'session:update',
  sessionPermission: 'session:permission',
  sessionPermissionRespond: 'session:permission-respond',
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

// 一个任务的浏览器标签页；还没打开过网页时 url 为空
export interface BrowserState {
  sessionId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop' | 'external'

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
}

export interface SessionOptions {
  permissionMode?: PermissionMode
  model?: ModelRef
}

// 新建任务失败的原因。ipcMain.handle 抛出的错误过 IPC 后只剩 message，所以原因写在 message 开头的「[code] 」里
export type StartTaskErrorCode = 'model-missing' | 'model-auth' | 'project-missing' | 'unknown'
const START_TASK_ERROR_CODES = ['model-missing', 'model-auth', 'project-missing'] as const

export function encodeStartTaskError(code: (typeof START_TASK_ERROR_CODES)[number], message: string): string {
  return `[${code}] ${message}`
}

export function decodeStartTaskError(message: string): { code: StartTaskErrorCode; message: string } {
  const match = /^\[([a-z-]+)\] /.exec(message)
  const code = START_TASK_ERROR_CODES.find((item) => item === match?.[1])
  return match && code ? { code, message: message.slice(match[0].length) } : { code: 'unknown', message }
}

// 查哪些 MCP 服务器：某个任务用的，或者设置里开着的（projectPath 为 null 时在最近的项目或用户目录里启动）
export type McpStatusTarget = { sessionId: string } | { projectPath: string | null }

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
  createSession(projectPath: string, options?: SessionOptions): Promise<SessionHandle>
  // 返回新的模型名（换了模型时）
  configureSession(sessionId: string, options: SessionOptions): Promise<{ modelLabel: string | null }>
  rewindSession(sessionId: string, turnId: string): Promise<{ filesRestored: boolean }>
  checkpointDiff(sessionId: string, turnId: string): Promise<string>
  projectBranch(projectPath: string): Promise<string | null>
  openProjectFolder(projectPath: string): Promise<void>
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
    defaultPermissionMode?: PermissionMode
    security?: SecuritySettings
    execution?: ExecutionSettings
  }): Promise<SettingsView>
  // 只打开 http(s) 链接
  openExternal(url: string): Promise<void>
  // 不给项目就列出所有项目的任务
  listSessions(projectPath: string | null): Promise<StoredSessionSummary[]>
  searchSessions(query: string): Promise<SessionSearchResult[]>
  loadSession(sessionId: string, projectPath: string): Promise<LoadedSessionHandle>
  updateSession(sessionId: string, change: { title?: string; archived?: boolean }): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  sendPrompt(sessionId: string, turnId: string, text: string, options: PromptOptions): Promise<StopReason>
  // 深度安全扫描作为一轮记进任务，像 sendPrompt 一样等它跑完
  deepScan(sessionId: string, turnId: string, scope: 'task' | 'project'): Promise<StopReason>
  // 先出计划：规划模型只读地出一份计划，作为一轮记进任务
  plan(sessionId: string, turnId: string, text: string, skills: string[]): Promise<StopReason>
  compactSession(sessionId: string, turnId: string): Promise<StopReason>
  // 项目、用户目录和兼容的 Claude/Codex 目录里的 Skill，同名的只列优先的那个
  listSkills(projectPath: string): Promise<SkillInfo[]>
  saveMcpServer(input: McpServerInput): Promise<SettingsView>
  deleteMcpServer(serverId: string): Promise<SettingsView>
  // retry 为 true 时连不上的马上重连
  mcpStatus(target: McpStatusTarget, retry: boolean): Promise<McpServerStatus[]>
  // 把 MCP prompt 展开成文字
  mcpPrompt(target: McpStatusTarget, server: string, prompt: string, args: Record<string, string>): Promise<string>
  // 项目、用户目录、开着的插件和兼容目录里的自定义命令
  listCommands(projectPath: string): Promise<CommandInfo[]>
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
  getBrowserState(sessionId: string): Promise<BrowserState | null>
  onBrowserState(listener: (state: BrowserState) => void): () => void
  // 智能体在用某个任务的浏览器，界面把面板打开
  onBrowserActivity(listener: (event: { sessionId: string }) => void): () => void
  // 弹出文件夹选择框；取消时返回 null
  installPluginFromFolder(): Promise<PluginView[] | null>
  installPluginFromGit(url: string): Promise<PluginView[]>
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginView[]>
  deletePlugin(pluginId: string): Promise<PluginView[]>
  cancelSession(sessionId: string): Promise<void>
  onSessionUpdate(listener: (notification: SessionNotification) => void): () => void
  onPermissionRequest(listener: (request: PermissionRequestEvent) => void): () => void
  respondPermission(requestId: string, optionId: string | null): Promise<void>
  previewCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
  restoreCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
}
