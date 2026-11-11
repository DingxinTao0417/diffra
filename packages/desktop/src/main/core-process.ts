import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { type CoreClientHandlers, connectToCore, handshake } from '@diffra/core'
import { app } from 'electron'
import type { CoreStatus } from '../shared/ipc'

const HANDSHAKE_TIMEOUT_MS = 10_000

type CoreConnection = ReturnType<typeof connectToCore>

let child: ChildProcessByStdio<Writable, Readable, null> | undefined
let ready: Promise<CoreConnection> | undefined
let stopping = false

export function startCore(handlers: CoreClientHandlers): Promise<CoreStatus> {
  // 用 Electron 自带的 Node 跑 core，不额外打包 Node；打包时不能关闭 RunAsNode fuse。
  let rgPath: string | undefined
  try {
    rgPath = ripgrepPath()
  } catch (error) {
    // 找不到 rg 时 core 照常启动，用到搜索类工具时才会报错
    console.error('[core] 找不到 ripgrep', error)
  }
  child = spawn(process.execPath, [join(import.meta.dirname, 'core.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // 会话记录放在应用数据目录下；core 每轮开始和结束时保存
      DIFFRA_SESSIONS_DIR: join(app.getPath('userData'), 'sessions'),
      // 每次模型调用的用量，按月追加
      DIFFRA_USAGE_DIR: join(app.getPath('userData'), 'usage'),
      // 架构分析的项目列表、分析结果、目标架构
      DIFFRA_ARCHITECTURE_DIR: join(app.getPath('userData'), 'architecture'),
      ...(rgPath ? { DIFFRA_RG_PATH: rgPath } : {}),
      // 随 Diffra 带的 Skill：打包后在 resources/skills（electron-builder 的 extraResources），开发时是 core 包里的 skills 目录
      DIFFRA_SKILLS_DIR: app.isPackaged ? join(process.resourcesPath, 'skills') : join(app.getAppPath(), '..', 'core', 'skills'),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.on('error', (error) => console.error('[core] 进程启动失败', error))
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`[core] 进程意外退出 code=${code} signal=${signal}`)
  })

  const connection = connectToCore(child.stdin, child.stdout, handlers)
  const info = handshake(connection, HANDSHAKE_TIMEOUT_MS)
  ready = info.then(() => connection)
  // 握手失败由下面返回的状态记录；调用 coreConnection() 的地方会各自收到这个 reject
  ready.catch(() => {})

  return info.then(
    (value): CoreStatus => ({ state: 'connected', ...value }),
    (error: unknown): CoreStatus => {
      console.error('[core] 握手失败', error)
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    },
  )
}

export function coreConnection(): Promise<CoreConnection> {
  if (!ready) return Promise.reject(new Error('core 还没有启动'))
  return ready
}

export function stopCore(): void {
  stopping = true
  child?.kill()
}

// core 打进 out/main/core.js 后，@vscode/ripgrep 找不到自己的平台包，由这里算好路径传进去：
// 打包后 rg 在 resources 目录（electron-builder 的 extraResources）；开发时从 core 包的依赖里解析
function ripgrepPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, process.platform === 'win32' ? 'rg.exe' : 'rg')
  const requireFromCore = createRequire(join(app.getAppPath(), '..', 'core', 'package.json'))
  const ripgrep: unknown = requireFromCore('@vscode/ripgrep')
  if (typeof ripgrep === 'object' && ripgrep !== null && 'rgPath' in ripgrep && typeof ripgrep.rgPath === 'string') {
    return ripgrep.rgPath
  }
  throw new Error('无法从 @vscode/ripgrep 取得 rg 路径')
}
