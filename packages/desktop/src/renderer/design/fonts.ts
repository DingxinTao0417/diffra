import type { Editor } from '@open-pencil/core'
import { sizeAutoResizingText } from '@open-pencil/core/layout'
import { fontManager, prepareGraphFonts } from '@open-pencil/core/text'

const SETTLE_MS = 150

let localFontAccess: Promise<unknown> | null = null
// 页面不可见时（面板关着、被弹窗盖着、任务在后台）Chromium 当场拒绝读系统字体，列表和单个字体文件都一样（Page needs to be visible.），
// 这期间准备的文字缺回退、按方框量。不改文字就不会再准备，所以记下来，回到可见时整页再准备；一直可见时不多准备，免得开关弹窗也整页重排
let preparedWhileHidden = false

// 中文等内置字体没有的字回退到系统字体，要等 queryLocalFonts 返回才读得到。机器忙时它要好几秒，页面不可见时还会被拒；
// 引擎把这期间的「没找到回退」当成定论、之后不再自己重试，所以准备字体前先等它，没拿到就再要一次。
// 不加等待上限：浏览器总会给结果或报错，加超时会又回到「先准备、后到列表」
export function requestLocalFonts(): Promise<unknown> {
  const state = fontManager.localAccessState()
  if (state === 'granted' || state === 'unsupported') return Promise.resolve()
  localFontAccess ??= fontManager.requestLocalFontAccess().finally(() => {
    localFontAccess = null
    if (fontManager.localAccessState() !== 'granted') console.warn('读取系统字体失败，中文等内置字体没有的字会显示成方框，下次准备字体时再试')
  })
  return localFontAccess
}

// 文字画出来之前要先备好字体：它点名的字体，加上这些字体缺字时的回退（中文回退到系统的微软雅黑等）。
// SDK 不替宿主做这一步，OpenPencil 自己的编辑器是在每次编辑后准备的；这里同样在改完之后准备，然后重排、重画
export async function prepareFonts(editor: Editor, nodeIds: readonly string[]): Promise<void> {
  if (document.hidden) preparedWhileHidden = true
  await requestLocalFonts()
  const graph = editor.graph
  const ids = nodeIds.filter((id) => graph.getNode(id))
  if (ids.length === 0) return
  // 字体覆盖哪些字读不出来时按缺字处理、去加载回退（OpenPencil 桌面版同样这么设）
  const prepared = await prepareGraphFonts(graph, ids, {
    loadFont: (family, style, characters, signal) => fontManager.loadFont(family, style, characters, signal),
    treatUnknownCoverageAsMissing: true,
  })
  if (document.hidden) preparedWhileHidden = true
  if (editor.graph !== graph) return
  if (prepared.changed) {
    for (const id of ids) {
      // 重排只量自动布局里的文字，自己定尺寸的文字要先按新字体量一遍（OpenPencil 等到字体后也是先量再重排）。
      // 正在编辑的由编辑器自己量，提交后会再准备一次；文件里存了字形的保持文件里的尺寸
      const node = graph.getNode(id)
      if (node?.type === 'TEXT' && id !== editor.state.editingTextId && !node.derivedTextGlyphs?.length) sizeAutoResizingText(graph, id)
      editor.runLayoutForNode(id)
    }
  }
  editor.renderer?.invalidateNodesForFonts(graph, ids)
  editor.requestRender()
}

export function preparePageFonts(editor: Editor): Promise<void> {
  return prepareFonts(
    editor,
    editor.graph.getChildren(editor.state.currentPageId).map((node) => node.id),
  )
}

export function prepareFontsWhenVisible(editor: Editor): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !preparedWhileHidden) return
    preparedWhileHidden = false
    preparePageFonts(editor).catch((error: unknown) => console.error('准备字体失败', error))
  })
}

// 用户新建或改了文字层（包括正在输入）时，攒一小会儿再准备字体
export function watchTextFonts(editor: Editor): void {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (id: string) => {
    pending.add(id)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const ids = [...pending]
      pending.clear()
      prepareFonts(editor, ids).catch((error: unknown) => console.error('准备字体失败', error))
    }, SETTLE_MS)
  }
  editor.onEditorEvent('node:created', (node) => {
    if (node.type === 'TEXT') schedule(node.id)
  })
  const FONT_FIELDS = ['text', 'fontFamily', 'fontWeight', 'fontStyle', 'italic', 'styleRuns']
  editor.onEditorEvent('node:updated', (id, changes) => {
    if (FONT_FIELDS.some((field) => field in changes)) schedule(id)
  })
}
