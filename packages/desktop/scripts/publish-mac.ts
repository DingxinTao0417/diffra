// 把 Mac 安装包发布到更新源的 mac 目录：node scripts/publish-mac.ts [版本号] [--local]，不写版本号就用 package.json 的
// Mac 包现在还在 Mac 上手动打（pnpm package:mac）；--local 直接用本机 release/ 里的构建产物，否则把 release/ 里的这几个文件传到 v<版本号> 的 GitHub Release：
//   gh release upload v<版本号> release/Diffra-<版本号>-arm64.dmg release/Diffra-<版本号>-arm64.dmg.blockmap \
//     release/Diffra-<版本号>-arm64.zip release/Diffra-<版本号>-arm64.zip.blockmap release/latest-mac.yml --clobber
// 这个脚本在哪台电脑上跑都行（要有 publish.config.json 和服务器密钥）：
// 1. 从 GitHub Release 下载上面这几个文件
// 2. 核对 latest-mac.yml 里的版本，以及 dmg、zip 的 sha512 和大小
// 3. 按顺序上传：安装包、差分文件，最后才是 latest-mac.yml
// 4. 把官网下载按钮用的 Diffra-latest-arm64.dmg 指向这个版本
// 5. 从公网地址取回 latest-mac.yml 和 dmg 的大小，确认和本地一致；官网要跨域读 latest-mac.yml，顺便检查跨域头
// Mac 预览版还不自动更新（updater.ts），latest-mac.yml 和 zip 先跟着传，以后开了自动更新直接能用
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import builderConfig from '../electron-builder.config.ts'
import { desktopDir, loadPublishConfig, remote, run } from './remote.ts'

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const FETCH_TIMEOUT_MS = 30_000
const ARCH = 'arm64'
const LATEST_ALIAS = `Diffra-latest-${ARCH}.dmg`
const SITE_ORIGIN = 'https://diffra.dev'

// latest-mac.yml 的 files 里每个文件一项：url、sha512、size
function parseFiles(text: string): Map<string, { sha512: string; size: number }> {
  const files = new Map<string, { sha512: string; size: number }>()
  for (const match of text.matchAll(/- url: (\S+)\s+sha512: (\S+)\s+size: (\d+)/g)) {
    files.set(match[1], { sha512: match[2], size: Number(match[3]) })
  }
  return files
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const local = args.includes('--local')
  const version = args.find((arg) => !arg.startsWith('--')) ?? (JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version
  const tag = `v${version}`
  const dmg = `Diffra-${version}-${ARCH}.dmg`
  const zip = `Diffra-${version}-${ARCH}.zip`
  const packages = [dmg, zip]
  const files = [dmg, zip, `${dmg}.blockmap`, `${zip}.blockmap`, 'latest-mac.yml']
  const publish = Array.isArray(builderConfig.mac?.publish) ? builderConfig.mac.publish[0] : null
  const publicUrl = publish && typeof publish === 'object' && 'url' in publish && typeof publish.url === 'string' ? publish.url : null
  if (!publicUrl) throw new Error('electron-builder.config.ts 的 mac 里没有更新源地址')
  if (process.env.DIFFRA_UPDATE_URL) throw new Error('设置了 DIFFRA_UPDATE_URL（只用于本地演练），正式发布前先清掉')

  const config = loadPublishConfig()
  // Mac 的目录和 Windows 的并排：…/win → …/mac
  const macDir = config.macRemoteDir ?? posix.join(posix.dirname(config.remoteDir), 'mac')
  const { ssh, upload } = remote(config)
  const workDir = local ? null : mkdtempSync(join(tmpdir(), 'diffra-publish-mac-'))
  const sourceDir = workDir ?? join(desktopDir, 'release')
  try {
    if (local) {
      console.log('使用本机 release/ 里的构建产物…')
      if (!existsSync(join(sourceDir, 'latest-mac.yml'))) throw new Error('没有找到 release/latest-mac.yml，先运行 pnpm --filter @diffra/desktop package:mac')
    } else {
      console.log(`下载 ${tag} 的 Mac 安装包…`)
      await run('gh', ['release', 'download', tag, ...files.flatMap((name) => ['--pattern', name]), '--dir', sourceDir, '--clobber'], DOWNLOAD_TIMEOUT_MS)
    }

    const latestText = readFileSync(join(sourceDir, 'latest-mac.yml'), 'utf8')
    const listed = parseFiles(latestText)
    const latestVersion = /^version: (.+)$/m.exec(latestText)?.[1]?.trim()
    const problems: string[] = latestVersion === version ? [] : [`latest-mac.yml 的版本是 ${latestVersion}，不是 ${version}`]
    const sizes = new Map<string, number>()
    for (const name of packages) {
      const bytes = readFileSync(join(sourceDir, name))
      sizes.set(name, bytes.length)
      const entry = listed.get(name)
      if (!entry) problems.push(`latest-mac.yml 里没有 ${name}`)
      else if (entry.sha512 !== createHash('sha512').update(bytes).digest('base64')) problems.push(`${name} 的 sha512 和 latest-mac.yml 对不上`)
      else if (entry.size !== bytes.length) problems.push(`${name} 的大小 ${bytes.length} 和 latest-mac.yml 的 ${entry.size} 对不上`)
    }
    if (problems.length > 0) throw new Error(`安装包没通过核对，没有上传：\n${problems.join('\n')}`)
    console.log(`核对通过：${dmg}，${((sizes.get(dmg) ?? 0) / 1024 / 1024).toFixed(1)}MB`)

    await ssh(`mkdir -p '${macDir}'`)
    for (const name of files) {
      console.log(`上传 ${name}…`)
      await upload(join(sourceDir, name), `${macDir}/${name}`)
    }
    // 先建好新的链接再改名替换，换的瞬间也不会下到半个文件
    await ssh(`cd '${macDir}' && ln -sfn '${dmg}' '${LATEST_ALIAS}.partial' && mv -Tf '${LATEST_ALIAS}.partial' '${LATEST_ALIAS}'`)

    const online = await fetch(`${publicUrl}latest-mac.yml`, { headers: { Origin: SITE_ORIGIN }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!online.ok || (await online.text()) !== latestText) throw new Error(`线上的 latest-mac.yml 和刚上传的不一致（HTTP ${online.status}）`)
    for (const name of [dmg, LATEST_ALIAS]) {
      const head = await fetch(`${publicUrl}${name}`, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!head.ok || Number(head.headers.get('content-length')) !== sizes.get(dmg)) throw new Error(`线上的 ${name} 大小不对（HTTP ${head.status}）`)
    }
    if (online.headers.get('access-control-allow-origin') !== SITE_ORIGIN) {
      console.warn(`注意：${publicUrl}latest-mac.yml 没有给 ${SITE_ORIGIN} 的跨域头，官网下载页读不到 Mac 版的版本号和大小（下载按钮照样能用）。要在 nginx 里给 /mac/ 的 .yml 也加上 Access-Control-Allow-Origin`)
    }
    console.log(`已发布 Mac 版 ${version}。官网下载按钮现在指向它：${publicUrl}${LATEST_ALIAS}`)
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
