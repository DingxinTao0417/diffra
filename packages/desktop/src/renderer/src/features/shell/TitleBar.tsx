import { type ReactNode, useRef } from 'react'
import { ArrowLeft, ArrowRight, Menu, PanelLeft } from 'lucide-react'
import { moveHistory } from '@/state/actions'
import { store, useAppState } from '@/state/store'

// 顶栏：主菜单、侧栏开关、后退前进，其余地方可以拖动窗口；右边留给系统的窗口按钮。
// 高度用 px 固定为 40，和主进程给系统按钮设的高度一致，不跟着字号缩放
export function TitleBar() {
  const settingsOpen = useAppState((state) => state.route.name === 'settings')
  const sidebarOpen = useAppState((state) => state.sidebarOpen)
  const canGoBack = useAppState((state) => state.route.name === 'settings' || state.historyIndex > 0)
  const canGoForward = useAppState((state) => state.route.name !== 'settings' && state.historyIndex < state.history.length - 1)
  const menuButton = useRef<HTMLButtonElement>(null)

  const openMenu = () => {
    const rect = menuButton.current?.getBoundingClientRect()
    if (!rect) return
    window.diffra.popupMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom) }).catch((error: unknown) => console.error('打开菜单失败', error))
  }

  return (
    <div className="title-bar flex h-[40px] shrink-0 items-center gap-[2px] bg-sidebar pl-[8px] text-muted-foreground" data-testid="title-bar">
      <BarButton label="主菜单" buttonRef={menuButton} onClick={openMenu}>
        <Menu className="size-[16px]" />
      </BarButton>
      {/* 设置页没有侧栏，开关不显示，但留出同样的位置，免得后退、前进在进出设置时左右跳 */}
      {settingsOpen ? (
        <span aria-hidden className="size-[30px] shrink-0" />
      ) : (
        <BarButton
          label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          shortcut="Ctrl+B"
          onClick={() => store.set((state) => ({ ...state, sidebarOpen: !state.sidebarOpen }))}
        >
          <PanelLeft className="size-[16px]" />
        </BarButton>
      )}
      <BarButton label="后退" shortcut="Alt+←" disabled={!canGoBack} onClick={() => void moveHistory(-1)}>
        <ArrowLeft className="size-[16px]" />
      </BarButton>
      <BarButton label="前进" shortcut="Alt+→" disabled={!canGoForward} onClick={() => void moveHistory(1)}>
        <ArrowRight className="size-[16px]" />
      </BarButton>
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
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={shortcut ? `${label} ${shortcut}` : label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-[30px] items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
