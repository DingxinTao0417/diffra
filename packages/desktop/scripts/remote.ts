// 发布脚本共用：读服务器连接方式、跑命令、上传文件
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const desktopDir = resolve(import.meta.dirname, '..')
const SSH_TIMEOUT_MS = 60_000
// 安装包一百多 MB，上行慢的网络要好几分钟
const UPLOAD_TIMEOUT_MS = 30 * 60_000

const remotePath = z.string().regex(/^\/[\w./-]+$/, '要写成绝对路径，只含字母、数字和 . / - _')

// 服务器的连接方式写在不提交的 publish.config.json 里，样例见 publish.config.example.json
const configSchema = z.object({
  ssh: z.object({ target: z.string().min(1), port: z.number().int().positive(), identityFile: z.string().min(1) }),
  // 更新源的安装包目录
  remoteDir: remotePath,
  // 官网文件目录
  siteDir: remotePath,
  // nginx 访问日志（含轮转出来的旧文件），统计用；默认是 Ubuntu 上 nginx 的位置
  accessLogs: z.string().regex(/^\/[\w./*-]+$/).default('/var/log/nginx/access.log*'),
})

export type PublishConfig = z.infer<typeof configSchema>

export function loadPublishConfig(): PublishConfig {
  return configSchema.parse(JSON.parse(readFileSync(join(desktopDir, 'publish.config.json'), 'utf8')))
}

export function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${file} 启动失败：${error.message}`, { cause: error }))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${file} ${args.join(' ')} 失败（${signal ? '超时被结束' : `退出码 ${code}`}）：\n${output.trim()}`))
    })
  })
}

export function remote(config: PublishConfig) {
  const identityFile = config.ssh.identityFile.replace(/^~(?=[\\/])/, homedir())
  const ssh = (command: string) =>
    run('ssh', ['-i', identityFile, '-p', String(config.ssh.port), '-o', 'BatchMode=yes', config.ssh.target, command], SSH_TIMEOUT_MS)
  const scp = (local: string, target: string) =>
    run('scp', ['-i', identityFile, '-P', String(config.ssh.port), '-o', 'BatchMode=yes', local, `${config.ssh.target}:${target}`], UPLOAD_TIMEOUT_MS)
  // 先传成 .partial 再改名：传到一半的文件不会被别人下到（nginx 不对外提供 .partial）
  const upload = async (local: string, target: string) => {
    await scp(local, `${target}.partial`)
    await ssh(`mv -f '${target}.partial' '${target}'`)
  }
  const download = (source: string, local: string) =>
    run('scp', ['-i', identityFile, '-P', String(config.ssh.port), '-o', 'BatchMode=yes', `${config.ssh.target}:${source}`, local], UPLOAD_TIMEOUT_MS)
  return { ssh, upload, download }
}
