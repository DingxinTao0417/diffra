// 运行的系统。Windows 是一直以来的样子，Mac 的差别都从这里分出去，不改 Windows 的显示和按键
export const IS_MAC = window.diffra.platform === 'darwin'
// Mac 专用的样式（拖动区域）挂在 <html data-platform="darwin"> 下面；Windows 不加，样式不受影响
if (IS_MAC) document.documentElement.dataset.platform = 'darwin'
// Mac 上红绿灯和侧栏开关、后退前进浮在窗口左上角（见 TitleBar），占的高度和宽度
export const MAC_CHROME_HEIGHT = 40
export const MAC_SIDEBAR_MIN_PX = 216

// 快捷键在代码里按 Windows 的写法写（Ctrl+K、Alt+←）。Mac 上：Ctrl → ⌘；终端开关还是 ⌃`（⌘` 是系统切换窗口）；
// 后退前进是 ⌘[、⌘]（⌥← 在输入框里是按词移动）
const MAC_SPECIAL: Record<string, string[]> = {
  'Ctrl+`': ['⌃', '`'],
  'Alt+←': ['⌘', '['],
  'Alt+→': ['⌘', ']'],
}
const MAC_KEYS: Record<string, string> = { Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Enter: '↩' }

// 一组按键，每个放进一个 <Kbd>
export function shortcutKeys(keys: string[]): string[] {
  if (!IS_MAC) return keys
  return MAC_SPECIAL[keys.join('+')] ?? keys.map((key) => MAC_KEYS[key] ?? key)
}

// 写成一串：Windows 是「Ctrl+K」，Mac 是「⌘K」
export function shortcutLabel(keys: string): string {
  if (!IS_MAC) return keys
  return shortcutKeys(keys.split('+')).join('')
}
