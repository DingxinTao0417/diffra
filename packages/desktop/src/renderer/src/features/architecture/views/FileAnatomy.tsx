import { useMemo, useState } from 'react'
import type { SymbolFact } from '@diffra/core/architecture'
import { ArrowLeft, ArrowRight, FileCode2 } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useArch } from '../context'
import { formatCount } from '../graph'

// L4：一个文件里的符号，谁引用了哪个符号，它又依赖了什么。鼠标移到符号上，标出用到它的文件
export function FileAnatomy({ path }: { path: string }) {
  const { index, analysis, go, peek } = useArch()
  const fileIndex = index.fileIndex.get(path)
  const file = fileIndex === undefined ? null : analysis.files[fileIndex]!
  const [hovered, setHovered] = useState<string | null>(null)

  const importers = useMemo(
    () =>
      fileIndex === undefined
        ? []
        : index.incoming[fileIndex]!.map((edgeIndex) => {
            const edge = analysis.edges[edgeIndex]!
            return { file: analysis.files[edge.from]!, names: [...new Set(edge.imports.flatMap((item) => item.names))], imports: edge.imports }
          }),
    [index, analysis, fileIndex],
  )
  const dependencies = useMemo(
    () =>
      fileIndex === undefined
        ? []
        : index.outgoing[fileIndex]!.map((edgeIndex) => {
            const edge = analysis.edges[edgeIndex]!
            return { file: analysis.files[edge.to]!, imports: edge.imports }
          }),
    [index, analysis, fileIndex],
  )
  const externals = useMemo(() => (fileIndex === undefined ? [] : analysis.externals.flatMap((external) => external.uses.filter((use) => use.file === fileIndex).map((use) => ({ external, use })))), [analysis, fileIndex])
  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const importer of importers) for (const name of importer.names) counts.set(name, (counts.get(name) ?? 0) + 1)
    return counts
  }, [importers])

  if (!file) return <div className="p-6 text-sm text-muted-foreground">这次分析里没有 {path}</div>
  const topLevel = file.symbols.filter((symbol) => symbol.parent === null)
  const members = (parent: string) => file.symbols.filter((symbol) => symbol.parent === parent)
  // 整模块导入（import * as x、Go、Java 的包级导入）不知道用了哪个符号
  const wholeModule = importers.filter((importer) => importer.names.length === 0 || importer.names.includes('*'))

  return (
    <div className="h-full overflow-y-auto" data-testid="architecture-file">
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <FileCode2 className="size-5 text-muted-foreground" />
          <h2 className="font-mono text-base font-semibold">{file.path}</h2>
          <Badge variant="secondary">{file.language}</Badge>
          {file.entry && <Badge variant="outline">入口</Badge>}
          <span className="text-xs text-muted-foreground">
            {formatCount(file.lines)} 行 · 近 {analysis.churnDays} 天 {file.churn} 次提交
          </span>
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => peek(file.path, 1)}>
            看代码
          </Button>
        </div>
        {!file.parsed && <div className="rounded-lg border p-3 text-sm text-muted-foreground">这种语言只统计文件和行数，不解析符号和依赖。</div>}
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr_1fr]">
          <Column title={`被谁引用（${importers.length}）`} icon={<ArrowRight className="size-3.5" />}>
            {importers.length === 0 && <Empty>没有项目里的文件引用它</Empty>}
            {importers.map((importer) => {
              const active = hovered !== null && (importer.names.includes(hovered) || importer.names.length === 0)
              return (
                <div key={importer.file.path} className={cn('rounded-md border p-2 transition-colors', active && 'border-foreground/40 bg-accent')}>
                  <FileLink path={importer.file.path} onOpen={() => go({ scope: `file:${importer.file.path}`, focus: null })} />
                  <div className="mt-1 flex flex-wrap gap-1">
                    {importer.names.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">整个模块</span>
                    ) : (
                      importer.names.map((name) => (
                        <span key={name} className={cn('rounded bg-muted px-1 font-mono text-[11px]', hovered === name && 'bg-highlight')}>
                          {name}
                        </span>
                      ))
                    )}
                  </div>
                  {importer.imports.map((item) => (
                    <button key={item.line} type="button" className="block text-[11px] text-muted-foreground hover:underline" onClick={() => peek(importer.file.path, item.line)}>
                      第 {item.line} 行
                    </button>
                  ))}
                </div>
              )
            })}
          </Column>
          <Column title={`符号（${file.symbols.length}）`}>
            {file.symbols.length === 0 && <Empty>没有顶层定义</Empty>}
            {topLevel.map((symbol) => (
              <SymbolRow key={`${symbol.name}:${symbol.line}`} symbol={symbol} uses={usage.get(symbol.name) ?? 0} wholeModule={wholeModule.length} onHover={setHovered} onOpen={() => peek(file.path, symbol.line)}>
                {members(symbol.name).map((member) => (
                  <SymbolRow key={`${member.name}:${member.line}`} symbol={member} uses={0} wholeModule={0} nested onHover={setHovered} onOpen={() => peek(file.path, member.line)} />
                ))}
              </SymbolRow>
            ))}
            {/* Rust 的 impl、Go 的方法所属的类型可能不在这个文件里 */}
            {file.symbols
              .filter((symbol) => symbol.parent !== null && !topLevel.some((top) => top.name === symbol.parent))
              .map((symbol) => (
                <SymbolRow key={`${symbol.parent}.${symbol.name}:${symbol.line}`} symbol={symbol} uses={0} wholeModule={0} onHover={setHovered} onOpen={() => peek(file.path, symbol.line)} />
              ))}
          </Column>
          <Column title={`依赖（${dependencies.length + externals.length}）`} icon={<ArrowLeft className="size-3.5 rotate-180" />}>
            {dependencies.length + externals.length === 0 && <Empty>不依赖别的文件</Empty>}
            {dependencies.map((dependency) => (
              <div key={dependency.file.path} className="rounded-md border p-2">
                <FileLink path={dependency.file.path} onOpen={() => go({ scope: `file:${dependency.file.path}`, focus: null })} />
                {dependency.imports.map((item) => (
                  <button key={`${item.line}:${item.specifier}`} type="button" className="mt-0.5 flex w-full gap-1.5 text-left font-mono text-[11px] hover:underline" onClick={() => peek(file.path, item.line)}>
                    <span className="text-muted-foreground">{item.line}</span>
                    <span className="truncate">{item.names.length > 0 ? item.names.join(', ') : item.specifier}</span>
                  </button>
                ))}
              </div>
            ))}
            {externals.map(({ external, use }) => (
              <button
                key={`${external.name}:${use.line}`}
                type="button"
                className="flex w-full items-center gap-2 rounded-md border border-dashed px-2 py-1 text-left text-xs hover:bg-accent"
                onClick={() => go({ focus: `external:${external.ecosystem}:${external.name}` }, false)}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{use.specifier}</span>
                <span className="text-muted-foreground">{external.builtin ? '自带' : '外部'}</span>
              </button>
            ))}
          </Column>
        </div>
      </div>
    </div>
  )
}

function Column({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{children}</div>
}

function FileLink({ path, onOpen }: { path: string; onOpen(): void }) {
  return (
    <button type="button" className="block w-full truncate text-left font-mono text-xs hover:underline" title={path} onClick={onOpen}>
      {path.split('/').pop()}
      <span className="text-muted-foreground"> · {path.split('/').slice(-3, -1).join('/')}</span>
    </button>
  )
}

function SymbolRow({
  symbol,
  uses,
  wholeModule,
  nested = false,
  onHover,
  onOpen,
  children,
}: {
  symbol: SymbolFact
  uses: number
  wholeModule: number
  nested?: boolean
  onHover(name: string | null): void
  onOpen(): void
  children?: React.ReactNode
}) {
  return (
    <div className={nested ? 'ml-4' : 'rounded-md border'}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
        onMouseEnter={() => onHover(symbol.name)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(symbol.name)}
        onBlur={() => onHover(null)}
        onClick={onOpen}
      >
        <span className="w-14 shrink-0 text-muted-foreground">{symbol.kind}</span>
        <span className={cn('min-w-0 flex-1 truncate font-mono', !symbol.exported && 'text-muted-foreground')}>
          {nested || !symbol.parent ? '' : `${symbol.parent}.`}
          {symbol.name}
        </span>
        {!nested && symbol.exported && (uses > 0 || wholeModule > 0) && (
          <span className="shrink-0 text-[11px] text-muted-foreground" title="按导入的名字统计；整模块导入的另算">
            {uses > 0 ? `${uses} 处引用` : ''}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground tabular-nums">{symbol.line}</span>
      </button>
      {children}
    </div>
  )
}
