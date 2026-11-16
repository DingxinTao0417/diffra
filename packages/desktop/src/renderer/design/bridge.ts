import { type Editor, executeAtomicTool } from '@open-pencil/core'
import { FigmaAPI } from '@open-pencil/core/figma-api'
import { JSX_REFERENCE } from '@open-pencil/design-jsx'
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig'
import { createCanvasKitRasterCodec, renderNodesToImage, renderThumbnail } from '@open-pencil/core/io/formats/raster'
import { fontManager } from '@open-pencil/core/text'
import { ALL_TOOLS, CORE_TOOLS, isAtomicTool, parseToolArgs, type ToolDef, toolFailure, toolsToAI } from '@open-pencil/core/tools'
import { reactive } from 'vue'
import { preparePageFonts, requestLocalFonts } from './fonts'
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
  // agent：调用的子智能体（加节点锁、画光标）；主智能体自己调时为 null
  run(name: string, args: unknown, agent?: AgentTag | null): Promise<DesignToolResult>
  openFig(base64: string): Promise<void>
  saveFig(): Promise<string>
  // 设计首页的缩略图（v2）：当前页的 PNG（base64）；画布还没启动或页面是空的返回 null
  thumbnail(): Promise<string | null>
}

const THUMB_WIDTH = 480
const THUMB_HEIGHT = 300

const MAX_RESULT_CHARS = 50_000

// 智能体：core 的 AgentTag。主智能体自己调用时没有，光标按 MAIN_AGENT 画
export interface AgentTag {
  id: string
  name: string
  color: string
}
const MAIN_AGENT: AgentTag = { id: 'main', name: '主智能体', color: '#57534E' }
const NODE_ID = /^-?\d+:\d+$/

// 画布上每个智能体的光标：指着它正在改（或看）的图层，名字后面写在干什么；两次调用之间在等模型，action 为 null。
// 设计页的覆盖层按它画光标和图层框；智能体结束时先显示「完成」再收起
export interface AgentCursor {
  agent: AgentTag
  nodeId: string
  action: string | null
  done: boolean
  // 最后一次换图层的时刻：改动前按它等光标走到位
  movedAt: number
}
export const agentCursors = reactive(new Map<string, AgentCursor>())
// 子智能体认领的区块，画成同色虚线框；工人结束时去掉
export const agentClaims = reactive(new Map<string, { agent: AgentTag; nodes: string[] }>())
// 刚改过、新建的图层闪一下；闪完删掉
export const agentFlashes = reactive(new Map<number, { color: string; nodeIds: string[] }>())
// 子智能体锁住的节点：节点 id → 子智能体。改到别人锁住的节点、它的下层，或者包含它的上层，都会被拒
const locks = new Map<string, AgentTag>()

// 和设计页光标的移动过渡一样长
export const CURSOR_MOVE_MS = 180
const DONE_SHOWN_MS = 1000
const FLASH_MS = 600
const MAX_FLASHED = 20
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function pointAt(agent: AgentTag, nodeId: string, action: string | null): void {
  const current = agentCursors.get(agent.id)
  const movedAt = current?.nodeId === nodeId ? current.movedAt : performance.now()
  agentCursors.set(agent.id, { agent, nodeId, action, done: false, movedAt })
}

function setAction(agent: AgentTag, action: string | null): void {
  const current = agentCursors.get(agent.id)
  if (current) agentCursors.set(agent.id, { ...current, action, done: false })
}

// 改动前等光标走到位。调用一到设计页光标就开始挪，排队的时间里多半已经到了，只等剩下的；面板看不见或减少动态效果时不等
async function arrive(agent: AgentTag): Promise<void> {
  const cursor = agentCursors.get(agent.id)
  if (!cursor || document.hidden || reducedMotion()) return
  const left = cursor.movedAt + CURSOR_MOVE_MS - performance.now()
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
}

let flashKey = 0
function flash(agent: AgentTag, nodeIds: string[]): void {
  if (nodeIds.length === 0 || reducedMotion()) return
  const key = flashKey++
  agentFlashes.set(key, { color: agent.color, nodeIds: nodeIds.slice(0, MAX_FLASHED) })
  setTimeout(() => agentFlashes.delete(key), FLASH_MS)
}

// 光标名字后面的动作
function actionLabel(name: string, mutates: boolean): string {
  if (name === 'render') return '绘制'
  if (name === 'set_image_fill') return '放图片'
  if (name === 'export_image') return '截图'
  if (name === 'eval') return '运行脚本'
  if (name === 'lint_fix') return '修正'
  if (name.startsWith('lint') || name.startsWith('analyze_')) return '检查'
  if (!mutates) return '查看'
  if (name.includes('text')) return '改文字'
  if (name.startsWith('delete') || name.startsWith('remove')) return '删除'
  if (name.startsWith('create')) return '新建'
  return '修改'
}

function isAgentTag(value: unknown): value is AgentTag {
  if (typeof value !== 'object' || value === null) return false
  const { id, name, color } = value as Record<string, unknown>
  return typeof id === 'string' && typeof name === 'string' && typeof color === 'string'
}

// 参数里出现的节点 id：字段名各工具不一样（id、ids、parent_id、replace_id、批量操作里的 id……），按值认；JSON 字符串里的也算
function nodeIdsIn(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8) return found
  if (typeof value === 'string') {
    const parts = value.split(/[\s,]+/).filter(Boolean)
    if (parts.length > 0 && parts.every((part) => NODE_ID.test(part))) for (const part of parts) found.add(part)
    else if (/^\s*[[{]/.test(value)) {
      try {
        nodeIdsIn(JSON.parse(value), found, depth + 1)
      } catch {
        // 不是 JSON 就不是节点 id
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) nodeIdsIn(item, found, depth + 1)
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) nodeIdsIn(item, found, depth + 1)
  }
  return found
}

function ancestorsOf(editor: Editor, id: string): string[] {
  const chain: string[] = []
  let current = editor.graph.getNode(id)?.parentId ?? null
  while (current && !chain.includes(current)) {
    chain.push(current)
    current = editor.graph.getNode(current)?.parentId ?? null
  }
  return chain
}

// 节点本身或上层被别的子智能体锁住，或者它包含别人锁住的节点：返回那个子智能体
function lockOwner(editor: Editor, agent: AgentTag, id: string): AgentTag | null {
  for (const node of [id, ...ancestorsOf(editor, id)]) {
    const owner = locks.get(node)
    if (owner && owner.id !== agent.id) return owner
  }
  for (const [locked, owner] of locks) {
    if (owner.id !== agent.id && ancestorsOf(editor, locked).includes(id)) return owner
  }
  return null
}

function claimNodes(editor: Editor, agent: AgentTag, nodes: string[]): { refused: string[] } {
  const refused: string[] = []
  for (const id of nodes) {
    if (!editor.graph.getNode(id)) {
      refused.push(`node ${id} does not exist`)
      continue
    }
    const owner = lockOwner(editor, agent, id)
    if (owner) refused.push(`node ${id} overlaps nodes owned by worker "${owner.name}"`)
  }
  if (refused.length > 0) return { refused }
  for (const id of nodes) locks.set(id, agent)
  agentClaims.set(agent.id, { agent, nodes })
  if (nodes[0]) pointAt(agent, nodes[0], null)
  return { refused }
}

function endAgent(agent: AgentTag | null): void {
  const id = agent?.id ?? MAIN_AGENT.id
  agentClaims.delete(id)
  for (const [node, owner] of locks) if (owner.id === id) locks.delete(node)
  const cursor = agentCursors.get(id)
  if (!cursor) return
  // 先显示「完成」一会儿再收起；这期间又开始干活（又认领、又调用）就不收
  agentCursors.set(id, { ...cursor, action: null, done: true })
  setTimeout(() => {
    if (agentCursors.get(id)?.done) agentCursors.delete(id)
  }, DONE_SHOWN_MS)
}

// 这次调用新建的节点里最上层的那些（父节点不是新建的）
function createdRoots(editor: Editor, before: Set<string>): string[] {
  const created = [...editor.graph.nodes.keys()].filter((id) => !before.has(id))
  const fresh = new Set(created)
  return created.filter((id) => !fresh.has(editor.graph.getNode(id)?.parentId ?? ''))
}

// 同一时间只执行一个调用：几个子智能体并行时，调用在这里排队，不会互相打断（比如 render 等字体时）
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)
  return run
}

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
// 页面、编组、组件、布尔运算、效果和图标，设计变量（颜色、字号、间距规范），以及检查和分析（lint、analyze_*）。
// 外部网络在主进程拦掉了，要联网（图库、网页搜索）或读写设置的工具不给；图标工具例外，它们走内置的 Lucide 图标数据（见 icons.ts）
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
  'list_available_fonts',
  'list_collections',
  'get_collection',
  'create_collection',
  'delete_collection',
  'list_variables',
  'find_variables',
  'get_variable',
  'create_variable',
  'set_variable',
  'delete_variable',
  'bind_variable',
  'unbind_variable',
  'lint',
  'lint_fix',
  'analyze_colors',
  'analyze_typography',
  'analyze_spacing',
  'analyze_overlaps',
])
const OFFLINE_ICON_TOOLS = new Set(['search_icons', 'insert_icon'])
const BLOCKED_CAPABILITIES = new Set(['network:access', 'filesystem:read', 'filesystem:write', 'settings:read', 'settings:write'])
const TOOLS: ToolDef[] = [...CORE_TOOLS, ...ALL_TOOLS.filter((def) => EXTRA_TOOLS.has(def.name) && !CORE_TOOLS.includes(def))].filter(
  (def) => OFFLINE_ICON_TOOLS.has(def.name) || !def.capabilities.some((capability) => BLOCKED_CAPABILITIES.has(capability)),
)
// 不给模型、只给 core 调的工具：放图片由 core 下载或读文件后调 set_image_fill，图片数据不经过模型
const INTERNAL_TOOLS: ToolDef[] = ALL_TOOLS.filter((def) => def.name === 'set_image_fill')

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
  // 引擎默认一个字体都不列，要宿主自己补：内置的 Inter 加系统字体（在线字体源没接）。
  // 系统字体被拒时（面板不可见）报错，免得模型以为只有 Inter 能用
  figma.listAvailableFontsAsync = async () => {
    await requestLocalFonts()
    if (fontManager.localAccessState() === 'denied') throw new Error('读不到系统字体（设计面板不可见时浏览器会拒绝），面板显示出来后再列')
    const families = await fontManager.listFamilyOptions()
    return families.flatMap(({ family }) => (fontManager.familyFacesSync(family) ?? [{ style: 'Regular' }]).map(({ style }) => ({ fontName: { family, style } })))
  }
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
  const byName = new Map([...TOOLS, ...INTERNAL_TOOLS].map((def) => [def.name, def]))
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
    run: (name, rawArgs, rawAgent) => {
      const worker = isAgentTag(rawAgent) ? rawAgent : null
      const agent = worker ?? MAIN_AGENT
      const def = byName.get(name)
      // 一到设计页就把光标挪向这次要动的图层：排队等前面的调用时光标已经在路上。别人锁住的图层不去，这次调用会被拒
      if (def) {
        const early = [...nodeIdsIn(rawArgs)].find((id) => editor.graph.getNode(id))
        if (early && !(worker && def.mutates && lockOwner(editor, worker, early))) pointAt(agent, early, actionLabel(name, def.mutates))
      }
      return enqueue(async () => {
        if (name === '__agent_claim') {
          const nodes = (rawArgs as { nodes?: unknown } | null)?.nodes
          if (!worker || !Array.isArray(nodes)) return toResult({ refused: ['invalid claim'] })
          return toResult(claimNodes(editor, worker, nodes.map(String)))
        }
        if (name === '__agent_done') {
          endAgent(worker)
          return toResult({})
        }
        if (!def) return { text: JSON.stringify({ error: `没有这个设计工具：${name}` }), image: null }
        if (worker && name === 'eval') return toResult({ error: 'Workers cannot use eval: it can change nodes other workers own.' })
        try {
          const args = parseToolArgs(name, def.input, rawArgs) as Record<string, unknown>
          const targets = [...nodeIdsIn(args)].filter((id) => editor.graph.getNode(id))
          // 子智能体改文档：不能碰别人锁住的节点
          if (worker && def.mutates) {
            for (const id of targets) {
              const owner = lockOwner(editor, worker, id)
              if (owner) return toResult({ error: `Node ${id} belongs to worker "${owner.name}". Work inside your own nodes; mention what you need in your report.` })
            }
          }
          // 光标先到要改的图层（新建的内容先指父节点），走到位再改：画面上先看到光标，再看到变化
          const action = actionLabel(name, def.mutates)
          if (targets[0]) pointAt(agent, targets[0], action)
          else setAction(agent, action)
          if (def.mutates) await arrive(agent)
          const before = def.mutates ? new Set(editor.graph.nodes.keys()) : null
          const output = await runTool(editor, def, args)
          // 改过文档就先备好字体再返回：排版尺寸和之后的截图才是按真实字体算的
          if (def.mutates) await preparePageFonts(editor)
          editor.requestRender()
          const created = before ? createdRoots(editor, before) : []
          // 子智能体改过、新建的节点归它，别的子智能体不能再改
          if (worker && def.mutates) for (const id of [...targets, ...created]) locks.set(id, worker)
          if (created[0]) pointAt(agent, created[0], action)
          if (def.mutates) flash(agent, created.length > 0 ? created : targets)
          return toResult(output)
        } catch (error) {
          return toResult(toolFailure(error))
        } finally {
          // 这次调用做完了，在等模型的下一步
          setAction(agent, null)
        }
      })
    },
    openFig: async (base64) => {
      const graph = await parseFigFile(fromBase64(base64).buffer)
      editor.replaceGraph(graph)
      await preparePageFonts(editor)
    },
    saveFig: async () => toBase64(await exportFigFile(editor.graph)),
    thumbnail: async () => {
      const renderer = editor.renderer
      if (!renderer) return null
      const png = renderThumbnail(renderer.ck, renderer, editor.graph, editor.state.currentPageId, THUMB_WIDTH, THUMB_HEIGHT, 'letterbox')
      return png ? toBase64(png) : null
    },
  }
}
