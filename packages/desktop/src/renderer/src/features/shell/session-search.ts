import { useEffect, useMemo, useState } from 'react'
import type { SessionSearchResult } from '@diffra/core/types'
import { REMOTE_DEVICE_CONNECTION_ENABLED } from '../../../../shared/remote'
import { useAppState } from '@/state/store'

const RECENT_LIMIT = 8
const SEARCH_DEBOUNCE_MS = 150
const REMOTE_LIMIT = 20
const NO_PEERS: never[] = []

// remote：别的设备授权给本机的会话（cwd 放项目名），点开是远程任务页
export type SearchItem = SessionSearchResult & { remote?: { deviceId: string; deviceName: string } }

// 列表里的唯一键：远程会话的 id 是对方设备上的，带上设备
export const searchItemKey = (item: SearchItem) => (item.remote ? `${item.remote.deviceId}/${item.sessionId}` : item.sessionId)

interface Searched {
  text: string
  items: SessionSearchResult[]
  failed: boolean
}

// 搜索框和侧栏内联搜索共用：没输入时列出最近任务，输入后用 core 的会话搜索，150ms 防抖。
// 别的设备授权给本机的会话只有列表在本机，按标题找，排在本机结果后面
export function useSessionSearch(query: string) {
  const tasks = useAppState((state) => state.tasks)
  const peers = useAppState((state) => (REMOTE_DEVICE_CONNECTION_ENABLED ? (state.remote?.peers ?? NO_PEERS) : NO_PEERS))
  const remoteLists = useAppState((state) => state.remoteLists)
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

  const remote = useMemo<SearchItem[]>(() => {
    if (!REMOTE_DEVICE_CONNECTION_ENABLED) return []
    const needle = text.toLowerCase()
    if (!needle) return []
    return peers
      .flatMap((peer) => {
        const list = remoteLists[peer.deviceId]?.list
        if (!list) return []
        return list.sessions
          .filter((session) => session.title.toLowerCase().includes(needle))
          .map((session) => ({
            sessionId: session.sessionId,
            cwd: list.projects.find((project) => project.id === session.projectId)?.name ?? '',
            title: session.title,
            updatedAt: session.updatedAt,
            snippet: '',
            remote: { deviceId: peer.deviceId, deviceName: peer.name },
          }))
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, REMOTE_LIMIT)
  }, [text, peers, remoteLists])

  // 搜索期间继续显示上一次的结果，不回落到最近任务，列表不会来回跳
  const searching = text !== '' && searched?.text !== text
  const list: SearchItem[] = text ? [...(searched?.items ?? []), ...remote] : recent
  return {
    text,
    list,
    searching,
    failed: text !== '' && !searching && searched?.text === text && searched.failed,
    highlight: text ? (searched?.text ?? '') : '',
    noProject,
  }
}
