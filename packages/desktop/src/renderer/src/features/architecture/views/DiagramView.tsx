import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type DiagramKind, diagramBlocks } from '@diffra/core/architecture'
import { Expand, ImageDown, LoaderCircle, PencilLine, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { showToast } from '@/state/store'
import { interpret, saveDiagram, useArchitecture } from '../architecture-store'
import { blockFocus, diagramOf, useArch } from '../context'
import { BlockDiagramView } from '../diagram/BlockDiagram'
import { blockLinks, blockOverlays, findBlockIn, relatedBlocks } from '../diagram/diagram-model'

export const DIAGRAM_NAMES: Record<DiagramKind, string> = { application: '应用架构', technology: '技术架构', system: '系统架构' }
const DIAGRAM_HINTS: Record<DiagramKind, string> = {
  application: '模块按层摆，方块认领代码；双击方块进到它内部的依赖图',
  technology: '用到的框架、库和协议按用途分层；双击方块看它在哪些地方被用到',
  system: '使用者、进程和部署单元、外部服务，箭头上是通信方式',
}

// 架构图：应用、技术、系统三张分层方块图。没让模型画之前是按目录和依赖自动排的；可以手改，改过的方块重新生成时保留
export function DiagramView() {
  const context = useArch()
  const { route, go, diagrams, draft, setDraft, index, project, analysis } = context
  const kind = route.diagram
  const editing = draft?.kind === kind
  const diagram = diagramOf(context, kind)
  const progress = useArchitecture((state) => state.running[project.id])
  const generating = progress?.phase === 'interpreting'
  const [fit, setFit] = useState(false)
  const [scale, setScale] = useState(1)
  const [exporting, setExporting] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)

  const overlays = useMemo(() => (diagram ? blockOverlays(index, diagram) : new Map()), [index, diagram])
  const links = useMemo(() => (diagram && kind !== 'technology' ? blockLinks(index, diagram) : new Map<string, number>()), [index, diagram, kind])
  const prefix = `block:${kind}:`
  const selected = route.focus?.startsWith(prefix) ? route.focus.slice(prefix.length) : null
  // 编辑时不按依赖淡化别的方块，免得看不清在改什么
  const related = !editing && selected && links.size > 0 ? relatedBlocks(links, selected) : null
  const unverified = diagram ? diagramBlocks(diagram).filter(({ block }) => block.unverified).length : 0

  // 适合窗口：按内容高度缩放到一屏放得下（导出 PNG 也靠它把整张图放进可见区域）
  useLayoutEffect(() => {
    if (!fit || !scroller.current || !content.current) {
      setScale(1)
      return
    }
    const available = scroller.current.clientHeight - 48
    const height = content.current.scrollHeight
    setScale(height > available ? Math.max(0.35, available / height) : 1)
  }, [fit, diagram])

  const open = (id: string) => {
    if (!diagram) return
    const block = findBlockIn(diagram, id)
    if (!block) return
    // 认领了代码的方块进到它内部的依赖图；技术、外部系统这类方块留在图上选中，右边列出用到它的地方
    if (block.paths.length > 0) {
      go({ tab: 'dependencies', section: 'graph', scope: `block:${kind}:${id}`, focus: null })
      return
    }
    go({ focus: blockFocus(kind, id) }, false)
  }

  const exportPng = async () => {
    if (!content.current) return
    setExporting(true)
    const wasFit = fit
    setFit(true)
    // 等缩放生效两帧再截
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = content.current.getBoundingClientRect()
    try {
      await window.diffra.saveVisualPng({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) }, `${project.name}-${DIAGRAM_NAMES[kind]}图`)
    } catch (error) {
      showToast(`导出失败：${errorMessage(error)}`)
    } finally {
      setFit(wasFit)
      setExporting(false)
    }
  }

  const save = async () => {
    if (!draft) return
    if (await saveDiagram(project.id, draft.diagram)) setDraft(null)
  }

  return (
    <div className="flex h-full flex-col" data-testid="architecture-diagram">
      <div className="flex items-center gap-3 overflow-hidden border-b px-4 py-2 text-xs whitespace-nowrap [&>*:not(:last-child)]:shrink-0">
        <Segmented<DiagramKind>
          label="哪张架构图"
          size="sm"
          value={kind}
          options={(['application', 'technology', 'system'] as const).map((value) => ({ value, label: DIAGRAM_NAMES[value] }))}
          onChange={(value) => {
            if (draft?.dirty) {
              showToast('这张图有没保存的改动，先保存或放弃')
              return
            }
            setDraft(null)
            go({ diagram: value, focus: null })
          }}
        />
        {editing ? (
          <>
            <Button size="xs" disabled={!draft.dirty} onClick={() => void save()} data-testid="diagram-save">
              保存
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              {draft.dirty ? '放弃改动' : '退出编辑'}
            </Button>
            <span className="text-muted-foreground">拖动方块换组、换层，双击改名；选中方块后在右边改说明和代码路径。改过的方块重新生成时保留</span>
          </>
        ) : (
          <>
            <Button size="xs" variant="outline" disabled={!diagram} onClick={() => diagram && setDraft({ kind, diagram, dirty: false })} data-testid="diagram-edit">
              <PencilLine className="size-3" />
              编辑
            </Button>
            <Button size="xs" variant="outline" disabled={generating} onClick={() => void interpret(project.id, [kind])} data-testid="diagram-generate">
              {generating ? <LoaderCircle className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
              {diagram?.source === 'model' ? '让模型重画' : '让模型画'}
            </Button>
            <Button size="xs" variant="ghost" aria-pressed={fit} onClick={() => setFit((value) => !value)}>
              <Expand className="size-3" />
              {fit ? '原始大小' : '适合窗口'}
            </Button>
            <Button size="xs" variant="ghost" disabled={!diagram || exporting} onClick={() => void exportPng()}>
              <ImageDown className="size-3" />
              导出 PNG
            </Button>
          </>
        )}
        <span className="ml-auto min-w-0 truncate text-muted-foreground">
          {diagram?.source === 'model' && diagram.model ? `${diagram.model.modelId} 画于 ${formatTime(diagram.generatedAt)}` : '按包、目录和依赖自动排的'}
          {diagram && diagram.fingerprint !== analysis.fingerprint && diagram.source === 'model' ? ' · 基于上一次分析' : ''}
          {unverified > 0 ? ` · ${unverified} 个方块对不上代码` : ''}
        </span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-4">
        {diagram ? (
          <>
            <div className="mb-2 text-xs text-muted-foreground">{DIAGRAM_HINTS[kind]}</div>
            <div style={{ zoom: scale }}>
              <BlockDiagramView
                ref={content}
                diagram={diagram}
                overlays={overlays}
                selected={selected}
                related={related}
                onChange={editing ? (next) => setDraft({ kind, diagram: next, dirty: true }) : undefined}
                onSelect={(id) => go({ focus: id ? blockFocus(kind, id) : null }, false)}
                onOpen={open}
              />
            </div>
            {!editing && related && (
              <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="size-3 rounded-sm outline-2 outline-foreground/70" />
                  选中的方块依赖它
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-3 rounded-sm outline-2 outline-dashed outline-foreground/50" />
                  它依赖选中的方块
                </span>
              </div>
            )}
            {diagram.source === 'static' && !editing && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                <Badge variant="outline">自动排的</Badge>
                没调模型：层按依赖关系算，方块就是目录。让模型画一张，层和方块会按职责命名、按模块划分，每个方块的代码路径都会和分析结果核对。
              </div>
            )}
          </>
        ) : (
          <div className="p-8 text-center text-sm text-muted-foreground">重新分析一次就会出图</div>
        )}
      </div>
    </div>
  )
}
