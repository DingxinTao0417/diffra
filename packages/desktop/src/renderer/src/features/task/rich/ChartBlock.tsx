import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChartData } from '@diffra/core/rich'
import { BarChart, LineChart, PieChart, ScatterChart, HeatmapChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { type EChartsCoreOption, type EChartsType, init, use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { ChartColumn, Download, Image as ImageIcon, Table2 } from 'lucide-react'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { BlockShell, ShellAction } from './BlockShell'
import { cssVar, downloadBlob, safeFileName, svgToPng } from './download'
import type { FenceInfo } from './fence'
import { prefersReducedMotion, useThemeKey } from './theme'

// 这个文件整个按需加载（RichBlock 里 lazy）：ECharts 只在回答里第一次出现图表时才取。只注册用到的图表和组件，SVG 渲染（导出不糊、能出静态 SVG）
use([BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, AriaComponent, SVGRenderer])

const TYPE_NAMES: Record<ChartData['type'], string> = { bar: '柱状图', line: '折线图', area: '面积图', pie: '饼图', scatter: '散点图', heatmap: '热力图' }

// 颜色从令牌取真实值（ECharts 要做颜色运算）：--chart-1..4，系列多于 4 个时再用同一组颜色和卡片底色混出的浅一档
// 令牌的值可能被压缩成 #fff 这样的简写：先让画布把任意 CSS 颜色规整成 #rrggbb
let colorContext: CanvasRenderingContext2D | null = null
function rgbOf(value: string): number[] | null {
  colorContext ??= document.createElement('canvas').getContext('2d')
  if (!colorContext) return null
  colorContext.fillStyle = '#000000'
  colorContext.fillStyle = value
  const normalized = String(colorContext.fillStyle)
  return /^#[\da-f]{6}$/i.test(normalized) ? [1, 3, 5].map((at) => Number.parseInt(normalized.slice(at, at + 2), 16)) : null
}

function mix(color: string, base: string, amount: number): string {
  const parse = rgbOf
  const a = parse(color)
  const b = parse(base)
  if (!a || !b) return color
  return `#${a.map((channel, index) => Math.round(channel * (1 - amount) + b[index]! * amount).toString(16).padStart(2, '0')).join('')}`
}

function themeColors() {
  const card = cssVar('--card')
  const base = ['--chart-1', '--chart-2', '--chart-3', '--chart-4'].map(cssVar)
  return {
    palette: [...base, ...base.map((color) => mix(color, card, 0.45))],
    card,
    foreground: cssVar('--foreground'),
    muted: cssVar('--muted-foreground'),
    border: cssVar('--border'),
    popover: cssVar('--popover'),
    popoverForeground: cssVar('--popover-foreground'),
    font: cssVar('--font-sans'),
  }
}

const formatNumber = (value: number) => (Math.abs(value) >= 10_000 ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value))

export function chartOption(data: ChartData): EChartsCoreOption {
  const colors = themeColors()
  const unit = data.unit ?? ''
  const value = (raw: unknown) => (typeof raw === 'number' ? `${formatNumber(raw)}${unit}` : String(raw ?? '—'))
  const axisLabel = { color: colors.muted, hideOverlap: true }
  const common = {
    color: colors.palette,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: colors.font, color: colors.foreground, fontSize: 12 },
    animation: !prefersReducedMotion(),
    aria: { enabled: true },
    tooltip: { backgroundColor: colors.popover, borderColor: colors.border, textStyle: { color: colors.popoverForeground, fontSize: 12 }, valueFormatter: value, confine: true },
  }
  const legend = (show: boolean) => (show ? { type: 'scroll', top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: colors.muted }, pageTextStyle: { color: colors.muted } } : undefined)
  if (data.type === 'pie') {
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item', formatter: (params: { name: string; value: number; percent: number }) => `${params.name}：${value(params.value)}（${params.percent}%）` },
      legend: legend(true),
      series: [{ type: 'pie', radius: ['40%', '68%'], center: ['50%', '56%'], avoidLabelOverlap: true, itemStyle: { borderColor: colors.card, borderWidth: 2 }, label: { color: colors.foreground, formatter: '{b} {d}%' }, data: data.slices }],
    }
  }
  if (data.type === 'heatmap') {
    const cells = data.values.flatMap((row, y) => row.map((cell, x) => [x, y, cell]))
    const numbers = cells.map((cell) => cell[2]).filter((cell): cell is number => typeof cell === 'number')
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item', formatter: (params: { value: [number, number, number | null] }) => `${data.y[params.value[1]]} · ${data.x[params.value[0]]}：${value(params.value[2])}` },
      grid: { left: 8, right: 8, top: 8, bottom: 44, containLabel: true },
      xAxis: { type: 'category', data: data.x, axisLabel, axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false }, splitArea: { show: false } },
      yAxis: { type: 'category', data: data.y, axisLabel, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: { min: Math.min(...numbers, 0), max: Math.max(...numbers, 1), calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120, itemWidth: 10, textStyle: { color: colors.muted }, inRange: { color: [mix(colors.palette[0]!, colors.card, 0.88), colors.palette[0]!] } },
      series: [{ type: 'heatmap', data: cells, label: { show: cells.length <= 120, color: colors.foreground, formatter: (params: { value: [number, number, number | null] }) => (params.value[2] === null ? '' : formatNumber(params.value[2])) }, itemStyle: { borderColor: colors.card, borderWidth: 1 } }],
    }
  }
  const valueAxis = (name?: string) => ({ type: 'value', name, nameTextStyle: { color: colors.muted }, axisLabel: { ...axisLabel, formatter: (raw: number) => `${formatNumber(raw)}${unit}` }, splitLine: { lineStyle: { color: colors.border } } })
  if (data.type === 'scatter') {
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item', formatter: (params: { seriesName: string; value: [number, number] }) => `${params.seriesName}：${formatNumber(params.value[0])}，${value(params.value[1])}` },
      legend: legend(data.series.length > 1),
      grid: { left: 8, right: 16, top: data.series.length > 1 ? 32 : 16, bottom: 8, containLabel: true },
      xAxis: { ...valueAxis(data.xLabel), axisLabel: { ...axisLabel, formatter: formatNumber } },
      yAxis: valueAxis(data.yLabel),
      series: data.series.map((series) => ({ type: 'scatter', name: series.name, data: series.points, symbolSize: 8, emphasis: { focus: 'series' } })),
    }
  }
  const category = { type: 'category', data: data.categories, name: data.xLabel, nameTextStyle: { color: colors.muted }, axisLabel, axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false }, inverse: data.horizontal }
  const bar = data.type === 'bar'
  return {
    ...common,
    tooltip: { ...common.tooltip, trigger: 'axis', axisPointer: { type: bar ? 'shadow' : 'line', shadowStyle: { color: mix(colors.border, colors.card, 0.5) } } },
    legend: legend(data.series.length > 1),
    grid: { left: 8, right: 16, top: data.series.length > 1 ? 32 : 16, bottom: 8, containLabel: true },
    xAxis: data.horizontal ? valueAxis(data.yLabel) : category,
    yAxis: data.horizontal ? category : valueAxis(data.yLabel),
    series: data.series.map((series) => ({
      type: bar ? 'bar' : 'line',
      name: series.name,
      data: series.data,
      stack: data.stacked ? 'total' : undefined,
      areaStyle: data.type === 'area' ? { opacity: 0.18 } : undefined,
      showSymbol: data.categories.length <= 24,
      connectNulls: false,
      barMaxWidth: 32,
      itemStyle: bar ? { borderRadius: data.horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0] } : undefined,
      emphasis: { focus: 'series' },
    })),
  }
}

function chartHeight(data: ChartData): number {
  if (data.type === 'heatmap') return Math.min(560, Math.max(200, data.y.length * 28 + 90))
  if (data.type !== 'pie' && data.type !== 'scatter' && data.horizontal) return Math.min(520, Math.max(200, data.categories.length * 28 * (data.stacked ? 1 : Math.min(data.series.length, 3)) + 60))
  return 280
}

// 一张图：ECharts 画在 div 里，宽度变了跟着重排，主题变了重设颜色
function ChartCanvas({ data, height, onReady }: { data: ChartData; height: number; onReady?: (chart: EChartsType | null) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const chart = useRef<EChartsType | null>(null)
  const theme = useThemeKey()
  useEffect(() => {
    const element = host.current
    if (!element) return
    const instance = init(element, undefined, { renderer: 'svg', locale: 'ZH' })
    chart.current = instance
    onReady?.(instance)
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.dispose()
      chart.current = null
      onReady?.(null)
    }
  }, [onReady])
  useEffect(() => {
    chart.current?.setOption(chartOption(data), true)
  }, [data, theme])
  return <div ref={host} className="w-full" style={{ height }} data-testid="chart-canvas" />
}

// 无障碍和「看数字」：同一份数据的表格
function ChartTable({ data }: { data: ChartData }) {
  let header: string[]
  let rows: Array<Array<string | number | null>>
  if (data.type === 'pie') {
    header = ['名称', `数值${data.unit ? `（${data.unit}）` : ''}`]
    rows = data.slices.map((slice) => [slice.name, slice.value])
  } else if (data.type === 'scatter') {
    header = ['系列', data.xLabel ?? 'x', data.yLabel ?? 'y']
    rows = data.series.flatMap((series) => series.points.map(([x, y]) => [series.name, x, y]))
  } else if (data.type === 'heatmap') {
    header = ['', ...data.x]
    rows = data.y.map((label, index) => [label, ...(data.values[index] ?? [])])
  } else {
    header = [data.xLabel ?? '', ...data.series.map((series) => series.name)]
    rows = data.categories.map((name, index) => [name, ...data.series.map((series) => series.data[index] ?? null)])
  }
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-sm" data-testid="chart-table">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} scope="col" className="sticky top-0 border-b bg-muted px-2.5 py-1 text-left font-bold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, at) => (
                <td key={at} className={at === 0 ? 'border-b px-2.5 py-1' : 'border-b px-2.5 py-1 text-right tabular-nums'}>
                  {cell === null ? '—' : typeof cell === 'number' ? formatNumber(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ChartBlock({ data }: { data: ChartData; info: FenceInfo }) {
  const [table, setTable] = useState(false)
  const chart = useRef<EChartsType | null>(null)
  // ChartCanvas 的 effect 依赖它，要稳定
  const onReady = useCallback((instance: EChartsType | null) => (chart.current = instance), [])
  const title = data.title ?? TYPE_NAMES[data.type]
  const height = chartHeight(data)
  const svg = () => chart.current?.renderToSVGString() ?? null
  const saveSvg = () => {
    const content = svg()
    if (content) downloadBlob(new Blob([content], { type: 'image/svg+xml' }), `${safeFileName(title)}.svg`)
  }
  const savePng = () => {
    const content = svg()
    if (!content) return
    svgToPng(content, cssVar('--card')).then(
      (blob) => downloadBlob(blob, `${safeFileName(title)}.png`),
      (error: unknown) => showToast(`保存图片失败：${errorMessage(error)}`),
    )
  }
  return (
    <BlockShell
      testId="chart-block"
      kind={`chart-${data.type}`}
      tone="card"
      icon={<ChartColumn className="size-3.5 shrink-0" />}
      title={title}
      meta={data.unit ? <span className="shrink-0">· 单位 {data.unit}</span> : undefined}
      actions={
        <>
          <ShellAction label={table ? '看图' : '看数据表'} pressed={table} onClick={() => setTable(!table)}>
            <Table2 />
          </ShellAction>
          <ShellAction label="另存为 SVG" onClick={saveSvg}>
            <Download />
          </ShellAction>
          <ShellAction label="另存为 PNG" onClick={savePng}>
            <ImageIcon />
          </ShellAction>
        </>
      }
      expand={() => <ChartCanvas data={data} height={Math.round(window.innerHeight * 0.6)} />}
    >
      <div className={table ? 'hidden' : 'px-2 pt-2 pb-1'} role="img" aria-label={`${title}（${TYPE_NAMES[data.type]}），可以切到数据表看具体数字`}>
        <ChartCanvas data={data} height={height} onReady={onReady} />
      </div>
      {table && <ChartTable data={data} />}
    </BlockShell>
  )
}

