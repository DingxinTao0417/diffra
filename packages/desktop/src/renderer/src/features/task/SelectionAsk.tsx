import { type RefObject, useContext, useEffect, useMemo, useState } from 'react'
import { fillComposer } from '@/state/actions'
import { AnswerContext } from './answer-links'

// 选中对话里的一段文字（第 674 步）：旁边浮出「解释这个 / 展开这个 / 换个说法」，点了把这段引用和要求填进输入框，不发。
// 远程、只读的会话没有本机的输入框，不出
const MAX_QUOTE = 2000
const ACTIONS = [
  { label: '解释这个', prompt: '解释一下这段：' },
  { label: '展开这个', prompt: '展开讲讲这段：' },
  { label: '换个说法', prompt: '换个说法讲讲这段：' },
] as const

export function quoted(text: string): string {
  const trimmed = text.trim()
  const clipped = trimmed.length > MAX_QUOTE ? `${trimmed.slice(0, MAX_QUOTE)}…` : trimmed
  return clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

// 填进输入框的「问问这个」：远程、只读的会话是 null
export function useAskAbout(): ((prompt: string, text: string) => void) | null {
  const sessionId = useContext(AnswerContext)?.sessionId ?? null
  return useMemo(() => (sessionId ? (prompt: string, text: string) => fillComposer(sessionId, `${prompt}\n${quoted(text)}\n\n`) : null), [sessionId])
}

export function SelectionAsk({ root }: { root: RefObject<HTMLElement | null> }) {
  const ask = useAskAbout()
  const [menu, setMenu] = useState<{ text: string; top: number; left: number; below: boolean } | null>(null)

  useEffect(() => {
    const element = root.current
    if (!ask || !element) return
    const update = () => {
      const selection = document.getSelection()
      const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null
      const text = selection?.toString().trim() ?? ''
      const start = range?.startContainer.parentElement
      // 只认对话里的文字；输入框、按钮里的不算
      if (!range || text.length < 2 || !element.contains(range.commonAncestorContainer) || start?.closest('input, textarea, button')) return setMenu(null)
      const rect = range.getBoundingClientRect()
      const below = rect.top < 56
      setMenu({ text, top: below ? rect.bottom + 8 : rect.top - 8, left: rect.left + rect.width / 2, below })
    }
    const clear = () => {
      if (document.getSelection()?.isCollapsed) setMenu(null)
    }
    element.addEventListener('pointerup', update)
    element.addEventListener('keyup', update)
    element.addEventListener('scroll', update)
    document.addEventListener('selectionchange', clear)
    return () => {
      element.removeEventListener('pointerup', update)
      element.removeEventListener('keyup', update)
      element.removeEventListener('scroll', update)
      document.removeEventListener('selectionchange', clear)
    }
  }, [ask, root])

  if (!menu || !ask) return null
  return (
    <div
      role="toolbar"
      aria-label="问问选中的这段"
      className="fixed z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 text-xs shadow-overlay"
      style={{ top: menu.top, left: menu.left, transform: `translate(-50%, ${menu.below ? '0' : '-100%'})` }}
      data-testid="selection-ask"
      // 点按钮时不让选区丢掉
      onPointerDown={(event) => event.preventDefault()}
    >
      {ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          className="rounded-md px-2 py-1 hover:bg-accent"
          onClick={() => {
            ask(action.prompt, menu.text)
            document.getSelection()?.removeAllRanges()
            setMenu(null)
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
