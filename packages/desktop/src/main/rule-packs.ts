import { parseRulePack, type RulePack, type SessionRules } from '@diffra/core'

// 内置规则包在构建时打进主进程的 bundle，安装包里不需要单独的文件
const BUILTIN_SOURCES = import.meta.glob<string>('../../../core/rules/packs/*.md', { query: '?raw', import: 'default', eager: true })
const BUILTIN_ORDER = ['universal', 'security']

export const BUILTIN_RULE_PACKS: RulePack[] = Object.values(BUILTIN_SOURCES)
  .map((source) => parseRulePack(source))
  .sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id))

function order(id: string): number {
  const index = BUILTIN_ORDER.indexOf(id)
  return index < 0 ? BUILTIN_ORDER.length : index
}

// 内置规则包全部生效：强制级和推荐级都写进提示词（按项目语言挑包，篇幅预算由 core 控制）。
// 不能按项目关闭，也不能导入自己的规则包
export const SESSION_RULES: SessionRules = { packs: BUILTIN_RULE_PACKS }
