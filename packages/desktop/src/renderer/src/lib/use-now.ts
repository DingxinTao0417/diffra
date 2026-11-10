import { useEffect, useState } from 'react'

// 当前时间，每隔 intervalMs 刷新一次：逾期、今天这类按时间分的显示跟着变
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
