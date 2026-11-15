import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Menu, PanelLeft } from 'lucide-react'
import { cn } from 'cn'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { REMOTE_DEVICE_CONNECTION_ENABLED } from '../../../../shared/remote'
import { RemoteControlIndicator } from '@/features/devices/DevicesOverview'
import { IS_MAC, MAC_CHROME_HEIGHT, shortcutLabel } from '@/lib/platform'
import { moveHistory, toggleSidebar } from '@/state/actions'
import { isSidebarShown, useAppState } from '@/state/store'

// 顶栏：主菜单、侧栏开关、后退前进，其余地方可以拖动窗口；右边留给系统的窗口按钮，按钮左边是「能操作本机的设备在线」的提示。
// 高度用 px 固定为 40，和主进程给系统按钮设的高度一致，不跟着字号缩放。
// Mac 的样子不一样，见下面 IS_MAC 那段
export function TitleBar() {
  const fullScreen = useFullScreen()
  const settingsOpen = useAppState((state) => state.route.name === 'settings')
  const sidebarShown = useAppState(isSidebarShown)
  const canGoBack = useAppState((state) => state.route.name === 'settings' || state.historyIndex > 0)
  const canGoForward = useAppState((state) => state.route.name !== 'settings' && state.historyIndex < state.history.length - 1)
  const menuButton = useRef<HTMLButtonElement>(null)

  const openMenu = () => {
    const rect = menuButton.current?.getBoundingClientRect()
    if (!rect) return
    window.diffra.popupMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom) }).catch((error: unknown) => console.error('打开菜单失败', error))
  }

  // 设置页没有侧栏，开关不显示，但留出同样的位置，免得后退、前进在进出设置时左右跳
  const navButtons = (
    <>
      {settingsOpen ? (
        <span aria-hidden className="size-[30px] shrink-0" />
      ) : (
        <BarButton label={sidebarShown ? '收起侧栏' : '展开侧栏'} shortcut="Ctrl+B" onClick={toggleSidebar}>
          <PanelLeft className="size-[16px]" />
        </BarButton>
      )}
      <BarButton label="后退" shortcut="Alt+←" disabled={!canGoBack} onClick={() => void moveHistory(-1)}>
        <ArrowLeft className="size-[16px]" />
      </BarButton>
      <BarButton label="前进" shortcut="Alt+→" disabled={!canGoForward} onClick={() => void moveHistory(1)}>
        <ArrowRight className="size-[16px]" />
      </BarButton>
    </>
  )

  // Mac：不单独占一行。红绿灯、侧栏开关、后退前进浮在窗口左上角（落在侧栏顶部；侧栏收起时落在内容区留出的那一条里），
  // 能操作本机的设备在线时后面跟一个琥珀色小图标。窗口最上面一条整条能拖动（mac-drag-strip，见 styles.css），里面的按钮、输入框照常能点
  if (IS_MAC) {
    return (
      <>
        {/* 垫在所有内容下面（负 z-index）：点击照常落在上面的内容上，拖动区域照样算它（不用 pointer-events: none，那样的元素可能不算） */}
        <div aria-hidden className="mac-drag-strip fixed inset-x-0 top-0 -z-10" style={{ height: MAC_CHROME_HEIGHT }} />
        <div
          className={cn('title-bar fixed top-0 left-0 z-40 flex items-center gap-[2px] text-muted-foreground', fullScreen ? 'pl-[8px]' : 'pl-[84px]')}
          style={{ height: MAC_CHROME_HEIGHT }}
          data-testid="title-bar"
        >
          {navButtons}
          {REMOTE_DEVICE_CONNECTION_ENABLED && <RemoteControlIndicator compact />}
        </div>
      </>
    )
  }

  return (
    <div className="title-bar flex h-[40px] shrink-0 items-center gap-[2px] bg-sidebar pl-[8px] text-muted-foreground" data-testid="title-bar">
      <BarButton label="主菜单" buttonRef={menuButton} onClick={openMenu}>
        <Menu className="size-[16px]" />
      </BarButton>
      {navButtons}
      <div className="flex-1" />
      {REMOTE_DEVICE_CONNECTION_ENABLED && <RemoteControlIndicator />}
    </div>
  )
}

function BarButton({
  label,
  shortcut,
  disabled,
  buttonRef,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  disabled?: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
  onClick(): void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex size-[30px] items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcutLabel(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

// 只有 Mac 关心全屏（红绿灯会藏起来）；Windows 不订阅
function useFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    if (!IS_MAC) return
    void window.diffra.isFullScreen().then(setFullScreen)
    return window.diffra.onFullScreenChange(setFullScreen)
  }, [])
  return fullScreen
}
