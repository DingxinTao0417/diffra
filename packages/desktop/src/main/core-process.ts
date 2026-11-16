import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { type CoreClientHandlers, connectToCore, handshake } from '@diffra/core'
import { app } from 'electron'
import type { CoreStatus } from '../shared/ipc'

// 冷启动到握手完成一般零点几秒，但机器忙的时候（开机时杀毒软件在扫、CI 上）偶尔会卡十几秒。
// 握手失败后这次运行就用不了 core（直到重启应用），所以宁可多等：设置里这段时间显示「连接中」
const HANDSHAKE_TIMEOUT_MS = 60_000

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
      // 多候选方案的 git worktree（v2），不放进用户的项目里
      DIFFRA_WORKTREES_DIR: join(app.getPath('userData'), 'worktrees'),
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
  const started = performance.now()
  const info = handshake(connection, HANDSHAKE_TIMEOUT_MS)
  ready = info.then(() => connection)
  // 握手失败由下面返回的状态记录；调用 coreConnection() 的地方会各自收到这个 reject
  ready.catch(() => {})

  return info.then(
    (value): CoreStatus => ({ state: 'connected', ...value }),
    (error: unknown): CoreStatus => {
      // 记下等了多久、子进程还在不在，分得清是 core 卡住了还是退出了
      console.error(`[core] 握手失败：等了 ${Math.round(performance.now() - started)}ms，子进程${child?.exitCode === null ? '还在' : `已退出 code=${child?.exitCode}`}`, error)
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
  // Windows 上 kill() 只结束 core 自己，它在后台跑着的命令（exec_command 到点没结束的）会留下来：连子进程一起结束
  if (process.platform === 'win32' && child?.pid !== undefined && child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else child?.kill()
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
