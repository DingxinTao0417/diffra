import { type ReactNode, useContext, useState } from 'react'
import { ChevronsDownUp, ChevronsUpDown, Copy, PanelRight } from 'lucide-react'
import { cn } from 'cn'
import { AnswerContext, LanguageBadge, openFilePreview, useProjectFile } from '../answer-links'
import { BlockShell, copyText, FallbackNote, ShellAction } from './BlockShell'
import type { FenceInfo } from './fence'
import { type Token, useHighlighted } from './highlight'

// 超过这么多行默认收起，只露出前 PREVIEW_LINES 行
const COLLAPSE_LINES = 30
const PREVIEW_LINES = 16
// 命令、输出这类不标行号
const UNNUMBERED = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'text', 'txt', 'plaintext', 'output'])

// 回答里的代码块：语法高亮、行号、文件名、重点行、长代码收起、复制、放大，是项目里的文件时能在右侧文件面板打开。
// closed 为 false 是流式输出中还没写完：只按纯文本显示，写完再高亮
export function CodeBlock({ info, closed = true, note, extraActions }: { info: FenceInfo; closed?: boolean; note?: string; extraActions?: ReactNode }) {
  const lines = useHighlighted(info.code, info.language, closed)
  const [expanded, setExpanded] = useState(false)
  const target = useContext(AnswerContext)
  const file = useProjectFile(info.file)
  const long = lines.length > COLLAPSE_LINES
  const numbered = info.startLine !== null || info.highlight.size > 0 || (lines.length >= 4 && !UNNUMBERED.has(info.language))
  const label = info.file ?? info.language
  return (
    <BlockShell
      testId="code-block"
      kind="code"
      icon={info.file ? <LanguageBadge path={info.file} /> : undefined}
      title={<span className={cn(info.file && 'font-mono')} title={info.file ?? undefined}>{label}</span>}
      meta={long ? <span className="shrink-0 tabular-nums">{lines.length} 行</span> : undefined}
      actions={
        <>
          {extraActions}
          {file && target && (
            <ShellAction label="在文件面板打开" onClick={() => openFilePreview(target.project, file.relative, info.startLine)}>
              <PanelRight />
            </ShellAction>
          )}
          {long && (
            <ShellAction label={expanded ? '收起' : `展开全部 ${lines.length} 行`} onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
            </ShellAction>
          )}
          <ShellAction label="复制代码" onClick={() => copyText(info.code, '已复制代码')}>
            <Copy />
          </ShellAction>
        </>
      }
      expand={() => <CodeLines lines={lines} numbered={numbered} start={info.startLine ?? 1} highlight={info.highlight} />}
    >
      <div className="relative" data-language={info.language || undefined}>
        <CodeLines lines={long && !expanded ? lines.slice(0, PREVIEW_LINES) : lines} numbered={numbered} start={info.startLine ?? 1} highlight={info.highlight} />
        {long && !expanded && (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 border-t py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setExpanded(true)}
            data-testid="code-expand"
          >
            <ChevronsUpDown className="size-3.5" />
            展开其余 {lines.length - PREVIEW_LINES} 行
          </button>
        )}
      </div>
      {note && <FallbackNote message={note} />}
    </BlockShell>
  )
}

export function CodeLines({ lines, numbered, start, highlight }: { lines: Token[][]; numbered: boolean; start: number; highlight: ReadonlySet<number> }) {
  const gutter = `${String(start + lines.length - 1).length}ch`
  return (
    <pre className="code-body">
      <code className="block w-max min-w-full">
        {lines.map((tokens, index) => (
          <span key={index} className={cn('code-line', highlight.has(index + 1) && 'code-line-mark')} data-mark={highlight.has(index + 1) || undefined}>
            {numbered && (
              <span className="code-ln" style={{ width: gutter }} aria-hidden="true">
                {start + index}
              </span>
            )}
            <span>{tokens.map((token, at) => (token.className ? <span key={at} className={token.className}>{token.text}</span> : token.text))}</span>
          </span>
        ))}
      </code>
    </pre>
  )
}
