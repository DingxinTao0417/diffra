// 1234 → 1k，1000000 → 1m
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

// 侧栏和列表里的时间：今天显示时刻，昨天显示「昨天」，更早显示日期
export function formatTime(iso: string | number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const time = date.getTime()
  if (time >= startOfToday) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (time >= startOfToday - 86_400_000) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

const pad = (value: number) => String(value).padStart(2, '0')
