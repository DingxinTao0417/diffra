import { useMemo, useState } from 'react'
import type { TableData } from '@diffra/core/rich'
import { ArrowDown, ArrowUp, ArrowUpDown, Copy, Search, Sheet, Table2 } from 'lucide-react'
import { cn } from 'cn'
import { BlockShell, copyText, ShellAction } from './BlockShell'
import { toCsv, toMarkdown } from './RichTable'

// 先显示这么多行，「显示更多」每次多这么多
const PAGE_ROWS = 50
// 行数到这么多才给筛选框
const FILTER_ROWS = 8

type Cell = TableData['rows'][number][number]

const cellText = (value: Cell) => (value === null ? '' : String(value))

// ```table：结构化数据。点表头排序（再点倒序、第三次恢复），行多时能筛选，分页显示；复制成 Markdown 或 CSV 时按当前排序和筛选
export function DataTableBlock({ data, bare }: { data: TableData; bare?: boolean }) {
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null)
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(PAGE_ROWS)
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matched = needle ? data.rows.filter((row) => row.some((value) => cellText(value).toLowerCase().includes(needle))) : data.rows
    if (!sort) return matched
    const numeric = data.columns[sort.column]?.numeric
    return [...matched].sort((a, b) => {
      const left = a[sort.column] ?? null
      const right = b[sort.column] ?? null
      if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
      const order = numeric && typeof left === 'number' && typeof right === 'number' ? left - right : cellText(left).localeCompare(cellText(right), 'zh-CN', { numeric: true })
      return order * sort.direction
    })
  }, [data, filter, sort])
  const plain = () => ({ header: data.columns.map((column) => column.label), align: data.columns.map((column) => column.align), rows: rows.map((row) => row.map(cellText)) })
  const cycle = (column: number) => setSort((current) => (current?.column !== column ? { column, direction: 1 } : current.direction === 1 ? { column, direction: -1 } : null))
  return (
    <BlockShell
      bare={bare}
      testId="rich-table"
      kind="table"
      tone="card"
      icon={<Table2 className="size-3.5 shrink-0" />}
      title={data.title ?? '表格'}
      meta={<span className="shrink-0 tabular-nums">· {filter ? `${rows.length}/${data.rows.length}` : data.rows.length} 行</span>}
      actions={
        <>
          <ShellAction label="复制为 Markdown" onClick={() => copyText(toMarkdown(plain()), '已复制表格')}>
            <Copy />
          </ShellAction>
          <ShellAction label="复制为 CSV" onClick={() => copyText(toCsv(plain()), '已复制 CSV')}>
            <Sheet />
          </ShellAction>
        </>
      }
    >
      {data.rows.length >= FILTER_ROWS && (
        <label className="flex items-center gap-1.5 border-b px-3 py-1 text-sm">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选" aria-label="筛选表格" className="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground" />
        </label>
      )}
      <div className="max-h-[28rem] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {data.columns.map((column, index) => {
                const active = sort?.column === index
                const Icon = !active ? ArrowUpDown : sort.direction === 1 ? ArrowUp : ArrowDown
                return (
                  <th key={column.key} scope="col" aria-sort={active ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'} className={cn('sticky top-0 z-1 border-b bg-muted p-0 font-bold', index > 0 && 'border-l')}>
                    <button type="button" className={cn('flex w-full items-center gap-1 px-2.5 py-1.5 hover:bg-accent', column.align === 'right' && 'justify-end', column.align === 'center' && 'justify-center')} onClick={() => cycle(index)}>
                      <span className="truncate">{column.label}</span>
                      <Icon className={cn('size-3 shrink-0', active ? 'text-foreground' : 'text-muted-foreground/60')} aria-hidden="true" />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-accent/40" data-testid="rich-table-row">
                {row.map((value, index) => (
                  <td key={index} className={cn('border-b px-2.5 py-1', index > 0 && 'border-l', data.columns[index]?.numeric && 'tabular-nums', data.columns[index]?.align === 'right' && 'text-right', data.columns[index]?.align === 'center' && 'text-center', value === null && 'text-muted-foreground')}>
                    {value === null ? '—' : cellText(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-3 py-3 text-center text-sm text-muted-foreground">{data.rows.length === 0 ? '没有数据' : '没有匹配的行'}</p>}
      </div>
      {rows.length > limit && (
        <button type="button" className="w-full border-t py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setLimit(limit + PAGE_ROWS)} data-testid="rich-table-more">
          显示更多（还有 {rows.length - limit} 行）
        </button>
      )}
    </BlockShell>
  )
}
