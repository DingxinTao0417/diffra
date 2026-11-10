// 生成官网（build-website.ts）并传到服务器：node scripts/publish-website.ts
// 每个文件先传成 .partial 再改名；传完从公网取回每个页面核对。
// 更新日志按 tag 生成，发完新版本（publish:release）再发官网
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { buildWebsite, SITE_ORIGIN, WEBSITE_OUT } from './build-website.ts'
import { loadPublishConfig, remote } from './remote.ts'

const FETCH_TIMEOUT_MS = 30_000

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesIn(path) : [path]
  })
}

async function main(): Promise<void> {
  const pages = buildWebsite()
  const config = loadPublishConfig()
  const { ssh, upload } = remote(config)
  await ssh(`test -d '${config.siteDir}'`)
  const files = filesIn(WEBSITE_OUT).map((path) => relative(WEBSITE_OUT, path).replaceAll('\\', '/'))
  const dirs = [...new Set(files.map((file) => file.split('/').slice(0, -1).join('/')).filter(Boolean))]
  for (const dir of dirs) await ssh(`mkdir -p '${config.siteDir}/${dir}'`)
  for (const file of files) {
    console.log(`上传 ${file}…`)
    await upload(join(WEBSITE_OUT, file), `${config.siteDir}/${file}`)
  }

  for (const page of pages.filter((name) => name !== '404.html')) {
    const url = `${SITE_ORIGIN}/${page === 'index.html' ? '' : page}`
    const online = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!online.ok || (await online.text()) !== readFileSync(join(WEBSITE_OUT, page), 'utf8')) {
      throw new Error(`线上的 ${url} 和刚上传的不一致（HTTP ${online.status}）`)
    }
  }
  console.log(`官网已更新：${SITE_ORIGIN}/（${files.length} 个文件）`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
