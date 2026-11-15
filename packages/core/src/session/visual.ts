import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { VISUAL_MAX_CHARS, VISUAL_META_KEY } from '../protocol.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import { toolDefinitionChars } from './tools.js'

export const SHOW_VISUAL_TOOL = 'show_visual'

const label = z.string().trim().min(1).max(200)
const note = z.string().max(2000)

// 参数沙盘（第 688 步）的公式：只能用数字、参数名、x、运算符和下面这些 Math 函数，工具箱（visual-kit.js 的 FORMULA_NAMES）按同一份名单算
export const FORMULA_FUNCTIONS = ['abs', 'min', 'max', 'pow', 'sqrt', 'cbrt', 'log', 'log2', 'log10', 'exp', 'round', 'floor', 'ceil', 'sin', 'cos', 'tan', 'PI', 'E']
const FORMULA_TOKEN = /\s+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_]\w*|\*\*|<=|>=|==|!=|&&|\|\||[-+*/%^()?:,<>!]/y
const SANDBOX_POINTS = 200

// 公式哪里不对；没问题返回 null
export function formulaProblem(formula: string, names: ReadonlySet<string>): string | null {
  let depth = 0
  // 上一个是数、名字或右括号时，后面不能直接跟数、名字、函数或左括号（2x、(a)(b) 要写乘号）
  let previous: { token: string; value: boolean } | null = null
  FORMULA_TOKEN.lastIndex = 0
  while (FORMULA_TOKEN.lastIndex < formula.length) {
    const at = FORMULA_TOKEN.lastIndex
    const match = FORMULA_TOKEN.exec(formula)
    if (!match) return `has an unsupported character "${formula[at]}" at ${at}`
    const token = match[0]
    if (/^\s/.test(token)) continue
    const name = /^[A-Za-z_]/.test(token)
    if (name && !names.has(token) && !FORMULA_FUNCTIONS.includes(token)) return `uses an unknown name "${token}" (only the parameter ids${names.has('x') ? ', x' : ''} and ${FORMULA_FUNCTIONS.join(', ')})`
    const operand = name || /^[\d.]/.test(token) || token === '('
    if (previous?.value && operand) return `is missing an operator between "${previous.token}" and "${token}" (write * for multiplication)`
    if (token === '(') depth++
    if (token === ')' && --depth < 0) return 'has an unmatched ")"'
    const call = name && FORMULA_FUNCTIONS.includes(token) && token !== 'PI' && token !== 'E'
    previous = { token, value: (name && !call) || /^[\d.]/.test(token) || token === ')' }
  }
  return depth === 0 ? null : 'has an unmatched "("'
}

const formula = z.string().trim().min(1).max(300)
const sandboxInput = z
  .object({
    intro: note.optional(),
    params: z
      .array(z.object({ id: z.string().regex(/^[A-Za-z_]\w{0,30}$/, 'use letters, digits and _'), label: label, min: z.number(), max: z.number(), step: z.number().positive().optional(), value: z.number(), unit: z.string().max(20).optional() }))
      .min(1)
      .max(6),
    x: z.object({ from: z.number(), to: z.number(), step: z.number().positive().optional(), label: label.optional() }).optional(),
    chart: z.object({ type: z.enum(['line', 'area', 'bar']), title: label.optional(), unit: z.string().max(20).optional(), series: z.array(z.object({ name: label, formula })).min(1).max(4) }).optional(),
    outputs: z.array(z.object({ label: label, formula, unit: z.string().max(20).optional() })).max(6).optional(),
  })
  .superRefine((value, context) => {
    const ids = value.params.map((param) => param.id)
    value.params.forEach((param, index) => {
      if (param.id === 'x' || FORMULA_FUNCTIONS.includes(param.id)) context.addIssue({ code: 'custom', path: ['params', index, 'id'], message: `"${param.id}" is reserved` })
      if (ids.indexOf(param.id) !== index) context.addIssue({ code: 'custom', path: ['params', index, 'id'], message: `duplicate id "${param.id}"` })
      if (param.min >= param.max) context.addIssue({ code: 'custom', path: ['params', index, 'max'], message: 'max must be greater than min' })
      else if (param.value < param.min || param.value > param.max) context.addIssue({ code: 'custom', path: ['params', index, 'value'], message: 'value must be between min and max' })
    })
    if (!value.chart && !value.outputs?.length) context.addIssue({ code: 'custom', path: ['chart'], message: 'give a chart, outputs, or both' })
    if (value.chart) {
      if (!value.x) context.addIssue({ code: 'custom', path: ['x'], message: 'a chart needs x: {from, to, step}' })
      else if (value.x.from >= value.x.to) context.addIssue({ code: 'custom', path: ['x', 'to'], message: 'to must be greater than from' })
      else if ((value.x.to - value.x.from) / (value.x.step ?? 1) + 1 > SANDBOX_POINTS) context.addIssue({ code: 'custom', path: ['x', 'step'], message: `at most ${SANDBOX_POINTS} points; use a bigger step` })
      const names = new Set([...ids, 'x'])
      value.chart.series.forEach((series, index) => {
        const problem = formulaProblem(series.formula, names)
        if (problem) context.addIssue({ code: 'custom', path: ['chart', 'series', index, 'formula'], message: `the formula ${problem}` })
      })
    }
    const names = new Set(ids)
    value.outputs?.forEach((output, index) => {
      const problem = formulaProblem(output.formula, names)
      if (problem) context.addIssue({ code: 'custom', path: ['outputs', index, 'formula'], message: `the formula ${problem}` })
    })
  })

// 预设（第 667 步）：模型只给数据，桌面端的工具箱（visual-kit.js 的 diffra.preset）按模板画，样子稳定、跟着主题走
const PRESETS = {
  compare: z.object({
    intro: note.optional(),
    options: z.array(z.object({ name: label, summary: note.optional(), pros: z.array(note).max(12).optional(), cons: z.array(note).max(12).optional(), recommended: z.boolean().optional() })).min(2).max(6),
  }),
  timeline: z.object({
    intro: note.optional(),
    items: z.array(z.object({ time: z.string().max(60).optional(), title: label, detail: note.optional(), status: z.enum(['done', 'active', 'pending', 'failed']).optional() })).min(1).max(50),
  }),
  chart: z.object({
    intro: note.optional(),
    type: z.enum(['bar', 'line', 'area', 'pie', 'donut', 'scatter']),
    data: z.union([
      z.array(z.union([z.object({ label: label, value: z.number() }), z.tuple([z.number(), z.number()]), z.object({ x: z.number(), y: z.number() })])).min(1).max(2000),
      z.object({ labels: z.array(label).max(500).optional(), series: z.array(z.object({ name: label, values: z.array(z.union([z.number(), z.tuple([z.number(), z.number()])])).max(2000) })).min(1).max(12) }),
    ]),
    options: z.object({ title: label.optional(), unit: z.string().max(20).optional(), stacked: z.boolean().optional(), height: z.number().int().min(120).max(800).optional() }).optional(),
  }),
  mockup: z.object({
    intro: note.optional(),
    device: z.enum(['desktop', 'mobile']).optional(),
    screens: z
      .array(
        z.object({
          title: label.optional(),
          device: z.enum(['desktop', 'mobile']).optional(),
          blocks: z.array(z.object({ kind: z.enum(['nav', 'header', 'text', 'button', 'input', 'image', 'list', 'card', 'table']), text: note.optional(), items: z.array(note).max(30).optional() })).min(1).max(40),
        }),
      )
      .min(1)
      .max(4),
  }),
  flow: z.object({
    intro: note.optional(),
    direction: z.enum(['LR', 'TD']).optional(),
    nodes: z.array(z.object({ id: z.string().min(1).max(60), label: label, kind: z.enum(['start', 'end', 'decision', 'step']).optional() })).min(2).max(40),
    edges: z.array(z.object({ from: z.string().min(1).max(60), to: z.string().min(1).max(60), label: z.string().max(40).optional() })).max(80),
  }),
  cards: z.object({
    intro: note.optional(),
    items: z.array(z.object({ label: label, value: z.union([z.string().max(60), z.number()]), unit: z.string().max(20).optional(), delta: z.union([z.string().max(30), z.number()]).optional(), better: z.enum(['up', 'down']).optional() })).min(1).max(12),
  }),
  sandbox: sandboxInput,
} as const

type PresetName = keyof typeof PRESETS
const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]]

const visualInput = z
  .object({
    title: z.string().trim().min(1).max(80).describe('A short name for the visual, shown above it'),
    preset: z.enum(PRESET_NAMES).optional().describe('A ready-made template; give its data instead of code'),
    data: z.unknown().optional().describe('The data for the preset'),
    code: z.string().min(1).max(VISUAL_MAX_CHARS).optional().describe('An HTML fragment (no <html>/<head>/<body>), or an <svg> element; only when no preset fits'),
  })
  .superRefine((value, context) => {
    if (value.preset && value.code) context.addIssue({ code: 'custom', message: 'Give either preset with data, or code, not both' })
    if (!value.preset && !value.code) context.addIssue({ code: 'custom', message: 'Give preset with data, or code' })
    if (value.preset) {
      const parsed = PRESETS[value.preset].safeParse(value.data)
      if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: ['data', ...issue.path.map(String)], message: issue.message })
    }
  })

// 预设生成的代码：数据按 JSON 嵌进脚本，< 换成 <，数据里写了 </script> 也跑不出这段脚本
export function presetCode(preset: PresetName, data: unknown): string {
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  return `<script>diffra.preset(${json(preset)}, ${json(data)})</script>`
}

// 在对话里画一张图或一个能点的小演示：方案对比、界面样稿、流程图、数据图表。
// 代码在桌面端的独立沙箱页面里跑，能联网（CDN 上的库、网络图片），碰不到应用自己的接口
export const showVisualTool = tool({
  description: [
    'Show the user a visual inline in the conversation: a UI mockup, a custom layout, or a small interactive demo.',
    'Try the lighter options first: plain Markdown, a ```mermaid diagram, or a structured block in your reply (chart, metrics, table, timeline, steps, compare). Use show_visual only when none of them fits. Do not use it for things one or two sentences can say, and do not chart three numbers. Keep explanations in your normal reply, not inside the visual.',
    'Prefer a preset with data over code: it looks consistent and follows the theme. Presets and their data:',
    '- compare: {options:[{name,summary,pros:[],cons:[],recommended}]}  - timeline: {items:[{time,title,detail,status:"done|active|pending|failed"}]}',
    '- chart: {type:"bar|line|area|pie|donut|scatter",data:[{label,value}] or {labels:[],series:[{name,values:[]}]},options:{title,unit,stacked}}',
    '- mockup: {device:"desktop|mobile",screens:[{title,blocks:[{kind:"nav|header|text|button|input|image|list|card|table",text,items:[]}]}]}',
    '- flow: {direction:"LR|TD",nodes:[{id,label,kind:"start|end|decision|step"}],edges:[{from,to,label}]}  - cards: {items:[{label,value,unit,delta,better:"up|down"}]}',
    '- sandbox: lets the user drag sliders and watch a result change, for "what if" questions (cost vs. traffic, timeout vs. retries). {params:[{id:"users",label,min,max,step,value,unit}],x:{from,to,step,label},chart:{type:"line|area|bar",title,unit,series:[{name,formula:"users * 0.02 * x"}]},outputs:[{label,formula,unit}]}; formulas use numbers, the param ids, x (chart only), + - * / % ^ ( ) and comparisons, and abs min max pow sqrt log log10 exp round floor ceil.',
    'Any preset data can start with an "intro" sentence.',
    'With code (an HTML fragment or an <svg>): scripts run, and public CDNs (cdnjs, jsdelivr, unpkg) and web images load. A kit is already loaded: diffra.chart(type, data, {title, unit, stacked, into}) returns a themed SVG chart element; diffra.ui.card({title, body, footer, tone}), stat({label, value, unit, delta, better}), badge(text, tone), tabs([{label, content}]), progress(value, {max, label}), grid(children, {min}), table(rows, {columns}) return elements. Elements with data-step="1", "2"… appear one by one in presentation mode.',
    "Match the app: colors only through the CSS variables --bg, --fg, --muted, --border, --card, --primary, --soft, --accent, --warning, --danger, --success, --chart-1..4 (they follow the user's light/dark theme and color scheme); the body font is already set. Keep the outer background transparent.",
    "Actions the user triggers: diffra.fill(text) or diffra.ask(text) put text into the user's message box (the user still sends it), diffra.copy(text) copies, diffra.openFile(path, line) opens a project file, diffra.openBrowser(url) opens a page after the user confirms.",
    'Write labels in the language the user writes in.',
  ].join('\n'),
  inputSchema: visualInput,
})

export async function runShowVisual(call: StepToolCall, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = visualInput.safeParse(call.input)
  if (!parsed.success) {
    const message = `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: '可视化', kind: 'other', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  const { title, preset, data } = parsed.data
  const code = preset ? presetCode(preset, data) : parsed.data.code!
  if (code.length > VISUAL_MAX_CHARS) return { result: errorResult(call, `The visual is too large (over ${VISUAL_MAX_CHARS} characters).`), edited: false }
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId: call.toolCallId,
    title: `可视化 ${title}`,
    kind: 'other',
    status: 'completed',
    _meta: { diffra: { [VISUAL_META_KEY]: { title, code, ...(preset ? { preset } : {}) } } },
  })
  return { result: textResult(call, `Shown to the user as an inline visual titled "${title}"${preset ? ` (preset ${preset})` : ''}.`), edited: false }
}

export const VISUAL_TOOL_CHARS = toolDefinitionChars({ [SHOW_VISUAL_TOOL]: showVisualTool })
