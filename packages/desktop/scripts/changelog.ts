// 从提交信息生成更新日志：node scripts/changelog.ts [--check] [--notes <文件>]
// - 按 v<版本号> 的 tag 分版本，每个版本收它和上一个 tag 之间的 feat、fix 提交（规则见 src/shared/changelog.ts）
// - package.json 的版本比最新的 tag 新（改了版本号还没打 tag）时，最新 tag 之后的提交算这个版本，日期是今天
// - 写到 out/changelog.json，客户端从这里读；electron-builder.config.ts 也从这里取这个版本的说明写进 latest.yml
// - 早期几条英文提交按 scripts/changelog-overrides.ts 换成中文
// - --check：package.json 这个版本一条日志都没有、或者有不是中文的条目就失败（CI 发版前用）
// - --notes <文件>：把这个版本的说明写到文件里（GitHub Release 用）
// - 官网的更新日志页由 build-website.ts 生成
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ChangelogRelease, compareVersions, formatNotes, releaseItems } from '../src/shared/changelog.ts'
import { SUBJECT_OVERRIDES } from './changelog-overrides.ts'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CHANGELOG_FILE = join(desktopDir, 'out', 'changelog.json')
const TAG = /^v(\d+\.\d+\.\d+)$/

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: desktopDir, encoding: 'utf8', windowsHide: true })
}

function subjects(range: string): string[] {
  return git(['log', '--no-merges', '--format=%H%x09%s', range])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [hash = '', ...rest] = line.split('\t')
      return SUBJECT_OVERRIDES[hash] ?? rest.join('\t')
    })
    .reverse()
}

const CHINESE = /[一-鿿]/

// 发版前的检查：这一版至少一条日志，每条都是中文。没问题返回 null
export function checkRelease(version: string, release: ChangelogRelease | undefined): string | null {
  const items = release ? [...release.added, ...release.fixed] : []
  if (items.length === 0) return `${version} 没有更新日志：上一个版本之后没有 feat 或 fix 提交。发版前至少要有一条用户看得到的改动`
  const english = items.filter((item) => !CHINESE.test(item))
  if (english.length === 0) return null
  return `更新日志要用中文，这些条目不是：\n${english.map((item) => `- ${item}`).join('\n')}\n改提交信息，或者在 scripts/changelog-overrides.ts 里按提交哈希写中文说明`
}

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// 新的版本在前
export function readChangelog(): ChangelogRelease[] {
  const version = (JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version
  const tags = git(['for-each-ref', '--format=%(refname:short)\t%(creatordate:short)', 'refs/tags/v*'])
    .split('\n')
    .flatMap((line) => {
      const [name = '', date = ''] = line.split('\t')
      const match = TAG.exec(name)
      return match?.[1] ? [{ name, version: match[1], date }] : []
    })
    .sort((a, b) => compareVersions(a.version, b.version))
  const releases: ChangelogRelease[] = tags.map((tag, index) => {
    const previous = tags[index - 1]
    return { version: tag.version, date: tag.date, ...releaseItems(subjects(previous ? `${previous.name}..${tag.name}` : tag.name)) }
  })
  const latest = tags.at(-1)
  if (!latest || compareVersions(version, latest.version) > 0) {
    releases.push({ version, date: today(), ...releaseItems(subjects(latest ? `${latest.name}..HEAD` : 'HEAD')) })
  }
  return releases.reverse()
}

function main(): void {
  const args = process.argv.slice(2)
  const releases = readChangelog()
  mkdirSync(dirname(CHANGELOG_FILE), { recursive: true })
  writeFileSync(CHANGELOG_FILE, `${JSON.stringify(releases, null, 2)}\n`)
  const version = (JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version: string }).version
  const current = releases.find((release) => release.version === version)
  if (args.includes('--check')) {
    const problem = checkRelease(version, current)
    if (problem) throw new Error(problem)
  }
  const notesIndex = args.indexOf('--notes')
  const notesFile = notesIndex >= 0 ? args[notesIndex + 1] : undefined
  if (notesFile) writeFileSync(notesFile, `${current ? formatNotes(current) : ''}\n`)
  console.log(`更新日志：${releases.length} 个版本，写到 ${CHANGELOG_FILE}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
