// Diffra 浏览器扩展的本机宿主：浏览器按 native messaging 启动它（Diffra.exe 以 node 模式运行这个脚本，见 native-host-registry.ts），
// 它把扩展的消息（4 字节长度 + JSON）一行一条地转给主进程的命名管道，反过来也一样。只转发，不理解内容。
// Diffra 没开时每 2 秒重连一次；连上后先报令牌，再补发扩展最近一次打招呼
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import type { HostMessage } from '../shared/browser-bridge'

const RETRY_MS = 2_000
// 浏览器发给宿主的单条消息上限是 64MiB
const MAX_FRAME_BYTES = 64 * 1024 * 1024

const pipePath = process.env.DIFFRA_BRIDGE_PIPE
const tokenFile = process.env.DIFFRA_BRIDGE_TOKEN_FILE
if (!pipePath || !tokenFile) {
  process.stderr.write('Diffra 浏览器宿主缺少 DIFFRA_BRIDGE_PIPE 或 DIFFRA_BRIDGE_TOKEN_FILE\n')
  process.exit(1)
}

let pipe: Socket | null = null
let hello: string | null = null
let input = Buffer.alloc(0)

function toBrowser(message: HostMessage | string): void {
  const json = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message))
  const length = Buffer.alloc(4)
  length.writeUInt32LE(json.length)
  process.stdout.write(Buffer.concat([length, json]))
}

process.stdin.on('data', (chunk: Buffer) => {
  input = Buffer.concat([input, chunk])
  while (input.length >= 4) {
    const size = input.readUInt32LE(0)
    if (size > MAX_FRAME_BYTES) process.exit(1)
    if (input.length < 4 + size) break
    const line = input.subarray(4, 4 + size).toString('utf8')
    input = input.subarray(4 + size)
    if (line.includes('"type":"hello"')) hello = line
    // Diffra 没开时扩展的消息没人收，丢掉；连上后补发打招呼
    pipe?.write(`${line}\n`)
  }
})
process.stdin.on('end', () => process.exit(0))

async function connectPipe(): Promise<void> {
  let token: string
  try {
    token = (await readFile(tokenFile!, 'utf8')).trim()
  } catch {
    setTimeout(() => void connectPipe(), RETRY_MS)
    return
  }
  const socket = connect(pipePath!)
  let rest = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => {
    pipe = socket
    socket.write(`${JSON.stringify({ type: 'host', token, pid: process.pid })}\n`)
    if (hello) socket.write(`${hello}\n`)
    toBrowser({ type: 'diffra', connected: true })
  })
  socket.on('data', (data: string) => {
    rest += data
    let index
    while ((index = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, index)
      rest = rest.slice(index + 1)
      if (line) toBrowser(line)
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    if (pipe === socket) {
      pipe = null
      toBrowser({ type: 'diffra', connected: false })
    }
    setTimeout(() => void connectPipe(), RETRY_MS)
  })
}

toBrowser({ type: 'diffra', connected: false })
void connectPipe()
