import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { FolderOpen, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SidePanel } from '@/features/task/SidePanel'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

// 任务页右侧的设计面板。画布是主进程叠在这块区域上的设计页（OpenPencil，Vue），这里只负责顶栏和把位置告诉主进程。
// 和浏览器面板一样：弹窗、下拉菜单打开时（Radix 给 body 加 data-scroll-locked）先把它藏起来
export function DesignPanel({ sessionId, project, noProject }: { sessionId: string; project: string; noProject: boolean }) {
  const body = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const sync = () => {
      const covered = document.body.hasAttribute('data-scroll-locked')
      const rect = element.getBoundingClientRect()
      window.diffra.setDesignBounds(sessionId, covered || rect.width === 0 ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    sync()
    const resize = new ResizeObserver(sync)
    resize.observe(element)
    resize.observe(document.body)
    const locked = new MutationObserver(sync)
    locked.observe(document.body, { attributes: true, attributeFilter: ['data-scroll-locked'] })
    window.addEventListener('resize', sync)
    return () => {
      resize.disconnect()
      locked.disconnect()
      window.removeEventListener('resize', sync)
      window.diffra.setDesignBounds(sessionId, null)
    }
  }, [sessionId])

  const run = async (action: () => Promise<string | null>, done: string) => {
    try {
      const path = await action()
      if (path) showToast(`${done}：${path}`)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  return (
    <SidePanel
      width="fill"
      testId="design-panel"
      title="设计"
      actions={
        <>
          <ToolButton label="打开 .fig 文件" onClick={() => void run(() => window.diffra.designOpenFile(sessionId), '已打开')}>
            <FolderOpen className="size-4" />
          </ToolButton>
          <ToolButton label={noProject ? '另存为 .fig' : '另存到项目（.fig）'} onClick={() => void run(() => window.diffra.designSaveFile(sessionId, project), '已另存')}>
            <Save className="size-4" />
          </ToolButton>
        </>
      }
    >
      <div ref={body} className="relative min-h-0 flex-1 bg-background" data-testid="design-viewport" />
    </SidePanel>
  )
}

function ToolButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="text-muted-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
