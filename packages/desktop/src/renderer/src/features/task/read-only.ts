import { createContext, useContext } from 'react'

// 远程会话页（别的设备授权给本机看的任务）只读：作用于本机的按钮（继续、重新生成、撤销、定位问题、按计划执行、打开任务……）都不显示。
// 它们拿着对方的会话 id 调本机的接口，轻则报错，重则碰到本机同 id 的任务（docs/decisions.md「设备连接」）
export const ReadOnlyContext = createContext(false)

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext)
}
