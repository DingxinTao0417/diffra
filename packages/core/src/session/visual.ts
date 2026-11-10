import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { VISUAL_MAX_CHARS, VISUAL_META_KEY } from '../protocol.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import { toolDefinitionChars } from './tools.js'

export const SHOW_VISUAL_TOOL = 'show_visual'

const visualInput = z.object({
  title: z.string().trim().min(1).max(80).describe('A short name for the visual, shown above it'),
  code: z.string().min(1).max(VISUAL_MAX_CHARS).describe('An HTML fragment (no <html>/<head>/<body>), or an <svg> element'),
})

// 在对话里画一张图或一个能点的小演示：方案对比、界面样稿、流程图、数据图表。
// 代码在桌面端的独立沙箱页面里跑，能联网（CDN 上的库、网络图片），碰不到应用自己的接口
export const showVisualTool = tool({
  description: [
    'Show the user a visual inline in the conversation: a side-by-side comparison of options, a UI mockup, a flow or architecture diagram, a chart, or a small interactive demo.',
    'Use it when seeing beats reading (comparing layouts, a multi-step flow, numbers); do not use it for things one or two sentences can say. Keep explanations in your normal reply, not inside the visual.',
    'code is an HTML fragment or an <svg>. Scripts run, and you can load libraries from public CDNs (cdnjs, jsdelivr, unpkg) and images from the web.',
    "Match the app: colors only through the CSS variables --bg, --fg, --muted, --border, --card, --primary, --soft, --accent, --warning, --danger, --success (they follow the user's light/dark theme and color scheme); the body font is already set. Keep the outer background transparent.",
    "A button can put text into the user's message box with diffra.fill('text') (the user still sends it). Links open only after the user confirms.",
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
  const { title, code } = parsed.data
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId: call.toolCallId,
    title: `可视化 ${title}`,
    kind: 'other',
    status: 'completed',
    _meta: { diffra: { [VISUAL_META_KEY]: { title, code } } },
  })
  return { result: textResult(call, `Shown to the user as an inline visual titled "${title}".`), edited: false }
}

export const VISUAL_TOOL_CHARS = toolDefinitionChars({ [SHOW_VISUAL_TOOL]: showVisualTool })
