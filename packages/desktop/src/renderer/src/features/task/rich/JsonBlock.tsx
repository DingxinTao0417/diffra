import { useMemo, useState } from 'react'
import { parseRichBlock } from '@diffra/core/rich'
import { Braces, ChevronDown, ChevronRight, Code, Copy, ListTree, Search } from 'lucide-react'
import { cn } from 'cn'
import { BlockShell, copyText, ShellAction } from './BlockShell'
import { CodeBlock } from './CodeBlock'
import type { FenceInfo } from './fence'

// 超过这么多行的 JSON 默认按树显示，短的按代码显示；都能切换
const TREE_LINES = 40
// 一层最多先画这么多个子项
const CHILD_PAGE = 100

// ```json：先按代码显示（高亮、行号），合法时顶栏多一个「树形」开关；长的默认是树
export function JsonBlock({ info, closed }: { info: FenceInfo; closed: boolean }) {
  const parsed = useMemo(() => (closed ? parseRichBlock('json', info.code) : null), [closed, info.code])
  const lines = info.code.split('\n').length
  const [tree, setTree] = useState<boolean | null>(null)
  if (!parsed?.ok || typeof parsed.data.value !== 'object' || parsed.data.value === null) return <CodeBlock info={info} closed={closed} />
  const asTree = tree ?? lines > TREE_LINES
  if (!asTree) {
    return (
      <CodeBlock
        info={info}
        extraActions={
          <ShellAction label="树形查看" onClick={() => setTree(true)}>
            <ListTree />
          </ShellAction>
        }
      />
    )
  }
  return <JsonTree value={parsed.data.value} source={info.code} onShowCode={() => setTree(false)} />
}

// JSON 树：点箭头展开收起；搜索时自动展开命中的路径、高亮命中的键和值；点键名复制它的路径（$.a.b[0]）
export function JsonTree({ value, source, onShowCode }: { value: unknown; source: string; onShowCode?: () => void }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => (needle ? matchingPaths(value, needle) : null), [value, needle])
  return (
    <BlockShell
      testId="json-tree"
      kind="json"
      icon={<Braces className="size-3.5 shrink-0" />}
      title="JSON"
      meta={matches && <span className="shrink-0 tabular-nums">· {matches.hits} 处命中</span>}
      actions={
        <>
          {onShowCode && (
            <ShellAction label="按代码查看" onClick={onShowCode}>
              <Code />
            </ShellAction>
          )}
          <ShellAction label="复制 JSON" onClick={() => copyText(source, '已复制 JSON')}>
            <Copy />
          </ShellAction>
        </>
      }
    >
      <label className="flex items-center gap-1.5 border-b px-3 py-1 text-sm">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索键或值" aria-label="搜索 JSON" className="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground" />
      </label>
      <div className="max-h-96 overflow-auto bg-background py-1.5 font-mono text-xs leading-5" role="tree" aria-label="JSON">
        <JsonNode name={null} value={value} path="$" depth={0} matches={matches} needle={needle} />
      </div>
    </BlockShell>
  )
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

// 命中的路径和它们的所有上级（要展开）
function matchingPaths(value: unknown, needle: string): { open: Set<string>; hits: number } {
  const open = new Set<string>()
  let hits = 0
  const walk = (node: unknown, path: string, key: string | null): boolean => {
    let found = false
    if (key !== null && key.toLowerCase().includes(needle)) {
      hits += 1
      found = true
    }
    if (node !== null && typeof node === 'object') {
      let inside = false
      for (const [childKey, child] of Object.entries(node)) {
        const index = Array.isArray(node) ? Number(childKey) : childKey
        if (walk(child, childPath(path, index), Array.isArray(node) ? null : childKey)) inside = true
      }
      if (inside) open.add(path)
      found ||= inside
    } else if (String(node).toLowerCase().includes(needle)) {
      hits += 1
      found = true
    }
    return found
  }
  walk(value, '$', null)
  return { open, hits }
}

function JsonNode({ name, value, path, depth, matches, needle }: { name: string | number | null; value: unknown; path: string; depth: number; matches: { open: Set<string> } | null; needle: string }) {
  const [open, setOpen] = useState(depth < 2)
  const [limit, setLimit] = useState(CHILD_PAGE)
  const expanded = matches ? matches.open.has(path) || open : open
  const indent = { paddingLeft: `${0.75 + depth * 1}rem` }
  const label =
    name === null ? null : (
      <button type="button" className={cn('rounded-xs hover:underline', typeof name === 'string' && 'text-(--code-number)', needle && String(name).toLowerCase().includes(needle) && 'bg-highlight')} title={`复制路径 ${path}`} onClick={() => copyText(path, `已复制路径 ${path}`)}>
        {typeof name === 'number' ? name : JSON.stringify(name)}
      </button>
    )
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    const array = Array.isArray(value)
    const summary = array ? `[${entries.length}]` : `{${entries.length}}`
    return (
      <div role="treeitem" aria-expanded={expanded} data-path={path}>
        <div className="flex items-center gap-1 pr-3 hover:bg-accent/50" style={indent}>
          <button type="button" aria-label={expanded ? `收起 ${path}` : `展开 ${path}`} className="-ml-4 flex size-4 items-center justify-center text-muted-foreground" onClick={() => setOpen(!expanded)}>
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
          {label}
          {label && <span className="text-muted-foreground">:</span>}
          <span className="text-muted-foreground">{summary}</span>
        </div>
        {expanded && (
          <div role="group">
            {entries.slice(0, limit).map(([key, child]) => {
              const childKey = array ? Number(key) : key
              return <JsonNode key={key} name={childKey} value={child} path={childPath(path, childKey)} depth={depth + 1} matches={matches} needle={needle} />
            })}
            {entries.length > limit && (
              <button type="button" className="text-muted-foreground hover:text-foreground" style={{ paddingLeft: `${1.75 + depth * 1}rem` }} onClick={() => setLimit(limit + CHILD_PAGE)}>
                还有 {entries.length - limit} 项…
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  const tone = typeof value === 'string' ? 'text-(--code-string)' : value === null ? 'text-muted-foreground' : 'text-(--code-keyword)'
  return (
    <div role="treeitem" className="flex min-w-0 items-baseline gap-1 pr-3 hover:bg-accent/50" style={indent} data-path={path}>
      {label}
      {label && <span className="text-muted-foreground">:</span>}
      <span className={cn('min-w-0 break-all', tone, needle && text.toLowerCase().includes(needle) && 'bg-highlight')}>{text}</span>
    </div>
  )
}
