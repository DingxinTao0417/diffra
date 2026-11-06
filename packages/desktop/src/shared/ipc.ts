import type { ListModelsResult, TestModelResult } from '@diffra/core/types'
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
}
