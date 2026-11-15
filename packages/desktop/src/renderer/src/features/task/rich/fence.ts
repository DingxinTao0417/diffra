import { createContext, useContext } from 'react'
import type { ExtraProps } from 'react-markdown'

// hast 的类型借 react-markdown 导出的，不为类型单独装 @types/hast
export type Element = NonNullable<ExtraProps['node']>
export type ElementContent = Element['children'][number]

// 一段回答的原文和是否还在流式输出：判断代码围栏有没有闭合要看原文（未闭合的围栏在语法树里一直延伸到结尾）
export interface MarkdownSource {
  text: string
  streaming: boolean
}

export const MarkdownSourceContext = createContext<MarkdownSource>({ text: '', streaming: false })

export function useMarkdownSource(): MarkdownSource {
  return useContext(MarkdownSourceContext)
}

export interface FenceInfo {
  // 小写的语言名（```ts → ts），没写是空串
  language: string
  // 围栏里写的文件名：```ts title="src/a.ts"、```ts src/a.ts、```ts:src/a.ts:12
  file: string | null
  // 第一行的行号：```ts src/a.ts:12、start=12
  startLine: number | null
  // 要高亮的行（按代码块里的第几行，从 1 起）：{1,3-5}
  highlight: ReadonlySet<number>
  code: string
}

const MAX_HIGHLIGHT_LINES = 500

// pre > code 节点里的语言、meta 和代码。remark 把语言放在 language-xxx 类名里，语言后面的文字放在 data.meta 里
export function fenceInfo(pre: Element | undefined): FenceInfo {
  const code = pre?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code')
  const classes = code?.properties.className
  const languageClass = Array.isArray(classes) ? classes.find((name): name is string => typeof name === 'string' && name.startsWith('language-')) : undefined
  let language = languageClass?.slice('language-'.length) ?? ''
  let meta = typeof code?.data === 'object' && code.data && 'meta' in code.data && typeof code.data.meta === 'string' ? code.data.meta : ''
  // ```ts:src/a.ts 这种把文件名接在语言后面的写法
  const colon = language.indexOf(':')
  if (colon > 0) {
    meta = `${language.slice(colon + 1)} ${meta}`
    language = language.slice(0, colon)
  }
  const parsed = parseMeta(meta)
  return { language: language.toLowerCase(), ...parsed, code: textOf(code?.children ?? []).replace(/\n$/, '') }
}

export function parseMeta(meta: string): Pick<FenceInfo, 'file' | 'startLine' | 'highlight'> {
  let file: string | null = null
  let startLine: number | null = null
  const highlight = new Set<number>()
  const tokens = meta.match(/\{[^}]*\}|\w+="[^"]*"|\w+='[^']*'|\S+/g) ?? []
  for (const token of tokens) {
    const ranges = /^\{([\d,\s-]+)\}$/.exec(token)
    if (ranges) {
      for (const part of ranges[1]!.split(',')) {
        const [from, to = from] = part.trim().split('-').map(Number)
        if (!from || !to || to < from) continue
        for (let line = from; line <= Math.min(to, from + MAX_HIGHLIGHT_LINES); line++) highlight.add(line)
      }
      continue
    }
    const pair = /^(\w+)=["']?([^"']*)["']?$/.exec(token)
    if (pair) {
      const [, key = '', value = ''] = pair
      if (/^(title|file|filename|path)$/i.test(key) && value) file = value
      else if (/^(start|startline|line)$/i.test(key) && Number(value) > 0) startLine = Number(value)
      continue
    }
    // 不带键的、像路径的（有扩展名或斜杠）当文件名；后面可以跟 :行号
    if (!file && /[./\\]/.test(token)) {
      const match = /^(.+?)(?::(\d+))?$/.exec(token)
      file = match?.[1] ?? token
      if (match?.[2]) startLine = Number(match[2])
    }
  }
  return { file, startLine, highlight }
}

export function textOf(nodes: ElementContent[]): string {
  return nodes.map((node) => (node.type === 'text' ? node.value : node.type === 'element' ? textOf(node.children) : '')).join('')
}

// 流式输出时，围栏还没写到结尾的反引号：语法树里这个代码块一直延伸到原文末尾，最后一行不是收尾的围栏。
// 在引用、列表里时每行前面有 >、缩进，比较前去掉
export function fenceClosed(source: MarkdownSource, node: Element | undefined): boolean {
  if (!source.streaming) return true
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  if (start === undefined || end === undefined) return true
  const lines = source.text.slice(start, end).replace(/\s+$/, '').split('\n')
  const open = /^[\s>]*(`{3,}|~{3,})/.exec(lines[0] ?? '')
  // 缩进写的代码块没有围栏，写到哪显示到哪
  if (!open) return true
  if (lines.length < 2) return false
  const last = (lines.at(-1) ?? '').replace(/^[\s>]*/, '').trimEnd()
  const marker = open[1]!
  return last.length >= marker.length && [...last].every((char) => char === marker[0])
}
