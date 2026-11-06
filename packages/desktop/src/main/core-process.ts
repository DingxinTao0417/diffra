import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { connectToCore, handshake } from '@diffra/core'
import type { CoreStatus } from '../shared/ipc'

const HANDSHAKE_TIMEOUT_MS = 10_000

type CoreConnection = ReturnType<typeof connectToCore>

let child: ChildProcessByStdio<Writable, Readable, null> | undefined
let ready: Promise<CoreConnection> | undefined
let stopping = false

export function startCore(): Promise<CoreStatus> {
  // 用 Electron 自带的 Node 跑 core，不额外打包 Node；打包时不能关闭 RunAsNode fuse。
  child = spawn(process.execPath, [join(import.meta.dirname, 'core.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.on('error', (error) => console.error('[core] 进程启动失败', error))
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`[core] 进程意外退出 code=${code} signal=${signal}`)
  })

  const connection = connectToCore(child.stdin, child.stdout)
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
