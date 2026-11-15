import { type ReactNode, useContext, useMemo, useState } from 'react'
import { ClipboardCopy, Copy, FlaskConical, PanelRight, RotateCw, Wrench } from 'lucide-react'
import { cn } from 'cn'
import { fillComposer } from '@/state/actions'
import { formatDuration } from '@/lib/format'
import { AnswerContext, LanguageBadge, openFilePreview, useProjectFile } from '../answer-links'
import { copyText, ShellAction } from '../rich/BlockShell'
import { CodeLines } from '../rich/CodeBlock'
import { useHighlighted } from '../rich/highlight'
import { JsonTree } from '../rich/JsonBlock'
import { parseAnsi, stripAnsi } from './ansi'
import { type FileRead, parseRead, parseSearch, parseTestSummary, type SearchResults, splitCommandOutput, type TestSummary } from './output-parsers'

// 输出超过这么多行只画最后这么多（报错一般在最后）
const MAX_LINES = 2000
const MAX_SEARCH_FILES = 30
const MAX_SEARCH_HITS = 300

// 工具步骤展开后的输出（第 655 步）：命令的退出状态和操作在顶上一行；测试结果先给汇总和失败的用例、搜索结果按文件分组、读文件按代码高亮，
// 其余命令的输出保留 ANSI 颜色；不是命令、输出是 JSON 的显示成能折叠的树。认不出的照原样
export function ToolOutputView({ command, output }: { command: string | null; output: string }) {
  const target = useContext(AnswerContext)
  const parsed = useMemo(() => (command ? splitCommandOutput(output) : { exitCode: null, state: null, body: output }), [command, output])
  const view = useMemo(() => {
    if (!command) {
      const json = jsonOf(output)
      return json === undefined ? null : ({ kind: 'json', value: json } as const)
    }
    const test = parseTestSummary(parsed.body)
    if (test) return { kind: 'test', test } as const
    const search = parseSearch(command, parsed.body)
    if (search) return { kind: 'search', search } as const
    const read = parsed.exitCode === 0 ? parseRead(command, parsed.body) : null
    return read ? ({ kind: 'read', read } as const) : null
  }, [command, output, parsed])
  const fill = target ? (text: string) => fillComposer(target.sessionId, text) : null
  const header = command && parsed.state ? output.slice(0, output.indexOf('\n') < 0 ? undefined : output.indexOf('\n')) : null
  const failedTests = view?.kind === 'test' && view.test.failures.length > 0 ? view.test.failures : null
  // JSON 树自己带外框，不再套一层（卡片里不套卡片）
  if (view?.kind === 'json') {
    return (
      <div className="mt-1.5 ml-5" data-testid="tool-output" data-view="json">
        <JsonTree value={view.value} source={output} />
      </div>
    )
  }
  return (
    <div className="mt-1.5 ml-5 overflow-hidden rounded-md border bg-muted" data-testid="tool-output" data-view={view?.kind ?? 'text'}>
      {command && (
        <div className="flex min-h-7 items-center gap-2 border-b pr-1 pl-2.5 text-xs">
          {header && <span className={cn('shrink-0 font-mono', parsed.exitCode !== null && parsed.exitCode !== 0 ? 'text-destructive' : 'text-muted-foreground')}>{header}</span>}
          {view?.kind === 'test' && <TestBadges test={view.test} exitCode={parsed.exitCode} />}
          <span className="ml-auto flex shrink-0 items-center">
            {failedTests && fill && (
              <ShellAction label="填入修复提示词" onClick={() => fill(`这些测试失败了，找到原因并修好：\n${failedTests.map((name) => `- ${name}`).join('\n')}\n\n命令：${command}`)}>
                <Wrench />
              </ShellAction>
            )}
            {fill && parsed.state !== 'running' && (
              <ShellAction label="重新运行（填进输入框）" onClick={() => fill(`重新运行这条命令：${command}`)}>
                <RotateCw />
              </ShellAction>
            )}
            <ShellAction label="复制命令" onClick={() => copyText(command, '已复制命令')}>
              <Copy />
            </ShellAction>
            <ShellAction label="复制输出" onClick={() => copyText(stripAnsi(parsed.body), '已复制输出')}>
              <ClipboardCopy />
            </ShellAction>
          </span>
        </div>
      )}
      {view?.kind === 'test' && <FailureList test={view.test} />}
      {view?.kind === 'search' && <SearchView search={view.search} />}
      {view?.kind === 'read' && <ReadView read={view.read} />}
      {(!view || view.kind === 'test') && <TerminalText text={parsed.body} />}
    </div>
  )
}

function jsonOf(text: string): unknown {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed) || trimmed.length > 200_000) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

// 带 ANSI 颜色的终端输出
function TerminalText({ text }: { text: string }) {
  const lines = useMemo(() => {
    const all = parseAnsi(text.replace(/\n$/, ''))
    return { shown: all.slice(-MAX_LINES), hidden: Math.max(0, all.length - MAX_LINES) }
  }, [text])
  if (!text.trim()) return <p className="px-2.5 py-1.5 text-xs text-muted-foreground">没有输出</p>
  return (
    <pre className="max-h-72 overflow-auto p-2 font-mono text-xs whitespace-pre-wrap" data-testid="terminal-output">
      {lines.hidden > 0 && <span className="block text-muted-foreground">（前面还有 {lines.hidden} 行，复制输出能拿到全部）</span>}
      {lines.shown.map((spans, index) => (
        <span key={index} className="block min-h-[1lh]">
          {spans.map((span, at) => (span.className ? <span key={at} className={span.className}>{span.text}</span> : span.text))}
        </span>
      ))}
    </pre>
  )
}

function TestBadges({ test, exitCode }: { test: TestSummary; exitCode: number | null }) {
  const allPassed = test.failed === 0 && exitCode === 0
  return (
    <span className="flex min-w-0 items-center gap-2 tabular-nums" data-testid="test-summary">
      <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/* success-color-allow: 测试命令跑完、全部通过、退出码为 0，是验证结果 */}
      <span className={cn(allPassed ? 'text-success' : 'text-muted-foreground')}>通过 {test.passed}</span>
      {test.failed > 0 && <span className="text-destructive">失败 {test.failed}</span>}
      {test.skipped > 0 && <span className="text-muted-foreground">跳过 {test.skipped}</span>}
      {test.duration !== null && <span className="text-muted-foreground">用时 {formatDuration(test.duration * 1000)}</span>}
    </span>
  )
}

function FailureList({ test }: { test: TestSummary }) {
  if (test.failures.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5 border-b px-2.5 py-1.5 text-xs" data-testid="test-failures" aria-label="失败的用例">
      {test.failures.map((name) => (
        <li key={name} className="flex min-w-0 gap-1.5">
          <span className="shrink-0 text-destructive">✕</span>
          <span className="min-w-0 font-mono break-all">{name}</span>
        </li>
      ))}
    </ul>
  )
}

function SearchView({ search }: { search: SearchResults }) {
  const [all, setAll] = useState(false)
  const files = all ? search.files : search.files.slice(0, MAX_SEARCH_FILES)
  let budget = all ? Number.POSITIVE_INFINITY : MAX_SEARCH_HITS
  return (
    <div className="max-h-96 overflow-auto bg-background py-1 text-xs" data-testid="search-results">
      <p className="px-2.5 pb-1 text-muted-foreground">
        {search.files.length} 个文件 · {search.total} 处
      </p>
      {files.map((file) => {
        const hits = file.hits.slice(0, Math.max(0, budget))
        budget -= hits.length
        return <SearchFile key={file.path} path={file.path} hits={hits} total={file.hits.length} pattern={search.pattern} />
      })}
      {!all && (search.files.length > files.length || budget <= 0) && (
        <button type="button" className="px-2.5 py-1 text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          显示全部
        </button>
      )}
    </div>
  )
}

function SearchFile({ path, hits, total, pattern }: { path: string; hits: SearchResults['files'][number]['hits']; total: number; pattern: string | null }) {
  const target = useContext(AnswerContext)
  const file = useProjectFile(path)
  const open = (line: number) => (file && target ? openFilePreview(target.project, file.relative, line) : undefined)
  return (
    <div className="mt-1" data-testid="search-file">
      <div className="flex items-center gap-1.5 px-2.5 py-0.5">
        <LanguageBadge path={path} />
        <span className="min-w-0 truncate font-mono">{path}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{total}</span>
      </div>
      {hits.map((hit, index) => (
        <button
          key={index}
          type="button"
          disabled={!file}
          className="flex w-full min-w-0 items-baseline gap-2 px-2.5 py-px text-left font-mono enabled:hover:bg-accent"
          title={file ? `在文件面板打开第 ${hit.line} 行` : undefined}
          onClick={() => open(hit.line)}
          data-testid="search-hit"
        >
          <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">{hit.line}</span>
          <span className="min-w-0 truncate">{highlightPattern(hit.text.trim(), pattern)}</span>
        </button>
      ))}
    </div>
  )
}

// 命中的那段标出来：模式是普通文字时按不区分大小写的子串找；是正则时试着按正则找，写错了就不标
function highlightPattern(text: string, pattern: string | null): ReactNode {
  if (!pattern) return text
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'gi')
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  }
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(regex)) {
    if (!match[0]) break
    parts.push(text.slice(last, match.index), <mark key={match.index} className="rounded-xs bg-highlight text-foreground">{match[0]}</mark>)
    last = match.index + match[0].length
  }
  parts.push(text.slice(last))
  return parts
}

function ReadView({ read }: { read: FileRead }) {
  const target = useContext(AnswerContext)
  const file = useProjectFile(read.path)
  const code = read.text.replace(/\n$/, '')
  const lines = useHighlighted(code, read.path.slice(read.path.lastIndexOf('.') + 1).toLowerCase(), true)
  return (
    <div className="bg-background" data-testid="read-view">
      <div className="flex items-center gap-1.5 border-b pr-1 pl-2.5 text-xs">
        <LanguageBadge path={read.path} />
        <span className="min-w-0 truncate py-1 font-mono">{read.path}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          第 {read.startLine}–{read.startLine + lines.length - 1} 行
        </span>
        {file && target && (
          <span className="ml-auto">
            <ShellAction label="在文件面板打开" onClick={() => openFilePreview(target.project, file.relative, read.startLine)}>
              <PanelRight />
            </ShellAction>
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-auto">
        <CodeLines lines={lines} numbered start={read.startLine} highlight={new Set()} />
      </div>
    </div>
  )
}
