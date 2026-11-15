// 把安装包发布到更新源：node scripts/publish-release.ts [版本号] [--local]，不写版本号就用 package.json 的
// 1. 从 v<版本号> 的 GitHub Release（草稿也行）下载安装包、差分文件和 latest.yml；--local 直接用本机 release/ 里的构建产物
// 2. 核对 latest.yml 里的版本、文件名、sha512 和大小
// 3. 按顺序上传：安装包、差分文件，最后才是 latest.yml（客户端看到新版本时文件已经齐了）
// 4. 把官网下载按钮用的 Diffra-Setup-latest.exe 指向这个版本
// 5. 从公网地址取回 latest.yml 和安装包信息，确认和本地一致
// 服务器上的旧版本文件不删：差分下载要用旧版本的 .blockmap
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import builderConfig from '../electron-builder.config.ts'
import { desktopDir, loadPublishConfig, remote, run } from './remote.ts'

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const FETCH_TIMEOUT_MS = 30_000
const LATEST_ALIAS = 'Diffra-Setup-latest.exe'

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
  const args = process.argv.slice(2)
  const local = args.includes('--local')
  const version = args.find((arg) => !arg.startsWith('--')) ?? (JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version
  const tag = `v${version}`
  const exe = `Diffra-Setup-${version}.exe`
  const files = [exe, `${exe}.blockmap`, 'latest.yml']
  const publish = Array.isArray(builderConfig.publish) ? builderConfig.publish[0] : null
  const publicUrl = publish && typeof publish === 'object' && 'url' in publish && typeof publish.url === 'string' ? publish.url : null
  if (!publicUrl) throw new Error('electron-builder.config.ts 里没有更新源地址')
  if (process.env.DIFFRA_UPDATE_URL) throw new Error('设置了 DIFFRA_UPDATE_URL（只用于本地演练），正式发布前先清掉')

  const config = loadPublishConfig()
  const { ssh, upload } = remote(config)
  const workDir = local ? null : mkdtempSync(join(tmpdir(), 'diffra-publish-'))
  const sourceDir = workDir ?? join(desktopDir, 'release')
  try {
    if (local) {
      console.log('使用本机 release/ 里的构建产物…')
      if (!existsSync(join(sourceDir, 'latest.yml'))) throw new Error('没有找到 release/latest.yml，先运行 pnpm --filter @diffra/desktop package')
    } else {
      console.log(`下载 ${tag} 的安装包…`)
      await run('gh', ['release', 'download', tag, ...files.flatMap((name) => ['--pattern', name]), '--dir', sourceDir, '--clobber'], DOWNLOAD_TIMEOUT_MS)
    }

    const latestText = readFileSync(join(sourceDir, 'latest.yml'), 'utf8')
    const latest = parseLatest(latestText)
    const exeBytes = readFileSync(join(sourceDir, exe))
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
      console.log(`上传 ${name}…`)
      await upload(join(sourceDir, name), `${config.remoteDir}/${name}`)
    }
    // 先建好新的链接再改名替换，换的瞬间也不会下到半个文件
    await ssh(`cd '${config.remoteDir}' && ln -sfn '${exe}' '${LATEST_ALIAS}.partial' && mv -Tf '${LATEST_ALIAS}.partial' '${LATEST_ALIAS}'`)

    const online = await fetch(`${publicUrl}latest.yml`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!online.ok || (await online.text()) !== latestText) throw new Error(`线上的 latest.yml 和刚上传的不一致（HTTP ${online.status}）`)
    for (const name of [exe, LATEST_ALIAS]) {
      const head = await fetch(`${publicUrl}${name}`, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!head.ok || Number(head.headers.get('content-length')) !== exeBytes.length) throw new Error(`线上的 ${name} 大小不对（HTTP ${head.status}）`)
    }
    console.log(`已发布 ${version}。官网下载按钮现在指向它：${publicUrl}${LATEST_ALIAS}`)
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
