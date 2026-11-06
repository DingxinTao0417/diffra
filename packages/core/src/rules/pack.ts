import type { Rule, RuleLevel, RulePack } from '../protocol.js'

const LEVELS: Record<string, RuleLevel> = {
  强制: 'required',
  推荐: 'recommended',
  required: 'required',
  recommended: 'recommended',
}
const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RULE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/
const RULE_LINE = /^- \[([^\]]+)\]\[([^\]]+)\]\s*(.*)$/
const FIELDS = ['id', 'name', 'languages', 'source', 'license'] as const
// 规则会写进提示词，单条太长说明写成了文章，应该拆开
const MAX_RULE_CHARS = 300

export class RulePackError extends Error {}

// 规则包是带 front matter 的 markdown：
//   ---
//   id: java              小写字母、数字和连字符
//   name: Java
//   languages: java       多个用逗号分隔，* 表示不分语言
//   source: 出处
//   license: 许可证
//   ---
//   ## 小节标题
//   - [JAVA-NAME-1][强制] 规则内容
//     缩进的续行接在上一条规则后面
// 其他文字（说明段落）忽略。
export function parseRulePack(markdown: string): RulePack {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new RulePackError('规则包要以 --- 开头的 front matter 开始')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) throw new RulePackError('front matter 没有用 --- 结束')

  const meta = new Map<string, string>()
  for (const [index, line] of lines.slice(1, end).entries()) {
    if (!line.trim()) continue
    const match = /^([a-z]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) throw new RulePackError(`第 ${index + 2} 行：front matter 要写成「字段: 值」`)
    meta.set(match[1] ?? '', (match[2] ?? '').trim())
  }
  for (const field of FIELDS) {
    if (!meta.get(field)) throw new RulePackError(`front matter 缺少 ${field}`)
  }
  const id = meta.get('id') ?? ''
  if (!PACK_ID.test(id)) throw new RulePackError(`规则包 id「${id}」只能用小写字母、数字和连字符`)
  const languages = (meta.get('languages') ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (languages.length === 0) throw new RulePackError('languages 不能为空')
  if (languages.includes('*') && languages.length > 1) throw new RulePackError('languages 写了 * 就不能再写别的语言')

  const rules: Rule[] = []
  const seen = new Set<string>()
  let section: string | null = null
  let current: Rule | null = null
  for (let index = end + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const lineNo = index + 1
    if (line.startsWith('#')) {
      section = line.replace(/^#+\s*/, '').trim() || null
      current = null
      continue
    }
    if (line.startsWith('- [')) {
      const match = RULE_LINE.exec(line.trim())
      if (!match) throw new RulePackError(`第 ${lineNo} 行：规则要写成「- [编号][强制] 内容」`)
      const ruleId = match[1] ?? ''
      const level = LEVELS[match[2] ?? '']
      const text = (match[3] ?? '').trim()
      if (!RULE_ID.test(ruleId)) throw new RulePackError(`第 ${lineNo} 行：规则编号「${ruleId}」要用大写字母、数字和连字符，比如 JAVA-NAME-1`)
      if (!level) throw new RulePackError(`第 ${lineNo} 行：级别只能是「强制」或「推荐」`)
      if (!text) throw new RulePackError(`第 ${lineNo} 行：规则内容为空`)
      if (seen.has(ruleId)) throw new RulePackError(`第 ${lineNo} 行：规则编号 ${ruleId} 重复`)
      seen.add(ruleId)
      current = { id: ruleId, level, section, text }
      rules.push(current)
      continue
    }
    if (current && /^\s+\S/.test(line)) {
      current.text = `${current.text} ${line.trim()}`
      continue
    }
    current = null
  }
  if (rules.length === 0) throw new RulePackError('规则包里没有规则')
  const tooLong = rules.find((rule) => rule.text.length > MAX_RULE_CHARS)
  if (tooLong) throw new RulePackError(`规则 ${tooLong.id} 超过 ${MAX_RULE_CHARS} 字，请拆成几条`)

  return {
    id,
    name: meta.get('name') ?? id,
    languages,
    source: meta.get('source') ?? '',
    license: meta.get('license') ?? '',
    rules,
  }
}
