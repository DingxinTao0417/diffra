import { createContext, useContext, useEffect, useState } from 'react'
import { TOOL_PREVIEW_META_KEY } from '@diffra/core/types'
import type { TranscriptItem } from '@/features/session/transcript'
import { errorMessage } from '@/lib/errors'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// 远程会话里读取、执行、搜索的输出只同步了开头（对方在文字块的 _meta 里记着全文多长）。
// 远程任务页提供取全文的办法：向对方要这一步的全部输出、写回这一步；本机任务没有，也用不着
export const ToolOutputContext = createContext<((toolCallId: string) => Promise<void>) | null>(null)

// 只同步了开头时全文多少字，都在就是 null
function previewLength(item: ToolItem): number | null {
  for (const content of item.content) {
    if (content.type !== 'content' || content.content.type !== 'text') continue
    const length = content.content._meta?.[TOOL_PREVIEW_META_KEY]
    if (typeof length === 'number') return length
  }
  return null
}

// 展开时取全文；返回显示在输出下面的一句说明和失败时的重试
export function useFullOutput(item: ToolItem, expanded: boolean): { note: string | null; retry: (() => void) | null } {
  const load = useContext(ToolOutputContext)
  const total = previewLength(item)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!expanded || total === null || !load) return
    let cancelled = false
    setError(null)
    load(item.id).catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason))
    })
    return () => {
      cancelled = true
    }
  }, [expanded, total, load, item.id, attempt])
  if (total === null || !expanded) return { note: null, retry: null }
  const head = `只同步了开头（全文 ${total} 字）`
  if (!load) return { note: head, retry: null }
  if (error) return { note: `${head}，取全文失败：${error}`, retry: () => setAttempt((count) => count + 1) }
  return { note: `${head}，正在取全文…`, retry: null }
}
