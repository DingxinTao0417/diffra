// 项目路径在 Windows 上不分大小写；末尾分隔符和反斜杠不影响是不是同一个项目
export function sameProjectPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const normalize = (path: string) => path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return normalize(a) === normalize(b)
}
