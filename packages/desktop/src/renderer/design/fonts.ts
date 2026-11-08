import type { Editor } from '@open-pencil/core'
import { fontManager, prepareGraphFonts } from '@open-pencil/core/text'

const SETTLE_MS = 150

// 文字画出来之前要先备好字体：它点名的字体，加上这些字体缺字时的回退（中文回退到系统的微软雅黑等）。
// SDK 不替宿主做这一步，OpenPencil 自己的编辑器是在每次编辑后准备的；这里同样在改完之后准备，然后重排、重画
export async function prepareFonts(editor: Editor, nodeIds: readonly string[]): Promise<void> {
  const graph = editor.graph
  const ids = nodeIds.filter((id) => graph.getNode(id))
  if (ids.length === 0) return
  // 字体覆盖哪些字读不出来时按缺字处理、去加载回退（OpenPencil 桌面版同样这么设）
  const prepared = await prepareGraphFonts(graph, ids, {
    loadFont: (family, style, characters, signal) => fontManager.loadFont(family, style, characters, signal),
    treatUnknownCoverageAsMissing: true,
  })
  if (editor.graph !== graph) return
  if (prepared.changed) for (const id of ids) editor.runLayoutForNode(id)
  editor.renderer?.invalidateNodesForFonts(graph, ids)
  editor.requestRender()
}

export function preparePageFonts(editor: Editor): Promise<void> {
  return prepareFonts(
    editor,
    editor.graph.getChildren(editor.state.currentPageId).map((node) => node.id),
  )
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
