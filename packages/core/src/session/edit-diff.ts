import { EDIT_DIFF_META_KEY, type EditDiffMeta, type SessionUpdate, type StoredTurn, type ToolCallContent } from '../protocol.js'

// 改动卡片只带变化的那段，说明见 protocol.ts 的 EditDiffMeta
const CONTEXT_LINES = 3

type Diff = { path: string; oldText: string | null; newText: string }
type DiffContent = Extract<ToolCallContent, { type: 'diff' }>

// known：这一轮里每个文件最近一次改完后的全文（只在内存里）；和这次改之前的全文对不上时这次带上整份 base
export function compactEdit(known: Map<string, string>, diff: Diff): DiffContent {
  const needsBase = diff.oldText !== null && known.get(diff.path) !== diff.oldText
  known.set(diff.path, diff.newText)
  const before = diff.oldText === null ? [] : diff.oldText.split('\n')
  const after = diff.newText.split('\n')
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const from = Math.max(0, head - CONTEXT_LINES)
  const keepTail = Math.max(0, tail - CONTEXT_LINES)
  const oldPart = before.slice(from, before.length - keepTail)
  const newPart = after.slice(from, after.length - keepTail)
  const meta: EditDiffMeta = { startLine: from + 1, oldLines: oldPart.length, newLines: newPart.length, ...(needsBase && diff.oldText !== null ? { base: diff.oldText } : {}) }
  return { type: 'diff', path: diff.path, oldText: diff.oldText === null ? null : oldPart.join('\n'), newText: newPart.join('\n'), _meta: { diffra: { [EDIT_DIFF_META_KEY]: meta } } }
}

function isCompact(content: DiffContent): boolean {
  const diffra = content._meta?.diffra
  return typeof diffra === 'object' && diffra !== null && EDIT_DIFF_META_KEY in diffra
}

// 旧记录里的改动卡片带整份文件：发给界面前按同样的规则压缩（不改记录本身）
export function compactTurns(turns: StoredTurn[]): StoredTurn[] {
  return turns.map((turn) => {
    const known = new Map<string, string>()
    let changed = false
    const updates = turn.updates.map((update): SessionUpdate => {
      if ((update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') || !update.content) return update
      const content = update.content.map((item) => {
        if (item.type !== 'diff' || isCompact(item)) return item
        changed = true
        return compactEdit(known, { path: item.path, oldText: item.oldText ?? null, newText: item.newText })
      })
      return { ...update, content }
    })
    return changed ? { ...turn, updates } : turn
  })
}
