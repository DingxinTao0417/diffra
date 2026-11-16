import { languageOf } from '../rules/languages.js'
import { addedDependencies, dependenciesChanged } from './deps.js'
import { runSemgrep, scannerVersions } from './external.js'
import { classifyLicense, projectIsCopyleft, scanLicenses } from './licenses.js'
import type { AddedLines, SecurityFinding } from './types.js'

// 完成前、和静态检查一起跑的两样（v2 · M10）：都只提醒、不打回
const SEMGREP_GATE_TIMEOUT_MS = 90_000

// 本轮新加的依赖里有强传染许可证的（项目自己不是这类许可证时）：提醒换一个或确认能接受
export async function gateLicenses(cwd: string, added: AddedLines): Promise<{ findings: SecurityFinding[]; notes: string[] }> {
  if (!dependenciesChanged(added)) return { findings: [], notes: [] }
  const declared = await addedDependencies(cwd, added)
  if (declared.size === 0) return { findings: [], notes: [] }
  const report = await scanLicenses(cwd, new Set(declared.keys()))
  if (projectIsCopyleft(report.project)) return { findings: [], notes: [] }
  const findings = report.dependencies.flatMap((item): SecurityFinding[] => {
    const at = declared.get(item.ecosystem === 'python' ? item.name.toLowerCase().replace(/[._]/g, '-') : item.name)
    if (!at || classifyLicense(item.license) !== 'strong-copyleft') return []
    return [{ ruleId: 'LICENSE-COPYLEFT', severity: 'medium', path: at.path, line: at.line, message: `新加的依赖 ${item.name} 是 ${item.license}：强传染的许可证，用了它项目可能要按同样的许可证开源，确认能接受或换一个`, suppressed: null }]
  })
  return { findings, notes: report.notes }
}

// 本机装了 Semgrep 时，扫本轮改过的代码文件，只留落在新增行上的
export async function gateSemgrep(cwd: string, added: AddedLines, signal: AbortSignal): Promise<{ findings: SecurityFinding[]; notes: string[] }> {
  const files = [...added.keys()].filter((path) => languageOf(path) !== null)
  if (files.length === 0 || !(await scannerVersions()).semgrep) return { findings: [], notes: [] }
  try {
    const result = await runSemgrep(cwd, files, SEMGREP_GATE_TIMEOUT_MS, signal)
    const findings = result.findings.flatMap((item): SecurityFinding[] =>
      item.line !== null && added.get(item.path)?.has(item.line) ? [{ ruleId: `Semgrep:${item.ruleId}`, severity: 'medium', path: item.path, line: item.line, message: item.message.slice(0, 300), suppressed: null }] : [],
    )
    return { findings, notes: [] }
  } catch (error) {
    if (signal.aborted) return { findings: [], notes: [] }
    return { findings: [], notes: [`Semgrep 没跑成：${error instanceof Error ? error.message : String(error)}`] }
  }
}
