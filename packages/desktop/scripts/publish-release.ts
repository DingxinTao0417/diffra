// 把 CI 打好的安装包发布到更新源：node scripts/publish-release.ts [版本号]，不写版本号就用 package.json 的
// 1. 从 v<版本号> 的 GitHub Release（草稿也行）下载安装包、差分文件和 latest.yml
// 2. 核对 latest.yml 里的版本、文件名、sha512 和大小
// 3. 按顺序上传：安装包、差分文件，最后才是 latest.yml（客户端看到新版本时文件已经齐了）；每个先传成 .partial 再改名
// 4. 从公网地址取回 latest.yml 和安装包信息，确认和本地一致
// 服务器上的旧版本文件不删：差分下载要用旧版本的 .blockmap
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import builderConfig from '../electron-builder.config.ts'

const desktopDir = resolve(import.meta.dirname, '..')
const SSH_TIMEOUT_MS = 60_000
// 安装包一百多 MB，上行慢的网络要好几分钟
const UPLOAD_TIMEOUT_MS = 30 * 60_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const FETCH_TIMEOUT_MS = 30_000

// 服务器的连接方式写在不提交的 publish.config.json 里，样例见 publish.config.example.json
const configSchema = z.object({
  ssh: z.object({ target: z.string().min(1), port: z.number().int().positive(), identityFile: z.string().min(1) }),
  remoteDir: z.string().regex(/^\/[\w./-]+$/, '要写成绝对路径，只含字母、数字和 . / - _'),
})

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
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
      else reject(new Error(`${file} ${args.join(' ')} 失败（${signal ? `超时被结束` : `退出码 ${code}`}）：\n${output.trim()}`))
    })
  })
}

// electron-builder 生成的 latest.yml 格式固定，只取这几项
function parseLatest(text: string) {
  const field = (pattern: RegExp) => pattern.exec(text)?.[1]?.trim() ?? null
  return {
    version: field(/^version: (.+)$/m),
    path: field(/^path: (.+)$/m),
    sha512: field(/^sha512: (.+)$/m),
    size: Number(field(/^\s+size: (\d+)$/m)),
  }
}

async function main(): Promise<void> {
  const version = process.argv[2] ?? (JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version
  const tag = `v${version}`
  const exe = `Diffra-Setup-${version}.exe`
  const files = [exe, `${exe}.blockmap`, 'latest.yml']
  const publish = Array.isArray(builderConfig.publish) ? builderConfig.publish[0] : null
  const publicUrl = publish && typeof publish === 'object' && 'url' in publish && typeof publish.url === 'string' ? publish.url : null
  if (!publicUrl) throw new Error('electron-builder.config.ts 里没有更新源地址')
  if (process.env.DIFFRA_UPDATE_URL) throw new Error('设置了 DIFFRA_UPDATE_URL（只用于本地演练），正式发布前先清掉')

  const config = configSchema.parse(JSON.parse(readFileSync(join(desktopDir, 'publish.config.json'), 'utf8')))
  const identityFile = config.ssh.identityFile.replace(/^~(?=[\\/])/, homedir())
  const sshArgs = ['-i', identityFile, '-p', String(config.ssh.port), '-o', 'BatchMode=yes', config.ssh.target]
  const ssh = (command: string) => run('ssh', [...sshArgs, command], SSH_TIMEOUT_MS)
  const scp = (local: string, remote: string) =>
    run('scp', ['-i', identityFile, '-P', String(config.ssh.port), '-o', 'BatchMode=yes', local, `${config.ssh.target}:${remote}`], UPLOAD_TIMEOUT_MS)

  const workDir = mkdtempSync(join(tmpdir(), 'diffra-publish-'))
  try {
    console.log(`下载 ${tag} 的安装包…`)
    await run('gh', ['release', 'download', tag, ...files.flatMap((name) => ['--pattern', name]), '--dir', workDir, '--clobber'], DOWNLOAD_TIMEOUT_MS)

    const latestText = readFileSync(join(workDir, 'latest.yml'), 'utf8')
    const latest = parseLatest(latestText)
    const exeBytes = readFileSync(join(workDir, exe))
    const sha512 = createHash('sha512').update(exeBytes).digest('base64')
    const problems = [
      latest.version === version ? null : `latest.yml 的版本是 ${latest.version}，不是 ${version}`,
      latest.path === exe ? null : `latest.yml 指向 ${latest.path}，不是 ${exe}`,
      latest.sha512 === sha512 ? null : 'latest.yml 的 sha512 和安装包对不上',
      latest.size === exeBytes.length ? null : `latest.yml 的大小 ${latest.size} 和安装包 ${exeBytes.length} 对不上`,
    ].filter(Boolean)
    if (problems.length > 0) throw new Error(`安装包没通过核对，没有上传：\n${problems.join('\n')}`)
    console.log(`核对通过：${exe}，${(exeBytes.length / 1024 / 1024).toFixed(1)}MB`)

    await ssh(`test -d '${config.remoteDir}'`)
    for (const name of files) {
      const remote = `${config.remoteDir}/${name}`
      console.log(`上传 ${name}…`)
      await scp(join(workDir, name), `${remote}.partial`)
      await ssh(`mv -f '${remote}.partial' '${remote}'`)
    }

    const online = await fetch(`${publicUrl}latest.yml`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!online.ok || (await online.text()) !== latestText) throw new Error(`线上的 latest.yml 和刚上传的不一致（HTTP ${online.status}）`)
    const head = await fetch(`${publicUrl}${exe}`, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!head.ok || Number(head.headers.get('content-length')) !== exeBytes.length) throw new Error(`线上的安装包大小不对（HTTP ${head.status}）`)
    console.log(`已发布 ${version}。下载地址：${publicUrl}${exe}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
