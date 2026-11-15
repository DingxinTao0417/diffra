import { type ComponentProps, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { ChevronsDownUp, ChevronsUpDown, Copy, Sheet } from 'lucide-react'
import { cn } from 'cn'
import { copyText, ShellAction } from './BlockShell'
import { type Element, textOf } from './fence'

// 超过这么多行先收起，只显示前 PREVIEW_ROWS 行
const COLLAPSE_ROWS = 25
const PREVIEW_ROWS = 15

interface TableData {
  header: string[]
  rows: string[][]
  align: Array<'left' | 'center' | 'right' | null>
}

// 回答里的 Markdown 表格：横向滚动、表头固定、行多时收起；右上角能复制成 Markdown 或 CSV（悬停或键盘聚焦时出现）
export function RichTable({ node, children }: ComponentProps<'table'> & ExtraProps) {
  const [expanded, setExpanded] = useState(false)
  const data = node ? tableData(node) : { header: [], rows: [], align: [] }
  const long = data.rows.length > COLLAPSE_ROWS
  const collapsed = long && !expanded
  return (
    <div className="group/table relative w-fit max-w-full" data-testid="md-table" data-rows={data.rows.length}>
      <div className="absolute top-1 right-1 z-10 flex rounded-md border bg-popover opacity-0 shadow-overlay transition-opacity group-hover/table:opacity-100 focus-within:opacity-100">
        <ShellAction label="复制为 Markdown" onClick={() => copyText(toMarkdown(data), '已复制表格')}>
          <Copy />
        </ShellAction>
        <ShellAction label="复制为 CSV" onClick={() => copyText(toCsv(data), '已复制 CSV')}>
          <Sheet />
        </ShellAction>
        {long && (
          <ShellAction label={expanded ? '收起' : `展开全部 ${data.rows.length} 行`} onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </ShellAction>
        )}
      </div>
      <div className={cn('table-scroll overflow-auto rounded-lg border', expanded && 'max-h-[32rem]')}>
        {/* 收起时藏掉第 PREVIEW_ROWS 行以后的行（styles.css 的 .table-collapsed，行数写死在那边） */}
        <table className={cn(collapsed && 'table-collapsed')}>{children}</table>
      </div>
      {collapsed && (
        <button type="button" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(true)} data-testid="table-expand">
          <ChevronsUpDown className="size-3.5" />
          展开其余 {data.rows.length - PREVIEW_ROWS} 行
        </button>
      )}
    </div>
  )
}

function rowsOf(node: Element, tag: string): Element[] {
  const section = node.children.find((child): child is Element => child.type === 'element' && child.tagName === tag)
  return section ? section.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'tr') : []
}

function cellsOf(row: Element): Element[] {
  return row.children.filter((child): child is Element => child.type === 'element' && (child.tagName === 'td' || child.tagName === 'th'))
}

export function tableData(node: Element): TableData {
  const headRow = rowsOf(node, 'thead')[0]
  const headCells = headRow ? cellsOf(headRow) : []
  return {
    header: headCells.map((cell) => textOf(cell.children).trim()),
    align: headCells.map((cell) => {
      const align = cell.properties.align
      return align === 'left' || align === 'center' || align === 'right' ? align : null
    }),
    rows: rowsOf(node, 'tbody').map((row) => cellsOf(row).map((cell) => textOf(cell.children).trim())),
  }
}

const markdownCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function toMarkdown({ header, rows, align }: TableData): string {
  const divider = header.map((_, index) => {
    const value = align[index]
    return value === 'center' ? ':---:' : value === 'right' ? '---:' : value === 'left' ? ':---' : '---'
  })
  return [header, divider, ...rows].map((cells) => `| ${cells.map(markdownCell).join(' | ')} |`).join('\n')
}

const csvCell = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)

export function toCsv({ header, rows }: TableData): string {
  return [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\r\n')
}
