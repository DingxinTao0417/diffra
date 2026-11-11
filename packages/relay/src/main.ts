// 中转服务入口：node src/main.ts。端口从 RELAY_PORT 读，必须给；只听本机，由 nginx 终止 TLS 后转进来。
// 日志按行写到标准输出，systemd 追加到日志文件（见 deploy/）
import { readFileSync } from 'node:fs'
import { createRelay } from './relay.ts'

const port = Number(process.env.RELAY_PORT)
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error('RELAY_PORT 没有设置或不是有效端口')
  process.exit(1)
}

// 发布脚本在包根目录写 release.txt；本机直接跑时没有
let release = 'dev'
try {
  release = readFileSync(new URL('../release.txt', import.meta.url), 'utf8').trim()
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
}

const relay = createRelay({
  host: '127.0.0.1',
  port,
  trustProxy: process.env.RELAY_TRUST_PROXY === '1',
  release,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
})
await relay.listen()
console.log(`${new Date().toISOString()} listening 127.0.0.1:${port} release ${release}`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    relay.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('关闭中转服务失败', error)
        process.exit(1)
      },
    )
  })
}
