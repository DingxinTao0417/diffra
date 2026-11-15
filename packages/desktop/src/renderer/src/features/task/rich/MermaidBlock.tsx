import { type PointerEvent, useEffect, useId, useRef, useState } from 'react'
import { Code, Copy, Download, Image as ImageIcon, Minus, Plus, RotateCcw, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { BlockShell, BlockSkeleton, copyText, ShellAction } from './BlockShell'
import { CodeBlock } from './CodeBlock'
import { cssVar, downloadBlob, safeFileName, svgToPng } from './download'
import type { FenceInfo } from './fence'
import { useThemeKey } from './theme'

type Mermaid = typeof import('mermaid').default

const MAX_MERMAID_CHARS = 20_000
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_WHEEL_FACTOR = 0.0015

let mermaidModule: Promise<Mermaid> | null = null
// initialize 是全局的，几张图同时画会互相盖掉配置：一张一张来
let queue: Promise<unknown> = Promise.resolve()

// 颜色按应用当前的深浅色和配色取（mermaid 要拿真实颜色值做颜色运算，传 CSS 变量不行）；主题一变就重画
function themeVariables() {
  const dark = document.documentElement.classList.contains('dark')
  return {
    darkMode: dark,
    background: cssVar('--card'),
    fontFamily: cssVar('--font-sans'),
    fontSize: '13px',
    primaryColor: cssVar('--muted'),
    primaryTextColor: cssVar('--foreground'),
    primaryBorderColor: cssVar('--input'),
    secondaryColor: cssVar('--secondary'),
    secondaryTextColor: cssVar('--foreground'),
    secondaryBorderColor: cssVar('--input'),
    tertiaryColor: cssVar('--card'),
    tertiaryTextColor: cssVar('--foreground'),
    tertiaryBorderColor: cssVar('--border'),
    lineColor: cssVar('--muted-foreground'),
    textColor: cssVar('--foreground'),
    mainBkg: cssVar('--muted'),
    nodeBorder: cssVar('--input'),
    clusterBkg: cssVar('--background'),
    clusterBorder: cssVar('--border'),
    titleColor: cssVar('--foreground'),
    edgeLabelBackground: cssVar('--card'),
    noteBkgColor: cssVar('--warning-soft'),
    noteTextColor: cssVar('--foreground'),
    noteBorderColor: cssVar('--warning'),
    actorBkg: cssVar('--muted'),
    actorBorder: cssVar('--input'),
    actorTextColor: cssVar('--foreground'),
    signalColor: cssVar('--foreground'),
    signalTextColor: cssVar('--foreground'),
    labelBoxBkgColor: cssVar('--muted'),
    labelTextColor: cssVar('--foreground'),
    errorBkgColor: cssVar('--destructive-soft'),
    errorTextColor: cssVar('--destructive'),
    git0: cssVar('--chart-1'),
    git1: cssVar('--chart-2'),
    git2: cssVar('--chart-3'),
    git3: cssVar('--chart-4'),
    pie1: cssVar('--chart-1'),
    pie2: cssVar('--chart-2'),
    pie3: cssVar('--chart-3'),
    pie4: cssVar('--chart-4'),
  }
}

// securityLevel strict：点击事件和链接都不生效，标签里的 HTML 被清掉；标签画成 SVG 文字（不用 foreignObject），能导出 PNG
async function renderMermaid(id: string, code: string): Promise<string> {
  mermaidModule ??= import('mermaid').then((module) => module.default)
  const mermaid = await mermaidModule
  const task = queue.then(async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: themeVariables(), htmlLabels: false, fontFamily: cssVar('--font-sans') })
    try {
      await mermaid.parse(code)
      const { svg } = await mermaid.render(id, code)
      return svg
    } finally {
      // 出错时 mermaid 可能把临时节点留在 body 里
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })
  queue = task.catch(() => undefined)
  return task
}

// 回答里的 ```mermaid：流程图、时序图、状态图、类图、ER 图、甘特图……画成 SVG。语法错了按代码显示并说明原因
export function MermaidBlock({ info }: { info: FenceInfo }) {
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const theme = useThemeKey()
  const [result, setResult] = useState<{ code: string; svg: string } | { code: string; error: string } | null>(null)
  const [showCode, setShowCode] = useState(false)
  const tooLarge = info.code.length > MAX_MERMAID_CHARS
  useEffect(() => {
    if (tooLarge) return
    let stale = false
    renderMermaid(id, info.code).then(
      (svg) => !stale && setResult({ code: info.code, svg }),
      (error: unknown) => !stale && setResult({ code: info.code, error: errorMessage(error).split('\n').slice(0, 3).join(' ') }),
    )
    return () => {
      stale = true
    }
  }, [id, info.code, theme, tooLarge])
  if (tooLarge) return <CodeBlock info={info} note={`流程图太大（超过 ${MAX_MERMAID_CHARS} 字），按代码显示`} />
  const current = result?.code === info.code ? result : null
  if (current && 'error' in current) return <CodeBlock info={info} note={`流程图语法有误，按代码显示：${current.error}`} />
  if (!current) return <BlockSkeleton label="正在画图…" />
  const title = diagramTitle(info.code)
  const saveSvg = () => downloadBlob(new Blob([current.svg], { type: 'image/svg+xml' }), `${safeFileName(title)}.svg`)
  const savePng = () =>
    svgToPng(current.svg, cssVar('--card')).then(
      (blob) => downloadBlob(blob, `${safeFileName(title)}.png`),
      (error: unknown) => showToast(`保存图片失败：${errorMessage(error)}`),
    )
  const diagram = (large: boolean) =>
    large ? <ZoomableDiagram svg={current.svg} /> : <div className="mermaid-view flex justify-center overflow-auto p-3" dangerouslySetInnerHTML={{ __html: current.svg }} />
  return (
    <BlockShell
      testId="mermaid-block"
      kind="mermaid"
      tone="card"
      icon={<Workflow className="size-3.5 shrink-0" />}
      title={title}
      actions={
        <>
          <ShellAction label={showCode ? '看图' : '看代码'} pressed={showCode} onClick={() => setShowCode(!showCode)}>
            <Code />
          </ShellAction>
          <ShellAction label="复制代码" onClick={() => copyText(info.code, '已复制流程图代码')}>
            <Copy />
          </ShellAction>
          <ShellAction label="另存为 SVG" onClick={saveSvg}>
            <Download />
          </ShellAction>
          <ShellAction label="另存为 PNG" onClick={() => void savePng()}>
            <ImageIcon />
          </ShellAction>
        </>
      }
      expand={() => diagram(true)}
    >
      {showCode ? <pre className="code-body max-h-96 overflow-auto bg-muted">{info.code}</pre> : diagram(false)}
    </BlockShell>
  )
}

// 放大视图里滚轮缩放、拖拽平移；普通视图不挂这些事件，页面滚动照旧。
function ZoomableDiagram({ svg }: { svg: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const pointerX = event.clientX - rect.left - rect.width / 2
      const pointerY = event.clientY - rect.top - rect.height / 2
      setView((current) => {
        const nextScale = clamp(current.scale * Math.exp(-event.deltaY * ZOOM_WHEEL_FACTOR), ZOOM_MIN, ZOOM_MAX)
        const ratio = nextScale / current.scale
        return {
          scale: nextScale,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = (factor: number) => setView((current) => ({ ...current, scale: clamp(current.scale * factor, ZOOM_MIN, ZOOM_MAX) }))
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: viewRef.current.x, originY: viewRef.current.y }
  }
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    setView((previous) => ({ ...previous, x: current.originX + event.clientX - current.startX, y: current.originY + event.clientY - current.startY }))
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      ref={viewport}
      className="relative h-[65vh] min-h-80 cursor-grab touch-none overflow-hidden rounded-lg border bg-muted/20 select-none active:cursor-grabbing"
      role="group"
      aria-label="放大的流程图，滚轮缩放，拖动平移"
      data-testid="mermaid-zoom"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="mermaid-view absolute inset-0 flex items-center justify-center"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: 'center center' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-popover/95 p-1 text-xs shadow-overlay" onPointerDown={(event) => event.stopPropagation()}>
        <Button variant="ghost" size="icon-xs" aria-label="缩小" disabled={view.scale <= ZOOM_MIN} onClick={() => zoomBy(1 / 1.2)}>
          <Minus />
        </Button>
        <span className="w-12 text-center tabular-nums text-muted-foreground" data-testid="mermaid-zoom-value">{Math.round(view.scale * 100)}%</span>
        <Button variant="ghost" size="icon-xs" aria-label="放大" disabled={view.scale >= ZOOM_MAX} onClick={() => zoomBy(1.2)}>
          <Plus />
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon-xs" aria-label="还原大小" disabled={view.scale === 1 && view.x === 0 && view.y === 0} onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
          <RotateCcw />
        </Button>
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const DIAGRAM_NAMES: Array<[RegExp, string]> = [
  [/^(flowchart|graph)\b/, '流程图'],
  [/^sequenceDiagram\b/, '时序图'],
  [/^stateDiagram/, '状态图'],
  [/^classDiagram/, '类图'],
  [/^erDiagram\b/, 'ER 图'],
  [/^gantt\b/, '甘特图'],
  [/^pie\b/, '饼图'],
  [/^journey\b/, '用户旅程'],
  [/^gitGraph\b/, 'Git 分支图'],
  [/^mindmap\b/, '思维导图'],
  [/^timeline\b/, '时间线'],
  [/^(quadrantChart|xychart|sankey|block|architecture|kanban|packet|requirementDiagram|C4)/, '图'],
]

// 标题：图里写了 title 就用它，否则按图的种类叫
function diagramTitle(code: string): string {
  const lines = code.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('%%'))
  const explicit = lines.map((line) => /^title\s+(.+)$/.exec(line)?.[1]).find(Boolean)
  if (explicit) return explicit
  const head = lines[0] ?? ''
  return DIAGRAM_NAMES.find(([pattern]) => pattern.test(head))?.[1] ?? '图'
}
