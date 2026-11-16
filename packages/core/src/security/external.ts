import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { runProcess } from '../process.js'
import type { ToolFinding } from '../protocol.js'
import { commandEnv } from '../tools/command.js'

export type { ToolFinding }

// 外部扫描器（v2 · M10）：本机装了 Semgrep、CodeQL 才用，Diffra 不自带也不帮着装。
// Semgrep 的命令行是 LGPL，规则用项目自己的配置（.semgrep.yml）或官方规则库（要联网）；
// CodeQL 的命令行只许用在开源代码上、或者有 GitHub Advanced Security 授权的私有代码上，跑之前要用户确认有许可。
// 找不到时可以用 DIFFRA_SEMGREP_PATH、DIFFRA_CODEQL_PATH 指定可执行文件（.js/.mjs 用 Node 跑，测试用）

export interface ScannerVersions {
  semgrep: string | null
  codeql: string | null
}

const VERSION_TIMEOUT_MS = 15_000
const SEMGREP_LOCAL_CONFIGS = ['.semgrep.yml', '.semgrep.yaml', 'semgrep.yml', '.semgrep']
const MAX_FINDINGS = 500
// CodeQL 不用编译就能建数据库的语言，和 Diffra 的语言名对应
export const CODEQL_LANGUAGES: Record<string, { language: string; pack: string; suite: string }> = {
  typescript: { language: 'javascript-typescript', pack: 'codeql/javascript-queries', suite: 'javascript-security-extended.qls' },
  javascript: { language: 'javascript-typescript', pack: 'codeql/javascript-queries', suite: 'javascript-security-extended.qls' },
  python: { language: 'python', pack: 'codeql/python-queries', suite: 'python-security-extended.qls' },
  java: { language: 'java-kotlin', pack: 'codeql/java-queries', suite: 'java-security-extended.qls' },
  csharp: { language: 'csharp', pack: 'codeql/csharp-queries', suite: 'csharp-security-extended.qls' },
  ruby: { language: 'ruby', pack: 'codeql/ruby-queries', suite: 'ruby-security-extended.qls' },
}

function command(tool: 'semgrep' | 'codeql'): { file: string; prefix: string[] } {
  const override = process.env[tool === 'semgrep' ? 'DIFFRA_SEMGREP_PATH' : 'DIFFRA_CODEQL_PATH']
  if (override && /\.(m?js)$/.test(override)) return { file: process.execPath, prefix: [override] }
  return { file: override || tool, prefix: [] }
}

async function run(tool: 'semgrep' | 'codeql', args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  const { file, prefix } = command(tool)
  return runProcess(file, [...prefix, ...args], { cwd, timeoutMs, signal, env: commandEnv() })
}

let cached: { at: number; value: ScannerVersions } | null = null

// 装了没有、什么版本；结果留 10 分钟（每次打开对话框都探一遍太慢）
export async function scannerVersions(fresh = false): Promise<ScannerVersions> {
  if (!fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.value
  const probe = async (tool: 'semgrep' | 'codeql', args: string[]) => {
    try {
      const result = await run(tool, args, process.cwd(), VERSION_TIMEOUT_MS)
      if (result.exitCode !== 0) return null
      // 输出里可能混着 stderr 的警告：取第一个像版本号的行
      const lines = result.output.trim().split(/\r?\n/)
      return (lines.find((line) => /^\s*v?\d+\.\d+/.test(line)) ?? lines[0] ?? '').trim().slice(0, 80) || '已安装'
    } catch {
      return null
    }
  }
  const [semgrep, codeql] = await Promise.all([probe('semgrep', ['--version']), probe('codeql', ['version', '--format=terse'])])
  cached = { at: Date.now(), value: { semgrep, codeql } }
  return cached.value
}

const SEMGREP_SEVERITY: Record<string, ToolFinding['severity']> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' }

// files 为 null 时扫整个项目；只扫给的文件时（完成前）只看本轮改过的
export async function runSemgrep(cwd: string, files: string[] | null, timeoutMs: number, signal?: AbortSignal): Promise<{ findings: ToolFinding[]; notes: string[] }> {
  const local = SEMGREP_LOCAL_CONFIGS.find((name) => existsSync(join(cwd, name)))
  const notes = [local ? `规则用项目里的 ${local}` : '规则用 Semgrep 官方的 p/default（要联网下载）']
  const args = ['scan', '--json', '--metrics=off', '--disable-version-check', '--quiet', '--timeout', '30', '--config', local ?? 'p/default', ...(files ?? ['.'])]
  const result = await run('semgrep', args, cwd, timeoutMs, signal)
  if (result.aborted) throw new Error('取消了')
  if (result.timedOut) notes.push(`Semgrep 超过 ${Math.round(timeoutMs / 1000)} 秒没跑完，停掉了`)
  const start = result.output.indexOf('{')
  if (start < 0) throw new Error(`Semgrep 没有输出结果：${result.output.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`)
  const report = JSON.parse(result.output.slice(start, result.output.lastIndexOf('}') + 1)) as {
    results?: Array<{ check_id: string; path: string; start: { line: number }; extra: { message: string; severity: string } }>
    errors?: Array<{ message?: string }>
  }
  for (const error of (report.errors ?? []).slice(0, 3)) if (error.message) notes.push(`Semgrep：${error.message.slice(0, 200)}`)
  const findings = (report.results ?? []).slice(0, MAX_FINDINGS).map((item) => ({
    tool: 'semgrep' as const,
    ruleId: item.check_id.split('.').pop() ?? item.check_id,
    severity: SEMGREP_SEVERITY[item.extra.severity] ?? 'medium',
    path: item.path.replace(/\\/g, '/'),
    line: item.start.line,
    message: item.extra.message.replace(/\s+/g, ' ').trim(),
  }))
  return { findings, notes }
}

interface Sarif {
  runs?: Array<{ results?: Array<{ ruleId?: string; level?: string; message?: { text?: string }; locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }> }> }>
}

const SARIF_LEVEL: Record<string, ToolFinding['severity']> = { error: 'high', warning: 'medium', note: 'low' }

export function sarifFindings(sarif: Sarif, root: string): ToolFinding[] {
  return (sarif.runs ?? []).flatMap((run) =>
    (run.results ?? []).map((item) => {
      const location = item.locations?.[0]?.physicalLocation
      const uri = decodeURIComponent(location?.artifactLocation?.uri ?? '').replace(/^file:\/+/, '')
      const path = /^[A-Za-z]:|^\//.test(uri) ? relative(root, uri).replace(/\\/g, '/') : uri
      return { tool: 'codeql' as const, ruleId: item.ruleId ?? 'codeql', severity: SARIF_LEVEL[item.level ?? 'warning'] ?? 'medium', path, line: location?.region?.startLine ?? null, message: (item.message?.text ?? '').replace(/\s+/g, ' ').trim() }
    }),
  )
}

// 每种语言建一个数据库、跑官方的 security-extended 查询集；查询包没下载过时用 --download 取（要联网）。临时目录跑完就删
export async function runCodeql(cwd: string, languages: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ findings: ToolFinding[]; notes: string[] }> {
  const targets = [...new Map(languages.flatMap((language) => (CODEQL_LANGUAGES[language] ? [[CODEQL_LANGUAGES[language]!.language, CODEQL_LANGUAGES[language]!] as const] : []))).values()]
  if (targets.length === 0) throw new Error('项目里没有 CodeQL 不用编译就能分析的语言（JS/TS、Python、Java、C#、Ruby）')
  const dir = await mkdtemp(join(tmpdir(), 'diffra-codeql-'))
  const deadline = Date.now() + timeoutMs
  const notes: string[] = []
  const findings: ToolFinding[] = []
  try {
    for (const target of targets) {
      const left = deadline - Date.now()
      if (left <= 0) {
        notes.push(`超时了，${target.language} 没有分析`)
        continue
      }
      const db = join(dir, target.language)
      const created = await run('codeql', ['database', 'create', db, `--language=${target.language}`, `--source-root=${cwd}`, '--build-mode=none', '--overwrite'], cwd, left, signal)
      if (created.aborted) throw new Error('取消了')
      if (created.exitCode !== 0) {
        notes.push(`${target.language} 建数据库失败：${created.output.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? ''}`)
        continue
      }
      const output = join(dir, `${target.language}.sarif`)
      const analyzed = await run('codeql', ['database', 'analyze', db, '--format=sarif-latest', `--output=${output}`, '--download', `${target.pack}:codeql-suites/${target.suite}`], cwd, Math.max(1000, deadline - Date.now()), signal)
      if (analyzed.aborted) throw new Error('取消了')
      if (analyzed.exitCode !== 0 || !existsSync(output)) {
        notes.push(`${target.language} 分析失败：${analyzed.output.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? ''}`)
        continue
      }
      findings.push(...sarifFindings(JSON.parse(await readFile(output, 'utf8')) as Sarif, cwd))
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => console.error('[security] 清理 CodeQL 临时目录失败', error))
  }
  return { findings: findings.slice(0, MAX_FINDINGS), notes }
}
