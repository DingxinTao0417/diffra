import { createContext, useContext } from 'react'

// 静态渲染（第 671 步，见 static-html.tsx）：导出、分享时在屏幕外用同一套组件渲染。组件据此给出离线能看的样子：
// 可视化用快照，作用于本机的操作栏不画
export const StaticContext = createContext(false)

export function useStatic(): boolean {
  return useContext(StaticContext)
}
