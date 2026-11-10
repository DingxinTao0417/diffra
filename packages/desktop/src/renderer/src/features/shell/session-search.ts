import { useEffect, useMemo, useState } from 'react'
import type { SessionSearchResult } from '@diffra/core/types'
import { useAppState } from '@/state/store'

const RECENT_LIMIT = 8
const SEARCH_DEBOUNCE_MS = 150

interface Searched {
  text: string
  items: SessionSearchResult[]
  failed: boolean
}

// 搜索框和侧栏内联搜索共用：没输入时列出最近任务，输入后用 core 的会话搜索，150ms 防抖
export function useSessionSearch(query: string) {
  const tasks = useAppState((state) => state.tasks)
  const [searched, setSearched] = useState<Searched | null>(null)
  const text = query.trim()

  const recent = useMemo<SessionSearchResult[]>(
    () =>
      [...tasks]
        .filter((task) => !task.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT_LIMIT)
        .map((task) => ({ sessionId: task.sessionId, cwd: task.cwd, title: task.title, updatedAt: task.updatedAt, snippet: '' })),
    [tasks],
  )

  // 搜索结果不带无项目标记，按已知任务查
  const noProject = useMemo(() => new Set(tasks.filter((task) => task.noProject).map((task) => task.sessionId)), [tasks])

  useEffect(() => {
    if (!text) {
      setSearched((current) => (current === null ? current : null))
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      window.diffra.searchSessions(text).then(
        (found) => {
          if (stale) return
          setSearched({ text, items: found, failed: false })
        },
        (error: unknown) => {
          console.error(`搜索任务失败：${text}`, error)
          if (stale) return
          setSearched({ text, items: [], failed: true })
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text])

  // 搜索期间继续显示上一次的结果，不回落到最近任务，列表不会来回跳
  const searching = text !== '' && searched?.text !== text
  const list = text ? (searched?.items ?? []) : recent
  return {
    text,
    list,
    searching,
    failed: text !== '' && !searching && searched?.text === text && searched.failed,
    highlight: text ? (searched?.text ?? '') : '',
    noProject,
  }
}
