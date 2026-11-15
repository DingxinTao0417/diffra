import { type ComponentType, lazy, Suspense, useMemo } from 'react'
import { isRichBlockKind, parseRichBlock, type RichBlockKind, type RichBlockMap } from '@diffra/core/rich'
import { BlockSkeleton } from './BlockShell'
import { CodeBlock } from './CodeBlock'
import { CompareBlock, KeyValueBlock, MetricsBlock, StepsBlock, TimelineBlock } from './DataBlocks'
import { DataTableBlock } from './DataTableBlock'
import type { FenceInfo } from './fence'
import { FileTreeBlock } from './FileTreeBlock'
import { JsonTree } from './JsonBlock'
import { LogBlock } from './LogBlock'
import { TodosBlock } from './TodosBlock'

// 图表用 ECharts，按需加载：回答里第一次出现 ```chart 时才取
const ChartBlock = lazy(() => import('./ChartBlock'))

export type RichRenderer<K extends RichBlockKind> = ComponentType<{ data: RichBlockMap[K]; info: FenceInfo }>

// kind → 渲染器（第 650 步）。schema 和上限在 core 的 rich/blocks.ts，这里只管怎么画
const RENDERERS: { [K in RichBlockKind]: RichRenderer<K> } = {
  chart: ({ data, info }) => (
    <Suspense fallback={<BlockSkeleton label="正在加载图表…" />}>
      <ChartBlock data={data} info={info} />
    </Suspense>
  ),
  metrics: MetricsBlock,
  table: DataTableBlock,
  timeline: TimelineBlock,
  steps: StepsBlock,
  compare: CompareBlock,
  filetree: FileTreeBlock,
  keyvalue: KeyValueBlock,
  todos: TodosBlock,
  json: ({ data, info }) => <JsonTree value={data.value} source={info.code} />,
  log: LogBlock,
}

const NAMES: Record<RichBlockKind, string> = {
  chart: '图表',
  metrics: '指标卡',
  table: '表格',
  timeline: '时间线',
  steps: '步骤',
  compare: '方案对比',
  filetree: '文件树',
  keyvalue: '键值表',
  todos: '后续事项',
  json: 'JSON',
  log: '日志',
}

const SKELETON_LABELS: Partial<Record<RichBlockKind, string>> = { chart: '正在画图表…', log: '正在输出日志…' }

// 代码围栏的语言是不是富块；json 另有 JsonBlock（先按代码显示，能切成树），不走这里
export function richKindOf(language: string): RichBlockKind | null {
  return language !== 'json' && isRichBlockKind(language) ? language : null
}

// 富块：没写完时占位；数据不对、版本太新、超上限时回退成代码块，写明原因
export function RichBlock({ kind, info, closed }: { kind: RichBlockKind; info: FenceInfo; closed: boolean }) {
  const result = useMemo(() => (closed ? parseRichBlock(kind, info.code) : null), [closed, kind, info.code])
  if (!result) return <BlockSkeleton label={SKELETON_LABELS[kind] ?? `正在写${NAMES[kind]}…`} />
  if (!result.ok) return <CodeBlock info={info} note={`没能显示成${NAMES[kind]}，按代码显示：${result.error}`} />
  const Renderer = RENDERERS[kind] as RichRenderer<typeof kind>
  return <Renderer data={result.data} info={info} />
}
