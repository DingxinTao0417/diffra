import { useContext, useMemo, useState } from 'react'
import type { FileTreeData } from '@diffra/core/rich'
import { ChevronDown, ChevronRight, Copy, Folder, FolderOpen, FolderTree } from 'lucide-react'
import { cn } from 'cn'
import { AnswerContext, LanguageBadge, openFilePreview, useProjectFile } from '../answer-links'
import { BlockShell, copyText, ShellAction } from './BlockShell'

type Status = FileTreeData['items'][number]['status']

interface TreeNode {
  name: string
  path: string
  file: { status?: Status; note?: string } | null
  children: TreeNode[]
}

// 改动标记用 diff 的颜色（表示改动方向，不是验证结果）
const STATUS: Record<NonNullable<Status>, { mark: string; label: string; className: string }> = {
  added: { mark: 'A', label: '新增', className: 'text-diff-add-fg' },
  modified: { mark: 'M', label: '修改', className: 'text-muted-foreground' },
  deleted: { mark: 'D', label: '删除', className: 'text-diff-del-fg' },
  renamed: { mark: 'R', label: '改名', className: 'text-muted-foreground' },
}

// 只有一个子目录的目录合成一行（src/features/task）
function buildTree(items: FileTreeData['items']): TreeNode[] {
  const root: TreeNode = { name: '', path: '', file: null, children: [] }
  for (const item of items) {
    const parts = item.path.replace(/\/+$/, '').split('/').filter(Boolean)
    const directory = item.path.endsWith('/')
    let node = root
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/')
      let child = node.children.find((candidate) => candidate.name === part)
      if (!child) {
        child = { name: part, path, file: null, children: [] }
        node.children.push(child)
      }
      if (index === parts.length - 1 && !directory) child.file = { status: item.status, note: item.note }
      node = child
    })
  }
  const squash = (node: TreeNode): TreeNode => {
    let current = { ...node, children: node.children.map(squash) }
    while (!current.file && current.children.length === 1 && !current.children[0]!.file) {
      const only = current.children[0]!
      current = { ...only, name: `${current.name}/${only.name}` }
    }
    return current
  }
  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes.sort((a, b) => Number(Boolean(a.file) && a.children.length === 0) - Number(Boolean(b.file) && b.children.length === 0) || a.name.localeCompare(b.name)).map((node) => ({ ...node, children: sortNodes(node.children) }))
  return sortNodes(root.children.map(squash))
}

// ```filetree：目录结构或这次改了哪些文件。目录能收起；项目里的文件点一下在文件面板打开
export function FileTreeBlock({ data }: { data: FileTreeData }) {
  const tree = useMemo(() => buildTree(data.items), [data.items])
  const counts = data.items.reduce<Record<string, number>>((total, item) => (item.status ? { ...total, [item.status]: (total[item.status] ?? 0) + 1 } : total), {})
  return (
    <BlockShell
      testId="rich-filetree"
      kind="filetree"
      tone="card"
      icon={<FolderTree className="size-3.5 shrink-0" />}
      title={data.title ?? data.root ?? '文件'}
      meta={
        <span className="shrink-0 tabular-nums">
          · {data.items.length} 项
          {Object.entries(counts).map(([status, count]) => ` · ${STATUS[status as NonNullable<Status>].label} ${count}`)}
        </span>
      }
      actions={
        <ShellAction label="复制路径列表" onClick={() => copyText(data.items.map((item) => item.path).join('\n'), '已复制路径')}>
          <Copy />
        </ShellAction>
      }
    >
      <ul className="max-h-96 overflow-auto py-1 text-sm" role="tree" aria-label={data.title ?? '文件'}>
        {tree.map((node) => (
          <TreeRow key={node.path} node={node} depth={0} />
        ))}
      </ul>
    </BlockShell>
  )
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 3)
  const indent = { paddingLeft: `${0.75 + depth * 1}rem` }
  if (node.children.length > 0) {
    return (
      <li role="treeitem" aria-expanded={open}>
        <button type="button" className="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left hover:bg-accent" style={indent} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          {open ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate font-mono text-xs">{node.name}</span>
        </button>
        {open && (
          <ul role="group">
            {node.children.map((child) => (
              <TreeRow key={child.path} node={child} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    )
  }
  return <FileRow node={node} indent={indent} />
}

function FileRow({ node, indent }: { node: TreeNode; indent: React.CSSProperties }) {
  const target = useContext(AnswerContext)
  // 删掉的文件不在了，不去查
  const deleted = node.file?.status === 'deleted'
  const file = useProjectFile(deleted ? null : node.path)
  const status = node.file?.status ? STATUS[node.file.status] : null
  const content = (
    <>
      <span className="size-3.5 shrink-0" />
      {node.name.includes('.') ? <LanguageBadge path={node.name} /> : <span className="size-3.5 shrink-0" />}
      <span className={cn('min-w-0 truncate font-mono text-xs', deleted && 'line-through')}>{node.name}</span>
      {node.file?.note && <span className="min-w-0 truncate text-xs text-muted-foreground">{node.file.note}</span>}
      {status && (
        <span className={cn('ml-auto shrink-0 font-mono text-xs', status.className)} title={status.label}>
          {status.mark}
          <span className="sr-only">{status.label}</span>
        </span>
      )}
    </>
  )
  return (
    <li role="treeitem" data-testid="rich-filetree-file" data-status={node.file?.status}>
      {file && target ? (
        <button type="button" className="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left hover:bg-accent" style={indent} title={`在文件面板打开 ${file.relative}`} onClick={() => openFilePreview(target.project, file.relative, null)}>
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 py-0.5 pr-3" style={indent}>
          {content}
        </div>
      )}
    </li>
  )
}
