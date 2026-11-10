// 内容面板嵌在侧栏底色里，左上圆角；首页、任务页和设置页共用，分隔线位置才不会在切换时跳动
export const INSET_PANEL = 'overflow-hidden rounded-tl-xl border-t border-l border-sidebar-border bg-background'

// 按当前根字号（跟着「文字大小」）把 rem 换成像素，分栏拖动的上下限用
export function remPx(rem: number): number {
  return rem * parseFloat(getComputedStyle(document.documentElement).fontSize)
}
