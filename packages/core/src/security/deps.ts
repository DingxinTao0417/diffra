import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type PackageJson, packageManagerOf, projectPython } from '../project/detect.js'
import { runProcess } from '../process.js'
import { commandEnv } from '../tools/command.js'
import type { AddedLines, SecurityFinding } from './types.js'

const AUDIT_TIMEOUT_SECONDS = 60
const NODE_MANIFESTS = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml'])
const PYTHON_MANIFESTS = /^(requirements.*\.txt|pyproject\.toml)$/

// 审计的 JSON 输出可能很长，不能用 runShell（它会截成首尾各 200 行）
function runAudit(cwd: string, bashPath: string, command: string, signal: AbortSignal) {
  return runProcess(bashPath, ['-c', command], { cwd, timeoutMs: AUDIT_TIMEOUT_SECONDS * 1000, signal, env: commandEnv() })
}

// 输出里可能混着 stderr 的警告，只取第一个 { 到最后一个 } 之间
function jsonIn(output: string): unknown {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('没有 JSON 输出')
  return JSON.parse(output.slice(start, end + 1))
}

function firstLine(output: string): string {
  return (output.trim().split(/\r?\n/)[0] ?? '').slice(0, 200)
}

export function dependenciesChanged(added: AddedLines): boolean {
  return [...added.keys()].some((path) => !path.includes('/') && (NODE_MANIFESTS.has(path) || PYTHON_MANIFESTS.test(basename(path))))
}

export interface AuditResult {
  findings: SecurityFinding[]
  // 卡片上的说明：没漏洞、跳过的原因、项目原有的漏洞数
  notes: string[]
  // 该审计的清单都审计完了：跳过、失败、超时或新依赖没进锁文件时为 false
  complete: boolean
  // 项目原有、和本轮改动无关的漏洞数
  existing: number
}

// 只把本轮新加或改了版本的依赖算到这一轮头上：高危、严重打回换版本，其余提醒；项目原有的漏洞只报数量。
// 审计要联网查漏洞库，失败或超时只在卡片上说明，不拦截
export async function auditDependencies(cwd: string, added: AddedLines, bashPath: string | null, signal: AbortSignal): Promise<AuditResult> {
  const result: AuditResult = { findings: [], notes: [], complete: true, existing: 0 }
  if (!bashPath) {
    result.complete = false
    result.notes.push('依赖审计需要 Git Bash，这一轮跳过了')
    return result
  }
  const paths = [...added.keys()]
  if (paths.some((path) => NODE_MANIFESTS.has(path))) await auditNode(cwd, added, bashPath, signal, result)
  if (paths.some((path) => !path.includes('/') && PYTHON_MANIFESTS.test(path))) await auditPython(cwd, added, bashPath, signal, result)
  return result
}

// package.json 里本轮新增的依赖行：名字 → 行号
function addedNodeDependencies(pkg: PackageJson, added: AddedLines): Map<string, number> {
  const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  const found = new Map<string, number>()
  for (const [line, text] of added.get('package.json') ?? []) {
    const match = /^\s*"(@?[^"]+)"\s*:/.exec(text)
    if (match?.[1] && names.has(match[1])) found.set(match[1], line)
  }
  return found
}

async function auditNode(cwd: string, added: AddedLines, bashPath: string, signal: AbortSignal, result: AuditResult): Promise<void> {
  let pkg: PackageJson
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as PackageJson
  } catch {
    result.complete = false
    result.notes.push('读不了 package.json，跳过了依赖审计')
    return
  }
  const pm = await packageManagerOf(cwd, pkg)
  if (pm !== 'pnpm' && pm !== 'npm') {
    result.complete = false
    result.notes.push(`${pm} 项目暂不支持依赖审计`)
    return
  }
  const run = await runAudit(cwd, bashPath, `${pm} audit --json`, signal)
  if (run.timedOut || run.aborted) {
    result.complete = false
    result.notes.push(`依赖审计没有完成（${run.timedOut ? '超时' : '已停止'}），这次不拦截`)
    return
  }
  // 有漏洞时 audit 的退出码不是 0，按输出判断
  let report: unknown
  try {
    report = jsonIn(run.output)
  } catch {
    result.complete = false
    result.notes.push(`依赖审计没有完成，这次不拦截：${firstLine(run.output)}`)
    return
  }
  // 没有锁文件、联网失败等情况 audit 也输出 JSON，内容是 error 对象
  const failure = (report as { error?: { code?: string; summary?: string; message?: string } }).error
  if (failure) {
    result.complete = false
    result.notes.push(`依赖审计没有完成，这次不拦截：${firstLine(failure.summary ?? failure.message ?? failure.code ?? '')}`)
    return
  }
  const fresh = addedNodeDependencies(pkg, added)
  if (fresh.size > 0 && !added.has('pnpm-lock.yaml') && !added.has('package-lock.json')) {
    result.complete = false
    result.notes.push('package.json 加了依赖但锁文件没变，新依赖可能还没安装，审计里没有它们')
  }
  const vulnerabilities = pm === 'pnpm' ? pnpmVulnerabilities(report) : npmVulnerabilities(report)
  let existing = 0
  for (const item of vulnerabilities) {
    const owner = item.directDependencies.find((name) => fresh.has(name))
    if (!owner) {
      existing++
      continue
    }
    const serious = item.severity === 'high' || item.severity === 'critical'
    result.findings.push({
      ruleId: 'DEP-VULN',
      severity: serious ? 'high' : 'medium',
      path: 'package.json',
      line: fresh.get(owner) ?? 1,
      message: `本轮加入的依赖 ${owner} 带有已知漏洞（${item.name}，${item.severity}：${item.title}）${item.fix ? `，升级到 ${item.fix}` : '，换一个没有这个漏洞的版本或替代包'}`,
      suppressed: null,
    })
  }
  result.existing += existing
  if (existing > 0) result.notes.push(`项目原有 ${existing} 个依赖漏洞，和本轮改动无关，没有计入`)
  if (result.findings.length === 0 && existing === 0) result.notes.push('依赖审计：没有发现已知漏洞')
}

interface Vulnerability {
  name: string
  severity: string
  title: string
  fix: string | null
  // 漏洞经由哪些直接依赖引入
  directDependencies: string[]
}

// pnpm audit --json：advisories，每条带依赖路径「导入方>直接依赖>…>有漏洞的包」
function pnpmVulnerabilities(report: unknown): Vulnerability[] {
  const advisories = (report as { advisories?: Record<string, unknown> }).advisories ?? {}
  return Object.values(advisories).map((value) => {
    const advisory = value as { module_name?: string; severity?: string; title?: string; patched_versions?: string; findings?: Array<{ paths?: string[] }> }
    const direct = new Set<string>()
    for (const finding of advisory.findings ?? []) for (const path of finding.paths ?? []) direct.add(path.split('>')[1] ?? '')
    return {
      name: advisory.module_name ?? '',
      severity: advisory.severity ?? 'unknown',
      title: advisory.title ?? '',
      fix: advisory.patched_versions && advisory.patched_versions !== '<0.0.0' ? `${advisory.module_name} ${advisory.patched_versions}` : null,
      directDependencies: [...direct],
    }
  })
}

// npm audit --json（npm 7 起）：vulnerabilities 按包名列出，直接依赖本身也会列出来（via 指向下层）
function npmVulnerabilities(report: unknown): Vulnerability[] {
  const entries = (report as { vulnerabilities?: Record<string, unknown> }).vulnerabilities ?? {}
  return Object.values(entries).map((value) => {
    const entry = value as { name?: string; severity?: string; via?: Array<string | { title?: string }>; fixAvailable?: boolean | { name?: string; version?: string } }
    const title = entry.via?.map((via) => (typeof via === 'string' ? `经由 ${via}` : (via.title ?? ''))).filter(Boolean)[0] ?? ''
    const fix = typeof entry.fixAvailable === 'object' && entry.fixAvailable.name ? `${entry.fixAvailable.name}@${entry.fixAvailable.version ?? ''}` : null
    return { name: entry.name ?? '', severity: entry.severity ?? 'unknown', title, fix, directDependencies: entry.name ? [entry.name] : [] }
  })
}

// requirements*.txt / pyproject.toml 里本轮新增的依赖：规范化后的名字 → 行号
function addedPythonDependencies(added: AddedLines): Map<string, { path: string; line: number }> {
  const found = new Map<string, { path: string; line: number }>()
  for (const [path, lines] of added) {
    if (path.includes('/') || !PYTHON_MANIFESTS.test(path)) continue
    for (const [line, text] of lines) {
      const match = /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|>|<|"|,|$)/.exec(text)
      if (match?.[1] && !/^(name|version|description|requires-python|readme|license)$/i.test(match[1])) {
        found.set(match[1].toLowerCase().replace(/[._]/g, '-'), { path, line })
      }
    }
  }
  return found
}

async function auditPython(cwd: string, added: AddedLines, bashPath: string, signal: AbortSignal, result: AuditResult): Promise<void> {
  const python = await projectPython(cwd)
  if (!python) {
    result.complete = false
    result.notes.push('没找到项目的虚拟环境，跳过了 Python 依赖审计')
    return
  }
  const run = await runAudit(cwd, bashPath, `${python} -m pip_audit -f json --progress-spinner off`, signal)
  if (run.timedOut || run.aborted) {
    result.complete = false
    result.notes.push(`Python 依赖审计没有完成（${run.timedOut ? '超时' : '已停止'}），这次不拦截`)
    return
  }
  if (/No module named pip_audit/.test(run.output)) {
    result.complete = false
    result.notes.push('虚拟环境里没装 pip-audit，跳过了 Python 依赖审计')
    return
  }
  let report: { dependencies?: Array<{ name?: string; version?: string; vulns?: Array<{ id?: string; fix_versions?: string[] }> }> }
  try {
    report = jsonIn(run.output) as typeof report
  } catch {
    result.complete = false
    result.notes.push(`Python 依赖审计没有完成，这次不拦截：${firstLine(run.output)}`)
    return
  }
  const fresh = addedPythonDependencies(added)
  let existing = 0
  for (const dependency of report.dependencies ?? []) {
    for (const vuln of dependency.vulns ?? []) {
      const where = fresh.get((dependency.name ?? '').toLowerCase().replace(/[._]/g, '-'))
      if (!where) {
        existing++
        continue
      }
      const fix = vuln.fix_versions?.[0]
      // pip-audit 不给严重程度：有修复版本时打回升级，没有时提醒
      result.findings.push({
        ruleId: 'DEP-VULN',
        severity: fix ? 'high' : 'medium',
        path: where.path,
        line: where.line,
        message: `本轮加入的依赖 ${dependency.name} ${dependency.version ?? ''} 带有已知漏洞（${vuln.id ?? ''}）${fix ? `，升级到 ${fix}` : '，暂无修复版本，确认是否必须使用'}`,
        suppressed: null,
      })
    }
  }
  result.existing += existing
  if (existing > 0) result.notes.push(`项目原有 ${existing} 个 Python 依赖漏洞，和本轮改动无关，没有计入`)
  if (result.findings.length === 0 && existing === 0) result.notes.push('Python 依赖审计：没有发现已知漏洞')
}
