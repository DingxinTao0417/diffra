// 把仓库 website/ 下的官网文件传到服务器：node scripts/publish-website.ts
// 每个文件先传成 .partial 再改名，传完从公网取回首页核对
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { desktopDir, loadPublishConfig, remote } from './remote.ts'

const SITE_URL = 'https://diffra.dev/'
const FETCH_TIMEOUT_MS = 30_000
const websiteDir = resolve(desktopDir, '../../website')

async function main(): Promise<void> {
  const config = loadPublishConfig()
  const { ssh, upload } = remote(config)
  const files = readdirSync(websiteDir).filter((name) => statSync(join(websiteDir, name)).isFile())
  if (!files.includes('index.html')) throw new Error(`${websiteDir} 里没有 index.html`)

  await ssh(`test -d '${config.siteDir}'`)
  for (const name of files) {
    console.log(`上传 ${name}…`)
    await upload(join(websiteDir, name), `${config.siteDir}/${name}`)
  }

  const online = await fetch(SITE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!online.ok || (await online.text()) !== readFileSync(join(websiteDir, 'index.html'), 'utf8')) {
    throw new Error(`线上的首页和刚上传的不一致（HTTP ${online.status}）`)
  }
  console.log(`官网已更新：${SITE_URL}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
