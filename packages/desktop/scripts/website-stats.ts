// 官网和更新服务的访问统计：pnpm --filter @diffra/desktop stats
// 数据来自服务器的 nginx 访问日志（隐私政策里写了：保留 180 天，只看汇总，不公开）。
// 在服务器上用 GoAccess 生成报表，下载到 out/stats/ 本机打开；另外在终端里打几项关键数字：
// 安装包下载次数、每天检查更新的不同 IP 数（大致等于在用的安装数）
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { desktopDir, loadPublishConfig, remote } from './remote.ts'

const REPORT = '/tmp/diffra-stats.html'

async function main(): Promise<void> {
  const config = loadPublishConfig()
  const { ssh, download } = remote(config)
  const logs = `zcat -f ${config.accessLogs}`
  const installed = await ssh('command -v goaccess || true')
  if (!installed.trim()) throw new Error('服务器上没装 GoAccess：先在服务器上 apt install goaccess（见 docs/decisions.md「官网」）')

  const downloads = await ssh(`${logs} | awk '$9 == 200 && $7 ~ /^\\/win\\/Diffra-Setup-.*\\.exe$/' | wc -l`)
  // 每行「次数 日/月/年」，日志里的日期是 10/Nov/2026 这种，在本机按日期排
  const daily = (
    await ssh(`${logs} | awk '$7 == "/win/latest.yml" { split($4, t, ":"); print substr(t[1], 2), $1 }' | sort -u | awk '{ print $1 }' | sort | uniq -c`)
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [count = '', day = ''] = line.trim().split(/\s+/)
      return { day, count, time: Date.parse(day.replaceAll('/', ' ')) }
    })
    .sort((a, b) => a.time - b.time)
    .slice(-14)
  console.log(`安装包完整下载次数（日志保留期内）：${downloads.trim()}`)
  console.log('最近 14 天每天检查更新的不同 IP 数：')
  console.log(daily.map((item) => `  ${item.day}  ${item.count}`).join('\n') || '  （没有记录）')

  await ssh(`${logs} | goaccess - --log-format=COMBINED --no-global-config --ignore-crawlers -o ${REPORT} > /dev/null 2>&1`)
  const outDir = join(desktopDir, 'out', 'stats')
  mkdirSync(outDir, { recursive: true })
  const local = join(outDir, `report-${new Date().toISOString().slice(0, 10)}.html`)
  await download(REPORT, local)
  await ssh(`rm -f ${REPORT}`)
  console.log(`完整报表：${local}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
