import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { type FileDiff, parseUnifiedDiff } from '@/lib/unified-diff'
import { type RemoteTaskSource, useRemoteTask } from './remote-task'

export type TaskDiff = { state: 'loading' } | { state: 'ready'; files: FileDiff[] } | { state: 'error'; message: string }

const LOADING: TaskDiff = { state: 'loading' }
const CACHE_LIMIT = 8

// 只在内存里留最近读到的几份结果（按会话 + 起始轮），切面板、切范围时先显示旧数据再后台刷新；骨架只在这个 key 第一次读取回来之前出现
const cache = new Map<string, { version: number; diff: TaskDiff }>()

function remember(key: string, version: number, diff: TaskDiff) {
  const current = cache.get(key)
  // 晚到的旧版本结果不能盖掉已经读到的新结果
  if (current && current.version > version) return
  cache.delete(key)
  cache.set(key, { version, diff })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}

// 从某一轮开始到现在的文件改动；文件可能变了（changeVersion 变化）就重新读。远程任务向对方要（会话 id 带着设备，缓存不会撞）；
// 远程任务页的上下文在 TaskPage 里面才有，TaskPage 自己用时把来源直接传进来
export function useTaskDiff(sessionId: string, sinceTurnId: string | null, enabled: boolean, changeVersion: number, source?: RemoteTaskSource): TaskDiff | null {
  const context = useRemoteTask()
  const remote = source ?? context
  const key = sinceTurnId ? `${sessionId}:${sinceTurnId}` : null
  const [shown, setShown] = useState<{ key: string; version: number; diff: TaskDiff } | null>(null)
  const lastRead = useRef(0)

  useEffect(() => {
    // 停用时保留上次的结果，重新启用时直接显示
    if (!enabled || !key || !sinceTurnId) return
    const hit = cache.get(key)
    // 骨架占位的版本比任何读到的结果都旧，在途的读取回来就能替换它
    setShown((current) => (hit ? { key, ...hit } : current?.key === key && current.diff.state === 'ready' ? current : { key, version: -1, diff: LOADING }))
    // 在途的结果也要落地，只是不能盖掉更新的；已经换到别的 key 时不动正在显示的
    const land = (diff: TaskDiff) => setShown((current) => (current?.key !== key || current.version > changeVersion ? current : { key, version: changeVersion, diff }))
    // 第一次立即读；工具调用连着完成时每 300ms 最多读一次，不用等这一串结束才刷新
    const timer = setTimeout(() => {
      lastRead.current = Date.now()
      ;(remote ? remote.diff(sinceTurnId) : window.diffra.checkpointDiff(sessionId, sinceTurnId)).then(
        (text) => {
          const diff: TaskDiff = { state: 'ready', files: parseUnifiedDiff(text) }
          remember(key, changeVersion, diff)
          land(diff)
        },
        (error: unknown) => land({ state: 'error', message: errorMessage(error) }),
      )
    }, Math.max(0, lastRead.current + 300 - Date.now()))
    return () => clearTimeout(timer)
  }, [sessionId, sinceTurnId, key, enabled, changeVersion, remote])

  if (!key) return null
  if (shown?.key === key) return shown.diff
  return cache.get(key)?.diff ?? (enabled ? LOADING : null)
}
