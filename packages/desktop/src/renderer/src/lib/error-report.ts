import { errorMessage } from './errors'

// 界面里没接住的错误交给主进程记到 logs/renderer.log。一次加载最多记 50 条、连着一样的只记一次：
// 无限更新这类错误一秒能刷几十条
const MAX_REPORTS = 50
let reported = 0
let last = ''

export function reportRendererError(kind: string, error: unknown, componentStack?: string): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : errorMessage(error)
  const text = `[${kind}] ${detail}${componentStack ? `\n组件：${componentStack.trim()}` : ''}`
  if (text === last || reported >= MAX_REPORTS) return
  last = text
  reported++
  window.diffra.logRendererError(text.slice(0, 8000))
}

// 事件回调、定时器里抛的错和没处理的 Promise 失败；渲染里的错由 main.tsx 交给 React 的 onCaughtError
export function watchUncaughtErrors(): void {
  window.addEventListener('error', (event) => reportRendererError('error', event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => reportRendererError('unhandledrejection', event.reason))
}
