import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { EXTENSION_IDS, NATIVE_HOST_NAMES } from '../shared/browser-bridge'

const run = promisify(execFile)
const REG_TIMEOUT_MS = 10_000

// 各浏览器在当前用户下找 native messaging 宿主的注册表位置
const REGISTRY_ROOTS = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
} as const
type RegistryTarget = keyof typeof REGISTRY_ROOTS

export interface BridgeEndpoint {
  pipe: string
  token: string
  hostName: string
}

// 命名管道按数据目录区分：正式版、开发版、e2e 的临时目录各用各的
export function bridgePipe(userDataDir: string): string {
  return `\\\\.\\pipe\\diffra-browser-${createHash('sha256').update(userDataDir.toLowerCase()).digest('hex').slice(0, 16)}`
}

// 默认登记到 Chrome 和 Edge；e2e 用 DIFFRA_BROWSER_HOST_TARGETS 换成 none，测扩展的用例配合 DIFFRA_BROWSER_HOST=test 用单独的宿主名
function targets(): RegistryTarget[] {
  const raw = process.env.DIFFRA_BROWSER_HOST_TARGETS ?? 'chrome,edge'
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is RegistryTarget => item in REGISTRY_ROOTS)
}

// cmd 里 % 会被当成变量，路径里有的话写成 %%
const cmdValue = (value: string) => value.replace(/%/g, '%%')

// 每次启动重写宿主的启动脚本、清单和注册表：安装位置、数据目录变了也能自己对上；令牌每次启动换新的
export async function registerNativeHost(userDataDir: string): Promise<BridgeEndpoint> {
  const dir = join(userDataDir, 'browser-bridge')
  const hostName = process.env.DIFFRA_BROWSER_HOST === 'test' ? NATIVE_HOST_NAMES.test : app.isPackaged ? NATIVE_HOST_NAMES.packaged : NATIVE_HOST_NAMES.development
  const endpoint = { pipe: bridgePipe(userDataDir), token: randomBytes(32).toString('hex'), hostName }
  await mkdir(dir, { recursive: true })
  const tokenFile = join(dir, 'token')
  await writeFile(tokenFile, endpoint.token)
  if (process.platform !== 'win32') return endpoint

  // 打包版里脚本在 app.asar 里，node 模式下的 Electron 能直接读
  const script = join(app.getAppPath(), 'out', 'main', 'native-host.js')
  const launcher = join(dir, 'diffra-browser-host.cmd')
  await writeFile(
    launcher,
    [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "DIFFRA_BRIDGE_PIPE=${cmdValue(endpoint.pipe)}"`,
      `set "DIFFRA_BRIDGE_TOKEN_FILE=${cmdValue(tokenFile)}"`,
      `"${cmdValue(process.execPath)}" "${cmdValue(script)}" %*`,
      '',
    ].join('\r\n'),
  )
  const origins = [EXTENSION_IDS.development, EXTENSION_IDS.chromeWebStore, EXTENSION_IDS.edgeAddons].filter((id): id is string => id !== null).map((id) => `chrome-extension://${id}/`)
  const manifest = join(dir, `${hostName}.json`)
  await writeFile(manifest, JSON.stringify({ name: hostName, description: 'Diffra 浏览器扩展的本机宿主', path: launcher, type: 'stdio', allowed_origins: origins }, null, 2))
  for (const target of targets()) {
    try {
      await run('reg.exe', ['add', `${REGISTRY_ROOTS[target]}\\${hostName}`, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { timeout: REG_TIMEOUT_MS, windowsHide: true })
    } catch (error) {
      console.error(`[browser-bridge] 登记到 ${target} 失败`, error)
    }
  }
  return endpoint
}
