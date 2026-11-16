import { languageOf, listProjectFiles } from '../rules/languages.js'
import { SECURITY_TOOLS, type SecurityTool, type SecurityToolReport, type SecurityToolsInfo } from '../protocol.js'
import { discoverRoutes, runDynamicTests } from './dynamic.js'
import { runCodeql, runSemgrep, scannerVersions, type ToolFinding } from './external.js'
import { type LicenseReport, projectIsCopyleft, scanLicenses } from './licenses.js'

export { SECURITY_TOOLS, type SecurityTool, type SecurityToolReport, type SecurityToolsInfo }

// 任务页「更多安全检查」（v2 · M10）：依赖许可证、外部扫描器（Semgrep、CodeQL）、动态测试，都是用户手动发起、跑完给一份报告，
// 用户勾选后填进输入框让智能体修。每样都有超时，可以取消

const TIMEOUTS: Record<SecurityTool, number> = { licenses: 60_000, semgrep: 10 * 60_000, codeql: 30 * 60_000, dynamic: 5 * 60_000 }
const ROUTE_FILE = /\.(?:[cm]?[jt]sx?|py|java|kt)$/
const MAX_ROUTE_FILES = 2000



export async function securityToolsInfo(cwd: string, rgPath: string): Promise<SecurityToolsInfo> {
  const [versions, files] = await Promise.all([scannerVersions(), listProjectFiles(cwd, rgPath)])
  const routes = await discoverRoutes(cwd, files.filter((file) => ROUTE_FILE.test(file) && !/(^|\/)(node_modules|dist|build|test|tests|__tests__)\//.test(file)).slice(0, MAX_ROUTE_FILES))
  return { ...versions, routes }
}

export interface SecurityToolParams {
  cwd: string
  tool: SecurityTool
  rgPath: string
  baseUrl?: string
  routes?: string[]
  // 用户确认过有 CodeQL 的使用许可（开源项目，或者有 GitHub Advanced Security）
  codeqlLicensed?: boolean
}

export function licenseFindings(report: LicenseReport): ToolFinding[] {
  const copyleft = projectIsCopyleft(report.project)
  return report.dependencies.flatMap((item): ToolFinding[] => {
    const name = `${item.name}${item.version ? `@${item.version}` : ''}`
    if (item.kind === 'strong-copyleft' && !copyleft)
      return [{ tool: 'licenses', ruleId: 'LICENSE-COPYLEFT', severity: 'medium', path: item.declaredIn, line: null, message: `${name} 是 ${item.license}：强传染的许可证，用了它项目可能要按同样的许可证开源${report.project ? `（项目是 ${report.project}）` : ''}` }]
    if (item.kind === 'unknown') return [{ tool: 'licenses', ruleId: 'LICENSE-UNKNOWN', severity: 'low', path: item.declaredIn, line: null, message: `${name} 认不出许可证${item.license ? `（写的是 ${item.license}）` : '（没写）'}，要人看一下` }]
    return []
  })
}

export async function runSecurityTool(params: SecurityToolParams, signal: AbortSignal): Promise<SecurityToolReport> {
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const done = (findings: ToolFinding[], notes: string[], extra: Partial<SecurityToolReport> = {}): SecurityToolReport => ({ tool: params.tool, startedAt, durationMs: Math.round(performance.now() - started), findings, notes, ...extra })
  const timeout = TIMEOUTS[params.tool]
  switch (params.tool) {
    case 'licenses': {
      const report = await scanLicenses(params.cwd)
      if (signal.aborted) throw new Error('取消了')
      const notes = [...report.notes, `查了 ${report.dependencies.length} 个依赖${report.project ? `，项目自己是 ${report.project}` : '，项目没写许可证'}`]
      return done(licenseFindings(report), notes, { licenses: report })
    }
    case 'semgrep': {
      if (!(await scannerVersions(true)).semgrep) throw new Error('本机没装 Semgrep（pip install semgrep 或 brew install semgrep），装好后再试')
      const { findings, notes } = await runSemgrep(params.cwd, null, timeout, signal)
      return done(findings, notes)
    }
    case 'codeql': {
      if (!params.codeqlLicensed) throw new Error('先确认有 CodeQL 的使用许可（开源项目，或者有 GitHub Advanced Security）')
      if (!(await scannerVersions(true)).codeql) throw new Error('本机没装 CodeQL 命令行（从 github.com/github/codeql-action/releases 下载），装好后再试')
      const files = await listProjectFiles(params.cwd, params.rgPath)
      const languages = [...new Set(files.flatMap((file) => languageOf(file) ?? []))]
      const { findings, notes } = await runCodeql(params.cwd, languages, timeout, signal)
      return done(findings, notes)
    }
    case 'dynamic': {
      if (!params.baseUrl) throw new Error('填一个本机服务的地址，比如 http://localhost:3000')
      const { findings, notes } = await runDynamicTests({ baseUrl: params.baseUrl, routes: params.routes ?? [], signal })
      return done(findings, notes)
    }
  }
}
