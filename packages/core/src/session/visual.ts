import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { VISUAL_MAX_CHARS, VISUAL_META_KEY } from '../protocol.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import { toolDefinitionChars } from './tools.js'

export const SHOW_VISUAL_TOOL = 'show_visual'

const label = z.string().trim().min(1).max(200)
const note = z.string().max(2000)

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
