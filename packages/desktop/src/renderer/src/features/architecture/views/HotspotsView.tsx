import { useMemo, useState } from 'react'
import { cn } from 'cn'
import { Segmented } from '@/components/ui/segmented'
import { useArch } from '../context'
import { formatCount, hotspots, parseScope } from '../graph'

const MAX_ROWS = 100

type Grouping = 'file' | 'dir'

// 热点：又大、又常改、又和很多代码耦合的地方，最该先看懂、最值得重构
export function HotspotsView() {
  const { index, analysis, route, go } = useArch()
  const [grouping, setGrouping] = useState<Grouping>('file')
  const { kind, path } = parseScope(route.scope)
  const scopeFiles = useMemo(() => (kind === 'dir' ? index.filesUnder(path) : kind === 'file' ? [index.fileIndex.get(path)!].filter((at) => at !== undefined) : index.filesUnder('')), [index, kind, path])
  const files = useMemo(() => hotspots(index, scopeFiles).slice(0, MAX_ROWS), [index, scopeFiles])
  const dirs = useMemo(() => {
    const totals = new Map<string, { lines: number; churn: number; coupling: number; score: number; files: number }>()
    for (const { file, score } of hotspots(index, scopeFiles)) {
      const info = analysis.files[file]!
      const entry = totals.get(info.module) ?? { lines: 0, churn: 0, coupling: 0, score: 0, files: 0 }
      entry.lines += info.lines
      entry.churn += info.churn
      entry.coupling += index.fileFanIn[file]! + index.fileFanOut[file]!
      entry.score += score
      entry.files++
      totals.set(info.module, entry)
    }
    return [...totals].map(([dir, value]) => ({ dir, ...value })).sort((a, b) => b.score - a.score).slice(0, MAX_ROWS)
  }, [index, analysis, scopeFiles])
  const maxScore = Math.max(1, ...(grouping === 'file' ? files.map((item) => item.score) : dirs.map((item) => item.score)))
  const noHistory = analysis.commits.length === 0

  return (
    <div className="h-full overflow-y-auto p-5" data-testid="architecture-hotspots">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented<Grouping>
          label="热点按什么列"
          size="sm"
          value={grouping}
          options={[
            { value: 'file', label: '文件' },
            { value: 'dir', label: '目录' },
          ]}
          onChange={setGrouping}
        />
        <span className="text-xs text-muted-foreground">
          分数 = 代码行数 × 最近 {analysis.churnDays} 天的提交次数 × 耦合度（依赖和被依赖的文件数），各取对数{noHistory && '。不是 git 仓库，改动次数都按 0 算'}
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 font-normal">{grouping === 'file' ? '文件' : '目录'}</th>
            <th className="w-20 text-right font-normal">代码行</th>
            <th className="w-20 text-right font-normal">提交</th>
            <th className="w-20 text-right font-normal">{grouping === 'file' ? '被依赖/依赖' : '耦合'}</th>
            <th className="w-48 pl-4 font-normal">热度</th>
          </tr>
        </thead>
        <tbody>
          {grouping === 'file'
            ? files.map(({ file, score }) => {
                const info = analysis.files[file]!
                const id = `file:${info.path}`
                return (
                  <tr key={file} className={cn('cursor-pointer border-b hover:bg-accent', route.focus === id && 'bg-accent')} onClick={() => go({ focus: id }, false)} onDoubleClick={() => go({ tab: 'dependencies', section: 'graph', scope: id, focus: null })}>
                    <td className="max-w-0 truncate py-1.5 font-mono" title={info.path}>
                      {info.path}
                    </td>
                    <td className="text-right tabular-nums">{formatCount(info.lines)}</td>
                    <td className="text-right tabular-nums">{info.churn}</td>
                    <td className="text-right tabular-nums">
                      {index.fileFanIn[file]}/{index.fileFanOut[file]}
                    </td>
                    <td className="pl-4">
                      <Bar ratio={score / maxScore} />
                    </td>
                  </tr>
                )
              })
            : dirs.map((item) => {
                const id = `dir:${item.dir}`
                return (
                  <tr key={item.dir} className={cn('cursor-pointer border-b hover:bg-accent', route.focus === id && 'bg-accent')} onClick={() => go({ focus: id }, false)}>
                    <td className="max-w-0 truncate py-1.5 font-mono" title={item.dir}>
                      {item.dir || '（根目录）'} <span className="text-muted-foreground">· {item.files} 个文件</span>
                    </td>
                    <td className="text-right tabular-nums">{formatCount(item.lines)}</td>
                    <td className="text-right tabular-nums">{item.churn}</td>
                    <td className="text-right tabular-nums">{item.coupling}</td>
                    <td className="pl-4">
                      <Bar ratio={item.score / maxScore} />
                    </td>
                  </tr>
                )
              })}
        </tbody>
      </table>
    </div>
  )
}

function Bar({ ratio }: { ratio: number }) {
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
      <span className="block h-full" style={{ width: `${Math.max(2, ratio * 100)}%`, background: 'color-mix(in oklab, var(--warning) 75%, var(--foreground))' }} />
    </span>
  )
}
