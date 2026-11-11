import { useMemo, useState } from 'react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import type { DependencySection } from '@/state/store'
import { useArch } from '../context'
import { type Scope, scopeGraph } from '../graph'
import { GraphView } from './GraphView'

const MAX_MATRIX = 40

// 依赖：架构图的下钻层。依赖图（包 → 目录 → 文件 → 符号）、当前范围的依赖矩阵、循环依赖、外部包
export function DependenciesView() {
  const { route, go } = useArch()
  return (
    <div className="flex h-full flex-col" data-testid="architecture-dependencies">
      <div className="border-b px-4 py-2">
        <Segmented<DependencySection>
          label="依赖视图"
          size="sm"
          value={route.section}
          options={[
            { value: 'graph', label: '依赖图' },
            { value: 'matrix', label: '依赖矩阵' },
            { value: 'cycles', label: '循环依赖' },
            { value: 'externals', label: '外部包' },
          ]}
          onChange={(section) => go({ section })}
        />
      </div>
      {route.section === 'graph' ? (
        <div className="min-h-0 flex-1">
          <GraphView />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {route.section === 'matrix' && <Matrix />}
          {route.section === 'cycles' && <Cycles />}
          {route.section === 'externals' && <Externals />}
        </div>
      )}
    </div>
  )
}

function Matrix() {
  const { index, interpretation, diagrams, route, go } = useArch()
  const graph = useMemo(() => scopeGraph(index, route.scope as Scope, { interpretation, diagrams }, { outside: false, externals: false, hideTypeOnly: false }), [index, route.scope, interpretation, diagrams])
  const nodes = useMemo(() => [...graph.nodes].sort((a, b) => b.lines - a.lines).slice(0, MAX_MATRIX), [graph])
  const cell = useMemo(() => new Map(graph.edges.map((edge) => [edge.id, edge])), [graph])
  const max = Math.max(1, ...graph.edges.map((edge) => edge.count))
  if (nodes.length < 2) return <p className="text-sm text-muted-foreground">这一层只有一个节点，换到上一层看</p>
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        行依赖列，格子里是 import 条数；对角线两边都有数的是互相依赖，标黄的在循环依赖里。{graph.nodes.length > MAX_MATRIX && `只列最大的 ${MAX_MATRIX} 个。`}
      </p>
      <table className="border-separate border-spacing-0 text-xs" data-testid="architecture-matrix">
        <thead>
          <tr>
            <th />
            {nodes.map((node, at) => (
              <th key={node.id} className="w-8 px-0.5 pb-1 text-center font-normal text-muted-foreground" title={node.label}>
                {at + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((row, rowAt) => (
            <tr key={row.id}>
              <th className="max-w-56 truncate pr-2 text-left font-normal" title={row.path}>
                <button type="button" className="max-w-full truncate hover:underline" onClick={() => go({ focus: row.id }, false)}>
                  <span className="mr-1 text-muted-foreground tabular-nums">{rowAt + 1}</span>
                  {row.label}
                </button>
              </th>
              {nodes.map((column) => {
                const edge = cell.get(`${row.id}>${column.id}`)
                const diagonal = row.id === column.id
                return (
                  <td key={column.id} className="size-8 border border-border/60 p-0 text-center">
                    {edge ? (
                      <button
                        type="button"
                        className={cn('size-full tabular-nums hover:ring-2 hover:ring-ring', edge.cyclic && 'bg-warning-soft', route.focus === `edge:${edge.id}` && 'ring-2 ring-ring')}
                        style={edge.cyclic ? undefined : { background: `color-mix(in oklab, var(--chart-1) ${Math.round(8 + (edge.count / max) * 50)}%, transparent)` }}
                        title={`${row.label} → ${column.label}：${edge.count} 条`}
                        onClick={() => go({ focus: `edge:${edge.id}` }, false)}
                      >
                        {edge.count}
                      </button>
                    ) : diagonal ? (
                      <span className="block size-full bg-muted" />
                    ) : null}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cycles() {
  const { index, analysis, route, go } = useArch()
  const scopePath = route.scope.startsWith('dir:') ? route.scope.slice(4) : ''
  const cycles = useMemo(
    () => index.fileCycles.filter((cycle) => scopePath === '' || cycle.some((file) => analysis.files[file]!.path.startsWith(`${scopePath}/`))).sort((a, b) => b.length - a.length),
    [index, analysis, scopePath],
  )
  if (cycles.length === 0) return <p className="text-sm text-muted-foreground">{scopePath ? `「${scopePath}」下` : ''}没有文件之间的循环依赖</p>
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        文件之间互相 import 形成的环（{cycles.length} 个）。环里的文件只能一起改、一起测，拆环通常是把共同依赖的部分挪到更下层。
      </p>
      {cycles.map((cycle, at) => {
        const members = new Set(cycle)
        const inner = cycle.flatMap((file) => index.outgoing[file]!.filter((edge) => members.has(analysis.edges[edge]!.to)))
        return (
          <div key={at} className="space-y-2 rounded-lg border border-warning/40 p-3" data-testid="architecture-cycle">
            <div className="text-xs font-medium">
              {cycle.length} 个文件 · {inner.length} 条依赖
            </div>
            <div className="flex flex-wrap gap-1">
              {cycle.map((file) => (
                <button key={file} type="button" onClick={() => go({ tab: 'dependencies', section: 'graph', scope: `dir:${analysis.files[file]!.module}`, focus: `file:${analysis.files[file]!.path}` })}>
                  <Badge variant="outline" className="font-mono hover:bg-accent" title={analysis.files[file]!.path}>
                    {analysis.files[file]!.path.split('/').slice(-2).join('/')}
                  </Badge>
                </button>
              ))}
            </div>
            <div className="space-y-0.5">
              {inner.slice(0, 12).map((edgeIndex) => {
                const edge = analysis.edges[edgeIndex]!
                return (
                  <button
                    key={edgeIndex}
                    type="button"
                    className="block w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => go({ focus: `edge:file:${analysis.files[edge.from]!.path}>file:${analysis.files[edge.to]!.path}` }, false)}
                  >
                    {analysis.files[edge.from]!.path.split('/').pop()}:{edge.imports[0]?.line} → {analysis.files[edge.to]!.path.split('/').pop()}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Externals() {
  const { analysis, route, go } = useArch()
  const [builtin, setBuiltin] = useState(false)
  const shown = analysis.externals.filter((item) => builtin || !item.builtin)
  // 清单里声明了、代码里一处都没导入的（npm、Python 的名字能直接对上）
  const unused = useMemo(() => {
    const used = new Set(analysis.externals.map((item) => item.name.toLowerCase()))
    return analysis.packages.flatMap((item) =>
      item.ecosystem === 'npm' || item.ecosystem === 'python'
        ? item.dependencies.filter((name) => !used.has(name.toLowerCase()) && !name.startsWith('@types/') && !Object.keys(analysis.resolver.npmPackages).includes(name)).map((name) => ({ name, manifest: item.manifest ?? '' }))
        : [],
    )
  }, [analysis])
  return (
    <div className="space-y-5">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
        <Switch label="也列语言自带的库" checked={builtin} onChange={setBuiltin} />
        也列语言自带的库（node:fs、Python 标准库、Go 标准库、java.*）
      </label>
      <table className="w-full text-xs" data-testid="architecture-externals">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 font-normal">包</th>
            <th className="font-normal">生态</th>
            <th className="font-normal">清单</th>
            <th className="text-right font-normal">导入次数</th>
            <th className="pl-4 font-normal">主要用在</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((external) => {
            const dirs = new Map<string, number>()
            for (const use of external.uses) {
              const dir = analysis.files[use.file]!.module
              dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
            }
            const top = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 2)
            const id = `external:${external.ecosystem}:${external.name}`
            return (
              <tr key={id} className={cn('cursor-pointer border-b hover:bg-accent', route.focus === id && 'bg-accent')} onClick={() => go({ focus: id }, false)}>
                <td className="py-1.5 font-mono">{external.name}</td>
                <td>{external.ecosystem}</td>
                <td className="text-muted-foreground">{external.builtin ? '自带' : external.declared ? '已声明' : <span className="text-warning">没声明</span>}</td>
                <td className="text-right tabular-nums">{external.count}</td>
                <td className="truncate pl-4 font-mono text-muted-foreground">{top.map(([dir]) => dir || '（根目录）').join('、')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {unused.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">声明了但代码里没导入（{unused.length}）</h3>
          <p className="text-xs text-muted-foreground">可能是构建工具、命令行工具、类型或插件，不一定能删，删之前确认一下。</p>
          <div className="flex flex-wrap gap-1">
            {unused.map((item) => (
              <Badge key={`${item.manifest}:${item.name}`} variant="outline" className="font-mono" title={item.manifest}>
                {item.name}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
