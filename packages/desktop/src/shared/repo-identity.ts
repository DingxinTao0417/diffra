// 同一个仓库在两台电脑上的不同检出：用远程地址（origin）加项目在仓库里的相对路径认出来。
// 两台机器各自的路径不一样，仓库地址和相对路径一样才算同一个项目
export interface RepoIdentity {
  origin: string
  subpath: string
}

// 项目路径在 Windows 上不分大小写；末尾分隔符和反斜杠不影响是不是同一个项目
export function projectIdentityKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

// https://github.com/o/r.git、git@github.com:o/r、ssh://git@github.com/o/r 都算同一个仓库
export function normalizeRepoOrigin(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const at = text.indexOf('@')
  if (at >= 0) text = text.slice(at + 1)
  // git@host:path 里用户后面那个冒号是分隔符，不是端口
  text = text.replace(/^([^/:]+):(?!\/)/, '$1/')
  text = text.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!text.includes('/')) return null
  return text.toLowerCase()
}

export function normalizeRepoSubpath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function sameProjectIdentity(a: RepoIdentity | null | undefined, b: RepoIdentity | null | undefined): boolean {
  if (!a || !b) return false
  const left = normalizeRepoOrigin(a.origin)
  const right = normalizeRepoOrigin(b.origin)
  if (!left || !right || left !== right) return false
  return normalizeRepoSubpath(a.subpath) === normalizeRepoSubpath(b.subpath)
}
