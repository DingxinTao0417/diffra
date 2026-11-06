import type {
  CheckpointChange,
  ListModelsResult,
  PermissionOption,
  RequestPermissionRequest,
  SessionChecks,
  SessionInfo,
  SessionNotification,
  StopReason,
  TestModelResult,
} from '@diffra/core/types'
import type { ModelRef, ProviderInput, Role, SettingsView } from './settings'

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
  projectPick: 'project:pick',
  projectLast: 'project:last',
  projectSave: 'project:save',
  sessionCreate: 'session:create',
  sessionPrompt: 'session:prompt',
  sessionCancel: 'session:cancel',
  sessionUpdate: 'session:update',
  sessionPermission: 'session:permission',
  sessionPermissionRespond: 'session:permission-respond',
  checkpointPreview: 'session:checkpoint-preview',
  checkpointRestore: 'session:checkpoint-restore',
} as const

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
  sessionId: string
  info: SessionInfo
  // 编码角色用的模型，显示在会话页上
  modelLabel: string
}

export interface PermissionRequestEvent {
  requestId: string
  sessionId: string
  toolCall: RequestPermissionRequest['toolCall']
  options: PermissionOption[]
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
  pickProject(): Promise<ProjectState | null>
  getLastProject(): Promise<ProjectState | null>
  saveProject(path: string, settings: { checks: SessionChecks; readOnlyPaths: string[] }): Promise<ProjectState>
  createSession(projectPath: string): Promise<SessionHandle>
  sendPrompt(sessionId: string, turnId: string, text: string): Promise<StopReason>
  cancelSession(sessionId: string): Promise<void>
  onSessionUpdate(listener: (notification: SessionNotification) => void): () => void
  onPermissionRequest(listener: (request: PermissionRequestEvent) => void): () => void
  respondPermission(requestId: string, optionId: string | null): Promise<void>
  previewCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
  restoreCheckpoint(sessionId: string, turnId: string): Promise<CheckpointChange[]>
}
