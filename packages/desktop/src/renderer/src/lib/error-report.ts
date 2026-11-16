import { errorMessage } from './errors'

// 界面里没接住的错误交给主进程记到 logs/renderer.log，条数由主进程限（main/app-log.ts）；
// 无限更新这类错误一秒能刷几十条，连着一样的这里就不再发
let last = ''

export function reportRendererError(kind: string, error: unknown, componentStack?: string): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : errorMessage(error)
  const text = `[${kind}] ${detail}${componentStack ? `\n组件：${componentStack.trim()}` : ''}`
  if (text === last) return
  last = text
  window.diffra.logRendererError(text.slice(0, 8000))
}

// 事件回调、定时器里抛的错和没处理的 Promise 失败；渲染里的错由 main.tsx 交给 React 的 onCaughtError
export function watchUncaughtErrors(): void {
  window.addEventListener('error', (event) => reportRendererError('error', event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => reportRendererError('unhandledrejection', event.reason))
}
