import { useSyncExternalStore } from 'react'

// 当前真正生效的主题：<html> 上的 dark 类、配色、字号。「跟随系统」时系统切深色，设置里的 appearance 不变、只有 dark 类变，
// 所以要拿真实颜色值画图的地方（流程图、图表）看这里，不看设置
function themeKey(): string {
  const root = document.documentElement
  return `${root.classList.contains('dark') ? 'dark' : 'light'}|${root.dataset.palette ?? ''}|${root.dataset.font ?? ''}`
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-palette', 'data-font'] })
  return () => observer.disconnect()
}

export function useThemeKey(): string {
  return useSyncExternalStore(subscribe, themeKey)
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
