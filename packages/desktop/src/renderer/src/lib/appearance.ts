import { type Appearance, DEFAULT_APPEARANCE } from '../../../shared/settings'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let current: Appearance = DEFAULT_APPEARANCE

// 把外观设置写到 <html> 上：配色、字号、内容宽度用 data 属性，深色用 .dark
export function applyAppearance(appearance: Appearance): void {
  current = appearance
  const root = document.documentElement
  root.dataset.palette = appearance.palette
  root.dataset.font = appearance.fontSize
  root.dataset.width = appearance.contentWidth
  const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && darkQuery.matches)
  root.classList.toggle('dark', dark)
}

// 「跟随系统」时，系统切换深浅色要跟着变
darkQuery.addEventListener('change', () => applyAppearance(current))
