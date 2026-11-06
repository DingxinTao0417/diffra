import { useEffect, useState } from 'react'
import type { ProjectState } from '../../../../shared/ipc'

// 项目的检查命令、禁写目录、规范设置和当前分支
export function useProject(path: string | null) {
  const [project, setProject] = useState<ProjectState | null>(null)
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    setProject(null)
    setBranch(null)
    if (!path) return
    let stale = false
    window.diffra.getProject(path).then(
      (state) => !stale && setProject(state),
      (error: unknown) => console.error('读取项目设置失败', error),
    )
    window.diffra.projectBranch(path).then(
      (name) => !stale && setBranch(name),
      (error: unknown) => console.error('读取分支失败', error),
    )
    return () => {
      stale = true
    }
  }, [path])

  return { project, setProject, branch }
}

export function checksSummary(project: ProjectState): string {
  const { afterEdit, beforeFinish } = project.checks
  if (!afterEdit && !beforeFinish) return '未配置检查'
  return `检查：${beforeFinish ?? afterEdit}`
}
