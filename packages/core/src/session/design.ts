import { jsonSchema, tool, type ToolResultPart, type ToolSet } from 'ai'
import { designStyleById, type PromptImage } from '../protocol.js'
import { PLACE_IMAGE_DEFINITION, PLACE_IMAGE_TOOL } from './design-image.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'

// 设计面板（OpenPencil 矢量编辑器）：工具定义来自客户端的设计页，设计任务每轮开始前由客户端配置给会话（session.design），
// 调用时 core 通过 ACP 请求客户端在设计页里执行（见 TurnIO.design）。画布上的修改都能撤销，页面是沙箱、断网的，所以不逐次确认。
// 工具名加 design_ 前缀，和 Diffra 自己的工具、MCP 工具分开
const PREFIX = 'design_'
// 只返回图片的工具，不看图的模型用不上
const IMAGE_ONLY_TOOLS = new Set(['export_image'])

// 设计页的工具加上 core 自己实现的放图片（下载、读文件要在 core 做）
export function designTools(session: Session): ToolSet {
  if (!session.design) return {}
  const tools: ToolSet = {}
  for (const spec of session.design.tools) {
    if (IMAGE_ONLY_TOOLS.has(spec.name) && !session.config.model.supportsImages) continue
    tools[PREFIX + spec.name] = tool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema) })
  }
  tools[PLACE_IMAGE_TOOL] = PLACE_IMAGE_DEFINITION
  return tools
}

// 上下文明细里设计工具和说明占的字数。设计页的工具参数是 JSON Schema，不能用 toolDefinitionChars（它按 zod 转）
export function designChars(session: Session): number {
  if (!session.design) return 0
  const tools = Object.keys(designTools(session))
  const specs = session.design.tools.filter((spec) => tools.includes(PREFIX + spec.name))
  const pageChars = specs.reduce((sum, spec) => sum + PREFIX.length + spec.name.length + spec.description.length + JSON.stringify(spec.inputSchema).length, 0)
  return pageChars + toolDefinitionChars({ [PLACE_IMAGE_TOOL]: PLACE_IMAGE_DEFINITION }) + designInstructions(session).length
}

// 内置的设计 Skill；技能清单里有它（「- 名字: 说明」一行）时让模型先读
const DESIGN_SKILL = 'frontend-design'

// 说明跟着设计工具一起接在系统提示词后面，没配置设计工具的会话不带
export function designInstructions(session: Session): string {
  if (!session.design) return ''
  const designSkill = session.systemPrompt.includes(`- ${DESIGN_SKILL}`)
  const lines = [
    'Design canvas:',
    `- The user opened the design panel: a vector design editor (OpenPencil, Figma-like) shown beside the conversation. Tools prefixed with ${PREFIX} work on its document; their descriptions name each other without the prefix.`,
    '- Draw designs on this canvas with those tools instead of writing HTML files, unless the user asks for code.',
    `- To implement a design in the project, read it with ${PREFIX}get_jsx (Tailwind output if the project uses Tailwind), then write code with edit_file following the project's existing components and styles.`,
    session.config.model.supportsImages
      ? `- After a visible change, look at the result with ${PREFIX}export_image on the affected nodes and fix what looks wrong.`
      : `- You cannot see images; check the result with ${PREFIX}describe and ${PREFIX}get_node instead.`,
    `- For photos, illustrations and logos use ${PLACE_IMAGE_TOOL} with an image URL or a local file; never hand-draw stand-ins for real images.` +
      (session.config.browser
        ? ' To find images on the web, open an image site in the built-in browser (for example https://unsplash.com/s/photos/<keywords>, https://www.pexels.com/search/<keywords>/ or https://commons.wikimedia.org), ' +
          'then call browser_images to list the image URLs on the page. Prefer freely licensed images and tell the user where they came from.'
        : ' The built-in browser is off, so you cannot search the web: use images the user gives you, or tell the user which images are needed.'),
    '',
    'Design workflow:',
    `1. Settle the subject, audience and visual direction first${designSkill ? ` (read the ${DESIGN_SKILL} skill)` : ''}. If a style preset is given below, start from it.`,
    `2. Set up the design system as variables before drawing pages: colors, type sizes, spacing and radius (${PREFIX}create_collection, ${PREFIX}create_variable), then bind them (${PREFIX}bind_variable) instead of repeating raw values.`,
    `3. Build repeated parts (buttons, cards, navigation, list items) once as components (${PREFIX}create_component) and reuse them with ${PREFIX}create_instance.`,
    '4. Compose each page in its own top-level frame from those parts, with realistic copy and real images. For a larger design, after steps 1-3 you can hand pages or sections to workers with delegate (pass their node ids in nodes) and then check the whole result.',
    `5. Before you finish, run ${PREFIX}lint and ${PREFIX}analyze_colors, ${PREFIX}analyze_typography, ${PREFIX}analyze_spacing and ${PREFIX}analyze_overlaps on the frames you changed; apply safe fixes with ${PREFIX}lint_fix and fix the findings that matter.`,
    '',
    session.design.instructions,
    ...styleLines(session),
  ]
  return `\n\n${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}`
}

// 建任务时选的风格预设：作为起点，按题材调整，用户另有要求时以用户为准
function styleLines(session: Session): string[] {
  const style = designStyleById(session.designStyle)
  if (!style) return []
  return ['', 'The user picked this style preset as the starting point. Adapt it to the subject; when the user asks for something different, follow the user.', style.instructions]
}

export function isDesignTool(session: Session, name: string): boolean {
  return name.startsWith(PREFIX) && session.design?.tools.some((spec) => PREFIX + spec.name === name) === true
}

export async function runDesignToolCall(
  session: Session,
  call: StepToolCall,
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ result: ToolResultPart; edited: boolean; images?: PromptImage[] }> {
  const name = call.toolName.slice(PREFIX.length)
  const readOnly = session.design?.tools.find((spec) => spec.name === name)?.readOnly ?? false
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: `设计 ${name}`, kind: readOnly ? 'read' : 'other', status: 'in_progress', rawInput: call.input })
  const fail = async (message: string) => {
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  if (!io.design) return fail('The design panel is not available in this client.')
  try {
    const output = await io.design(name, call.input, signal)
    // 看不了图的模型只拿文字部分（比如像素对比的统计）
    const image = output.image && session.config.model.supportsImages ? output.image : null
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: image ? `${output.text}\n（图片已发给模型）` : output.text } }],
    })
    const text = image ? `${output.text}\nThe image is attached in the next message.` : output.text
    // 改的是画布，不是项目文件：不算编辑
    return { result: textResult(call, text), edited: false, images: image ? [image] : [] }
  } catch (error) {
    if (signal.aborted) return fail('Cancelled by the user.')
    return fail(`Design tool failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
