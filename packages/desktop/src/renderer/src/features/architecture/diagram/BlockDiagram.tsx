import { forwardRef, useState } from 'react'
import type { BlockDiagram as Diagram, BlockKind, DiagramBlock, DiagramSide } from '@diffra/core/architecture'
import { ArrowDown, ArrowUp, CircleHelp, Database, Globe, Plus, Trash2, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { formatCount } from '../graph'
import {
  addBlock,
  addGroup,
  addLayer,
  addSide,
  type BlockOverlay,
  moveBlock,
  moveLayer,
  removeBlock,
  removeGroup,
  removeLayer,
  removeSide,
  setConnectorLabel,
  updateBlock,
  updateGroup,
  updateLayer,
  updateSide,
} from './diagram-model'

// 每层一个色调（按位置，不表示含义）：四个图表色轮着用，第二轮换个深浅
const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)']
export const layerHue = (at: number) => HUES[at % HUES.length]!
const hueOf = layerHue
const mix = (color: string, percent: number, base = 'var(--card)') => `color-mix(in oklab, ${color} ${percent}%, ${base})`
export const layerTint = (at: number, percent: number) => mix(layerHue(at), percent)

export interface BlockDiagramProps {
  diagram: Diagram
  overlays: Map<string, BlockOverlay>
  selected: string | null
  // 选中方块时：它依赖的、依赖它的方块
  related: { uses: Set<string>; usedBy: Set<string> } | null
  // 有值就是编辑模式：每次改动交回新的图
  onChange?: (diagram: Diagram) => void
  onSelect(id: string | null): void
  onOpen(id: string): void
}

// 分层方块图：横带从上到下，左边层名，带里是分组和方块，层之间的箭头标着怎么通信，右边竖栏跨几层
export const BlockDiagramView = forwardRef<HTMLDivElement, BlockDiagramProps>(function BlockDiagramView({ diagram, overlays, selected, related, onChange, onSelect, onOpen }, ref) {
  const editing = Boolean(onChange)
  const [dragging, setDragging] = useState<string | null>(null)
  const change = (next: Diagram) => onChange?.(next)
  const layerIndex = new Map(diagram.layers.map((layer, at) => [layer.id, at]))
  const sideRows = (side: DiagramSide) => {
    const from = layerIndex.get(side.from) ?? 0
    const to = layerIndex.get(side.to) ?? diagram.layers.length - 1
    return { start: Math.min(from, to) * 2 + 1, end: Math.max(from, to) * 2 + 2 }
  }
  const drop = (target: { group?: string; side?: string; before?: string }) => (event: React.DragEvent) => {
    if (!dragging) return
    event.preventDefault()
    event.stopPropagation()
    change(moveBlock(diagram, dragging, target))
    setDragging(null)
  }
  const allowDrop = (event: React.DragEvent) => {
    if (dragging) event.preventDefault()
  }

  const renderBlock = (block: DiagramBlock, vertical = false) => (
    <BlockBox
      key={block.id}
      block={block}
      overlay={overlays.get(block.id)}
      vertical={vertical}
      selected={selected === block.id}
      relation={related ? (related.uses.has(block.id) ? 'uses' : related.usedBy.has(block.id) ? 'usedBy' : selected === block.id ? null : 'other') : null}
      editing={editing}
      onSelect={() => onSelect(block.id)}
      onOpen={() => onOpen(block.id)}
      onRename={(name) => change(updateBlock(diagram, block.id, { name }))}
      onRemove={() => change(removeBlock(diagram, block.id))}
      onDragStart={() => setDragging(block.id)}
      onDragEnd={() => setDragging(null)}
      onDropBefore={drop({ before: block.id, ...placeOf(diagram, block.id) })}
      onDragOver={allowDrop}
    />
  )

  if (diagram.layers.length === 0) {
    return (
      <div ref={ref} className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        这张图还是空的
        {editing && (
          <Button variant="outline" size="xs" className="ml-2" onClick={() => change(addLayer(diagram, 0))}>
            <Plus className="size-3" />
            加一层
          </Button>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} className="space-y-3 select-none" data-testid="block-diagram" onClick={(event) => event.target === event.currentTarget && onSelect(null)}>
      <div className="grid gap-x-2" style={{ gridTemplateColumns: `7.5rem minmax(0, 1fr)${diagram.sides.map(() => ' 9.5rem').join('')}` }}>
        {diagram.layers.map((layer, at) => {
          const hue = hueOf(at)
          const connector = at + 1 < diagram.layers.length ? diagram.connectors.find((item) => item.from === layer.id && item.to === diagram.layers[at + 1]!.id) : undefined
          const empty = layer.groups.every((group) => group.blocks.length === 0)
          return [
            <div
              key={`label:${layer.id}`}
              className="group/layer flex flex-col justify-center gap-1 rounded-lg border-l-4 px-2.5 py-2"
              style={{ gridColumn: 1, gridRow: at * 2 + 1, background: mix(hue, 18), borderLeftColor: hue }}
              title={layer.description || undefined}
              data-testid="diagram-layer"
            >
              <EditableText value={layer.name} editing={editing} className="text-sm font-bold" label="层名" onCommit={(name) => change(updateLayer(diagram, layer.id, { name }))} />
              {layer.description && <span className="line-clamp-2 text-xs text-muted-foreground">{layer.description}</span>}
              {editing && (
                <span className="flex gap-0.5">
                  <IconButton label="上移这一层" disabled={at === 0} onClick={() => change(moveLayer(diagram, layer.id, -1))}>
                    <ArrowUp className="size-3" />
                  </IconButton>
                  <IconButton label="下移这一层" disabled={at === diagram.layers.length - 1} onClick={() => change(moveLayer(diagram, layer.id, 1))}>
                    <ArrowDown className="size-3" />
                  </IconButton>
                  <IconButton label={empty ? '删除这一层' : '先把方块移走才能删这一层'} disabled={!empty} onClick={() => change(removeLayer(diagram, layer.id))}>
                    <Trash2 className="size-3" />
                  </IconButton>
                </span>
              )}
            </div>,
            <div
              key={`band:${layer.id}`}
              className="flex min-w-0 flex-wrap items-stretch gap-2 rounded-lg border p-2"
              style={{ gridColumn: 2, gridRow: at * 2 + 1, background: mix(hue, 6), borderColor: mix(hue, 30, 'var(--border)') }}
            >
              {layer.groups.map((group) => (
                <div
                  key={group.id}
                  className={cn('flex min-w-0 flex-col gap-1.5', group.name && 'rounded-md border bg-card/60 p-1.5', !group.name && 'flex-1', dragging && 'outline-1 outline-offset-2 outline-dashed outline-muted-foreground/40')}
                  onDragOver={allowDrop}
                  onDrop={drop({ group: group.id })}
                  data-testid="diagram-group"
                >
                  {(group.name || editing) && (
                    <div className="flex items-center gap-1 px-0.5">
                      <EditableText value={group.name} placeholder="（无标题分组）" editing={editing} className="min-w-0 flex-1 truncate text-xs text-muted-foreground" label="分组名" onCommit={(name) => change(updateGroup(diagram, group.id, name))} />
                      {editing && (
                        <IconButton label="删除分组（方块挪到同层别的分组）" onClick={() => change(removeGroup(diagram, group.id))}>
                          <X className="size-3" />
                        </IconButton>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {group.blocks.map((block) => renderBlock(block))}
                    {editing && <AddBlockButton onAdd={(kind) => change(addBlock(diagram, { group: group.id }, kind).diagram)} />}
                    {!editing && group.blocks.length === 0 && <span className="px-1 text-xs text-muted-foreground">空</span>}
                  </div>
                </div>
              ))}
              {editing && (
                <Button variant="ghost" size="xs" className="self-center text-muted-foreground" onClick={() => change(addGroup(diagram, layer.id))}>
                  <Plus className="size-3" />
                  分组
                </Button>
              )}
            </div>,
            at + 1 < diagram.layers.length ? (
              <div key={`connector:${layer.id}`} className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground" style={{ gridColumn: 2, gridRow: at * 2 + 2 }} data-testid="diagram-connector">
                <ArrowDown className="size-4" />
                <EditableText
                  value={connector?.label ?? ''}
                  placeholder={editing ? '写上怎么通信（IPC、HTTP…）' : ''}
                  editing={editing}
                  className="min-w-0 truncate"
                  label="连线说明"
                  onCommit={(label) => change(setConnectorLabel(diagram, layer.id, diagram.layers[at + 1]!.id, label))}
                />
                {connector?.label ? <ArrowDown className="size-4" /> : null}
              </div>
            ) : null,
          ]
        })}
        {diagram.sides.map((side, at) => {
          const rows = sideRows(side)
          const hue = 'var(--muted-foreground)'
          return (
            <div
              key={side.id}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-1.5"
              style={{ gridColumn: 3 + at, gridRow: `${rows.start} / ${rows.end}`, background: mix(hue, 6), borderColor: mix(hue, 25, 'var(--border)') }}
              onDragOver={allowDrop}
              onDrop={drop({ side: side.id })}
              title={side.description || undefined}
              data-testid="diagram-side"
            >
              <div className="flex items-center gap-1 px-0.5">
                <EditableText value={side.name} editing={editing} className="min-w-0 flex-1 text-center text-xs font-bold" label="竖栏名" onCommit={(name) => change(updateSide(diagram, side.id, { name }))} />
                {editing && (
                  <IconButton label={side.blocks.length === 0 ? '删除竖栏' : '先把方块移走才能删竖栏'} disabled={side.blocks.length > 0} onClick={() => change(removeSide(diagram, side.id))}>
                    <X className="size-3" />
                  </IconButton>
                )}
              </div>
              {editing && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <LayerSelect diagram={diagram} value={side.from} label="竖栏从哪一层开始" onChange={(from) => change(updateSide(diagram, side.id, { from }))} />
                  到
                  <LayerSelect diagram={diagram} value={side.to} label="竖栏到哪一层" onChange={(to) => change(updateSide(diagram, side.id, { to }))} />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-1.5">
                {side.blocks.map((block) => renderBlock(block, true))}
                {editing && <AddBlockButton onAdd={(kind) => change(addBlock(diagram, { side: side.id }, kind).diagram)} />}
              </div>
            </div>
          )
        })}
      </div>
      {editing && (
        <div className="flex gap-2">
          <Button variant="outline" size="xs" onClick={() => change(addLayer(diagram, diagram.layers.length))}>
            <Plus className="size-3" />
            在最下面加一层
          </Button>
          <Button variant="outline" size="xs" onClick={() => change(addSide(diagram))}>
            <Plus className="size-3" />
            加一个右侧竖栏
          </Button>
        </div>
      )}
    </div>
  )
})

function placeOf(diagram: Diagram, id: string): { group?: string; side?: string } {
  for (const layer of diagram.layers) for (const group of layer.groups) if (group.blocks.some((item) => item.id === id)) return { group: group.id }
  for (const side of diagram.sides) if (side.blocks.some((item) => item.id === id)) return { side: side.id }
  return {}
}

const KIND_ICONS: Partial<Record<BlockKind, typeof Globe>> = { external: Globe, store: Database }

function BlockBox({
  block,
  overlay,
  vertical,
  selected,
  relation,
  editing,
  onSelect,
  onOpen,
  onRename,
  onRemove,
  onDragStart,
  onDragEnd,
  onDropBefore,
  onDragOver,
}: {
  block: DiagramBlock
  overlay: BlockOverlay | undefined
  vertical: boolean
  selected: boolean
  relation: 'uses' | 'usedBy' | 'other' | null
  editing: boolean
  onSelect(): void
  onOpen(): void
  onRename(name: string): void
  onRemove(): void
  onDragStart(): void
  onDragEnd(): void
  onDropBefore(event: React.DragEvent): void
  onDragOver(event: React.DragEvent): void
}) {
  const [renaming, setRenaming] = useState(false)
  const Icon = KIND_ICONS[block.kind]
  const detail = block.kind === 'tech' ? (overlay?.uses ? `${formatCount(overlay.uses)} 处` : '') : overlay?.files ? `${formatCount(overlay.files)} 文件` : ''
  const title = [block.description, block.paths.length > 0 ? `代码：${block.paths.join('、')}` : '', block.packages.length > 0 ? `外部包：${block.packages.join('、')}` : '', block.unverified ? '路径或外部包和分析结果对不上' : '']
    .filter(Boolean)
    .join('\n')
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={editing && !renaming}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDropBefore}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      onMouseDown={(event) => {
        // 双击的第二下会选中方块里的字
        if (event.detail > 1) event.preventDefault()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onSelect()
        if (editing) setRenaming(true)
        else onOpen()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || renaming) return
        if (editing) setRenaming(true)
        else onOpen()
      }}
      title={title || undefined}
      className={cn(
        'group/block relative flex min-w-[5.5rem] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md border bg-card px-2.5 py-1.5 text-center text-xs transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring',
        vertical && 'w-full',
        block.kind === 'external' && 'bg-muted/60',
        (block.unverified || overlay?.planned) && 'border-dashed',
        block.unverified && 'border-warning',
        (overlay?.violations ?? 0) > 0 && 'border-destructive',
        selected && 'z-10 bg-accent ring-2 ring-ring ring-offset-2 ring-offset-background',
        relation === 'uses' && 'outline-2 outline-offset-1 outline-foreground/70',
        relation === 'usedBy' && 'outline-2 outline-offset-1 outline-dashed outline-foreground/50',
        relation === 'other' && 'opacity-35',
      )}
      aria-pressed={selected}
      data-testid="diagram-block"
      data-block={block.id}
    >
      {renaming ? (
        <input
          autoFocus
          defaultValue={block.name}
          aria-label="方块名"
          className="w-24 rounded-sm border bg-background px-1 text-center text-xs outline-none"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            setRenaming(false)
            if (event.target.value.trim() && event.target.value.trim() !== block.name) onRename(event.target.value.trim())
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <span className="flex max-w-40 items-center gap-1">
          {Icon && <Icon className="size-3 shrink-0 text-muted-foreground" />}
          <span className="truncate">{block.name}</span>
          {block.unverified && <CircleHelp className="size-3 shrink-0 text-warning" aria-label="对不上分析结果" />}
        </span>
      )}
      {detail && <span className="text-xs text-muted-foreground tabular-nums">{detail}</span>}
      {overlay?.planned && <span className="text-xs text-muted-foreground">计划中</span>}
      {(overlay?.violations ?? 0) > 0 && <span className="absolute -top-1.5 -right-1.5 rounded-full bg-destructive px-1 text-xs leading-4 text-destructive-foreground tabular-nums">{overlay!.violations}</span>}
      {editing && !renaming && (
        <button
          type="button"
          aria-label={`删除方块「${block.name}」`}
          className="absolute -top-1.5 -left-1.5 hidden size-4 items-center justify-center rounded-full border bg-card text-muted-foreground group-hover/block:flex hover:text-destructive"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <X className="size-2.5" />
        </button>
      )}
    </div>
  )
}

function AddBlockButton({ onAdd }: { onAdd(kind: BlockKind): void }) {
  return (
    <button
      type="button"
      className="flex min-w-[5.5rem] items-center justify-center gap-1 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation()
        onAdd('code')
      }}
    >
      <Plus className="size-3" />
      方块
    </button>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-30"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

// 编辑模式里双击改字；回车或点别处确认，Esc 放弃
function EditableText({ value, placeholder = '', editing, className, label, onCommit }: { value: string; placeholder?: string; editing: boolean; className?: string; label: string; onCommit(value: string): void }) {
  const [open, setOpen] = useState(false)
  if (editing && open) {
    return (
      <input
        autoFocus
        defaultValue={value}
        aria-label={label}
        className={cn('w-full min-w-0 rounded-sm border bg-background px-1 outline-none', className)}
        onClick={(event) => event.stopPropagation()}
        onBlur={(event) => {
          setOpen(false)
          if (event.target.value.trim() !== value) onCommit(event.target.value.trim())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setOpen(false)
        }}
      />
    )
  }
  return (
    <span
      className={cn(className, editing && 'cursor-text rounded-sm hover:bg-background/60', !value && 'text-muted-foreground')}
      title={editing ? `双击修改${label}` : undefined}
      onDoubleClick={(event) => {
        if (!editing) return
        event.stopPropagation()
        setOpen(true)
      }}
    >
      {value || placeholder}
    </span>
  )
}

function LayerSelect({ diagram, value, label, onChange }: { diagram: Diagram; value: string; label: string; onChange(value: string): void }) {
  return (
    <select aria-label={label} value={value} className="min-w-0 flex-1 rounded-sm border bg-background px-0.5 py-0.5 text-xs" onClick={(event) => event.stopPropagation()} onChange={(event) => onChange(event.target.value)}>
      {diagram.layers.map((layer) => (
        <option key={layer.id} value={layer.id}>
          {layer.name}
        </option>
      ))}
    </select>
  )
}
