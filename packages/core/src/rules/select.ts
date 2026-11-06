import type { Rule, RulePack } from '../protocol.js'
import { languageOf } from './languages.js'

// 写进系统提示词的规则总量上限；每一步都会重发，太长既费 token，弱模型也记不住
export const MAX_RULES_PROMPT_CHARS = 4000

const isUniversal = (pack: RulePack) => pack.languages.includes('*')

// 不分语言的包在前，其余按项目里对应语言的文件数从多到少排；项目里没有的语言不选
export function selectRulePacks(packs: RulePack[], languages: ReadonlyMap<string, number>): RulePack[] {
  const fileCount = (pack: RulePack) => pack.languages.reduce((sum, language) => sum + (languages.get(language) ?? 0), 0)
  const specific = packs
    .filter((pack) => !isUniversal(pack) && pack.rules.length > 0 && fileCount(pack) > 0)
    .sort((a, b) => fileCount(b) - fileCount(a))
  return [...packs.filter((pack) => isUniversal(pack) && pack.rules.length > 0), ...specific]
}

// 审查只看和改动文件相关的包
export function packsForPaths(packs: RulePack[], paths: string[]): RulePack[] {
  const languages = new Set(paths.map(languageOf).filter((language): language is string => language !== null))
  return packs.filter((pack) => isUniversal(pack) || pack.languages.some((language) => languages.has(language)))
}

export function ruleLine(rule: Rule): string {
  return `- ${rule.id}${rule.level === 'recommended' ? '（推荐）' : ''}: ${rule.text}`
}

// 预算不够时先保证强制级：先挑强制规则，再用剩下的预算挑推荐规则，最后按包原来的顺序输出
export function renderRules(packs: RulePack[], budget = MAX_RULES_PROMPT_CHARS): { text: string; omitted: number } {
  const included = new Set<Rule>()
  const started = new Set<RulePack>()
  let used = 0
  let omitted = 0
  for (const level of ['required', 'recommended'] as const) {
    for (const pack of packs) {
      for (const rule of pack.rules) {
        if (rule.level !== level) continue
        const cost = ruleLine(rule).length + 1 + (started.has(pack) ? 0 : header(pack).length + 1)
        if (used + cost > budget) {
          omitted++
          continue
        }
        used += cost
        started.add(pack)
        included.add(rule)
      }
    }
  }
  const lines: string[] = []
  for (const pack of packs) {
    if (!started.has(pack)) continue
    lines.push(header(pack))
    for (const rule of pack.rules) if (included.has(rule)) lines.push(ruleLine(rule))
  }
  return { text: lines.join('\n'), omitted }
}

function header(pack: RulePack): string {
  return `### ${pack.name}`
}
