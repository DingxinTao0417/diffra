import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddedLines } from '../security/types.js'
import { extractFacts, sourceLanguageOf } from './extract.js'
import { type ArchitectureAnalysis, componentOfPath, evaluateTarget, linkViolation, type SourceLanguage, type TargetArchitecture, targetParts } from './model.js'
import { Resolver } from './resolve.js'

export interface ArchitectureFinding {
  path: string
  line: number
  specifier: string
  message: string
}

// 写在 import 那一行或上一行：// diffra-allow architecture: 理由
const ALLOW_COMMENT = /diffra-allow\s+architecture\s*[:：]\s*\S/i

// 任务里的架构检查：只看这一轮新增的行里的 import，按目标架构的规则判断；已有的违规不算在这一轮头上。
// 依赖解析用上次分析保存的配置（别名、工作区包、模块路径），这一轮新建的文件也算进项目文件
export async function checkArchitecture(root: string, analysis: ArchitectureAnalysis, target: TargetArchitecture, added: AddedLines): Promise<ArchitectureFinding[]> {
  const changed = new Map<string, { text: string; language: SourceLanguage }>()
  for (const path of added.keys()) {
    const language = sourceLanguageOf(path)
    if (!language) continue
    const text = await readFile(join(root, path), 'utf8').catch(() => null)
    if (text !== null) changed.set(path, { text, language })
  }
  if (changed.size === 0) return []

  const sourceFiles = new Map<string, SourceLanguage>()
  const namespaces = new Map<string, string | null>()
  for (const file of analysis.files) {
    const language = file.parsed ? sourceLanguageOf(file.path) : null
    if (language) {
      sourceFiles.set(file.path, language)
      namespaces.set(file.path, file.namespace)
    }
  }
  const facts = new Map<string, ReturnType<typeof extractFacts>>()
  for (const [path, { text, language }] of changed) {
    const fileFacts = extractFacts(path, text)
    facts.set(path, fileFacts)
    sourceFiles.set(path, language)
    namespaces.set(path, fileFacts?.namespace ?? null)
  }
  const resolver = new Resolver({
    config: analysis.resolver,
    allFiles: new Set([...analysis.files.map((file) => file.path), ...changed.keys()]),
    sourceFiles,
    namespaces,
    declaredGo: analysis.packages.filter((item) => item.ecosystem === 'go').flatMap((item) => item.dependencies),
  })

  const { components } = targetParts(target)
  const noCycles = target.rules.some((rule) => rule.kind === 'no-cycles')
  let existing: Set<string> | null = null
  const linked = (from: string, to: string) => {
    existing ??= new Set(evaluateTarget(analysis, target).links.map((link) => `${link.from}>${link.to}`))
    return existing.has(`${from}>${to}`)
  }
  const name = (id: string) => components.find((component) => component.id === id)?.name ?? id

  const findings: ArchitectureFinding[] = []
  for (const [path, { text, language }] of changed) {
    const fileFacts = facts.get(path)
    if (!fileFacts) continue
    const lines = text.split('\n')
    const newLines = added.get(path)!
    const from = componentOfPath(components, path)
    for (const fact of fileFacts.imports) {
      if (!newLines.has(fact.line)) continue
      if (ALLOW_COMMENT.test(lines[fact.line - 1] ?? '') || ALLOW_COMMENT.test(lines[fact.line - 2] ?? '')) continue
      const result = resolver.resolve(path, language, fact)
      if (result.kind === 'internal') {
        for (const file of result.files) {
          const to = componentOfPath(components, file)
          if (!from || !to || from === to) continue
          const violation = linkViolation(target, from, to)
          if (violation) findings.push({ path, line: fact.line, specifier: fact.specifier, message: violation.message })
          else if (noCycles && linked(to, from)) findings.push({ path, line: fact.line, specifier: fact.specifier, message: `「${name(from)}」和「${name(to)}」会循环依赖：「${name(to)}」已经依赖「${name(from)}」` })
        }
      } else if (result.kind === 'external') {
        for (const rule of target.rules) {
          if (rule.kind !== 'external' || rule.package !== result.name || (from && rule.only.includes(from))) continue
          findings.push({ path, line: fact.line, specifier: fact.specifier, message: `「${rule.package}」只许${rule.only.map((id) => `「${name(id)}」`).join('、')}使用${rule.note ? `：${rule.note}` : ''}` })
        }
      }
    }
  }
  // 同一行导入多个文件（Go 的包、Python 的 from x import a, b）只报一次
  return [...new Map(findings.map((item) => [`${item.path}:${item.line}:${item.message}`, item])).values()]
}
