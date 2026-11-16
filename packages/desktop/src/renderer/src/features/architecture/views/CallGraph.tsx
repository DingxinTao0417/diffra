import { useMemo } from 'react'
import type { CallLink } from '@diffra/core/architecture'
import { ArrowRight } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { useArch } from '../context'

// 函数级调用图（v2 · M9）：选中的函数在中间，左边谁调了它，右边它调了谁；点别的函数换成以它为中心。
// 只画一层：两层在大项目里很快就是几百个节点。宽的时候三栏，窄的时候竖着排
const MAX_SIDE = 30

export interface CallTarget {
  file: number
  symbol: string
}

export const callKey = (file: number, symbol: string) => `${file}\u0000${symbol}`

export function useCallIndex(calls: readonly CallLink[] | undefined) {
  return useMemo(() => {
    const callers = new Map<string, CallLink[]>()
    const callees = new Map<string, CallLink[]>()
    for (const call of calls ?? []) {
      const to = callKey(call.to, call.toSymbol)
      const from = callKey(call.from, call.fromSymbol)
      callers.set(to, [...(callers.get(to) ?? []), call])
      callees.set(from, [...(callees.get(from) ?? []), call])
    }
    return { callers, callees }
  }, [calls])
}

export function CallGraph({ target, onSelect }: { target: CallTarget; onSelect(next: CallTarget): void }) {
  const { analysis, peek } = useArch()
  const { callers, callees } = useCallIndex(analysis.calls)
  const key = callKey(target.file, target.symbol)
  const incoming = callers.get(key) ?? []
  const outgoing = callees.get(key) ?? []
  const centerPath = analysis.files[target.file]!.path
  const lineOf = (next: CallTarget) => analysis.files[next.file]!.symbols.find((symbol) => (symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name) === next.symbol)?.line ?? 1

  const side = (calls: CallLink[], direction: 'in' | 'out') => (
    <div className="flex min-w-0 flex-col gap-1.5" aria-label={direction === 'in' ? '调用了它的' : '它调用的'}>
      <span className="text-xs text-muted-foreground">{direction === 'in' ? `被 ${calls.length} 个函数调用` : `调用了 ${calls.length} 个函数`}</span>
      {calls.length === 0 && <span className="rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">{direction === 'in' ? '没有找到调用它的地方' : '没有调用项目里的函数'}</span>}
      {calls.slice(0, MAX_SIDE).map((call) => {
        const next = direction === 'in' ? { file: call.from, symbol: call.fromSymbol } : { file: call.to, symbol: call.toSymbol }
        const path = analysis.files[next.file]!.path
        return (
          <div key={callKey(next.file, next.symbol)} className={cn('rounded-md border bg-card text-xs', path !== centerPath && 'border-dashed')}>
            <button type="button" className="block w-full min-w-0 px-2 pt-1.5 text-left hover:underline" title={`${path}\n${next.symbol}`} onClick={() => onSelect(next)}>
              <span className="block truncate font-mono font-bold">{next.symbol}</span>
              <span className="block truncate text-muted-foreground">{path}</span>
            </button>
            <div className="flex flex-wrap gap-x-2 px-2 pb-1.5">
              {call.lines.slice(0, 4).map((line) => (
                <button key={line} type="button" className="text-muted-foreground tabular-nums hover:text-foreground hover:underline" onClick={() => peek(analysis.files[call.from]!.path, line)}>
                  {direction === 'in' ? `第 ${line} 行调用` : `第 ${line} 行`}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      {calls.length > MAX_SIDE && <span className="text-xs text-muted-foreground">还有 {calls.length - MAX_SIDE} 个</span>}
    </div>
  )

  const arrow = <ArrowRight className="size-4 shrink-0 self-center text-muted-foreground @max-xl:rotate-90" aria-hidden />

  return (
    <div className="@container space-y-2" data-testid="call-graph">
      <div className="grid items-start gap-2 @xl:grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)_1rem_minmax(0,1fr)]">
        {side(incoming, 'in')}
        {arrow}
        <div className="flex min-w-0 flex-col gap-1.5 @xl:pt-5">
          <div className="rounded-md border border-foreground/40 bg-soft px-2 py-1.5 text-xs ring-2 ring-ring/20">
            <span className="block truncate font-mono font-bold">{target.symbol}</span>
            <span className="block truncate text-muted-foreground">{centerPath}</span>
            <Button variant="outline" size="xs" className="mt-1" onClick={() => peek(centerPath, lineOf(target))}>
              看代码
            </Button>
          </div>
        </div>
        {arrow}
        {side(outgoing, 'out')}
      </div>
      <p className="text-xs text-muted-foreground">点一个函数换成以它为中心。静态分析：通过变量、回调、继承分派的调用对不上，不在这里。虚线框是别的文件里的。</p>
    </div>
  )
}
