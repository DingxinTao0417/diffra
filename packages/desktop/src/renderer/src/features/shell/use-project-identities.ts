import { useEffect, useState } from 'react'
import { projectIdentityKey, type RepoIdentity } from '../../../../shared/repo-identity'

const NO_IDENTITIES: Record<string, RepoIdentity | null> = {}

// 本机项目的仓库身份，按项目路径的小写形式索引。项目列表变了才重新问主进程；
// 不是 Git 仓库、没有 origin 的项目是 null，侧栏就不和别的设备上的项目合并
export function useProjectIdentities(paths: string[]): Record<string, RepoIdentity | null> {
  const key = paths.join('\n')
  const [identities, setIdentities] = useState<Record<string, RepoIdentity | null>>(NO_IDENTITIES)
  useEffect(() => {
    const wanted = key.split('\n').filter(Boolean)
    if (wanted.length === 0) {
      setIdentities(NO_IDENTITIES)
      return
    }
    let cancelled = false
    window.diffra.projectRepoIdentities(wanted).then(
      (result) => {
        if (cancelled) return
        const byPath: Record<string, RepoIdentity | null> = {}
        for (const [path, identity] of Object.entries(result)) byPath[projectIdentityKey(path)] = identity
        setIdentities(byPath)
      },
      (error: unknown) => {
        if (!cancelled) console.error('读取项目仓库身份失败', error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [key])
  return identities
}
