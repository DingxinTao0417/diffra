import { useEffect, useState } from 'react'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight'

type Parser = LanguageSupport['language']['parser']

// 回答里代码块的语法高亮：用文件面板同一套 CodeMirror 语法（各语言的解析器按需加载），颜色和文件面板一样走 --code-* 令牌（styles.css 的 .tok-*）

export interface Token {
  text: string
  className: string
}

// 和 FilePanel 的 HighlightStyle 一一对应
const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.modifier, tags.definitionKeyword, tags.moduleKeyword], class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.attributeName, tags.propertyName], class: 'tok-number' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'tok-comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], class: 'tok-function' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
  { tag: [tags.tagName, tags.heading], class: 'tok-tag' },
  { tag: tags.invalid, class: 'tok-invalid' },
])

// 回答里常见、CodeMirror 的语言表里叫法不一样的
const ALIASES: Record<string, string> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  'c++': 'cpp',
  cs: 'c#',
  csharp: 'c#',
  tsx: 'tsx',
  jsonc: 'json',
  json5: 'json',
}

// 超过这么多字的代码不高亮，原样显示（解析和上万个 span 都慢）
const MAX_HIGHLIGHT_CHARS = 200_000

const parsers = new Map<string, Promise<Parser | null>>()

function loadParser(language: string): Promise<Parser | null> {
  const name = ALIASES[language] ?? language
  let pending = parsers.get(name)
  if (!pending) {
    const description = LanguageDescription.matchLanguageName(languages, name, true)
    pending = description
      ? description.load().then(
          (support) => support.language.parser,
          (error: unknown) => {
            console.error('[markdown] 加载语法高亮失败', name, error)
            return null
          },
        )
      : Promise.resolve(null)
    parsers.set(name, pending)
  }
  return pending
}

export function tokenize(code: string, parser: Parser): Token[][] {
  const lines: Token[][] = [[]]
  highlightCode(
    code,
    parser.parse(code),
    highlighter,
    (text, className) => lines.at(-1)!.push({ text, className }),
    () => lines.push([]),
  )
  return lines
}

export function plainLines(code: string): Token[][] {
  return code.split('\n').map((text) => [{ text, className: '' }])
}

// 先按纯文本分行显示，解析器到了再换成高亮的；enabled 为 false（流式输出中）时只给纯文本
export function useHighlighted(code: string, language: string, enabled: boolean): Token[][] {
  const [result, setResult] = useState<{ code: string; language: string; lines: Token[][] } | null>(null)
  useEffect(() => {
    if (!enabled || !language || code.length > MAX_HIGHLIGHT_CHARS) return
    let stale = false
    void loadParser(language).then((parser) => {
      if (stale || !parser) return
      setResult({ code, language, lines: tokenize(code, parser) })
    })
    return () => {
      stale = true
    }
  }, [code, language, enabled])
  return result && result.code === code && result.language === language ? result.lines : plainLines(code)
}
