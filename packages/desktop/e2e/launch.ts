import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, test } from '@playwright/test'

export const desktopDir = resolve(import.meta.dirname, '..')

// 每个测试用自己的临时数据目录，不碰开发和正式安装的数据
export function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'diffra-e2e-'))
}

// packaged 项目跑打包出来的程序，见 playwright.config.ts
function packagedExecutable(): string | null {
  const executable: unknown = test.info().project.metadata.executable
  return typeof executable === 'string' ? resolve(desktopDir, executable) : null
}

export function isPackagedRun(): boolean {
  return packagedExecutable() !== null
}

export function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const env = Object.fromEntries(
    // Electron 宿主启动测试时可能继承该变量；被测应用必须以桌面模式启动。
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
  )
  const executable = packagedExecutable()
  // 打包版只认正式数据目录（不看 DIFFRA_USER_DATA_DIR），用 Chromium 的 --user-data-dir 换成临时目录
  if (executable) return electron.launch({ executablePath: executable, args: [`--user-data-dir=${userDataDir}`], env })
  return electron.launch({ args: ['.'], cwd: desktopDir, env: { ...env, DIFFRA_USER_DATA_DIR: userDataDir } })
}
