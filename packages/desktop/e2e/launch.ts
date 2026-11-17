import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, test } from '@playwright/test'

export const desktopDir = resolve(import.meta.dirname, '..')
// 应用窗口的缩放比（为什么 CI 里是 0.8 见 launchApp）。截图按它出图，按截图坐标点击的用例要用它换算
export const DEVICE_SCALE = process.env.CI ? 0.8 : 1
export const APP_VERSION =(JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version

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
  const env: Record<string, string> = {
    ...Object.fromEntries(
      // Electron 宿主启动测试时可能继承该变量；被测应用必须以桌面模式启动。
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
    ),
    // 不往真实浏览器的注册表里登记浏览器扩展的宿主；要测扩展的用例自己换成 chromium
    DIFFRA_BROWSER_HOST_TARGETS: 'none',
    // e2e 的脚本模型按固定步数回复；默认关掉下一句建议，专门的用例再打开
    DIFFRA_SUGGESTIONS_OFF: '1',
    // 扩展页会联网取目录：测试里默认连本机一个没人听的端口（马上失败，用内置目录），不去请求真的官网；要测的用例自己换
    DIFFRA_CATALOG_URL: 'http://127.0.0.1:9/extensions/catalog.json',
    // 藏到托盘时不在用户桌面上冒真的气泡通知
    DIFFRA_TRAY_QUIET: '1',
    // 「外部扫描器」按本机装没装 Semgrep、CodeQL 显示：测试里默认当没装（指到不存在的程序），结果不随这台机器装了什么变；要测的用例自己指过去
    DIFFRA_SEMGREP_PATH: join(desktopDir, 'no-such-semgrep'),
    DIFFRA_CODEQL_PATH: join(desktopDir, 'no-such-codeql'),
    ...extraEnv,
  }
  const executable = packagedExecutable()
  // 打包版的无项目任务默认放「文档/Diffra」：测试不往真实的「文档」里写，和开发版一样放这次数据目录下的 workspace
  if (executable && !extraEnv.DIFFRA_DEFAULT_WORKSPACE) env.DIFFRA_DEFAULT_WORKSPACE = join(userDataDir, 'workspace')
  // CI 的 Windows 机器屏幕只有 1024×768，1200 宽的窗口被压到屏幕宽，开着任务监控时对话列不够宽，侧栏会自动收起，
  // 用例按侧栏一直在写的；缩到 0.8 倍后 1200×820 的窗口占 960×656 像素，布局和本机一致
  const extraArgs = DEVICE_SCALE === 1 ? [] : [`--force-device-scale-factor=${DEVICE_SCALE}`]
  // Mac：密钥加密用钥匙串里的「Diffra Safe Storage」。测试不碰用户真实的钥匙串，用 Chromium 的模拟钥匙串；
  // 不然打包版（签名和开发版不同）一存密钥就弹系统授权框，测试卡在那里
  if (process.platform === 'darwin') extraArgs.push('--use-mock-keychain')
  // 打包版只认正式数据目录（不看 DIFFRA_USER_DATA_DIR），用 Chromium 的 --user-data-dir 换成临时目录
  if (executable) return electron.launch({ executablePath: executable, args: [`--user-data-dir=${userDataDir}`, ...extraArgs], env })
  return electron.launch({ args: ['.', ...extraArgs], cwd: desktopDir, env: { ...env, DIFFRA_USER_DATA_DIR: userDataDir } })
}
