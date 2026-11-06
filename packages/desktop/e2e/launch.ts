import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

export const desktopDir = resolve(import.meta.dirname, '..')

// 每个测试用自己的临时数据目录，不碰开发和正式安装的数据
export function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'diffra-e2e-'))
}

export function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return electron.launch({ args: ['.'], cwd: desktopDir, env: { ...env, DIFFRA_USER_DATA_DIR: userDataDir } })
}
