<script setup lang="ts">
import type { Tool } from '@open-pencil/core'
import { buildOpenPencilClipboardHTML } from '@open-pencil/core/clipboard'
import { useEditor } from '@open-pencil/vue'
import { useCanvasInput } from '@open-pencil/vue/canvas'
import { useCanvas } from '@open-pencil/vue/canvas/surface'
import { useTextEdit } from '@open-pencil/vue/canvas/text-edit'
import { type EditorCommandId, useEditorCommands } from '@open-pencil/vue/editor/commands'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { agentCursors } from './bridge'
import { lucideSvg } from './icons'
import Inspector from './Inspector.vue'
import LayersPanel from './LayersPanel.vue'

const editor = useEditor()
const { runCommand, commands } = useEditorCommands()
const failure = ref<string | null>(null)
// 两侧面板按设计页宽度自动显隐（画布至少留 480px 左右）；用户手动开关后以手动为准
const width = ref(window.innerWidth)
const onResize = () => (width.value = window.innerWidth)
const layersChoice = ref<boolean | null>(null)
const inspectorChoice = ref<boolean | null>(null)
const showInspector = computed(() => inspectorChoice.value ?? width.value >= 760)
const showLayers = computed(() => layersChoice.value ?? width.value >= 1000)

// 0.17 的 CanvasRoot 只负责画，指针输入（选择、拖动、按工具画图、平移缩放）和文字编辑要宿主自己接，和 OpenPencil 自己的编辑器一样
const canvasRef = ref<HTMLCanvasElement | null>(null)
const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } = useCanvas(canvasRef, editor, {
  showRulers: false,
  onFailed: (error) => (failure.value = error instanceof Error ? error.message : String(error)),
})
useCanvasInput(canvasRef, editor, hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle)
useTextEdit(canvasRef, editor)

const TOOLS: Array<{ tool: Tool; label: string; key: string; icon: string }> = [
  { tool: 'SELECT', label: '移动', key: 'V', icon: 'mouse-pointer-2' },
  { tool: 'FRAME', label: '画板', key: 'F', icon: 'frame' },
  { tool: 'RECTANGLE', label: '矩形', key: 'R', icon: 'square' },
  { tool: 'ELLIPSE', label: '椭圆', key: 'O', icon: 'circle' },
  { tool: 'LINE', label: '直线', key: 'L', icon: 'slash' },
  { tool: 'PEN', label: '钢笔', key: 'P', icon: 'pen-tool' },
  { tool: 'TEXT', label: '文字', key: 'T', icon: 'type' },
  { tool: 'HAND', label: '抓手', key: 'H', icon: 'hand' },
]
// 工具栏只放图标，名字和快捷键在悬停提示和读屏名称里
const ICON = Object.fromEntries(
  ['panel-left', 'panel-right', 'undo-2', 'redo-2', 'minus', 'plus', 'maximize', ...TOOLS.map((item) => item.icon)].map((name) => [name, lucideSvg(name)]),
)
const ICON_BUTTON = 'flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-soft aria-pressed:text-foreground'

// Ctrl（Mac 上是 Cmd）组合键 → 编辑器命令；带 Shift、Alt 的单独列
const MOD_COMMANDS: Record<string, EditorCommandId> = {
  z: 'edit.undo',
  'shift+z': 'edit.redo',
  y: 'edit.redo',
  a: 'selection.selectAll',
  d: 'selection.duplicate',
  g: 'selection.group',
  'shift+g': 'selection.ungroup',
  'alt+g': 'selection.frameSelection',
  'alt+k': 'selection.createComponent',
  ']': 'selection.bringForward',
  '[': 'selection.sendBackward',
  'shift+]': 'selection.bringToFront',
  'shift+[': 'selection.sendToBack',
  'shift+h': 'selection.toggleVisibility',
  'shift+l': 'selection.toggleLock',
}
const SHIFT_COMMANDS: Record<string, EditorCommandId> = {
  '0': 'view.zoom100',
  '1': 'view.zoomFit',
  '2': 'view.zoomSelection',
  a: 'selection.wrapInAutoLayout',
}
const NUDGE: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }

const zoomPercent = computed(() => `${Math.round(editor.state.zoom * 100)}%`)

// 智能体的虚拟光标：每个在干活的智能体一个，指着它最近改（或看）的图层并框出来；画布缩放、平移时跟着走，图层不在当前页时不画
function onCurrentPage(id: string): boolean {
  let current = editor.graph.getNode(id)?.parentId ?? null
  while (current) {
    if (current === editor.state.currentPageId) return true
    current = editor.graph.getNode(current)?.parentId ?? null
  }
  return false
}
const cursors = computed(() => {
  const { zoom, panX, panY } = editor.state
  // 子智能体在干活时主智能体在等它们，不画它的光标，免得和工人的叠在一起
  const entries = [...agentCursors.values()]
  const working = entries.some(({ agent }) => agent.id !== 'main')
  const placed: Array<{ x: number; y: number }> = []
  return entries.flatMap(({ agent, nodeId }) => {
    const node = editor.graph.getNode(nodeId)
    if ((working && agent.id === 'main') || !node || !onCurrentPage(nodeId)) return []
    const position = editor.graph.getAbsolutePosition(nodeId)
    const x = position.x * zoom + panX
    const y = position.y * zoom + panY
    // 几个光标落在同一个角上时往下错开，名字不叠在一起
    const stacked = placed.filter((point) => Math.abs(point.x - x) < 8 && Math.abs(point.y - y) < 8).length
    placed.push({ x, y })
    return [{ agent, x, y, width: node.width * zoom, height: node.height * zoom, offset: stacked * 20 }]
  })
})
const zoomBy = (factor: number) => editor.zoomToLevel(Math.min(256, Math.max(0.02, editor.state.zoom * factor)))

function typing(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return Boolean(element && (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'))
}

// SDK 的画布只接指针和文字输入，快捷键由宿主绑定。正在编辑文字或输入框里打字时不拦
function onKeydown(event: KeyboardEvent) {
  if (editor.state.editingTextId || typing(event.target)) return
  const key = event.code.startsWith('Digit') ? event.code.slice(5) : event.key.toLowerCase()
  const combo = `${event.shiftKey ? 'shift+' : ''}${event.altKey ? 'alt+' : ''}${key}`
  if (event.ctrlKey || event.metaKey) {
    if (key === '=' || key === '+') return zoomByKey(event, 1.25)
    if (key === '-') return zoomByKey(event, 0.8)
    const command = MOD_COMMANDS[combo]
    if (!command) return
    event.preventDefault()
    runCommand(command)
    return
  }
  if (event.shiftKey && SHIFT_COMMANDS[key]) {
    event.preventDefault()
    runCommand(SHIFT_COMMANDS[key]!)
    return
  }
  const nudge = NUDGE[key]
  if (nudge && editor.state.selectedIds.size > 0) {
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    editor.nudgeSelected(nudge[0] * step, nudge[1] * step)
    return
  }
  if (event.altKey || event.shiftKey) return
  if (key === 'delete' || key === 'backspace') {
    event.preventDefault()
    runCommand('selection.delete')
    return
  }
  if (key === 'escape') {
    menu.value = null
    editor.setTool('SELECT')
    return
  }
  const item = TOOLS.find((tool) => tool.key.toLowerCase() === key)
  if (item) editor.setTool(item.tool)
}

function zoomByKey(event: KeyboardEvent, factor: number) {
  event.preventDefault()
  zoomBy(factor)
}

// 复制粘贴走系统剪贴板的 copy / paste 事件（不用申请剪贴板权限）；内容是 OpenPencil 的剪贴板 HTML，也能粘贴 Figma 复制的内容
function onCopy(event: ClipboardEvent, cut = false) {
  if (editor.state.editingTextId || typing(event.target)) return
  const nodes = [...editor.state.selectedIds].map((id) => editor.graph.getNode(id)).filter((node) => node !== undefined && node !== null)
  if (nodes.length === 0 || !event.clipboardData) return
  event.preventDefault()
  event.clipboardData.setData('text/html', buildOpenPencilClipboardHTML(nodes, editor.graph))
  event.clipboardData.setData('text/plain', editor.copySelectionAsText(nodes.map((node) => node.id)))
  if (cut) runCommand('selection.delete')
}

function viewportCenter() {
  const canvas = canvasRef.value
  const width = canvas?.clientWidth ?? 0
  const height = canvas?.clientHeight ?? 0
  return { x: (-editor.state.panX + width / 2) / editor.state.zoom, y: (-editor.state.panY + height / 2) / editor.state.zoom }
}

function onPaste(event: ClipboardEvent) {
  if (editor.state.editingTextId || typing(event.target) || !event.clipboardData) return
  const html = event.clipboardData.getData('text/html')
  const text = event.clipboardData.getData('text/plain')
  event.preventDefault()
  const center = viewportCenter()
  const done = html ? editor.pasteFromHTML(html, center) : text ? editor.pasteText(text, center.x, center.y) : null
  done?.catch((error: unknown) => console.error('粘贴失败', error))
}

// 右键菜单
const menu = ref<{ x: number; y: number } | null>(null)
const MENU: Array<Array<{ id: EditorCommandId | 'copy'; label: string }>> = [
  [
    { id: 'copy', label: '复制' },
    { id: 'selection.duplicate', label: '再制' },
    { id: 'selection.delete', label: '删除' },
  ],
  [
    { id: 'selection.group', label: '编组' },
    { id: 'selection.ungroup', label: '取消编组' },
    { id: 'selection.frameSelection', label: '用画板包住' },
    { id: 'selection.wrapInAutoLayout', label: '添加自动布局' },
    { id: 'selection.createComponent', label: '创建组件' },
  ],
  [
    { id: 'selection.bringToFront', label: '置于顶层' },
    { id: 'selection.bringForward', label: '上移一层' },
    { id: 'selection.sendBackward', label: '下移一层' },
    { id: 'selection.sendToBack', label: '置于底层' },
  ],
  [
    { id: 'selection.booleanUnion', label: '合并形状' },
    { id: 'selection.booleanSubtract', label: '减去顶层' },
    { id: 'selection.booleanIntersect', label: '取交集' },
    { id: 'selection.booleanExclude', label: '排除重叠' },
    { id: 'selection.flatten', label: '拼合' },
  ],
  [
    { id: 'view.zoomSelection', label: '缩放到选区' },
    { id: 'view.zoomFit', label: '缩放到全部' },
  ],
]
const enabled = (id: EditorCommandId | 'copy') => (id === 'copy' ? editor.state.selectedIds.size > 0 : commands[id].enabled.value)

// 右键先选中指针下的图层（和 OpenPencil、Figma 一样），菜单放不下时往左上收，不超出页面
const menuEl = ref<HTMLElement | null>(null)
async function openMenu(event: MouseEvent) {
  event.preventDefault()
  const canvas = canvasRef.value
  if (canvas) {
    const rect = canvas.getBoundingClientRect()
    const point = editor.screenToCanvas(event.clientX - rect.left, event.clientY - rect.top)
    editor.selectAtPoint(point.x, point.y)
  }
  menu.value = { x: event.clientX, y: event.clientY }
  await nextTick()
  const box = menuEl.value?.getBoundingClientRect()
  if (!box || !menu.value) return
  menu.value = { x: Math.max(4, Math.min(menu.value.x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(menu.value.y, window.innerHeight - box.height - 4)) }
}

function runMenu(id: EditorCommandId | 'copy') {
  menu.value = null
  if (id === 'copy') document.execCommand('copy')
  else runCommand(id)
}

const onCut = (event: ClipboardEvent) => onCopy(event, true)
const closeMenu = (event: PointerEvent) => {
  if (!(event.target as HTMLElement | null)?.closest('[data-design-menu]')) menu.value = null
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCut)
  document.addEventListener('paste', onPaste)
  window.addEventListener('pointerdown', closeMenu)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('copy', onCopy)
  document.removeEventListener('cut', onCut)
  document.removeEventListener('paste', onPaste)
  window.removeEventListener('pointerdown', closeMenu)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div class="flex size-full flex-col bg-background text-foreground">
    <header class="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 text-xs whitespace-nowrap [&>*]:shrink-0" data-testid="design-toolbar">
      <button type="button" :class="ICON_BUTTON" :aria-pressed="showLayers" aria-label="图层面板" title="图层面板" @click="layersChoice = !showLayers" v-html="ICON['panel-left']" />
      <span aria-hidden class="mx-1 h-4 w-px bg-border" />
      <button
        v-for="item in TOOLS"
        :key="item.tool"
        type="button"
        :class="ICON_BUTTON"
        :aria-label="item.label"
        :title="`${item.label}（${item.key}）`"
        :aria-pressed="editor.state.activeTool === item.tool"
        @click="editor.setTool(item.tool)"
        v-html="ICON[item.icon]"
      />
      <span aria-hidden class="mx-1 h-4 w-px bg-border" />
      <button type="button" :class="ICON_BUTTON" aria-label="撤销" title="撤销（Ctrl+Z）" :disabled="!commands['edit.undo'].enabled.value" @click="runCommand('edit.undo')" v-html="ICON['undo-2']" />
      <button type="button" :class="ICON_BUTTON" aria-label="重做" title="重做（Ctrl+Shift+Z）" :disabled="!commands['edit.redo'].enabled.value" @click="runCommand('edit.redo')" v-html="ICON['redo-2']" />
      <div class="flex-1 !shrink" />
      <button type="button" :class="ICON_BUTTON" aria-label="缩小" title="缩小（Ctrl+-）" @click="zoomBy(0.8)" v-html="ICON.minus" />
      <button type="button" class="h-7 w-12 rounded-md text-center text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground" title="缩放到 100%（Shift+0）" data-testid="design-zoom" @click="runCommand('view.zoom100')">{{ zoomPercent }}</button>
      <button type="button" :class="ICON_BUTTON" aria-label="放大" title="放大（Ctrl+=）" @click="zoomBy(1.25)" v-html="ICON.plus" />
      <button type="button" :class="ICON_BUTTON" aria-label="适应" title="缩放到全部（Shift+1）" @click="runCommand('view.zoomFit')" v-html="ICON.maximize" />
      <span aria-hidden class="mx-1 h-4 w-px bg-border" />
      <button type="button" :class="ICON_BUTTON" :aria-pressed="showInspector" aria-label="属性面板" title="属性面板" @click="inspectorChoice = !showInspector" v-html="ICON['panel-right']" />
    </header>
    <div class="flex min-h-0 flex-1">
      <LayersPanel v-if="showLayers" />
      <div class="relative min-w-0 flex-1" @contextmenu="openMenu">
        <canvas ref="canvasRef" class="absolute inset-0 size-full" />
        <div class="pointer-events-none absolute inset-0 overflow-hidden" data-testid="design-agent-cursors">
          <template v-for="cursor in cursors" :key="cursor.agent.id">
            <div
              class="absolute rounded-[3px] border-[1.5px] transition-[left,top,width,height] duration-300 ease-out"
              :style="{ left: `${cursor.x}px`, top: `${cursor.y}px`, width: `${cursor.width}px`, height: `${cursor.height}px`, borderColor: cursor.agent.color }"
            />
            <div
              class="absolute flex items-start transition-[left,top] duration-300 ease-out"
              :style="{ left: `${cursor.x - 2}px`, top: `${cursor.y - 2 + cursor.offset}px` }"
              data-testid="design-agent-cursor"
              :data-agent="cursor.agent.name"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M2 2 L15.5 8 L9.2 9.6 L6.8 15.8 Z" :fill="cursor.agent.color" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round" />
              </svg>
              <span class="mt-3 -ml-1 rounded-full px-1.5 text-[11px] leading-[18px] font-medium whitespace-nowrap text-white shadow-sm" :style="{ backgroundColor: cursor.agent.color }">{{ cursor.agent.name }}</span>
            </div>
          </template>
        </div>
        <div v-if="failure" class="absolute inset-0 flex items-center justify-center p-6 text-sm text-destructive" role="alert">画布启动失败：{{ failure }}</div>
      </div>
      <Inspector v-if="showInspector" />
    </div>
    <div
      v-if="menu"
      ref="menuEl"
      data-design-menu
      role="menu"
      class="fixed z-50 min-w-36 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-overlay"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
    >
      <template v-for="(group, index) in MENU" :key="index">
        <div v-if="index > 0" class="my-1 h-px bg-border" />
        <button
          v-for="item in group"
          :key="item.id"
          type="button"
          role="menuitem"
          class="flex w-full rounded px-2 py-1 text-left hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
          :disabled="!enabled(item.id)"
          @click="runMenu(item.id)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>
