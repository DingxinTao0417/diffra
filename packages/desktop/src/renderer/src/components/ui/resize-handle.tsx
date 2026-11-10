import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { cn } from 'cn'

const KEY_STEP = 16

export interface ResizeBounds {
  size: number
  min: number
  max: number
}

interface ResizeHandleProps {
  // vertical：竖线，左右拖改宽度；horizontal：横线，上下拖改高度
  orientation: 'vertical' | 'horizontal'
  // 往右（下）拖是变大为 1，往左（上）拖是变大为 -1
  grow: 1 | -1
  label: string
  // 每次拖动、按键时现量：窗口大小会变，上下限不能缓存；尺寸从实际渲染的大小算起，被 flex 压过时才没有空行程
  measure(handle: HTMLElement): ResizeBounds
  // 拖动中的尺寸，只改内存；松手、松开方向键时 onCommit 再保存
  onResize(size: number): void
  onCommit(size: number): void
  // 双击恢复默认
  onReset(): void
  className?: string
}

// 分栏之间的拖动条：拖动、方向键每次 16px、双击恢复默认
export function ResizeHandle({ orientation, grow, label, measure, onResize, onCommit, onReset, className }: ResizeHandleProps) {
  const drag = useRef<{ start: number; bounds: ResizeBounds; size: number } | null>(null)
  const keyed = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [aria, setAria] = useState<ResizeBounds | null>(null)
  const vertical = orientation === 'vertical'
  const clamp = (value: number, bounds: ResizeBounds) => Math.round(Math.min(bounds.max, Math.max(bounds.min, value)))

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const bounds = measure(event.currentTarget)
    drag.current = { start: vertical ? event.clientX : event.clientY, bounds, size: bounds.size }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    // 拖快了指针会离开拖动条，光标和不选中文字放到整页上
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current) return
    const delta = ((vertical ? event.clientX : event.clientY) - current.start) * grow
    const size = clamp(current.bounds.size + delta, current.bounds)
    if (size === current.size) return
    current.size = size
    onResize(size)
  }
  const onPointerEnd = () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    setDragging(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (current.size !== current.bounds.size) onCommit(current.size)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const index = keys.indexOf(event.key)
    if (index === -1) return
    event.preventDefault()
    const bounds = measure(event.currentTarget)
    const size = clamp(bounds.size + (index === 0 ? -KEY_STEP : KEY_STEP) * grow, bounds)
    setAria({ ...bounds, size })
    if (size === bounds.size) return
    keyed.current = size
    onResize(size)
  }
  const onKeyUp = () => {
    if (keyed.current === null) return
    const size = keyed.current
    keyed.current = null
    onCommit(size)
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={aria?.size}
      aria-valuemin={aria?.min}
      aria-valuemax={aria?.max}
      title="拖动调整大小，双击恢复默认"
      className={cn('group/resize z-20 touch-none outline-none', vertical ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={onReset}
      onFocus={(event) => setAria(measure(event.currentTarget))}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bg-muted-foreground/40 opacity-0 transition-opacity group-hover/resize:opacity-100 group-focus-visible/resize:bg-ring group-focus-visible/resize:opacity-100',
          vertical ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2',
          dragging && 'opacity-100',
        )}
      />
    </div>
  )
}
