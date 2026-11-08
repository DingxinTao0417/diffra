import { type Editor, executeAtomicTool } from '@open-pencil/core'
import { FigmaAPI } from '@open-pencil/core/figma-api'
import { JSX_REFERENCE } from '@open-pencil/design-jsx'
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig'
import { createCanvasKitRasterCodec, renderNodesToImage } from '@open-pencil/core/io/formats/raster'
import { ALL_TOOLS, CORE_TOOLS, isAtomicTool, parseToolArgs, type ToolDef, toolFailure, toolsToAI } from '@open-pencil/core/tools'
import { preparePageFonts } from './fonts'
import { ICON_SET_HINT } from './icons'

// 设计页对主进程的接口。主进程用 executeJavaScript 调 window.__diffraDesign，参数和返回值都是可以 JSON 化的数据
export interface DesignToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

export interface DesignToolResult {
  text: string
  image: { mimeType: string; data: string } | null
}

export interface DesignBridge {
  ready(): boolean
  // 配置给 core 会话的设计工具和说明（core 的 SessionDesign）
  session(): { tools: DesignToolSpec[]; instructions: string }
  run(name: string, args: unknown): Promise<DesignToolResult>
  openFig(base64: string): Promise<void>
  saveFig(): Promise<string>
}

const MAX_RESULT_CHARS = 50_000

// 接在 core 的设计说明后面：怎么在这个编辑器里干活，加上 render 用的设计 JSX 参考（OpenPencil 从渲染器元数据生成）
const INSTRUCTIONS = [
  '- Inspect the page and the selection (get_selection, find_nodes, get_node) before editing. Keep unrelated content and use the node IDs tools return.',
  '- Build with render and the design JSX below. Prefer auto-layout (flex, gap, padding, hug/fill sizes) to hand-placed coordinates. Replace a node with replace_id instead of deleting it first.',
  '- Place a new top-level frame beside existing ones, not on top of them, then call viewport_zoom_to_fit so the user sees it.',
  '- Use describe on a subtree to diagnose layout; edit existing nodes in place with the property tools and re-render only when the structure must change.',
  `- ${ICON_SET_HINT}`,
  '',
  'Design JSX reference:',
  JSX_REFERENCE,
].join('\n')

// 上游 AI 对话默认的核心工具，加上常用的扩展工具：export_image（能看图的模型靠它看自己画出来的样子，core 只给能看图的模型）、
// 页面、编组、组件、布尔运算、效果和图标。外部网络在主进程拦掉了，要联网（图库、网页搜索）或读写设置的工具不给；
// 图标工具例外，它们走内置的 Lucide 图标数据（见 icons.ts）
const EXTRA_TOOLS = new Set([
  'export_image',
  'export_svg',
  'get_page_tree',
  'list_pages',
  'create_page',
  'switch_page',
  'select_nodes',
  'clone_node',
  'rename_node',
  'group_nodes',
  'ungroup_node',
  'set_opacity',
  'set_effects',
  'create_component',
  'create_instance',
  'boolean_union',
  'boolean_subtract',
  'boolean_intersect',
  'search_icons',
  'insert_icon',
])
const OFFLINE_ICON_TOOLS = new Set(['search_icons', 'insert_icon'])
const BLOCKED_CAPABILITIES = new Set(['network:access', 'filesystem:read', 'filesystem:write', 'settings:read', 'settings:write'])
const TOOLS: ToolDef[] = [...CORE_TOOLS, ...ALL_TOOLS.filter((def) => EXTRA_TOOLS.has(def.name) && !CORE_TOOLS.includes(def))].filter(
  (def) => OFFLINE_ICON_TOOLS.has(def.name) || !def.capabilities.some((capability) => BLOCKED_CAPABILITIES.has(capability)),
)

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function isImageOutput(value: unknown): value is { base64: string; mimeType: string } & Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { base64?: unknown }).base64 === 'string' && typeof (value as { mimeType?: unknown }).mimeType === 'string'
}

function toResult(output: unknown): DesignToolResult {
  if (isImageOutput(output)) {
    const { base64, mimeType, ...metadata } = output
    return { text: JSON.stringify(metadata), image: { mimeType, data: base64 } }
  }
  const text = JSON.stringify(output) ?? 'null'
  return { text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…（结果太长，后面省略了）` : text, image: null }
}

// 和 OpenPencil 自己的 AI 对话一样，每次调用按当前文档、页面和选区新建一个 Figma Plugin API 对象
function makeFigma(editor: Editor): FigmaAPI {
  const figma = new FigmaAPI(editor.graph)
  figma.setRenderer(editor.renderer)
  figma.icons = editor.iconProvider
  figma.theme = editor.state.theme ?? 'light'
  figma.currentPage = figma.wrapNode(editor.state.currentPageId)
  figma.currentPage.selection = [...editor.state.selectedIds].map((id) => figma.getNodeById(id)).filter((node) => node !== null)
  const canvas = document.querySelector('canvas')
  const width = canvas?.clientWidth || window.innerWidth
  const height = canvas?.clientHeight || window.innerHeight
  figma.viewport = { center: { x: (-editor.state.panX + width / 2) / editor.state.zoom, y: (-editor.state.panY + height / 2) / editor.state.zoom }, zoom: editor.state.zoom }
  figma.exportImage = async (nodeIds, options) => {
    const renderer = editor.renderer
    if (!renderer) throw new Error('画布还没启动，导出不了图片')
    return renderNodesToImage(renderer.ck, renderer, editor.graph, options.pageId ?? editor.state.currentPageId, nodeIds, {
      scale: options.scale ?? 1,
      format: options.format ?? 'PNG',
      useAbsoluteBounds: options.useAbsoluteBounds,
    })
  }
  if (editor.renderer) figma.rasterCodec = createCanvasKitRasterCodec(editor.renderer.ck)
  return figma
}

// 工具改的当前页、选区和视口只写在这次的 Figma API 对象上，执行完同步回编辑器，用户才看得到
async function applyView(editor: Editor, figma: FigmaAPI, def: ToolDef, output: unknown, before: { selection: string; viewport: string }) {
  if (figma.currentPageId !== editor.state.currentPageId) await editor.switchPage(figma.currentPageId)
  const selection = figma.currentPage.selection.map((node) => node.id)
  if (selection.join(',') !== before.selection) editor.select(selection)
  const bounds = (output as { bounds?: { x: number; y: number; width: number; height: number } } | null)?.bounds
  if (def.name === 'viewport_zoom_to_fit' && bounds) editor.zoomToBounds(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height)
  else if (JSON.stringify(figma.viewport) !== before.viewport) editor.centerOn(figma.viewport.center.x, figma.viewport.center.y, figma.viewport.zoom)
}

// 改文档的工具记成一步撤销（标签「Diffra: 工具名」），用户 Ctrl+Z 能撤回智能体的修改
async function runTool(editor: Editor, def: ToolDef, args: Record<string, unknown>): Promise<unknown> {
  const figma = makeFigma(editor)
  const before = { selection: figma.currentPage.selection.map((node) => node.id).join(','), viewport: JSON.stringify(figma.viewport) }
  const output = await executeTool(editor, figma, def, args)
  await applyView(editor, figma, def, output, before)
  return output
}

async function executeTool(editor: Editor, figma: FigmaAPI, def: ToolDef, args: Record<string, unknown>): Promise<unknown> {
  if (!def.mutates) return def.execute(figma, args)
  try {
    await def.loadFonts(figma, args)
  } catch (error) {
    return toolFailure(error)
  }
  if (isAtomicTool(def)) return executeAtomicTool(editor, figma, def, args, { label: 'Diffra' })
  const pageId = figma.currentPageId
  return editor.recordEditAsync({ label: `Diffra: ${def.name}`, pageId }, () => editor.runMutationWithLayout(() => def.execute(figma, args), pageId))
}

export function installBridge(editor: Editor): void {
  const byName = new Map(TOOLS.map((def) => [def.name, def]))
  window.__diffraDesign = {
    ready: () => editor.renderer !== null,
    session: () => {
      // 借 OpenPencil 的 AI SDK 适配器拿到每个工具的 Standard JSON Schema，再转成普通 JSON Schema 交给 core
      const specs = toolsToAI(TOOLS, { getFigma: () => makeFigma(editor) }, { tool: ((options: unknown) => options) as never }) as Record<
        string,
        { description: string; inputSchema: { '~standard': { jsonSchema: { input(options: { target: string }): Record<string, unknown> } } } }
      >
      const tools = Object.entries(specs).map(([name, spec]) => ({
        name,
        description: spec.description,
        inputSchema: spec.inputSchema['~standard'].jsonSchema.input({ target: 'draft-07' }),
        readOnly: !byName.get(name)?.mutates,
      }))
      return { tools, instructions: INSTRUCTIONS }
    },
    run: async (name, rawArgs) => {
      const def = byName.get(name)
      if (!def) return { text: JSON.stringify({ error: `没有这个设计工具：${name}` }), image: null }
      try {
        const args = parseToolArgs(name, def.input, rawArgs) as Record<string, unknown>
        const output = await runTool(editor, def, args)
        // 改过文档就先备好字体再返回：排版尺寸和之后的截图才是按真实字体算的
        if (def.mutates) await preparePageFonts(editor)
        editor.requestRender()
        return toResult(output)
      } catch (error) {
        return toResult(toolFailure(error))
      }
    },
    openFig: async (base64) => {
      const graph = await parseFigFile(fromBase64(base64).buffer)
      editor.replaceGraph(graph)
      await preparePageFonts(editor)
    },
    saveFig: async () => toBase64(await exportFigFile(editor.graph)),
  }
}
