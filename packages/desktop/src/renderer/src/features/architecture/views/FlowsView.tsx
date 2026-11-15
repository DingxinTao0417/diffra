import { useState } from 'react'
import type { ArchitectureFlow } from '@diffra/core/architecture'
import { LoaderCircle, Route as RouteIcon, Sparkles } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { drawFlowChart, interpret, useArchitecture } from '../architecture-store'
import { useArch } from '../context'
import { FlowChartView } from './FlowChartView'
import { svgFont, wrapText } from './svg-text'

type FlowMode = 'sequence' | 'chart'

const LANE = 168
const HEADER = 54
const ROW = 46
const LINE = 14
const LABEL_FONT = 11
// 箭头说明至少给两条泳道宽，箭头短的步骤也不至于一行几个字
const LABEL_MIN = LANE * 2 - 16

// 泳道名取路径最后一段；和别的泳道撞名（比如两个 src）就往前多带几段，直到分得开
function laneLabels(names: string[]): Map<string, string> {
  const segments = (name: string) => name.split('/').filter(Boolean)
  const tail = (name: string, count: number) => segments(name).slice(-count).join('/') || name
  return new Map(
    names.map((name) => {
      let count = 1
      while (count < segments(name).length && names.some((other) => other !== name && tail(other, count) === tail(name, count))) count++
      const label = tail(name, count)
      // 路径从前面省略，留下能分开泳道的那几段
      return [name, label.length <= 20 ? label : label.includes('/') ? `…${label.slice(-19)}` : `${label.slice(0, 19)}…`]
    }),
  )
}


// 流程：模型解读出的关键运行流程，画成时序图；每一步带代码位置（已核对过存在）
export function FlowsView() {
  const { interpretation, project } = useArch()
  const progress = useArchitecture((state) => state.running[project.id])
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<FlowMode>('sequence')
  // 正在画流程图的流程（按流程名）；切到别的流程、切画法时还在画
  const [drawing, setDrawing] = useState<ReadonlySet<string>>(new Set())
  const flows = interpretation?.flows ?? []
  if (flows.length === 0) {
    return (
      <EmptyState icon={RouteIcon} title="还没有流程" description="关键流程（比如一次用户操作怎么穿过界面、进程边界、到外部服务再回来）由模型解读给出，每一步的代码位置都会和解析结果核对。">
        <Button size="sm" disabled={progress?.phase === 'interpreting'} onClick={() => void interpret(project.id, ['overview'])}>
          {progress?.phase === 'interpreting' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          让模型解读
        </Button>
      </EmptyState>
    )
  }
  const flow = flows[Math.min(selected, flows.length - 1)]!
  const draw = async (name: string) => {
    setDrawing((current) => new Set(current).add(name))
    try {
      await drawFlowChart(project.id, name)
    } catch (error) {
      showToast(`画流程图失败：${errorMessage(error)}`)
    } finally {
      setDrawing((current) => {
        const next = new Set(current)
        next.delete(name)
        return next
      })
    }
  }
  return (
    <div className="flex h-full" data-testid="architecture-flows">
      <div className="w-64 shrink-0 space-y-1 overflow-y-auto border-r p-2">
        {flows.map((item, at) => (
          <button key={item.name} type="button" className={cn('block w-full rounded-lg px-3 py-2 text-left hover:bg-accent', at === selected && 'bg-accent')} onClick={() => setSelected(at)}>
            <div className="text-sm font-bold">{item.name}</div>
            <div className="line-clamp-2 text-xs text-muted-foreground">{item.description}</div>
          </button>
        ))}
      </div>
      <div className="@container min-w-0 flex-1 overflow-auto p-5">
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold">{flow.name}</h2>
            <p className="text-sm text-muted-foreground">{flow.description}</p>
          </div>
          <Segmented<FlowMode>
            label="流程的画法"
            size="sm"
            value={mode}
            options={[
              { value: 'sequence', label: '时序图' },
              { value: 'chart', label: '流程图' },
            ]}
            onChange={setMode}
          />
        </div>
        {mode === 'sequence' ? (
          <Sequence flow={flow} />
        ) : (
          <FlowChartView name={flow.name} chart={interpretation?.charts?.[flow.name]} drawing={drawing.has(flow.name)} onDraw={() => void draw(flow.name)} />
        )}
      </div>
    </div>
  )
}

function Sequence({ flow }: { flow: ArchitectureFlow }) {
  const { index, go, peek } = useArch()
  const participants: string[] = []
  for (const step of flow.steps) for (const name of [step.from, step.to]) if (!participants.includes(name)) participants.push(name)
  const known = (name: string) => index.file(name) !== null || index.module(name) !== null
  const labels = laneLabels(participants)
  const open = (name: string) => {
    const file = index.file(name)
    if (file) go({ tab: 'dependencies', section: 'graph', scope: `dir:${file.module}`, focus: `file:${name}` })
    else if (index.module(name)) go({ tab: 'dependencies', section: 'graph', scope: `dir:${index.collapse(name)}`, focus: `dir:${name}` })
  }
  const lanes = participants.length * LANE
  const center = (name: string) => participants.indexOf(name) * LANE + LANE / 2
  // 每一步的说明折成几行，这一步的高度跟着行数走
  const font = svgFont(LABEL_FONT)
  let top = HEADER
  let width = lanes
  const rows = flow.steps.map((step, at) => {
    const from = center(step.from)
    const to = center(step.to)
    const self = step.from === step.to
    const room = self ? LABEL_MIN : Math.min(lanes - 8, Math.max(Math.abs(to - from) - 16, LABEL_MIN))
    const lines = wrapText(`${at + 1}. ${step.action}`, room, font)
    const y = top + 30 + (lines.length - 1) * LINE
    top += ROW + (lines.length - 1) * LINE
    // 说明居中在箭头上方，碰到左右边就往里挪；自调用的写在右边，超出就把图加宽
    const x = self ? from + 34 : Math.min(Math.max((from + to) / 2, room / 2 + 4), lanes - room / 2 - 4)
    if (self) width = Math.max(width, x + room + 8)
    return { step, from, to, self, lines, x, y }
  })
  const height = top + 16
  return (
    <div className="space-y-5">
      <svg width={width} height={height} className="text-xs" role="img" aria-label={`${flow.name}的时序图`}>
        <defs>
          <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--foreground)" />
          </marker>
        </defs>
        {participants.map((name) => {
          const x = center(name)
          return (
            <g key={name}>
              <line x1={x} y1={HEADER} x2={x} y2={height} stroke="var(--border)" strokeDasharray="4 4" />
              <g className={known(name) ? 'cursor-pointer' : undefined} onClick={() => open(name)}>
                <title>{name}</title>
                <rect x={x - LANE / 2 + 8} y={6} width={LANE - 16} height={34} rx={8} fill={known(name) ? 'var(--card)' : 'var(--muted)'} stroke="var(--border)" />
                <text x={x} y={27} textAnchor="middle" fill="var(--foreground)" fontSize={12}>
                  {labels.get(name)}
                </text>
              </g>
            </g>
          )
        })}
        {rows.map(({ step, from, to, self, lines, x, y }, at) => (
          <g key={at}>
            <title>{step.action}</title>
            {self ? (
              <path d={`M ${from} ${y - 8} h 28 v 16 h -26`} fill="none" stroke="var(--foreground)" markerEnd="url(#arch-arrow)" />
            ) : (
              <line x1={from} y1={y} x2={to + (to > from ? -4 : 4)} y2={y} stroke="var(--foreground)" markerEnd="url(#arch-arrow)" />
            )}
            <text textAnchor={self ? 'start' : 'middle'} fill="var(--foreground)" fontSize={LABEL_FONT}>
              {lines.map((line, row) => (
                <tspan key={row} x={x} y={y - 7 - (lines.length - 1 - row) * LINE}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>
      <ol className="space-y-1.5">
        {flow.steps.map((step, at) => (
          <li key={at} className="flex gap-3 rounded-md border px-3 py-2 text-sm">
            <span className="text-muted-foreground tabular-nums">{at + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="font-mono text-xs text-muted-foreground">
                {step.from} → {step.to}
              </span>
              <span className="block">{step.action}</span>
            </span>
            {step.anchor && (
              <Button variant="ghost" size="xs" className="shrink-0 font-mono" onClick={() => peek(step.anchor!.path, step.anchor!.line)}>
                {step.anchor.symbol ?? step.anchor.path.split('/').pop()}:{step.anchor.line}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
