// 把设备连接的中转服务（packages/relay）发到服务器：node scripts/publish-relay.ts [--dry-run]
// 只换代码和依赖、重启服务；第一次上线（DNS、证书、nginx、systemd、Node）见 docs/decisions.md「设备连接」。
// 每次发一个新目录 releases/<时间-提交>，current 链过去再重启；健康检查返回的版本对得上才算成功，对不上就链回上一个版本。
// --dry-run 只在本机打包、列出要做的事，不连服务器
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { RELAY_HOST } from '../../relay/src/protocol.ts'
import { desktopDir, loadPublishConfig, remote, run } from './remote.ts'

// 和 deploy/diffra-relay.service 里的路径一致
const RELAY_DIR = '/opt/diffra-relay'
const KEEP_RELEASES = 3
const HEALTH_URL = `https://${RELAY_HOST}/health`
const HEALTH_WAIT_MS = 20_000
const FETCH_TIMEOUT_MS = 10_000
const LOCAL_TIMEOUT_MS = 60_000
// 运行时依赖：都没有自己的依赖，照本机测过的那份原样拷过去，服务器上不再装
const RUNTIME_PACKAGES = ['ws', 'zod']
const RELEASE_NAME = /^\d{8}-\d{6}-[0-9a-f]{7,12}$/

const relayDir = resolve(desktopDir, '../relay')
const dryRun = process.argv.includes('--dry-run')

// 服务器上直接 node src/main.ts：源码、两个依赖、标明 ESM 的 package.json、健康检查用的版本标识
function stage(release: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffra-relay-'))
  cpSync(join(relayDir, 'src'), join(dir, 'src'), { recursive: true })
  const require = createRequire(join(relayDir, 'package.json'))
  for (const name of RUNTIME_PACKAGES) {
    const packageDir = realpathSync(dirname(require.resolve(`${name}/package.json`)))
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; version: string }
    if (Object.keys(manifest.dependencies ?? {}).length > 0) throw new Error(`${name} 有自己的依赖，不能只拷这一个包`)
    cpSync(packageDir, join(dir, 'node_modules', name), { recursive: true, dereference: true })
    console.log(`依赖 ${name}@${manifest.version}`)
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'diffra-relay', private: true, type: 'module' }, null, 2)}\n`)
  writeFileSync(join(dir, 'release.txt'), `${release}\n`)
  return dir
}

// Windows 上用系统自带的 tar（bsdtar）：Git Bash 的 GNU tar 会把 C: 当成远程主机
function tarCommand(): string {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

async function releaseName(): Promise<string> {
  // 发出去的代码要对得上一个提交：packages/relay 有没提交的改动就不发
  const dirty = (await run('git', ['-C', relayDir, 'status', '--porcelain', '--', '.'], LOCAL_TIMEOUT_MS)).trim()
  if (dirty && !dryRun) throw new Error(`packages/relay 有没提交的改动，先提交再发：\n${dirty}`)
  const commit = (await run('git', ['-C', relayDir, 'rev-parse', '--short', 'HEAD'], LOCAL_TIMEOUT_MS)).trim()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${commit}`
}

// 上传前在本机解开打好的包、照服务器上的方式启动一次，健康检查返回这个版本才算包是好的（漏了依赖、入口不对在这里就发现）
async function smokeTest(archive: string, release: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'diffra-relay-check-'))
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as AddressInfo
      probe.close(() => resolvePort(free))
    })
  })
  let output = ''
  try {
    await run(tarCommand(), ['-xzf', archive, '-C', dir], LOCAL_TIMEOUT_MS)
    const child = spawn(process.execPath, ['src/main.ts'], { cwd: dir, env: { ...process.env, RELAY_PORT: String(port) }, windowsHide: true })
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    try {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if ((await healthRelease(`http://127.0.0.1:${port}/health`)) === release) return
        await new Promise((resolveWait) => setTimeout(resolveWait, 200))
      }
      throw new Error(`打好的包在本机启动后健康检查没返回 ${release}：\n${output.trim()}`)
    } finally {
      // 等它真的退出再删目录：Windows 上进程还占着工作目录时删不掉
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => child.once('exit', resolveExit))
      child.kill()
      await exited
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function healthRelease(url = HEALTH_URL): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { release?: unknown }
    return typeof body.release === 'string' ? body.release : null
  } catch {
    return null
  }
}

async function waitForRelease(release: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_WAIT_MS
  while (Date.now() < deadline) {
    if ((await healthRelease()) === release) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  return false
}

async function main(): Promise<void> {
  const release = await releaseName()
  const staging = stage(release)
  const archive = `${staging}.tgz`
  try {
    await run(tarCommand(), ['-czf', archive, '-C', staging, '.'], LOCAL_TIMEOUT_MS)
    console.log(`打包好 ${release}：${(statSync(archive).size / 1024).toFixed(0)} KB`)
    await smokeTest(archive, release)
    console.log('本机试跑通过')
    const releaseDir = `${RELAY_DIR}/releases/${release}`
    const steps = [
      `检查服务器：${RELAY_DIR}/releases 存在、diffra-relay 服务装好、Node 24 以上`,
      `上传到 ${releaseDir}.tgz（先传成 .partial 再改名）`,
      `解压到 ${releaseDir}，current 链过去，重启 diffra-relay`,
      `等 ${HEALTH_URL} 返回 ${release}；对不上就把 current 链回上一个版本再重启`,
      `releases 下只留最近 ${KEEP_RELEASES} 个版本`,
    ]
    if (dryRun) {
      const config = loadPublishConfig()
      console.log(`--dry-run：不连服务器。会对 ${config.ssh.target} 做这些：`)
      for (const [index, step] of steps.entries()) console.log(`  ${index + 1}. ${step}`)
      return
    }

    const config = loadPublishConfig()
    const { ssh, upload } = remote(config)
    const node = (await ssh(`test -d '${RELAY_DIR}/releases' && systemctl cat diffra-relay >/dev/null && node --version`).catch((error: unknown) => {
      throw new Error(`服务器还没准备好，先完成第一次上线（docs/decisions.md「设备连接」）：${error instanceof Error ? error.message : String(error)}`)
    })).trim()
    if (Number(/^v(\d+)\./.exec(node)?.[1] ?? 0) < 24) throw new Error(`服务器上的 Node 是 ${node}，要 24 以上（直接跑 TS）`)
    const previous = (await ssh(`readlink '${RELAY_DIR}/current' || true`)).trim()

    console.log('上传…')
    await upload(archive, `${releaseDir}.tgz`)
    await ssh(
      [
        `mkdir '${releaseDir}'`,
        `tar -xzf '${releaseDir}.tgz' -C '${releaseDir}'`,
        `rm -f '${releaseDir}.tgz'`,
        `ln -sfn 'releases/${release}' '${RELAY_DIR}/current.next'`,
        `mv -Tf '${RELAY_DIR}/current.next' '${RELAY_DIR}/current'`,
        'systemctl restart diffra-relay',
      ].join(' && '),
    )
    if (!(await waitForRelease(release))) {
      const log = await ssh(`tail -n 20 /var/log/diffra-relay/relay.log`).catch(() => '（读不到日志）')
      if (previous) await ssh(`ln -sfn '${previous}' '${RELAY_DIR}/current.next' && mv -Tf '${RELAY_DIR}/current.next' '${RELAY_DIR}/current' && systemctl restart diffra-relay`)
      throw new Error(`${HEALTH_URL} 没有在 ${HEALTH_WAIT_MS / 1000} 秒内返回新版本，${previous ? `已链回 ${previous}` : '之前没有版本可退'}。最近的日志：\n${log}`)
    }

    const releases = (await ssh(`ls -1 '${RELAY_DIR}/releases'`)).split('\n').map((name) => name.trim()).filter((name) => RELEASE_NAME.test(name)).sort()
    for (const old of releases.slice(0, -KEEP_RELEASES)) {
      if (old === release || previous.endsWith(old)) continue
      await ssh(`rm -rf -- '${RELAY_DIR}/releases/${old}'`)
    }
    console.log(`中转服务已更新：${release}（${HEALTH_URL}）`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
