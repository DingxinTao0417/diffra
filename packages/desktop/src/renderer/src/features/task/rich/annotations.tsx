import { createContext, type ReactNode, useEffect, useState } from 'react'
import type { AnnotateMark, AnnotateShape } from '@diffra/core/rich'
import type { PromptImage } from '@diffra/core/types'
import { cssVar } from './download'

// 图上标注（第 685 步）：模型给的 annotate 块和用户自己画的标注用同一套画法。坐标都是占图片宽高的比例（0–1）。
// 颜色用 destructive：截图上最醒目，和危险操作无关；底下垫一圈 background 色，浅色、深色截图上都看得清

export const SHAPE_NAMES: Record<AnnotateShape, string> = { box: '框', circle: '圈', arrow: '箭头', pin: '编号' }

// 这一轮提问里的图片：annotate 块写 "@图片1" 指第一张。omitted：图片没带过来（远程会话没同步、分享版不带）
export const PromptImagesContext = createContext<{ images: PromptImage[]; omitted: boolean }>({ images: [], omitted: false })

// 屏幕上的尺寸（px），按图片显示的缩放换算回图片像素，放大缩小都一样粗
const STROKE = 3
const HALO = 2
const BADGE = 10
const PIN = 12
const FONT = 12
const HEAD = 14

type Geometry = {
  kind: 'rect' | 'ellipse' | 'arrow' | 'pin'
  x: number
  y: number
  w: number
  h: number
  head?: Array<[number, number]>
  badge: [number, number]
}

// 比例坐标 → 图片像素；编号的位置收在图片里
function geometryOf(mark: AnnotateMark, width: number, height: number, unit: number): Geometry {
  const clamp = (value: number, max: number, radius: number) => Math.min(Math.max(value, radius), max - radius)
  const x = mark.x * width
  const y = mark.y * height
  if (mark.shape === 'pin') return { kind: 'pin', x, y, w: 0, h: 0, badge: [clamp(x, width, PIN * unit), clamp(y, height, PIN * unit)] }
  const badge: [number, number] = [clamp(x, width, BADGE * unit), clamp(y, height, BADGE * unit)]
  if (mark.shape === 'arrow') {
    const x2 = mark.x2 * width
    const y2 = mark.y2 * height
    const angle = Math.atan2(y2 - y, x2 - x)
    const head: Array<[number, number]> = [-0.45, 0.45].map((spread) => [x2 - HEAD * unit * Math.cos(angle + spread), y2 - HEAD * unit * Math.sin(angle + spread)])
    return { kind: 'arrow', x, y, w: x2 - x, h: y2 - y, head: [head[0]!, [x2, y2], head[1]!], badge }
  }
  return { kind: mark.shape === 'box' ? 'rect' : 'ellipse', x, y, w: mark.w * width, h: mark.h * height, badge }
}

// 叠在图片上的 SVG：viewBox 是图片像素，线宽、编号按 scale（显示宽 / 图片宽）换算成固定的屏幕尺寸
export function MarkLayer({ marks, width, height, scale, active = null, onSelect }: { marks: AnnotateMark[]; width: number; height: number; scale: number; active?: number | null; onSelect?(index: number): void }) {
  const unit = 1 / scale
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 size-full overflow-visible text-destructive" aria-hidden={onSelect ? undefined : true} data-testid="annotation-layer">
      {marks.map((mark, index) => {
        const shape = geometryOf(mark, width, height, unit)
        const stroke = (active === index ? STROKE + 2 : STROKE) * unit
        const outline = (body: (props: { stroke: string; strokeWidth: number }) => ReactNode) => (
          <>
            {body({ stroke: 'var(--background)', strokeWidth: stroke + HALO * 2 * unit })}
            {body({ stroke: 'currentColor', strokeWidth: stroke })}
          </>
        )
        const [bx, by] = shape.badge
        const radius = (shape.kind === 'pin' ? PIN : BADGE) * unit
        return (
          <g key={index} data-testid="annotation-mark" data-shape={mark.shape} data-active={active === index ? '' : undefined}>
            {shape.kind === 'rect' && outline((props) => <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={2 * unit} fill="none" {...props} />)}
            {shape.kind === 'ellipse' && outline((props) => <ellipse cx={shape.x + shape.w / 2} cy={shape.y + shape.h / 2} rx={shape.w / 2} ry={shape.h / 2} fill="none" {...props} />)}
            {shape.kind === 'arrow' &&
              outline((props) => (
                <>
                  <line x1={shape.x} y1={shape.y} x2={shape.x + shape.w} y2={shape.y + shape.h} strokeLinecap="round" {...props} />
                  <polyline points={shape.head!.map((point) => point.join(',')).join(' ')} fill="none" strokeLinecap="round" strokeLinejoin="round" {...props} />
                </>
              ))}
            <g
              className={onSelect ? 'pointer-events-auto cursor-pointer' : undefined}
              role={onSelect ? 'button' : undefined}
              aria-label={onSelect ? `标注 ${index + 1}${mark.note ? `：${mark.note}` : ''}` : undefined}
              onClick={onSelect ? () => onSelect(index) : undefined}
            >
              <circle cx={bx} cy={by} r={radius + HALO * unit} fill="var(--background)" />
              <circle cx={bx} cy={by} r={radius} fill="currentColor" />
              <text x={bx} y={by} dy="0.35em" textAnchor="middle" fontSize={FONT * unit} fontWeight={700} fill="var(--destructive-foreground)">
                {index + 1}
              </text>
            </g>
          </g>
        )
      })}
    </svg>
  )
}

// 图片显示出来的宽度（px）：标注的线宽、编号按它换算
// 用回调 ref：对话框里的内容挂载得晚，挂上了才开始量
export function useDisplayWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width]
}

// 画到图片上（填进输入框用）：unit 是编辑时一个屏幕像素对应的图片像素，看到什么样存下来就什么样
export function drawMarks(context: CanvasRenderingContext2D, marks: AnnotateMark[], width: number, height: number, unit: number) {
  const color = cssVar('--destructive')
  const halo = cssVar('--background')
  const font = getComputedStyle(document.body).fontFamily
  context.lineCap = 'round'
  context.lineJoin = 'round'
  marks.forEach((mark, index) => {
    const shape = geometryOf(mark, width, height, unit)
    const path = new Path2D()
    if (shape.kind === 'rect') path.rect(shape.x, shape.y, shape.w, shape.h)
    if (shape.kind === 'ellipse') path.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2)
    if (shape.kind === 'arrow') {
      path.moveTo(shape.x, shape.y)
      path.lineTo(shape.x + shape.w, shape.y + shape.h)
      const [left, tip, right] = shape.head!
      path.moveTo(...left!)
      path.lineTo(...tip!)
      path.lineTo(...right!)
    }
    if (shape.kind !== 'pin') {
      context.strokeStyle = halo
      context.lineWidth = (STROKE + HALO * 2) * unit
      context.stroke(path)
      context.strokeStyle = color
      context.lineWidth = STROKE * unit
      context.stroke(path)
    }
    const [bx, by] = shape.badge
    const radius = (shape.kind === 'pin' ? PIN : BADGE) * unit
    context.fillStyle = halo
    context.beginPath()
    context.arc(bx, by, radius + HALO * unit, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = color
    context.beginPath()
    context.arc(bx, by, radius, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = cssVar('--destructive-foreground')
    context.font = `700 ${FONT * unit}px ${font}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(index + 1), bx, by)
  })
}

// 填进输入框的说明：编号和图上一致
export function marksText(marks: AnnotateMark[], subject: string): string {
  return [`${subject}标了 ${marks.length} 处，编号和图上一致：`, ...marks.map((mark, index) => `${index + 1}. ${SHAPE_NAMES[mark.shape]}${mark.note?.trim() ? `：${mark.note.trim()}` : ''}`)].join('\n')
}
