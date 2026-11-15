import { type ReactNode, useContext, useState } from 'react'
import { ChevronsDownUp, ChevronsUpDown, Copy, PanelRight, SquareTerminal, TextCursorInput, TriangleAlert } from 'lucide-react'
import type { CommandRisk } from '@diffra/core/types'
import { Button } from '@/components/ui/button'
import { typeIntoTerminal } from '@/features/terminal/terminals'
import { errorMessage } from '@/lib/errors'
import { fillComposer } from '@/state/actions'
import { showToast } from '@/state/store'
import { useStatic } from '../static-context'
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
// 能打进终端的命令（第 687 步）
const SHELL = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat'])

// 命令原文：console 写法里只留带提示符（$ 或 PowerShell 的 PS …>）的命令行，去掉提示符；别的行是输出
const PROMPT = /^\s*(?:\$|PS [^>]*>) /
export function commandOf(info: FenceInfo): string {
  const lines = info.code.replace(/\n$/, '').split('\n')
  if (info.language !== 'console') return lines.join('\n')
  return lines.flatMap((line) => (PROMPT.test(line) ? [line.replace(PROMPT, '')] : [])).join('\n')
}

// 回答里的代码块：语法高亮、行号、文件名、重点行、长代码收起、复制、放大，是项目里的文件时能在右侧文件面板打开。
// closed 为 false 是流式输出中还没写完：只按纯文本显示，写完再高亮
export function CodeBlock({ info, closed = true, note, extraActions }: { info: FenceInfo; closed?: boolean; note?: string; extraActions?: ReactNode }) {
  const lines = useHighlighted(info.code, info.language, closed)
  const [expanded, setExpanded] = useState(false)
  const target = useContext(AnswerContext)
  const isStatic = useStatic()
  const file = useProjectFile(info.file)
  // 命令打进终端之前看到的风险（中、高风险要再点一次确认）
  const [risky, setRisky] = useState<CommandRisk | null>(null)
  const runnable = closed && !isStatic && target !== null && SHELL.has(info.language) && commandOf(info).trim() !== ''
  const typeIn = () => {
    if (!target) return
    setRisky(null)
    void typeIntoTerminal(target.project, commandOf(info)).catch((error: unknown) => showToast(errorMessage(error)))
  }
  const run = () => {
    window.diffra.commandRisk(commandOf(info)).then(
      (risk) => (risk.level === 'low' ? typeIn() : setRisky(risk)),
      (error: unknown) => showToast(errorMessage(error)),
    )
  }
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
          {runnable && (
            <>
              <ShellAction label="在终端运行（打进去，按回车才执行）" onClick={run}>
                <SquareTerminal />
              </ShellAction>
              <ShellAction label="填入输入框" onClick={() => fillComposer(target!.sessionId, commandOf(info))}>
                <TextCursorInput />
              </ShellAction>
            </>
          )}
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
      {risky && (
        <div className={cn('flex flex-wrap items-start gap-2 border-t px-3 py-2 text-xs', risky.level === 'high' ? 'bg-destructive-soft' : 'bg-warning-soft')} role="alert" data-testid="command-risk">
          <TriangleAlert className={cn('mt-0.5 size-3.5 shrink-0', risky.level === 'high' ? 'text-destructive' : 'text-warning')} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-bold">{risky.level === 'high' ? '这条命令风险高，难以撤销' : '这条命令需要留意'}</p>
            <ul className="list-disc pl-4">
              {risky.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
          <span className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant="outline" onClick={typeIn}>
              仍然打进终端
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRisky(null)}>
              取消
            </Button>
          </span>
        </div>
      )}
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
