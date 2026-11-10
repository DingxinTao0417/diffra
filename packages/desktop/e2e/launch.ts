import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, test } from '@playwright/test'

export const desktopDir = resolve(import.meta.dirname, '..')
export const APP_VERSION = (JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version

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

// extraEnv：只给这一次启动加的环境变量，比如缩短 core 的提示时限
export function launchApp(userDataDir: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const env = {
    ...Object.fromEntries(
      // Electron 宿主启动测试时可能继承该变量；被测应用必须以桌面模式启动。
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
    ),
    // 不往真实浏览器的注册表里登记浏览器扩展的宿主；要测扩展的用例自己换成 chromium
    DIFFRA_BROWSER_HOST_TARGETS: 'none',
    ...extraEnv,
  }
  const executable = packagedExecutable()
  // CI 的 Windows 机器屏幕只有 1024×768，1200 宽的窗口被压到屏幕宽，开着任务监控时对话列不够宽，侧栏会自动收起，
  // 用例按侧栏一直在写的；缩到 0.8 倍后 1200×820 的窗口占 960×656 像素，布局和本机一致
  const scale = process.env.CI ? ['--force-device-scale-factor=0.8'] : []
  // 打包版只认正式数据目录（不看 DIFFRA_USER_DATA_DIR），用 Chromium 的 --user-data-dir 换成临时目录
  if (executable) return electron.launch({ executablePath: executable, args: [`--user-data-dir=${userDataDir}`, ...scale], env })
  return electron.launch({ args: ['.', ...scale], cwd: desktopDir, env: { ...env, DIFFRA_USER_DATA_DIR: userDataDir } })
}
