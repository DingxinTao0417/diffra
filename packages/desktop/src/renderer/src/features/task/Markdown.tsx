import { type ComponentProps, createContext, memo, useContext, useId, useMemo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { AnswerCode, AnswerLink, fileOfCode, fileOfHref } from './answer-links'
import { AnswerImage, CompareImages, isBeforeAfter } from './rich/AnswerImage'
import { BlockSkeleton } from './rich/BlockShell'
import { Blockquote } from './rich/Callout'
import { CodeBlock } from './rich/CodeBlock'
import { DiffBlock } from './rich/DiffBlock'
import { type Element, fenceClosed, fenceInfo, type MarkdownSource, MarkdownSourceContext, textOf, useMarkdownSource } from './rich/fence'
import { FileCard, SourceCard } from './rich/FileCard'
import { JsonBlock } from './rich/JsonBlock'
import { InlineMath, MathBlock } from './rich/MathView'
import { MermaidBlock } from './rich/MermaidBlock'
import { normalizeMath, remarkCallouts } from './rich/remark-rich'
import { RichBlock, richKindOf } from './rich/RichBlock'
import { RichTable } from './rich/RichTable'

// 代码围栏按语言换成对应的富块；还在流式输出、没写完的富块先显示占位，不先闪一下代码（第 640 步）
function FencedBlock({ node }: ComponentProps<'pre'> & ExtraProps) {
  const source = useMarkdownSource()
  const info = fenceInfo(node)
  const closed = fenceClosed(source, node)
  switch (info.language) {
    case 'diff':
    case 'patch':
      return <DiffBlock info={info} />
    // $$ 包的块级公式和 ```math 都是 language-math；```latex 是给人看的源码，照常按代码显示
    case 'math':
      return closed ? <MathBlock tex={info.code} /> : <BlockSkeleton label="正在写公式…" />
    case 'mermaid':
      return closed ? <MermaidBlock info={info} /> : <BlockSkeleton label="正在画图…" />
    case 'json':
      return <JsonBlock info={info} closed={closed} />
  }
  // ```chart、```metrics 这类结构化富块（第 650 步）
  const kind = richKindOf(info.language)
  if (kind) return <RichBlock kind={kind} info={info} closed={closed} />
  return <CodeBlock info={info} closed={closed} />
}

function InlineCode({ className, children }: ComponentProps<'code'>) {
  if (typeof className === 'string' && className.includes('math-inline')) return <InlineMath tex={typeof children === 'string' ? children : String(children ?? '')} />
  return <AnswerCode className={className}>{children}</AnswerCode>
}

const isBlank = (child: Element['children'][number]) => child.type === 'text' && child.value.trim() === ''

// 单独成段的东西换成卡片：项目里的文件 → 文件卡，网页链接 → 来源卡，「前」「后」两张图 → 对比滑块
function Paragraph({ node, children, ...props }: ComponentProps<'p'> & ExtraProps) {
  const paragraph = <p {...props}>{children}</p>
  const parts = node?.children.filter((child) => !isBlank(child)) ?? []
  const only = parts.length === 1 && parts[0]?.type === 'element' ? parts[0] : null
  if (only?.tagName === 'code') {
    const file = fileOfCode(textOf(only.children))
    if (file) return <FileCard path={file.path} line={file.line} fallback={paragraph} />
  }
  if (only?.tagName === 'a' && typeof only.properties.href === 'string') {
    const href = only.properties.href
    if (/^https?:\/\//i.test(href)) return <SourceCard href={href} title={textOf(only.children) || href} />
    const file = !/^[a-z][\w+.-]+:/i.test(href) || /^file:/i.test(href) ? fileOfHref(href) : null
    if (file) return <FileCard path={file.path} line={file.line} fallback={paragraph} />
  }
  const images = parts.filter((child): child is Element => child.type === 'element' && child.tagName === 'img')
  if (images.length === 2 && parts.length === 2) {
    const [before, after] = images.map((image) => ({ src: String(image.properties.src ?? ''), alt: String(image.properties.alt ?? '') }))
    if (before && after && isBeforeAfter([before.alt, after.alt])) return <CompareImages before={before} after={after} />
  }
  return paragraph
}

// 脚注里只有一个网页链接的条目画成来源卡
function ListItem({ node, children, ...props }: ComponentProps<'li'> & ExtraProps) {
  const id = typeof props.id === 'string' ? props.id : ''
  const footnote = /fn-([^-]+)$/.exec(id)
  if (footnote && node) {
    const links = linksIn(node).filter((link) => link.properties.dataFootnoteBackref === undefined)
    const href = links[0]?.properties.href
    if (links.length === 1 && typeof href === 'string' && /^https?:\/\//i.test(href)) {
      return (
        <li {...props} className="footnote-source">
          <SourceCard href={href} title={textOf(links[0]!.children) || href} index={Number(footnote[1]) || undefined} />
        </li>
      )
    }
  }
  return <li {...props}>{children}</li>
}

// 标题带上 id（按它在原文里的行号），长回答顶上的目录用它跳过去；导出的静态页里同样能跳
function Heading({ node, children, ...props }: ComponentProps<'h2'> & ExtraProps) {
  const prefix = useContext(HeadingPrefixContext)
  const Tag = (node?.tagName ?? 'h2') as 'h1' | 'h2' | 'h3' | 'h4'
  const line = node?.position?.start.line
  return (
    <Tag {...props} id={line ? `${prefix}h${line}` : undefined}>
      {children}
    </Tag>
  )
}

const HeadingPrefixContext = createContext('')

interface TocEntry {
  level: number
  text: string
  line: number
}

// 长回答（第 674 步）：三个以上标题、正文够长时，顶上列出目录
const TOC_MIN_HEADINGS = 3
const TOC_MIN_CHARS = 1200

function tocOf(text: string): TocEntry[] {
  const entries: TocEntry[] = []
  let fence: string | null = null
  text.split('\n').forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]!
      else if (marker[0] === fence) fence = null
      return
    }
    if (fence) return
    const heading = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) return
    const plain = heading[2]!
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim()
    if (plain) entries.push({ level: heading[1]!.length, text: plain, line: index + 1 })
  })
  return entries
}

function AnswerToc({ entries, prefix }: { entries: TocEntry[]; prefix: string }) {
  const top = Math.min(...entries.map((entry) => entry.level))
  return (
    // 放在 .markdown 外面：那里的列表编号、链接颜色不要；目录是导航，不用主色
    <nav aria-label="目录" className="mb-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm [&_a]:text-muted-foreground [&_a:hover]:text-foreground [&_a:hover]:underline" data-testid="answer-toc">
      <p className="mb-1 text-xs text-muted-foreground">目录</p>
      <ol className="space-y-0.5">
        {entries.map((entry) => (
          <li key={entry.line} className="truncate" style={{ paddingLeft: `${(entry.level - top) * 0.875}rem` }}>
            <AnswerLink href={`#${prefix}h${entry.line}`}>{entry.text}</AnswerLink>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function linksIn(node: Element): Element[] {
  return node.children.flatMap((child) => (child.type !== 'element' ? [] : child.tagName === 'a' ? [child] : linksIn(child)))
}

// 链接默认在内置浏览器打开、右键换系统浏览器；项目里的文件显示成文件引用（见 answer-links）
const components: Components = {
  a: ({ href, children }) => <AnswerLink href={href}>{children}</AnswerLink>,
  code: InlineCode,
  pre: FencedBlock,
  blockquote: Blockquote,
  table: RichTable,
  img: AnswerImage,
  p: Paragraph,
  li: ListItem,
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
}

const remarkPlugins = [remarkGfm, remarkMath, remarkCallouts]

// 模型的回复按 Markdown 显示；不渲染原始 HTML。streaming：这一段还在流式输出（围栏没写完的富块显示占位）
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // 同一页面上几段回答的脚注 id 不能撞
  const prefix = `md${useId().replace(/[^\w-]/g, '')}-`
  const normalized = useMemo(() => normalizeMath(text), [text])
  const source = useMemo<MarkdownSource>(() => ({ text: normalized, streaming }), [normalized, streaming])
  const rehypeOptions = useMemo(() => ({ clobberPrefix: prefix, footnoteLabel: '来源与脚注', footnoteBackLabel: '回到正文', footnoteLabelProperties: { className: ['footnotes-label'] } }), [prefix])
  const toc = useMemo(() => (streaming || normalized.length < TOC_MIN_CHARS ? [] : tocOf(normalized)), [normalized, streaming])
  return (
    <MarkdownSourceContext.Provider value={source}>
      <HeadingPrefixContext.Provider value={prefix}>
        {toc.length >= TOC_MIN_HEADINGS && <AnswerToc entries={toc} prefix={prefix} />}
        <div className="markdown">
          <ReactMarkdown remarkPlugins={remarkPlugins} remarkRehypeOptions={rehypeOptions} components={components}>
            {normalized}
          </ReactMarkdown>
        </div>
      </HeadingPrefixContext.Provider>
    </MarkdownSourceContext.Provider>
  )
})
