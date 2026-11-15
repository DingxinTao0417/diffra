import { z } from 'zod'

// 回答里的结构化富块（第 650 步）：模型在回答里写 ```chart、```metrics 这样的代码围栏，内容是 JSON（json、log 是原文），
// 界面按 kind 找到渲染器画出来。schema 和上限放在 core：对话、导出、远程快照、分享页用同一份数据、同一套校验。
// 数据不合法、版本比这里新、超过上限时 parseRichBlock 返回 ok: false 和原因，界面回退成普通代码块，不影响整段回答。

// 每种块当前的版本。块里写 "v": 2 而这里还是 1：说明是更新的 Diffra 写的，回退成代码并提示
export const RICH_BLOCK_VERSION = 1

export const RICH_LIMITS = {
  // 一个块的原文
  chars: 100_000,
  chartSeries: 12,
  // 一张图所有系列加起来的点数
  chartPoints: 2_000,
  heatmapCells: 2_500,
  metrics: 12,
  tableRows: 1_000,
  tableColumns: 30,
  // 时间线、步骤、键值对的条数
  items: 200,
  compareOptions: 6,
  todos: 50,
  treeEntries: 1_000,
  logLines: 5_000,
  annotateMarks: 30,
  decisionCriteria: 8,
  // 字段里的一段文字
  text: 2_000,
} as const

const label = z.string().trim().min(1).max(200)
const text = z.string().max(RICH_LIMITS.text)
const scalar = z.union([z.string().max(RICH_LIMITS.text), z.number(), z.boolean(), z.null()])
const finite = z.number().refine(Number.isFinite, '不是有限数字')
const version = z.number().int().positive().optional()

// ---- chart ----

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'heatmap'

export type ChartData =
  | { type: 'bar' | 'line' | 'area'; title?: string; unit?: string; xLabel?: string; yLabel?: string; horizontal: boolean; stacked: boolean; categories: string[]; series: Array<{ name: string; data: Array<number | null> }> }
  | { type: 'pie'; title?: string; unit?: string; slices: Array<{ name: string; value: number }> }
  | { type: 'scatter'; title?: string; unit?: string; xLabel?: string; yLabel?: string; series: Array<{ name: string; points: Array<[number, number]> }> }
  | { type: 'heatmap'; title?: string; unit?: string; x: string[]; y: string[]; values: Array<Array<number | null>> }

const point = z.object({ label: label.optional(), name: label.optional(), x: z.union([label, finite]).optional(), value: finite.nullable().optional(), y: finite.nullable().optional() })

const chartInput = z.object({
  v: version,
  type: z.enum(['bar', 'line', 'area', 'pie', 'scatter', 'heatmap']),
  title: label.optional(),
  unit: z.string().max(20).optional(),
  xLabel: label.optional(),
  yLabel: label.optional(),
  horizontal: z.boolean().optional(),
  stacked: z.boolean().optional(),
  // 多系列：x 是类目，series[].data 和它一一对应；散点的 data 是 [x, y] 对
  x: z.array(z.union([label, finite])).optional(),
  y: z.array(z.union([label, finite])).optional(),
  series: z.array(z.object({ name: label, data: z.array(z.union([finite, z.null(), z.tuple([finite, finite])])) })).optional(),
  // 单系列的简写：[{ "label": "a", "value": 1 }]；热力图是按 y 排的二维数组
  data: z.array(z.union([point, z.array(finite.nullable()), finite])).optional(),
})

function parseChart(input: unknown): ChartData {
  const raw = chartInput.parse(input)
  const common = { title: raw.title, unit: raw.unit }
  if (raw.type === 'heatmap') {
    const x = (raw.x ?? []).map(String)
    const y = (raw.y ?? []).map(String)
    const rows = (raw.data ?? []).map((row) => (Array.isArray(row) ? row : null))
    if (x.length === 0 || y.length === 0) throw new Error('热力图要有 x 和 y 两组标签')
    if (rows.some((row) => row === null) || rows.length !== y.length) throw new Error('热力图的 data 要是二维数组，行数和 y 一样多')
    if (rows.some((row) => row!.length !== x.length)) throw new Error('热力图每一行的个数要和 x 一样多')
    if (x.length * y.length > RICH_LIMITS.heatmapCells) throw new Error(`热力图超过 ${RICH_LIMITS.heatmapCells} 格`)
    return { type: 'heatmap', ...common, x, y, values: rows as Array<Array<number | null>> }
  }
  if (raw.type === 'scatter') {
    const series = raw.series
      ? raw.series.map((item) => ({ name: item.name, points: item.data.filter((value): value is [number, number] => Array.isArray(value)) }))
      : [{ name: raw.title ?? '数据', points: (raw.data ?? []).flatMap((item) => (isPoint(item) && typeof item.x === 'number' && typeof item.y === 'number' ? [[item.x, item.y] as [number, number]] : [])) }]
    checkPoints(series.map((item) => item.points.length))
    if (series.every((item) => item.points.length === 0)) throw new Error('散点图的点要写成 [x, y] 或 { "x": 1, "y": 2 }')
    return { type: 'scatter', ...common, xLabel: raw.xLabel, yLabel: raw.yLabel, series }
  }
  // 柱状、折线、面积、饼：先统一成类目 + 系列
  let categories: string[]
  let series: Array<{ name: string; data: Array<number | null> }>
  if (raw.series) {
    categories = (raw.x ?? []).map(String)
    series = raw.series.map((item) => ({ name: item.name, data: item.data.map((value) => (Array.isArray(value) ? value[1] : value)) }))
    if (categories.length === 0) categories = series[0]?.data.map((_, index) => String(index + 1)) ?? []
    if (series.some((item) => item.data.length !== categories.length)) throw new Error('每个系列的 data 个数要和 x 一样多')
  } else {
    const points = (raw.data ?? []).filter(isPoint)
    if (points.length !== (raw.data ?? []).length) throw new Error('data 要写成 [{ "label": "名字", "value": 数字 }]')
    categories = points.map((item, index) => String(item.label ?? item.name ?? item.x ?? index + 1))
    series = [{ name: raw.title ?? raw.yLabel ?? '数值', data: points.map((item) => item.value ?? item.y ?? null) }]
  }
  if (series.length === 0 || categories.length === 0) throw new Error('图表没有数据')
  if (series.length > RICH_LIMITS.chartSeries) throw new Error(`系列超过 ${RICH_LIMITS.chartSeries} 个`)
  checkPoints(series.map((item) => item.data.length))
  if (raw.type === 'pie') {
    const values = series[0]!.data
    const slices = categories.map((name, index) => ({ name, value: values[index] ?? 0 }))
    if (slices.some((slice) => slice.value < 0)) throw new Error('饼图不能有负数')
    return { type: 'pie', ...common, slices }
  }
  return { type: raw.type, ...common, xLabel: raw.xLabel, yLabel: raw.yLabel, horizontal: raw.horizontal ?? false, stacked: raw.stacked ?? false, categories, series }
}

const isPoint = (item: unknown): item is z.infer<typeof point> => typeof item === 'object' && item !== null && !Array.isArray(item)

function checkPoints(counts: number[]) {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total > RICH_LIMITS.chartPoints) throw new Error(`图表超过 ${RICH_LIMITS.chartPoints} 个点`)
}

// ---- metrics ----

const metricsItem = z.object({
  label,
  value: z.union([z.string().max(60), finite]),
  unit: z.string().max(20).optional(),
  // 变化：数字（+12、-3.5）或写好的文字（"+12%"）
  delta: z.union([finite, z.string().max(30)]).optional(),
  trend: z.enum(['up', 'down', 'flat']).optional(),
  // 涨是好事还是坏事（耗时、错误数涨了是坏事）；不写时只画方向、不分好坏
  better: z.enum(['up', 'down']).optional(),
  note: text.optional(),
})
const metricsInput = z.union([z.object({ v: version, title: label.optional(), items: z.array(metricsItem).min(1).max(RICH_LIMITS.metrics) }), z.array(metricsItem).min(1).max(RICH_LIMITS.metrics)])

export type MetricsData = { title?: string; items: Array<z.infer<typeof metricsItem> & { trend?: 'up' | 'down' | 'flat' }> }

function parseMetrics(input: unknown): MetricsData {
  const raw = metricsInput.parse(input)
  const { title, items } = Array.isArray(raw) ? { title: undefined, items: raw } : raw
  return { title, items: items.map((item) => ({ ...item, trend: item.trend ?? trendOf(item.delta) })) }
}

function trendOf(delta: number | string | undefined): 'up' | 'down' | 'flat' | undefined {
  const value = typeof delta === 'number' ? delta : typeof delta === 'string' ? Number.parseFloat(delta.replace(/[^\d.+-]/g, '')) : Number.NaN
  if (Number.isNaN(value)) return undefined
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
}

// ---- table ----

const column = z.union([label, z.object({ key: label, label: label.optional(), align: z.enum(['left', 'center', 'right']).optional(), type: z.enum(['text', 'number']).optional() })])
const tableInput = z.object({
  v: version,
  title: label.optional(),
  columns: z.array(column).min(1).max(RICH_LIMITS.tableColumns),
  rows: z.array(z.union([z.array(scalar), z.record(z.string(), scalar)])).max(RICH_LIMITS.tableRows),
})

export type TableColumn = { key: string; label: string; align: 'left' | 'center' | 'right'; numeric: boolean }
export type TableData = { title?: string; columns: TableColumn[]; rows: Array<Array<string | number | boolean | null>> }

function parseTable(input: unknown): TableData {
  const raw = tableInput.parse(input)
  const keys = raw.columns.map((item) => (typeof item === 'string' ? item : item.key))
  const rows = raw.rows.map((row) => (Array.isArray(row) ? keys.map((_, index) => row[index] ?? null) : keys.map((key) => row[key] ?? null)))
  const columns = raw.columns.map((item, index): TableColumn => {
    const values = rows.map((row) => row[index]).filter((value) => value !== null && value !== '')
    const numeric = typeof item === 'object' && item.type ? item.type === 'number' : values.length > 0 && values.every((value) => typeof value === 'number')
    return typeof item === 'string'
      ? { key: item, label: item, align: numeric ? 'right' : 'left', numeric }
      : { key: item.key, label: item.label ?? item.key, align: item.align ?? (numeric ? 'right' : 'left'), numeric }
  })
  return { title: raw.title, columns, rows }
}

// ---- timeline / steps ----

const status = z.enum(['done', 'active', 'pending', 'failed', 'skipped'])
const timelineInput = z.union([
  z.object({ v: version, title: label.optional(), items: z.array(z.object({ time: z.string().max(60).optional(), title: label, detail: text.optional(), status: status.optional() })).min(1).max(RICH_LIMITS.items) }),
  z.array(z.object({ time: z.string().max(60).optional(), title: label, detail: text.optional(), status: status.optional() })).min(1).max(RICH_LIMITS.items),
])
export type TimelineData = { title?: string; items: Array<{ time?: string; title: string; detail?: string; status?: z.infer<typeof status> }> }

function parseTimeline(input: unknown): TimelineData {
  const raw = timelineInput.parse(input)
  return Array.isArray(raw) ? { items: raw } : { title: raw.title, items: raw.items }
}

const stepItem = z.union([label, z.object({ title: label, detail: text.optional(), done: z.boolean().optional(), status: status.optional(), command: z.string().max(500).optional() })])
const stepsInput = z.union([z.object({ v: version, title: label.optional(), current: z.number().int().min(1).optional(), items: z.array(stepItem).min(1).max(RICH_LIMITS.items) }), z.array(stepItem).min(1).max(RICH_LIMITS.items)])
export type StepsData = { title?: string; items: Array<{ title: string; detail?: string; command?: string; status: z.infer<typeof status> }> }

function parseSteps(input: unknown): StepsData {
  const raw = stepsInput.parse(input)
  const { title, current, items } = Array.isArray(raw) ? { title: undefined, current: undefined, items: raw } : raw
  return {
    title,
    items: items.map((item, index) => {
      const step = typeof item === 'string' ? { title: item } : item
      const explicit = typeof item === 'string' ? undefined : (item.status ?? (item.done ? 'done' : undefined))
      const derived = current === undefined ? 'pending' : index + 1 < current ? 'done' : index + 1 === current ? 'active' : 'pending'
      return { title: step.title, detail: 'detail' in step ? step.detail : undefined, command: 'command' in step ? step.command : undefined, status: explicit ?? derived }
    }),
  }
}

// ---- compare ----

const compareInput = z.object({
  v: version,
  title: label.optional(),
  criteria: z.array(label).max(20).optional(),
  options: z
    .array(
      z.object({
        name: label,
        summary: text.optional(),
        pros: z.array(text).max(20).optional(),
        cons: z.array(text).max(20).optional(),
        recommended: z.boolean().optional(),
        // 每条标准的评价：文字或分数，键是 criteria 里的名字
        scores: z.record(z.string(), z.union([z.string().max(200), finite])).optional(),
      }),
    )
    .min(2)
    .max(RICH_LIMITS.compareOptions),
})
export type CompareData = Omit<z.infer<typeof compareInput>, 'v'>

function parseCompare(input: unknown): CompareData {
  const { v: _v, ...data } = compareInput.parse(input)
  if (data.options.filter((option) => option.recommended).length > 1) throw new Error('只能推荐一个方案')
  return data
}

// ---- filetree ----

const fileStatus = z.enum(['added', 'modified', 'deleted', 'renamed'])
const treeInput = z.union([
  z.object({ v: version, title: label.optional(), root: z.string().max(500).optional(), items: z.array(z.union([z.string().min(1).max(500), z.object({ path: z.string().min(1).max(500), status: fileStatus.optional(), note: text.optional() })])).min(1).max(RICH_LIMITS.treeEntries) }),
  z.array(z.union([z.string().min(1).max(500), z.object({ path: z.string().min(1).max(500), status: fileStatus.optional(), note: text.optional() })])).min(1).max(RICH_LIMITS.treeEntries),
])
export type FileTreeData = { title?: string; root?: string; items: Array<{ path: string; status?: z.infer<typeof fileStatus>; note?: string }> }

function parseFileTree(input: unknown): FileTreeData {
  const raw = treeInput.parse(input)
  const { title, root, items } = Array.isArray(raw) ? { title: undefined, root: undefined, items: raw } : raw
  return { title, root, items: items.map((item) => (typeof item === 'string' ? { path: normalizePath(item) } : { ...item, path: normalizePath(item.path) })) }
}

const normalizePath = (path: string) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '')

// ---- keyvalue ----

const keyvalueInput = z.union([
  z.object({ v: version, title: label.optional(), items: z.array(z.object({ key: label, value: scalar, mono: z.boolean().optional() })).min(1).max(RICH_LIMITS.items) }),
  z.record(z.string().min(1).max(200), scalar),
])
export type KeyValueData = { title?: string; items: Array<{ key: string; value: string | number | boolean | null; mono?: boolean }> }

function parseKeyValue(input: unknown): KeyValueData {
  const raw = keyvalueInput.parse(input)
  if ('items' in raw && Array.isArray(raw.items)) return { title: typeof raw.title === 'string' ? raw.title : undefined, items: raw.items }
  const entries = Object.entries(raw as Record<string, string | number | boolean | null>)
  if (entries.length === 0) throw new Error('没有键值')
  if (entries.length > RICH_LIMITS.items) throw new Error(`超过 ${RICH_LIMITS.items} 项`)
  return { items: entries.map(([key, value]) => ({ key, value })) }
}

// ---- todos ----

// 回答里列出的后续事项（第 664 步）：界面上每条能加进待办、勾掉、改期、派给任务，和侧栏的待办是同一份
const todoItem = z.union([label, z.object({ text: label, note: text.optional(), priority: z.number().int().min(0).max(3).optional() })])
const todosInput = z.union([
  z.object({ v: version, title: label.optional(), items: z.array(todoItem).min(1).max(RICH_LIMITS.todos) }),
  z.array(todoItem).min(1).max(RICH_LIMITS.todos),
])
export type TodosData = { title?: string; items: Array<{ text: string; note?: string; priority?: 0 | 1 | 2 | 3 }> }

function parseTodos(input: unknown): TodosData {
  const raw = todosInput.parse(input)
  const { title, items } = Array.isArray(raw) ? { title: undefined, items: raw } : raw
  return { title, items: items.map((item) => (typeof item === 'string' ? { text: item } : { ...item, priority: item.priority as 0 | 1 | 2 | 3 | undefined })) }
}

// ---- log ----

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogData = { lines: Array<{ text: string; level: LogLevel | null; source: { path: string; line: number } | null }>; truncated: number }

const LEVELS: Array<[RegExp, LogLevel]> = [
  [/\b(ERROR|ERR|FATAL|CRITICAL|PANIC|FAIL(ED)?)\b|\[(error|fatal)\]|^E\d{4}|\b(Error|Exception):/, 'error'],
  [/\b(WARN(ING)?)\b|\[warn(ing)?\]|^W\d{4}/i, 'warn'],
  [/\b(INFO|NOTICE)\b|\[info\]|^I\d{4}/i, 'info'],
  [/\b(DEBUG|TRACE|VERBOSE)\b|\[(debug|trace)\]/i, 'debug'],
]
// 行里的源码位置：src/a.ts:12、at foo (D:\p\b.js:3:5)、File "x.py", line 8
const SOURCE = /(?:File "([^"]+)", line (\d+))|((?:[A-Za-z]:)?[\w./\\@-]*\w\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/

function parseLog(text: string): LogData {
  const all = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const lines = all.slice(0, RICH_LIMITS.logLines).map((line) => {
    const level = LEVELS.find(([pattern]) => pattern.test(line))?.[1] ?? null
    const match = SOURCE.exec(line)
    const source = match ? { path: (match[1] ?? match[3])!, line: Number(match[2] ?? match[4]) } : null
    return { text: line, level, source }
  })
  return { lines, truncated: Math.max(0, all.length - RICH_LIMITS.logLines) }
}

// ---- annotate ----

// 图上标注（第 685 步）：image 是项目里的图片路径、data: 地址，或这一轮提问里的图片（@图片1）。
// 坐标默认是占图片宽、高的比例（0–1）；写了 size（图片的像素宽高）就按像素。框和圈的 x、y 是左上角，圈是框里内切的椭圆；箭头从 x、y 指向 x2、y2
export type AnnotateShape = 'box' | 'circle' | 'arrow' | 'pin'
export type AnnotateMark =
  | { shape: 'box' | 'circle'; x: number; y: number; w: number; h: number; note?: string }
  | { shape: 'arrow'; x: number; y: number; x2: number; y2: number; note?: string }
  | { shape: 'pin'; x: number; y: number; note?: string }
export type AnnotateData = { image: string; title?: string; marks: AnnotateMark[] }

const annotateInput = z.object({
  v: version,
  image: z.string().trim().min(1),
  title: label.optional(),
  size: z.tuple([finite.positive(), finite.positive()]).optional(),
  marks: z
    .array(z.object({ shape: z.enum(['box', 'circle', 'arrow', 'pin']), x: finite, y: finite, w: finite.optional(), h: finite.optional(), x2: finite.optional(), y2: finite.optional(), note: text.optional() }))
    .min(1)
    .max(RICH_LIMITS.annotateMarks),
})

function parseAnnotate(input: unknown): AnnotateData {
  const raw = annotateInput.parse(input)
  if (/^https?:\/\//i.test(raw.image)) throw new Error('网络图片不加载：image 要是项目里的图片、data: 地址或这一轮提问里的图片（@图片1）')
  const [width, height] = raw.size ?? [1, 1]
  const ratio = (value: number, total: number, where: string) => {
    const result = value / total
    if (result < 0 || result > 1) throw new Error(`${where}：超出了图片范围${raw.size ? '' : '（没写 size 时坐标是 0–1 的比例）'}`)
    return result
  }
  const marks = raw.marks.map((mark, index): AnnotateMark => {
    const at = `marks.${index}`
    const x = ratio(mark.x, width, `${at}.x`)
    const y = ratio(mark.y, height, `${at}.y`)
    const note = mark.note?.trim() || undefined
    if (mark.shape === 'pin') return { shape: 'pin', x, y, note }
    if (mark.shape === 'arrow') {
      if (mark.x2 === undefined || mark.y2 === undefined) throw new Error(`${at}：箭头要写 x2、y2（指向的位置）`)
      return { shape: 'arrow', x, y, x2: ratio(mark.x2, width, `${at}.x2`), y2: ratio(mark.y2, height, `${at}.y2`), note }
    }
    if (!mark.w || !mark.h || mark.w < 0 || mark.h < 0) throw new Error(`${at}：${mark.shape === 'box' ? '框' : '圈'}要写正的 w、h（宽和高）`)
    return { shape: mark.shape, x, y, w: ratio(mark.x + mark.w, width, `${at}.w`) - x, h: ratio(mark.y + mark.h, height, `${at}.h`) - y, note }
  })
  return { image: raw.image, title: raw.title, marks }
}

// ---- decision ----

// 决策卡（第 689 步）：几个方案按加权的评判标准打分。分数在 0 到 scale（5 或 10）之间，权重 0–5（0 是不看这一项），用户能在界面上改权重、看排名变化、选一个
export type DecisionData = { title?: string; question?: string; scale: number; criteria: Array<{ name: string; weight: number }>; options: Array<{ name: string; summary?: string; scores: number[]; recommended: boolean }> }

const decisionInput = z.object({
  v: version,
  title: label.optional(),
  question: text.optional(),
  scale: z.union([z.literal(5), z.literal(10)]).optional(),
  criteria: z.array(z.union([label, z.object({ name: label, weight: z.number().int().min(0).max(5).optional() })])).min(1).max(RICH_LIMITS.decisionCriteria),
  options: z.array(z.object({ name: label, summary: text.optional(), scores: z.record(z.string(), finite), recommended: z.boolean().optional() })).min(2).max(RICH_LIMITS.compareOptions),
})

function parseDecision(input: unknown): DecisionData {
  const raw = decisionInput.parse(input)
  const scale = raw.scale ?? 5
  const criteria = raw.criteria.map((criterion) => (typeof criterion === 'string' ? { name: criterion, weight: 1 } : { name: criterion.name, weight: criterion.weight ?? 1 }))
  const repeated = criteria.find((criterion, index) => criteria.findIndex((other) => other.name === criterion.name) !== index)
  if (repeated) throw new Error(`评判标准「${repeated.name}」写了两次`)
  if (criteria.every((criterion) => criterion.weight === 0)) throw new Error('至少要有一个评判标准的权重大于 0')
  const options = raw.options.map((option, index) => ({
    name: option.name,
    summary: option.summary,
    recommended: option.recommended ?? false,
    scores: criteria.map((criterion) => {
      const score = option.scores[criterion.name]
      if (score === undefined) throw new Error(`options.${index}.scores：缺「${criterion.name}」的分数`)
      if (score < 0 || score > scale) throw new Error(`options.${index}.scores.${criterion.name}：分数要在 0–${scale} 之间`)
      return score
    }),
  }))
  if (options.filter((option) => option.recommended).length > 1) throw new Error('最多推荐一个方案')
  return { title: raw.title, question: raw.question, scale, criteria, options }
}

// ---- 注册表 ----

export interface RichBlockMap {
  chart: ChartData
  metrics: MetricsData
  table: TableData
  timeline: TimelineData
  steps: StepsData
  compare: CompareData
  filetree: FileTreeData
  keyvalue: KeyValueData
  todos: TodosData
  annotate: AnnotateData
  decision: DecisionData
  json: { value: unknown }
  log: LogData
}

export type RichBlockKind = keyof RichBlockMap

// format：json 的块内容按 JSON 解析后交给 parse；text 的直接把原文交给 parse
const REGISTRY: { [K in RichBlockKind]: { format: 'json' | 'text'; parse(input: unknown): RichBlockMap[K] } } = {
  chart: { format: 'json', parse: parseChart },
  metrics: { format: 'json', parse: parseMetrics },
  table: { format: 'json', parse: parseTable },
  timeline: { format: 'json', parse: parseTimeline },
  steps: { format: 'json', parse: parseSteps },
  compare: { format: 'json', parse: parseCompare },
  filetree: { format: 'json', parse: parseFileTree },
  keyvalue: { format: 'json', parse: parseKeyValue },
  todos: { format: 'json', parse: parseTodos },
  annotate: { format: 'json', parse: parseAnnotate },
  decision: { format: 'json', parse: parseDecision },
  json: { format: 'json', parse: (value) => ({ value }) },
  log: { format: 'text', parse: (value) => parseLog(String(value)) },
}

export const RICH_BLOCK_KINDS = Object.keys(REGISTRY) as RichBlockKind[]

export function isRichBlockKind(kind: string): kind is RichBlockKind {
  return Object.hasOwn(REGISTRY, kind)
}

export type RichBlockResult<K extends RichBlockKind = RichBlockKind> = { ok: true; kind: K; data: RichBlockMap[K] } | { ok: false; kind: K; error: string }

export function parseRichBlock<K extends RichBlockKind>(kind: K, source: string): RichBlockResult<K> {
  const entry = REGISTRY[kind]
  if (source.length > RICH_LIMITS.chars) return { ok: false, kind, error: `内容太长（超过 ${RICH_LIMITS.chars} 字）` }
  let input: unknown = source
  if (entry.format === 'json') {
    try {
      input = JSON.parse(source)
    } catch (error) {
      return { ok: false, kind, error: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
    }
    const declared = typeof input === 'object' && input !== null && !Array.isArray(input) && 'v' in input ? (input as { v: unknown }).v : undefined
    if (kind !== 'json' && typeof declared === 'number' && declared > RICH_BLOCK_VERSION) return { ok: false, kind, error: `这是第 ${declared} 版的 ${kind} 块，当前版本只认到第 ${RICH_BLOCK_VERSION} 版` }
  }
  try {
    return { ok: true, kind, data: entry.parse(input) as RichBlockMap[K] }
  } catch (error) {
    return { ok: false, kind, error: describe(error) }
  }
}

function describe(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 3)
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}：${issue.message}` : issue.message))
      .join('；')
  }
  return error instanceof Error ? error.message : String(error)
}
