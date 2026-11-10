import { EDIT_DIFF_META_KEY, type EditDiffMeta, type ToolCallContent } from '@diffra/core/types'

type DiffContent = Extract<ToolCallContent, { type: 'diff' }>

// 改动卡片只带变化的那段时的说明（见 core 的 EditDiffMeta）；旧记录没有，oldText、newText 是整份文件
export function editMeta(content: DiffContent): EditDiffMeta | null {
  const diffra = content._meta?.diffra
  if (typeof diffra !== 'object' || diffra === null) return null
  const meta = (diffra as Record<string, unknown>)[EDIT_DIFF_META_KEY]
  return typeof meta === 'object' && meta !== null ? (meta as EditDiffMeta) : null
}

export interface EditTexts {
  before: string | null
  after: string
}

export const editKey = (itemId: string, path: string) => `${itemId}\n${path}`

// 只用到对话条目的这几个字段（TranscriptItem 都满足）
type EditItem = { kind: string; id: string; status?: string; content?: ToolCallContent[] }

// 按顺序重放一轮里做完的改动，还原每次改动前后这个文件的全文（key 见 editKey）。
// 第一次改一个文件时卡片带整份 base，之后只带变化的那段，套到上一次的结果上
export function replayEdits(items: readonly EditItem[]): Map<string, EditTexts> {
  const current = new Map<string, string>()
  const result = new Map<string, EditTexts>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'completed' || !item.content) continue
    for (const content of item.content) {
      if (content.type !== 'diff') continue
      const meta = editMeta(content)
      let texts: EditTexts
      if (!meta) texts = { before: content.oldText ?? null, after: content.newText }
      else {
        const before = content.oldText == null ? null : (meta.base ?? current.get(content.path))
        if (before === undefined) {
          // 还原不了（不该出现）：这次和之后同一个文件的改动都不算进统计
          current.delete(content.path)
          continue
        }
        const lines = before === null ? [] : before.split('\n')
        const inserted = meta.newLines === 0 ? [] : content.newText.split('\n')
        const after = [...lines.slice(0, meta.startLine - 1), ...inserted, ...lines.slice(meta.startLine - 1 + meta.oldLines)].join('\n')
        texts = { before, after }
      }
      current.set(content.path, texts.after)
      result.set(editKey(item.id, content.path), texts)
    }
  }
  return result
}
