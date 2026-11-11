import { useEffect, useState } from 'react'
import { diagramBlocks } from '@diffra/core/architecture'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { formatTime } from '@/lib/format'
import { blockFocus, diagramOf, useArch } from './context'
import { Inspector } from './Inspector'
import { DIAGRAM_NAMES } from './views/DiagramView'
import { blockNamer, describeRule } from './views/target-model'

const WIDTH_KEY = 'diffra:architecture:panel-width'
const COLLAPSED_KEY = 'diffra:architecture:panel-collapsed'
const DEFAULT_WIDTH = 320
const MIN_WIDTH = 260
const MAX_WIDTH = 720

// 界面偏好存在本机浏览器存储里；读写失败（比如存储被禁用）就用默认值
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 存不下只是下次回到默认宽度
  }
}

// 右边一栏：选中东西时是它的详情，没选中时是当前视图的概况。宽度可以拖，可以收起
export function SidePanel() {
  const { route } = useArch()
  const [width, setWidth] = useState(() => Number(readStored(WIDTH_KEY)) || DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) === '1')
  const setCollapsedStored = (value: boolean) => {
    setCollapsed(value)
    writeStored(COLLAPSED_KEY, value ? '1' : null)
  }

  // 收起时又选中了东西：展开给它看详情
  useEffect(() => {
    if (route.focus) setCollapsed(false)
  }, [route.focus])

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l pt-2">
        <Button variant="ghost" size="icon" className="size-7" aria-label="展开右侧栏" title="展开右侧栏" onClick={() => setCollapsedStored(false)}>
          <PanelRightOpen className="size-4" />
        </Button>
      </div>
    )
  }
  return (
    <div className="relative shrink-0 border-l" style={{ width }} data-testid="architecture-side-panel">
      <ResizeHandle
        orientation="vertical"
        grow={-1}
        label="拖动调整右侧栏宽度"
        className="absolute inset-y-0 -left-1 z-10"
        measure={(handle) => ({ size: handle.parentElement!.getBoundingClientRect().width, min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth * 0.5)) })}
        onResize={setWidth}
        onCommit={(size) => writeStored(WIDTH_KEY, String(size))}
        onReset={() => {
          setWidth(DEFAULT_WIDTH)
          writeStored(WIDTH_KEY, null)
        }}
      />
      {route.focus ? <Inspector key={route.focus} focus={route.focus} onCollapse={() => setCollapsedStored(true)} /> : <Idle onCollapse={() => setCollapsedStored(true)} />}
    </div>
  )
}

function Idle({ onCollapse }: { onCollapse(): void }) {
  const { route } = useArch()
  // 依赖图、热点没选中东西时看当前范围本身
  if ((route.tab === 'dependencies' || route.tab === 'hotspots') && route.scope !== 'system') {
    // 范围的写法（project、dir:、file:、block:）和选中项的 id 一样
    return <Inspector key={`scope:${route.scope}`} focus={route.scope} onCollapse={onCollapse} scope />
  }
  return (
    <div className="flex h-full flex-col" data-testid="architecture-idle">
      <div className="flex items-center justify-end px-2 pt-2">
        <Button variant="ghost" size="icon" className="size-7" aria-label="收起右侧栏" title="收起右侧栏" onClick={onCollapse}>
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 text-sm">{route.tab === 'target' ? <TargetSummary /> : <DiagramSummary />}</div>
    </div>
  )
}

// 架构图没选中方块时：这张图有几层、每层几个方块，怎么看
function DiagramSummary() {
  const context = useArch()
  const { route, analysis, go } = context
  const diagram = diagramOf(context, route.diagram)
  if (!diagram) return <p className="text-muted-foreground">还没有这张图</p>
  const blocks = diagramBlocks(diagram)
  const unverified = blocks.filter(({ block }) => block.unverified).length
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{DIAGRAM_NAMES[route.diagram]}图</h2>
        <div className="text-xs text-muted-foreground">
          {diagram.source === 'model' && diagram.model ? `${diagram.model.modelId} 画于 ${formatTime(diagram.generatedAt)}` : '按包、目录和依赖自动排的'}
          {diagram.source === 'model' && diagram.fingerprint !== analysis.fingerprint && ' · 基于上一次分析'}
        </div>
        <div className="text-xs text-muted-foreground">
          {diagram.layers.length} 层 · {blocks.length} 个方块{diagram.sides.length > 0 ? ` · ${diagram.sides.length} 个竖栏` : ''}
          {unverified > 0 && <span className="text-warning"> · {unverified} 个对不上代码</span>}
        </div>
      </div>
      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">各层</h3>
        {diagram.layers.map((layer) => {
          const items = layer.groups.flatMap((group) => group.blocks)
          return (
            <div key={layer.id} className="space-y-0.5">
              <div className="flex justify-between text-xs font-medium">
                <span>{layer.name}</span>
                <span className="text-muted-foreground tabular-nums">{items.length}</span>
              </div>
              {layer.description && <div className="text-[11px] text-muted-foreground">{layer.description}</div>}
              <div className="flex flex-wrap gap-1">
                {items.slice(0, 12).map((item) => (
                  <button key={item.id} type="button" className="rounded border px-1.5 text-[11px] hover:bg-accent" onClick={() => go({ focus: blockFocus(route.diagram, item.id) }, false)}>
                    {item.name}
                  </button>
                ))}
                {items.length > 12 && <span className="text-[11px] text-muted-foreground">…还有 {items.length - 12} 个</span>}
              </div>
            </div>
          )
        })}
        {diagram.sides.map((side) => (
          <div key={side.id} className="flex justify-between text-xs">
            <span>右侧「{side.name}」</span>
            <span className="text-muted-foreground tabular-nums">{side.blocks.length}</span>
          </div>
        ))}
      </section>
      <section className="space-y-1 text-xs text-muted-foreground">
        <h3 className="font-medium">怎么看</h3>
        <p>单击方块看它的说明、认领的代码和上下游；双击{route.diagram === 'technology' ? '看它在哪些地方被用到' : '进到它内部的依赖图，再到文件和符号'}。</p>
        <p>选中方块后，实线框是它依赖的方块，虚线框是依赖它的方块。虚线边的方块是计划中或者对不上代码的。</p>
      </section>
    </>
  )
}

// 目标架构没选中方块时：规则和差距的概况
function TargetSummary() {
  const { target, evaluation, analysis } = useArch()
  if (!target || !evaluation) return <p className="text-muted-foreground">还没有目标架构。可以从应用架构图复制一份，再在上面改。</p>
  const name = blockNamer(target.diagram)
  const unassignedDirs = new Set(evaluation.unassigned.map((at) => analysis.files[at]!.module)).size
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">目标架构</h2>
        <div className="text-xs text-muted-foreground">{target.enforceInTasks ? '任务改完时检查新增的依赖' : '不在任务里检查'}</div>
      </div>
      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">差距</h3>
        <div className="text-xs">
          <span className={evaluation.violations.length > 0 ? 'text-destructive' : undefined}>{evaluation.violations.length} 处违规</span> · {evaluation.planned.length} 个方块还没有代码 · {unassignedDirs} 个目录没被认领
        </div>
      </section>
      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">规则（{target.rules.length}）</h3>
        {target.rules.length === 0 && <p className="text-xs text-muted-foreground">还没有规则</p>}
        {target.rules.map((rule) => (
          <div key={rule.id} className="text-xs">
            {describeRule(rule, name)}
          </div>
        ))}
      </section>
    </>
  )
}
