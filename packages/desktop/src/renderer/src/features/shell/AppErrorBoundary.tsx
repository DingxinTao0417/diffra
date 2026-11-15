import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'

// 界面渲染出错时的兜底：不再整窗白屏，说明原因、给「重新加载界面」。
// 只重新加载页面这一层，core 是单独的进程，后台在跑的任务不会停；
// 但「在跑」只记在页面里（actions.ts 的 runTurnOnCore），重载后正在跑的任务会显示成已停止
interface State {
  failed: boolean
  error: unknown
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        {/* 顶栏随应用一起没了，留一条能拖动窗口的位置 */}
        <div className="title-bar h-[40px] shrink-0" />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="alert" data-testid="app-crash">
          <h1 className="text-lg font-bold">界面出错了</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            重新加载界面就能接着用。后台在跑的任务不会停，但重新加载后界面暂时看不到它的进度，会显示成「已停止」。出错的原因记在数据文件夹的 logs/renderer.log 里。
          </p>
          <pre className="max-h-40 w-full max-w-xl overflow-auto rounded-md border bg-muted px-3 py-2 text-left text-xs whitespace-pre-wrap">{errorMessage(this.state.error)}</pre>
          <Button onClick={() => location.reload()}>重新加载界面</Button>
        </div>
      </div>
    )
  }
}
