import type {
  CandidateSpec,
  CheckDetection,
  CheckpointChange,
  CheckRunResult,
  CommandInfo,
  ExternalAgentDetection,
  ListModelsResult,
  LspServerStatus,
  McpServerStatus,
  PromptEnhancement,
  AskAnswer,
  PluginBlock,
  CommandRisk,
  PromptImage,
  ReasoningEffort,
  PermissionMode,
  PermissionOption,
  PluginInfo,
  RequestPermissionRequest,
  SessionAgentRef,
  SessionChecks,
  SessionSearchResult,
  SkillInfo,
  StoredSessionSummary,
  StoredTurn,
  SessionInfo,
  SessionNotification,
  SessionProcesses,
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
  ComputerAuditEntry,
  ComputerStatus,
  ComputerUseSettings,
  SystemSettings,
  ExecutionSettings,
  McpServerInput,
  ModelRef,
  PluginView,
  ProjectHooks,
  ProviderInput,
  Role,
  SecuritySettings,
  SettingsView,
} from './settings'
import type { FileReference } from './attachments'
import type { ExternalAgentDiscovery, ExternalAgentInput } from './external-agents'
import type { RemoteResumed, RemoteSnapshotPage, RemoteToolOutput, RequestCall, SessionList } from '@diffra/remote/messages'
import type { RemoteAction, RemoteActionResult, RemoteAddResult, RemoteAuditEntry, RemoteProjectGrant, RemoteSyncEvent, RemoteTaskCall, RemoteTaskCallResult, RemoteView } from './remote'
import type { ChangelogRelease } from './changelog'
import type { CatalogView, PrerequisiteState } from './extensions'
import type { Todo } from './todos'
import type { AnalysisProgress, ArchitectureBundle, ArchitectureEvent, ArchitectureLayout, ArchitectureProject, ArchitectureProjectSummary, BlockDiagram, FlowChart, InterpretPart, ModuleNote, SharedStatus, TargetArchitecture } from '@diffra/core/architecture'

export const IPC_CHANNELS = {
  coreStatus: 'core:status',
  appVersion: 'app:version',
  updateStatus: 'update:status',
  updateStatusChanged: 'update:status-changed',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  changelogGet: 'changelog:get',
  changelogUpdateNotice: 'changelog:update-notice',
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
  projectArchive: 'project:archive',
  projectDelete: 'project:delete',
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
  projectBranches: 'project:branches',
  projectSwitchBranch: 'project:switch-branch',
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
  terminalUrl: 'terminal:url',
  fileResolve: 'file:resolve',
  filePick: 'file:pick',
  fileRead: 'file:read',
  fileReadImage: 'file:read-image',
  fileWrite: 'file:write',
  fileOpen: 'file:open',
  fileReveal: 'file:reveal',
  preferencesSave: 'settings:preferences-save',
  workspacePick: 'settings:workspace-pick',
  workspaceReset: 'settings:workspace-reset',
  workspaceOpen: 'settings:workspace-open',
  openExternal: 'shell:open-external',
  sessionPrompt: 'session:prompt',
  sessionDeepScan: 'session:deep-scan',
  sessionPlan: 'session:plan',
  sessionRetryStep: 'session:retry-step',
  sessionVisualSnapshot: 'session:visual-snapshot',
  sessionUseVersion: 'session:use-version',
  sessionBlocks: 'session:blocks',
  commandRisk: 'command:risk',
  sessionApplyDiff: 'session:apply-diff',
  sessionProcesses: 'session:processes',
  sessionProcessStop: 'session:process-stop',
  sessionLspStatus: 'session:lsp-status',
  sessionLspControl: 'session:lsp-control',
  sessionProcessOutput: 'session:process-output',
  sessionDiagnose: 'session:diagnose',
  promptEnhance: 'prompt:enhance',
  todosList: 'todos:list',
  visualSavePng: 'visual:save-png',
  visualCapture: 'visual:capture',
  exportDocument: 'export:document',
  shareTurns: 'export:share-turns',
  todosSave: 'todos:save',
  todosNotify: 'todos:notify',
  todosFocus: 'todos:focus',
  todosChanged: 'todos:changed',
  todosSaveImage: 'todos:save-image',
  todosReadImage: 'todos:read-image',
  architectureList: 'architecture:list',
  architectureAdd: 'architecture:add',
  architecturePick: 'architecture:pick',
  architectureRemove: 'architecture:remove',
  architectureAnalyze: 'architecture:analyze',
  architectureCancel: 'architecture:cancel',
  architectureRunning: 'architecture:running',
  architectureBundle: 'architecture:bundle',
  architectureStale: 'architecture:stale',
  architectureWatch: 'architecture:watch',
  architectureExport: 'architecture:export',
  architectureTrace: 'architecture:trace',
  architectureTraceCommand: 'architecture:trace-command',
  architectureShared: 'architecture:shared',
  architectureImport: 'architecture:import',
  architectureInterpret: 'architecture:interpret',
  architectureInterpretModule: 'architecture:interpret-module',
  architectureFlowChart: 'architecture:flow-chart',
  architectureProposeTarget: 'architecture:propose-target',
  architectureSaveTarget: 'architecture:save-target',
  architectureSaveLayout: 'architecture:save-layout',
  architectureSaveDiagram: 'architecture:save-diagram',
  architectureSource: 'architecture:source',
  architectureOpenFile: 'architecture:open-file',
  architectureEvent: 'architecture:event',
  sessionCompact: 'session:compact',
  skillsList: 'skills:list',
  mcpSave: 'mcp:save',
  mcpDelete: 'mcp:delete',
  mcpOAuthLogin: 'mcp:oauth-login',
  mcpOAuthCancel: 'mcp:oauth-cancel',
  mcpOAuthLogout: 'mcp:oauth-logout',
  externalAgentDiscover: 'external-agent:discover',
  externalAgentSave: 'external-agent:save',
  externalAgentDelete: 'external-agent:delete',
  externalAgentDetect: 'external-agent:detect',
  candidatesGenerate: 'candidates:generate',
  candidateDiff: 'candidates:diff',
  candidateApply: 'candidates:apply',
  candidatesDiscard: 'candidates:discard',
  mcpStatus: 'mcp:status',
  mcpPrompt: 'mcp:prompt',
  commandsList: 'commands:list',
  pluginsList: 'plugins:list',
  pluginPrepare: 'plugins:prepare',
  pluginCommit: 'plugins:commit',
  pluginDiscard: 'plugins:discard',
  pluginSetEnabled: 'plugins:set-enabled',
  pluginSetHooks: 'plugins:set-hooks',
  pluginDelete: 'plugins:delete',
  pluginCheckUpdates: 'plugins:check-updates',
  pluginPrepareUpdate: 'plugins:prepare-update',
  pluginCommitUpdate: 'plugins:commit-update',
  extensionInstallMcp: 'extensions:install-mcp',
  extensionPrerequisites: 'extensions:prerequisites',
  extensionCatalog: 'extensions:catalog',
  windowChrome: 'window:chrome',
  menuPopup: 'menu:popup',
  menuCommand: 'menu:command',
  windowFullScreen: 'window:full-screen',
  rendererError: 'renderer:error',
  browserBounds: 'browser:bounds',
  browserNavigate: 'browser:navigate',
  browserCommand: 'browser:command',
  browserTab: 'browser:tab',
  browserSetBackend: 'browser:set-backend',
  browserResume: 'browser:resume',
  browserDevTools: 'browser:devtools',
  computerStatus: 'computer:status',
  computerAudit: 'computer:audit',
  computerAuditClear: 'computer:audit-clear',
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
  sessionPermissionSettled: 'session:permission-settled',
  sessionTaskAction: 'session:task-action',
  sessionTaskActionRespond: 'session:task-action-respond',
  checkpointPreview: 'session:checkpoint-preview',
  checkpointRestore: 'session:checkpoint-restore',
  remoteGetState: 'remote:get-state',
  remoteState: 'remote:state',
  remoteSetAllowIncoming: 'remote:set-allow-incoming',
  remoteSetName: 'remote:set-name',
  remoteCreateInvite: 'remote:create-invite',
  remoteCancelInvite: 'remote:cancel-invite',
  remoteRespond: 'remote:respond',
  remoteUpdateGrant: 'remote:update-grant',
  remoteRevoke: 'remote:revoke',
  remoteAddDevice: 'remote:add-device',
  remoteAddLanDevice: 'remote:add-lan-device',
  remoteBrowse: 'remote:browse',
  remoteSetPeerTodos: 'remote:set-peer-todos',
  remoteCancelAdd: 'remote:cancel-add',
  remoteRemovePeer: 'remote:remove-peer',
  remoteResetIdentity: 'remote:reset-identity',
  remoteAudit: 'remote:audit',
  remoteList: 'remote:list',
  remoteSubscribe: 'remote:subscribe',
  remotePage: 'remote:page',
  remoteToolOutput: 'remote:tool-output',
  remoteUnsubscribe: 'remote:unsubscribe',
  remoteEvent: 'remote:event',
  remotePrompt: 'remote:prompt',
  remoteCreate: 'remote:create',
  remoteCancel: 'remote:cancel',
  remotePermission: 'remote:permission',
  remoteAction: 'remote:action',
  remoteActionRespond: 'remote:action-respond',
  remoteTaskCall: 'remote:task-call',
  remoteTaskCallRespond: 'remote:task-call-respond',
  remoteCall: 'remote:call',
  remoteCompress: 'remote:compress',
  remoteCompressRespond: 'remote:compress-respond',
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
  // direct：Chrome 是直接启动的系统 Chrome（v2，不经扩展），没在跑时智能体一用就自动启动
  external: { connected: boolean; paused: string | null; direct?: boolean } | null
}

export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop' | 'external'

// 连着的 Diffra 浏览器扩展（每个浏览器的每个配置文件一条）
export interface BridgeStatus {
  connections: Array<{ id: number; browser: 'chrome' | 'edge' | 'chromium'; version: string; outdated: boolean }>
  // 直接启动的系统 Chrome（v2）；旧的状态里没有
  direct?: DirectChromeStatus
}

// 系统 Chrome：找到的程序、在不在跑、上次没启动起来的原因；supported 为假是这个系统（Linux）不支持
export interface DirectChromeStatus {
  supported: boolean
  executable: string | null
  name: string | null
  running: boolean
  error: string | null
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

// 回答里提到的、在项目里的文件（第 535 步）：path 是完整路径，relative 是相对项目的路径（用 /）
export interface ProjectFile {
  path: string
  relative: string
}

// 智能体起的开发服务器在主进程开的终端（第 527 步）
export interface TerminalOpenedEvent {
  id: string
  cwd: string
  shell: string
  devServer: { sessionId: string; command: string }
}

export type CoreStatus =
  | { state: 'connected'; agentName: string; agentVersion: string; protocolVersion: number }
  | { state: 'failed'; error: string }

// 新版本的说明从更新包的 latest.yml 来（旧客户端里没有新版本的日志）；没写的话是 null
export type UpdateNotes = { added: string[]; fixed: string[] } | null

export type UpdateStatus =
  // 不检查更新：未打包运行（开发模式、e2e），或者是没经过安装的免安装版（更新包只会装到已安装的那份，换不掉它自己）
  | { state: 'disabled'; reason: 'development' | 'portable' | 'mac-preview' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date' }
  | { state: 'downloading'; version: string; percent: number; notes: UpdateNotes }
  | { state: 'downloaded'; version: string; notes: UpdateNotes }
  | { state: 'error'; message: string }

// from 为 null：升级前的版本还不记版本号，不知道从哪升上来的
export interface UpdateNotice {
  from: string | null
  to: string
}

export interface ProjectState {
  path: string
  checks: SessionChecks
  readOnlyPaths: string[]
  // 在这个项目里选过「始终允许同类命令」的命令键
  allowedCommands: string[]
  hooks: ProjectHooks
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
  // 外接智能体的任务（v2）：用它自己的模型，modelLabel 是它的名字
  agent?: SessionAgentRef
}

export interface SessionOptions {
  permissionMode?: PermissionMode
  model?: ModelRef
  // 外接智能体的 id（设置里的 ExternalAgentConfig.id）；给了就不用 model，只在新建时有效
  agent?: string
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

// 插件从哪里装：选一个文件夹、Git 地址（可以带仓库里的子目录）、内置目录里的一项
export type PluginSource = { kind: 'folder' } | { kind: 'git'; url: string; subdir: string } | { kind: 'catalog'; id: string }

// 取回、读过还没装的插件，给用户看过再装；token 用来确认或放弃。location 是文件夹路径，或 Git 地址和子目录
export interface PluginPrepared {
  token: string
  info: PluginInfo
  source: 'folder' | 'git'
  location: string
}

// 从 Git 装的插件有没有新版本（v2）：比本机克隆的提交和远端默认分支的提交
export interface PluginUpdateCheck {
  pluginId: string
  state: 'latest' | 'available' | 'error'
  current: string | null
  latest: string | null
  error: string | null
}

// 取回的新版本，换上之前给用户看：版本、提交、改了哪些文件、钩子变没变
export interface PluginUpdatePrepared {
  token: string
  pluginId: string
  info: PluginInfo
  fromVersion: string | null
  fromCommit: string | null
  toCommit: string | null
  added: string[]
  removed: string[]
  modified: string[]
  // 改动的文件太多，上面只列了一部分
  truncated: boolean
  // none：新版本没有钩子；same：和允许时一样，照旧允许；changed：新的或变了的钩子，要重新允许才跑
  hooks: 'none' | 'same' | 'changed'
}

// 这一轮带上的 Skill（按名字）；goal 为目标模式，没达成就自动接着做
export interface PromptOptions {
  skills: string[]
  goal: boolean
  images: PromptImage[]
  // 计划卡片上点「按计划执行」：出计划那一轮的 id 和计划的步骤（v2，计划逐步打勾）
  fromPlan?: { turnId: string; steps: string[] }
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
  // 运行的系统（process.platform）：Mac 上顶栏给红绿灯留位置、快捷键显示成 ⌘
  platform: string
  getCoreStatus(): Promise<CoreStatus>
  getAppVersion(): Promise<string>
  getUpdateStatus(): Promise<UpdateStatus>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  // 这个版本带的更新日志（新的在前）
  getChangelog(): Promise<ChangelogRelease[]>
  // 升级后第一次启动：从哪个版本升上来的；只给一次，之后是 null
  takeUpdateNotice(): Promise<UpdateNotice | null>
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
  // 项目归档：项目下的会话一起归档；恢复时一起取消归档
  setProjectArchived(projectPath: string, archived: boolean): Promise<void>
  // 永久删除项目记录和项目下的会话记录，不动磁盘上的项目文件夹；返回删掉的会话 id
  deleteProject(projectPath: string): Promise<{ sessionIds: string[] }>
  // 只读项目文件，识别可以用的检查命令；不保存
  detectChecks(path: string): Promise<CheckDetection>
  // 在项目目录试跑一条检查命令
  runCheck(path: string, command: string): Promise<CheckRunResult>
  saveProject(path: string, settings: { checks: SessionChecks; readOnlyPaths: string[]; allowedCommands?: string[]; hooks?: ProjectHooks }): Promise<ProjectState>
  // projectPath 为 null 时建无项目任务
  createSession(projectPath: string | null, options?: SessionOptions): Promise<SessionHandle>
  // 返回新的模型名（换了模型时）
  configureSession(sessionId: string, options: SessionOptions): Promise<{ modelLabel: string | null }>
  // edited：撤掉的这一轮改没改过文件（重新生成后它留成「上一次」，改过的换不回来）
  rewindSession(sessionId: string, turnId: string): Promise<{ filesRestored: boolean; edited: boolean }>
  checkpointDiff(sessionId: string, turnId: string): Promise<string>
  projectBranch(projectPath: string): Promise<string | null>
  // 本地分支和当前分支；切换前检查有没有任务在跑、工作区有没有未提交的改动
  projectBranches(projectPath: string): Promise<{ current: string | null; branches: string[] }>
  switchProjectBranch(projectPath: string, branch: string): Promise<void>
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
  // 主进程开的终端（智能体起的开发服务器），界面在后台加一个标签页，不打开终端面板
  onTerminalOpened(listener: (event: TerminalOpenedEvent) => void): () => void
  // 开发服务器的输出里第一次出现本地地址
  onTerminalUrl(listener: (event: { id: string; url: string }) => void): () => void
  // 回答里提到的文件：哪些在项目里（不在的是 null）、读出来（最多 1 MB）、用默认应用打开、在资源管理器里显示
  resolveFiles(project: string, paths: string[]): Promise<Record<string, ProjectFile | null>>
  // 提问里的「选文件」（第 673 步）：系统选择框，只收项目里的文件（相对路径），项目外的只给个数
  pickProjectFiles(project: string, multiple: boolean): Promise<{ files: string[]; outside: number }>
  readFile(project: string, path: string): Promise<{ text: string; binary: boolean; truncated: boolean; version: string }>
  // 回答里引用的项目图片（主窗口的 CSP 只放行 data:，按 base64 取）：只认常见图片扩展名，最大 8 MB
  readImage(project: string, path: string): Promise<{ mimeType: string; data: string }>
  // 文件面板保存（第 546 步）：version 对不上（读出来之后外面改过）时不写、saved 为 false；version 传 null 是覆盖
  writeFile(project: string, path: string, text: string, version: string | null): Promise<{ saved: true; version: string } | { saved: false }>
  openFile(project: string, path: string): Promise<void>
  revealFile(project: string, path: string): Promise<void>
  savePreferences(change: {
    appearance?: Appearance
    layout?: Layout
    browser?: BrowserSettings
    defaultPermissionMode?: PermissionMode
    security?: SecuritySettings
    execution?: ExecutionSettings
    // 电脑操控（v2）：开了对新任务生效，关掉马上生效
    computerUse?: ComputerUseSettings
    // 托盘和开机自启（v2），马上生效
    system?: SystemSettings
    // 输入框里给这个模型选了思考程度，记下来
    reasoningChoice?: { providerId: string; modelId: string; effort: ReasoningEffort }
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
  // 导出 PDF、图片（第 678 步）：主进程在看不见的窗口里打开这份静态 HTML 打印或截图，先弹保存框；太长的图片只存前面一部分（truncated）
  exportDocument(html: string, format: 'pdf' | 'png', name: string): Promise<{ saved: boolean; truncated?: boolean }>
  // 分享版（第 679 步）：这几轮（null 是整个任务）按发给远程设备一样的规则脱敏后的记录
  shareTurns(sessionId: string, turnIds: string[] | null): Promise<{ title: string; turns: StoredTurn[] }>
  // 可视化的快照（第 670 步）：截主窗口里 rect 这块成 PNG；窗口没显示出来、截到空图时是 null
  captureVisual(rect: { x: number; y: number; width: number; height: number }): Promise<PromptImage | null>
  // 直接应用回答里的 diff（第 686 步），记成一轮 apply
  applyDiff(sessionId: string, turnId: string, prompt: string, diff: string): Promise<StopReason>
  // 回答里的命令打进终端之前看风险（第 687 步）
  commandRisk(command: string): Promise<CommandRisk>
  // 这个任务开着的插件注册的富块（第 682 步）
  sessionBlocks(sessionId: string): Promise<{ blocks: PluginBlock[] }>
  // 换回重新生成之前的那一次（第 676 步）：index 是这一轮 versions 里的位置
  useTurnVersion(sessionId: string, turnId: string, index: number): Promise<{ filesRestored: boolean }>
  // 压好的快照记回会话那张可视化卡（toolCallId）；已经有了的不记
  recordVisualSnapshot(sessionId: string, toolCallId: string, image: PromptImage): Promise<{ recorded: boolean }>
  // 待办：整份读、整份存
  listTodos(): Promise<Todo[]>
  // base：改之前界面手里有哪些待办（主进程据此分清界面删掉的和同步进来的，v2）
  saveTodos(todos: Todo[], base?: string[]): Promise<Todo[]>
  // 主进程合进了别的设备同步来的待办（v2）：界面换上这一份
  onTodosChanged(listener: (todos: Todo[]) => void): () => void
  // 待办到时间的系统通知；点通知把窗口调到前面，onTodoFocus 收到这条待办的 id
  notifyTodo(notice: { todoId: string; title: string; body: string }): Promise<void>
  onTodoFocus(listener: (todoId: string) => void): () => void
  // 待办附件里的图片：存成数据目录里的文件，返回 id；按 id 读回来显示或派给任务
  saveTodoImage(image: PromptImage): Promise<string>
  readTodoImage(id: string): Promise<PromptImage>
  // 架构：项目列表、后台分析（进度和结束走 onArchitectureEvent）、读结果、模型解读（用「规划」角色，没配用「编码」）、目标架构
  listArchitectureProjects(): Promise<ArchitectureProjectSummary[]>
  addArchitectureProject(path: string): Promise<ArchitectureProject>
  // 弹选文件夹的窗口并加进列表；取消时返回 null
  pickArchitectureProject(): Promise<ArchitectureProject | null>
  removeArchitectureProject(projectId: string): Promise<void>
  analyzeArchitecture(projectId: string): Promise<void>
  cancelArchitecture(projectId: string): Promise<void>
  runningArchitecture(): Promise<AnalysisProgress[]>
  getArchitecture(projectId: string): Promise<ArchitectureBundle>
  isArchitectureStale(projectId: string): Promise<boolean | null>
  // 打开着项目时监听文件变化（v2）：代码改了推 ArchitectureEvent.stale；auto 时改动停下后自动重新分析
  watchArchitecture(projectId: string, watch: boolean, auto: boolean): Promise<void>
  // 架构定义放进仓库（v2）：导出到项目的 .diffra/，看仓库里那份的状态，用仓库里的换掉本机的
  exportArchitecture(projectId: string): Promise<{ files: string[] }>
  // 运行时追踪（v2）：在后台跑一条命令，进度和结束走 onArchitectureEvent；默认命令（有 test 脚本就跑测试）
  traceArchitecture(projectId: string, command: string, timeoutSeconds: number): Promise<void>
  architectureTraceCommand(projectId: string): Promise<string>
  sharedArchitecture(projectId: string): Promise<SharedStatus>
  importArchitecture(projectId: string): Promise<void>
  // parts：要模型做哪几样（系统简介和流程、三张架构图），并行跑
  interpretArchitecture(projectId: string, parts: InterpretPart[]): Promise<void>
  saveArchitectureDiagram(projectId: string, diagram: BlockDiagram): Promise<void>
  interpretArchitectureModule(projectId: string, path: string): Promise<ModuleNote>
  // 让模型读这条流程经过的代码画流程图，存进解读结果
  drawArchitectureFlowChart(projectId: string, flow: string): Promise<FlowChart>
  proposeTargetArchitecture(projectId: string, principles: string): Promise<{ target: TargetArchitecture; rationale: string }>
  saveTargetArchitecture(projectId: string, target: TargetArchitecture | null): Promise<void>
  saveArchitectureLayout(projectId: string, layout: ArchitectureLayout): Promise<void>
  readArchitectureSource(projectId: string, path: string): Promise<{ text: string; lines: number }>
  // 用系统默认程序打开项目里的一个文件
  openArchitectureFile(projectId: string, path: string): Promise<void>
  onArchitectureEvent(listener: (event: ArchitectureEvent) => void): () => void
  // 优化输入框里的提示词：用「规划」角色的模型，没配就用 model（输入框选的），再没有就用「编码」角色
  enhancePrompt(request: { text: string; project: string | null; sessionId: string | null; model?: ModelRef; mentions: string[]; design: boolean }): Promise<PromptEnhancement>
  // 定位问题：停下的那一轮（target.turnId），或其中一个子智能体（target.cardId 是它的卡片）
  diagnose(sessionId: string, turnId: string, text: string, target: { turnId: string; cardId: string | null }): Promise<StopReason>
  // 模型很久没有输出时让卡住的那一步重发；agent 是 main 或子智能体的 id
  retryStep(sessionId: string, agent: string): Promise<{ retried: boolean }>
  // 智能体转到后台的命令：列表变化、停止、最近的输出（任务监控「运行中」）
  onSessionProcesses(listener: (event: SessionProcesses) => void): () => void
  stopProcess(sessionId: string, id: number): Promise<{ stopped: boolean }>
  // 插件的语言服务器（v2）：这个任务用到的服务器的状态和诊断；启动、停止、重启
  lspStatus(sessionId: string): Promise<LspServerStatus[]>
  controlLsp(sessionId: string, server: string, action: 'start' | 'stop' | 'restart'): Promise<LspServerStatus[]>
  processOutput(sessionId: string, id: number): Promise<{ text: string; running: boolean }>
  compactSession(sessionId: string, turnId: string): Promise<StopReason>
  // 项目、用户目录、插件和兼容的 Claude/Codex 目录里的 Skill，同名的只列优先的那个；任务里按建任务时开着的插件，首页按设置里开着的插件
  listSkills(target: McpStatusTarget): Promise<SkillInfo[]>
  saveMcpServer(input: McpServerInput): Promise<SettingsView>
  deleteMcpServer(serverId: string): Promise<SettingsView>
  // 浏览器登录的 MCP 服务器（v2）：用系统浏览器登录（等用户在浏览器里同意，最多 5 分钟）、取消等待、退出登录（撤销令牌）
  loginMcpServer(serverId: string): Promise<SettingsView>
  cancelMcpLogin(serverId: string): Promise<void>
  logoutMcpServer(serverId: string): Promise<SettingsView>
  // 多候选方案（v2）：生成（像出计划一样记成一轮，等它跑完）、看某个候选的改动、应用一个（记成一轮 apply）、全部放弃
  generateCandidates(sessionId: string, turnId: string, params: { title: string; request: string; plan: string | null; candidates: CandidateSpec[] }): Promise<StopReason>
  candidateDiff(sessionId: string, runTurnId: string, candidateId: string): Promise<string>
  applyCandidate(sessionId: string, turnId: string, params: { title: string; runTurnId: string; candidateId: string }): Promise<StopReason>
  discardCandidates(sessionId: string, runTurnId: string): Promise<void>
  // 外接智能体：本机找预设要的命令、保存、删除、检测（起进程握手一次，第一次用 npx 可能要等下载）
  discoverExternalAgents(): Promise<ExternalAgentDiscovery[]>
  saveExternalAgent(input: ExternalAgentInput): Promise<SettingsView>
  deleteExternalAgent(agentId: string): Promise<SettingsView>
  detectExternalAgent(input: ExternalAgentInput): Promise<ExternalAgentDetection>
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
  // 窗口进出全屏（Mac 全屏时没有红绿灯，顶栏不用再留位置）
  isFullScreen(): Promise<boolean>
  onFullScreenChange(listener: (fullScreen: boolean) => void): () => void
  // 界面里没接住的错误，记到 logs/renderer.log
  logRendererError(message: string): void
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
  // 当前标签页的开发者工具（v2）：内置浏览器单独开窗口，直接启动的 Chrome 在那里开检查器
  browserDevTools(sessionId: string): Promise<void>
  // 电脑操控（v2）：这台电脑支不支持；最近的操作记录（新的在前）；清空记录
  computerStatus(): Promise<ComputerStatus>
  computerAudit(): Promise<ComputerAuditEntry[]>
  clearComputerAudit(): Promise<void>
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
  // 装插件第一步：取回并读出内容（从文件夹装时弹出选择框，取消时返回 null）；第二步用户看过后确认，allowHooks 是允许它的钩子；不装了就放弃
  preparePlugin(source: PluginSource): Promise<PluginPrepared | null>
  commitPlugin(token: string, allowHooks: boolean): Promise<PluginView[]>
  discardPlugin(token: string): Promise<void>
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginView[]>
  setPluginHooks(pluginId: string, allowed: boolean): Promise<PluginView[]>
  deletePlugin(pluginId: string): Promise<PluginView[]>
  // 插件更新（v2）：查哪些从 Git 装的插件有新版本；取回新版本给用户看（取消用 discardPlugin）；换上，失败恢复原来的
  checkPluginUpdates(): Promise<PluginUpdateCheck[]>
  preparePluginUpdate(pluginId: string): Promise<PluginUpdatePrepared>
  commitPluginUpdate(token: string, allowHooks: boolean): Promise<PluginView[]>
  // 扩展目录里的 MCP 服务一键装：先连一次，连上了才保存；key 是用户填的 Token，没有就是 null
  installCatalogMcp(catalogId: string, key: string | null): Promise<SettingsView>
  // 本机有没有 npx、uvx、docker、railway 这些命令
  extensionPrerequisites(): Promise<PrerequisiteState>
  // 扩展目录（v2 联网更新）：cached 不联网，check 一小时内查过就不查，force 现在查
  extensionCatalog(mode: 'cached' | 'check' | 'force'): Promise<CatalogView>
  cancelSession(sessionId: string): Promise<void>
  onSessionUpdate(listener: (notification: SessionNotification) => void): () => void
  onPermissionRequest(listener: (request: PermissionRequestEvent) => void): () => void
  // answers：提问（ask_user）提交的答案，按问题的顺序（第 673 步）
  respondPermission(requestId: string, optionId: string | null, answers?: AskAnswer[]): Promise<void>
  // 权限请求答完了（可能是远程设备答的）：界面收起这张确认卡片
  onPermissionSettled(listener: (event: { requestId: string; sessionId: string }) => void): () => void
  onTaskAction(listener: (event: TaskActionEvent) => void): () => void
  respondTaskAction(requestId: string, result: TaskActionResult): Promise<void>
  previewCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
  restoreCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
  // 设备连接（见 shared/remote.ts）：状态变了主进程推 onRemoteState
  getRemoteState(): Promise<RemoteView>
  onRemoteState(listener: (view: RemoteView) => void): () => void
  setRemoteAllowIncoming(enabled: boolean): Promise<void>
  setRemoteName(name: string): Promise<void>
  createRemoteInvite(): Promise<void>
  cancelRemoteInvite(): Promise<void>
  // 本机的人对配对请求点了允许或拒绝；允许时带上开放哪些项目
  // todos：允许它同步待办（v2）
  respondRemoteRequest(deviceId: string, approved: boolean, projects: RemoteProjectGrant[], todos?: boolean): Promise<void>
  updateRemoteGrant(deviceId: string, projects: RemoteProjectGrant[], todos?: boolean): Promise<void>
  // 和本机去连的这台设备同步待办（v2，对方也要允许）
  setRemotePeerTodos(deviceId: string, enabled: boolean): Promise<void>
  revokeRemoteDevice(deviceId: string): Promise<void>
  // 粘贴邀请串添加设备：对方点了允许或拒绝、或者出错才返回
  addRemoteDevice(invite: string, name: string | null): Promise<RemoteAddResult>
  // 局域网版（v2）：在局域网里看到的设备上输入它的 6 位配对码
  addRemoteLanDevice(deviceId: string, code: string, name: string | null): Promise<RemoteAddResult>
  // 「添加设备」开着时找局域网里的设备
  browseRemoteDevices(on: boolean): Promise<void>
  cancelAddRemoteDevice(): Promise<void>
  removeRemotePeer(deviceId: string): Promise<void>
  resetRemoteIdentity(): Promise<void>
  getRemoteAudit(): Promise<RemoteAuditEntry[]>
  // 看自己连接的设备授权给本机的会话：列表、订阅（回一页快照，之后经 onRemoteEvent 推实时动静）、往前翻页、退订
  listRemoteSessions(deviceId: string): Promise<SessionList>
  // resume：断线前看到的位置（core 的 epoch 和 seq），对方接得上时回 resumed、之后补发缺的
  subscribeRemoteSession(deviceId: string, sessionId: string, resume?: { epoch: string; seq: number }): Promise<RemoteSnapshotPage | RemoteResumed>
  pageRemoteSession(deviceId: string, sessionId: string, before: number): Promise<RemoteSnapshotPage>
  // 展开只同步了开头的工具输出：turn 是这一轮在对方全部轮次里的位置
  remoteToolOutput(deviceId: string, sessionId: string, turn: number, turnId: string, toolCallId: string): Promise<RemoteToolOutput>
  unsubscribeRemoteSession(deviceId: string, sessionId: string): Promise<void>
  onRemoteEvent(listener: (event: RemoteSyncEvent) => void): () => void
  // 操作对方授权给本机「可查看和操作」的会话：发消息（对方在跑时排队）、在开放的项目里新建任务、停止、回答对方的权限请求
  promptRemoteSession(deviceId: string, sessionId: string, text: string): Promise<{ queued: boolean }>
  createRemoteSession(deviceId: string, projectId: string, text: string): Promise<{ sessionId: string }>
  cancelRemoteSession(deviceId: string, sessionId: string): Promise<void>
  // 提问（ask_user）的选项、提交、不答也走这里，提交时带答案
  respondRemotePermission(deviceId: string, requestId: string, optionId: string, answers?: AskAnswer[]): Promise<void>
  // 本机是被连接端：远程设备的操作交给界面做（同任务互通），做完回结果
  onRemoteAction(listener: (event: { requestId: string; action: RemoteAction }) => void): () => void
  respondRemoteAction(requestId: string, result: RemoteActionResult): Promise<void>
  onRemoteTaskCall(listener: (event: { requestId: string; call: RemoteTaskCall }) => void): () => void
  respondRemoteTaskCall(requestId: string, result: RemoteTaskCallResult): Promise<void>
  // 连接端：向对方发请求（新加的请求都走这里，主进程按协议校验请求和回复）
  remoteCall(deviceId: string, call: RequestCall): Promise<unknown>
  // 本机是被连接端：把提问图片压成发给远程的小图，压不了的回 null
  onRemoteCompress(listener: (event: { requestId: string; images: PromptImage[] }) => void): () => void
  respondRemoteCompress(requestId: string, result: Array<PromptImage | null>): Promise<void>
}
