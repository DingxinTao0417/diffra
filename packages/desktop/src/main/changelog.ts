// 更新日志：打包时生成的 out/changelog.json（见 scripts/changelog.ts）；升级后第一次启动记下从哪个版本升上来
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { type ChangelogRelease, compareVersions } from '../shared/changelog'
import { IPC_CHANNELS, type UpdateNotice } from '../shared/ipc'
import type { SettingsStore } from './settings-store'

let notice: UpdateNotice | null = null

async function readChangelog(): Promise<ChangelogRelease[]> {
  const file = join(app.getAppPath(), 'out', 'changelog.json')
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ChangelogRelease[]
  } catch (error) {
    // 构建时没生成（直接跑 electron-vite 没走 package.json 的脚本）：没有日志可看，不影响别的
    console.error(`[changelog] 读不到 ${file}`, error)
    return []
  }
}

// 启动时调一次。全新安装不提示；以前的版本还不记版本号，配过模型的说明是老用户升上来的，也提示
export async function recordVersion(settings: SettingsStore): Promise<void> {
  const current = app.getVersion()
  const { lastSeenVersion, providers } = settings.get()
  if (lastSeenVersion === current) return
  if (lastSeenVersion === null ? providers.length > 0 : compareVersions(current, lastSeenVersion) > 0) notice = { from: lastSeenVersion, to: current }
  await settings.update((value) => ({ ...value, lastSeenVersion: current }))
}

export function registerChangelogIpc(): void {
  ipcMain.handle(IPC_CHANNELS.changelogGet, () => readChangelog())
  ipcMain.handle(IPC_CHANNELS.changelogUpdateNotice, () => {
    const taken = notice
    notice = null
    return taken
  })
}
