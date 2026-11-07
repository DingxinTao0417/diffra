import { useEffect, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { type FileDiff, parseUnifiedDiff } from '@/lib/unified-diff'

export type TaskDiff = { state: 'loading' } | { state: 'ready'; files: FileDiff[] } | { state: 'error'; message: string }

const LOADING: TaskDiff = { state: 'loading' }
const CACHE_LIMIT = 8

// 只在内存里留最近读到的几份结果（按会话 + 起始轮），切面板、切范围时先显示旧数据再后台刷新
const cache = new Map<string, { version: number; diff: TaskDiff }>()

function remember(key: string, version: number, diff: TaskDiff) {
  const current = cache.get(key)
  // 晚到的旧版本结果不能盖掉已经读到的新结果
  if (current && current.version > version) return
  cache.delete(key)
  cache.set(key, { version, diff })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}

// 从某一轮开始到现在的文件改动；文件可能变了（changeVersion 变化）就重新读
export function useTaskDiff(sessionId: string, sinceTurnId: string | null, enabled: boolean, changeVersion: number): TaskDiff | null {
  const key = sinceTurnId ? `${sessionId}:${sinceTurnId}` : null
  const [shown, setShown] = useState<{ key: string; diff: TaskDiff } | null>(null)

  useEffect(() => {
    // 停用时保留上次的结果，重新启用时直接显示
    if (!enabled || !key || !sinceTurnId) return
    let stale = false
    const hit = cache.get(key)
    setShown((current) => (hit ? { key, diff: hit.diff } : current?.key === key && current.diff.state === 'ready' ? current : { key, diff: LOADING }))
    // 工具调用连着完成时合并成一次读取
    const timer = setTimeout(() => {
      window.diffra.checkpointDiff(sessionId, sinceTurnId).then(
        (text) => {
          const diff: TaskDiff = { state: 'ready', files: parseUnifiedDiff(text) }
          remember(key, changeVersion, diff)
          if (!stale) setShown({ key, diff })
        },
        (error: unknown) => !stale && setShown({ key, diff: { state: 'error', message: errorMessage(error) } }),
      )
    }, 300)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [sessionId, sinceTurnId, key, enabled, changeVersion])

  if (!key) return null
  if (shown?.key === key) return shown.diff
  return cache.get(key)?.diff ?? (enabled ? LOADING : null)
}
