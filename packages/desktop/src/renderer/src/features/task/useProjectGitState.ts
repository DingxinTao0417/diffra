import { useEffect, useState } from 'react'
import type { ProjectGitState } from '../../../../shared/ipc'
import { errorMessage } from '@/lib/errors'

const REFRESH_MS = 5000

export interface ProjectGitStateView {
  state: ProjectGitState | null
  loading: boolean
  error: string | null
}

// 任务监控打开时读工作区相对 HEAD 的状态；面板开着时定时刷新，用户或智能体在别处提交也能跟上
export function useProjectGitState(project: string | null, enabled: boolean, changeVersion: number): ProjectGitStateView {
  const [shown, setShown] = useState<ProjectGitStateView>({ state: null, loading: false, error: null })

  useEffect(() => {
    if (!enabled || !project) {
      setShown({ state: null, loading: false, error: null })
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = async (first: boolean) => {
      if (first) setShown((current) => ({ state: current.state, loading: true, error: null }))
      try {
        const state = await window.diffra.projectGitState(project)
        if (!cancelled) setShown({ state, loading: false, error: null })
      } catch (error) {
        if (!cancelled) setShown((current) => ({ state: current.state, loading: false, error: errorMessage(error) }))
      }
      if (!cancelled) timer = setTimeout(() => void read(false), REFRESH_MS)
    }
    void read(true)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [project, enabled, changeVersion])

  return shown
}
