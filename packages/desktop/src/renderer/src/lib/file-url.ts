// file:// 网址去掉协议，剩下文件路径（还没解码）。
// Windows 一直是去掉 file:/// 三条斜杠：file:///D:/p/a.ts → D:/p/a.ts。
// Mac 的绝对路径本身以 / 开头，只去掉 file:// 两条：file:///Users/a/b.ts → /Users/a/b.ts（原来会丢掉开头的 /，变成找不到的相对路径）。
// 可视化、设计稿这些页面可能没有 window.diffra，按原来的写法处理
const IS_MAC = typeof window !== 'undefined' && window.diffra?.platform === 'darwin'

export function stripFileScheme(url: string): string {
  return url.replace(IS_MAC ? /^file:\/\//i : /^file:\/\/\/?/i, '')
}
