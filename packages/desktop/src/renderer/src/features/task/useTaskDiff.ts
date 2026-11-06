import { useEffect, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { type FileDiff, parseUnifiedDiff } from '@/lib/unified-diff'

export type TaskDiff = { state: 'loading' } | { state: 'ready'; files: FileDiff[] } | { state: 'error'; message: string }

// 从某一轮开始到现在的文件改动；文件可能变了（changeVersion 变化）就重新读
export function useTaskDiff(sessionId: string, sinceTurnId: string | null, enabled: boolean, changeVersion: number): TaskDiff | null {
  const [diff, setDiff] = useState<TaskDiff | null>(null)

  useEffect(() => {
    if (!enabled || !sinceTurnId) {
      setDiff(null)
      return
    }
    let stale = false
    setDiff((current) => (current?.state === 'ready' ? current : { state: 'loading' }))
    // 工具调用连着完成时合并成一次读取
    const timer = setTimeout(() => {
      window.diffra.checkpointDiff(sessionId, sinceTurnId).then(
        (text) => !stale && setDiff({ state: 'ready', files: parseUnifiedDiff(text) }),
        (error: unknown) => !stale && setDiff({ state: 'error', message: errorMessage(error) }),
      )
    }, 300)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [sessionId, sinceTurnId, enabled, changeVersion])

  return diff
}
