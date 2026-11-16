import { useEffect, useMemo, useState } from 'react'
import { Activity, CircleAlert, Play } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { formatDuration, formatTime } from '@/lib/format'
import { trace, useArchitecture } from '../architecture-store'
import { useArch } from '../context'

const TIMEOUTS = [
  { value: '30', label: '30 秒' },
  { value: '120', label: '2 分钟' },
  { value: '600', label: '10 分钟' },
]
const MAX_ROWS = 50

const formatMs = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} 秒` : `${Math.round(value)} 毫秒`)

// 运行时追踪（v2 · M9）：在项目里跑一条命令（一般是测试），看真正执行到的函数、最花时间的地方、静态分析没看到的调用
export function RuntimeView() {
  const { project, analysis, runtime, go, peek } = useArch()
  const running = useArchitecture((state) => state.running[project.id])
  const [command, setCommand] = useState(runtime?.command ?? '')
  const [timeout, setTimeoutValue] = useState('120')

  // 没跑过时猜一条（有 test 脚本就跑测试）
  useEffect(() => {
    if (runtime || command) return
    let cancelled = false
    window.diffra
      .architectureTraceCommand(project.id)
      .then((guess) => {
        if (!cancelled) setCommand((current) => current || guess)
      })
      .catch((error: unknown) => console.error('[architecture] 猜运行时追踪的命令失败', error))
    return () => {
      cancelled = true
    }
  }, [project.id, runtime, command])

  const staticLinks = useMemo(() => new Set((analysis.calls ?? []).map((call) => `${call.from}\u0000${call.fromSymbol}\u0000${call.to}\u0000${call.toSymbol}`)), [analysis])
  const idleFiles = useMemo(() => {
    if (!runtime) return []
    const ran = new Set(runtime.functions.map((item) => item.file))
    return analysis.files.flatMap((file, index) => (file.parsed && !ran.has(index) ? [file.path] : []))
  }, [analysis, runtime])
  const lineOf = (file: number, symbol: string) => analysis.files[file]?.symbols.find((item) => (item.parent ? `${item.parent}.${item.name}` : item.name) === symbol)?.line ?? 1
  const openFunction = (file: number, symbol: string) => go({ tab: 'dependencies', section: 'graph', scope: `file:${analysis.files[file]!.path}`, focus: `symbol:${symbol}` })

  return (
    <div className="h-full overflow-y-auto" data-testid="architecture-runtime">
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <section className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-bold">运行时追踪</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            在项目文件夹里用 bash 跑一条命令（一般是测试），记下真正执行到的函数：Node.js 按 V8 采样算时间，Python 用 cProfile 记调用次数，它们起的子进程也算；别的语言不支持。命令会真的执行，不要填会改数据、发请求的命令。
          </p>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (command.trim()) void trace(project.id, command.trim(), Number(timeout))
            }}
          >
            <Input aria-label="要追踪的命令" className="h-8 min-w-60 flex-1 font-mono text-xs" placeholder="比如 npm test、python -m pytest -q" value={command} maxLength={2000} onChange={(event) => setCommand(event.target.value)} />
            <Segmented label="最长跑多久" size="sm" value={timeout} options={TIMEOUTS} onChange={setTimeoutValue} />
            <Button type="submit" size="sm" disabled={!command.trim() || running !== undefined}>
              <Play className="size-3.5" />
              {runtime ? '再跑一次' : '运行并追踪'}
            </Button>
          </form>
        </section>

        {!runtime ? (
          <p className="text-center text-sm text-muted-foreground">还没有运行记录</p>
        ) : (
          <>
            <section className="space-y-2" data-testid="runtime-summary">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{runtime.command}</code>
                <span className="text-xs text-muted-foreground">
                  {formatTime(runtime.startedAt)} · 用了 {formatDuration(runtime.durationMs)} · 跑到 {runtime.files} / {analysis.files.filter((file) => file.parsed).length} 个文件
                </span>
                {runtime.languages.map((language) => (
                  <Badge key={language} variant="secondary">
                    {language === 'node' ? 'Node.js' : 'Python'}
                  </Badge>
                ))}
                {runtime.timedOut ? <Badge variant="warning">超时停掉了</Badge> : runtime.exitCode !== 0 && <Badge variant="warning">退出码 {runtime.exitCode ?? '无'}</Badge>}
              </div>
              {runtime.notes.map((note) => (
                <p key={note} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {note}
                </p>
              ))}
              {runtime.output && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">命令输出（最后一段）</summary>
                  <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap break-all">{runtime.output}</pre>
                </details>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-xs text-muted-foreground">最花时间的函数（含它调用的）</h3>
              {runtime.functions.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">没有执行到项目里分析过的函数</p>
              ) : (
                <table className="w-full text-xs" data-testid="runtime-functions">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-1.5 font-normal">函数</th>
                      <th className="w-24 text-right font-normal">总时间</th>
                      <th className="w-24 text-right font-normal">自身</th>
                      <th className="w-20 text-right font-normal">调用次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runtime.functions.slice(0, MAX_ROWS).map((item) => (
                      <tr key={`${item.file}:${item.symbol}`} className="border-b border-border/50">
                        <td className="max-w-0 py-1">
                          <button type="button" className="block w-full truncate text-left hover:underline" title={`${analysis.files[item.file]?.path} ${item.symbol}`} onClick={() => openFunction(item.file, item.symbol)}>
                            <span className="font-mono">{item.symbol}</span>
                            <span className="text-muted-foreground"> · {analysis.files[item.file]?.path}</span>
                          </button>
                        </td>
                        <td className="text-right tabular-nums">{formatMs(item.totalMs)}</td>
                        <td className="text-right tabular-nums text-muted-foreground">{formatMs(item.selfMs)}</td>
                        <td className="text-right tabular-nums text-muted-foreground">{item.calls ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-xs text-muted-foreground">运行时的调用（「运行时才看到」的是静态分析对不上的：回调、动态分派、经过库的调用）</h3>
              <div className="space-y-1" data-testid="runtime-links">
                {runtime.links.slice(0, MAX_ROWS).map((link) => (
                  <div key={`${link.from}:${link.fromSymbol}:${link.to}:${link.toSymbol}`} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs" data-testid="runtime-link">
                    <button type="button" className="truncate font-mono hover:underline" onClick={() => peek(analysis.files[link.from]!.path, lineOf(link.from, link.fromSymbol))}>
                      {link.fromSymbol}
                    </button>
                    <span className="text-muted-foreground">→</span>
                    <button type="button" className="truncate font-mono hover:underline" onClick={() => peek(analysis.files[link.to]!.path, lineOf(link.to, link.toSymbol))}>
                      {link.toSymbol}
                    </button>
                    <span className="truncate text-muted-foreground">
                      {analysis.files[link.to]?.path} · {formatMs(link.ms)}
                      {link.calls !== null && ` · ${link.calls} 次`}
                    </span>
                    {!staticLinks.has(`${link.from}\u0000${link.fromSymbol}\u0000${link.to}\u0000${link.toSymbol}`) && <Badge variant="outline">运行时才看到</Badge>}
                  </div>
                ))}
              </div>
            </section>

            {idleFiles.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-xs text-muted-foreground">这次没运行到的文件（{idleFiles.length}）</h3>
                <p className="text-xs break-all text-muted-foreground">
                  {idleFiles.slice(0, 40).join('、')}
                  {idleFiles.length > 40 && ` 等 ${idleFiles.length} 个`}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
