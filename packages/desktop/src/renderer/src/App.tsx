import { useCallback, useEffect, useLayoutEffect } from 'react'
import { cn } from 'cn'
import type { MenuCommand } from '../../shared/ipc'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HomeView } from '@/features/home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { SearchDialog } from '@/features/shell/SearchDialog'
import { openProjectFolder, Sidebar } from '@/features/shell/Sidebar'
import { TitleBar } from '@/features/shell/TitleBar'
import { TaskView } from '@/features/task/TaskView'
import { toggleTerminalPanel, wireTerminalEvents } from '@/features/terminal/terminals'
import { QuickTodo, TodosView } from '@/features/todos/TodosView'
import { errorMessage } from '@/lib/errors'
import { INSET_PANEL } from '@/lib/shell'
import { initialize, moveHistory, openHome, openSettings, openTodos, setSidebarNarrow, toggleSidebar, wireCoreEvents } from '@/state/actions'
import { startTodoScheduler } from '@/state/todo-scheduler'
import { hasWidePanel, isSidebarShown, showToast, store, useAppState } from '@/state/store'

const TOAST_MS = 3000
// 主列（任务页的对话列，首页的 main）窄于这个宽度时自动收起侧栏。
// 默认 1200 宽窗口在「大」字号下开着监控面板时对话列约 584px，阈值不能高过它，否则一打开任务侧栏就没了
const NARROW_COLUMN_PX = 520

// 快捷键和中文菜单共用
function runCommand(command: MenuCommand): void {
  switch (command) {
    case 'new-task':
      return openHome()
    case 'open-project':
      return openProjectFolder()
    case 'settings':
      return openSettings()
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'search':
      return store.set((state) => ({ ...state, searchOpen: !state.searchOpen }))
    case 'terminal': {
      // 终端面板只在任务页上有
      const { route, live } = store.get()
      const project = route.name === 'task' ? live[route.sessionId]?.project : undefined
      if (project) toggleTerminalPanel(project)
      return
    }
    case 'quick-todo':
      return store.set((state) => ({ ...state, quickTodoOpen: true }))
    case 'back':
      return void moveHistory(-1)
    case 'forward':
      return void moveHistory(1)
    case 'check-updates':
      openSettings('about')
      window.diffra.checkForUpdates().catch((error: unknown) => showToast(`检查更新失败：${errorMessage(error)}`))
      return
    case 'about':
      return openSettings('about')
  }
}

const CTRL_KEYS: Record<string, MenuCommand> = { k: 'search', b: 'toggle-sidebar', ',': 'settings', '`': 'terminal', j: 'quick-todo' }

function sidebarWidth(): number {
  // 默认的 --sidebar-w 用 rem 写，跟着「文字大小」缩放；拖过之后是像素
  const root = getComputedStyle(document.documentElement)
  const value = root.getPropertyValue('--sidebar-w').trim()
  return value.endsWith('px') ? parseFloat(value) : parseFloat(value) * parseFloat(root.fontSize)
}

export function App() {
  const route = useAppState((state) => state.route)
  const sidebarShown = useAppState(isSidebarShown)
  const sidebarPx = useAppState((state) => state.settings?.layout.sidebarWidth ?? null)

  useLayoutEffect(() => {
    const root = document.documentElement.style
    if (sidebarPx === null) root.removeProperty('--sidebar-w')
    else root.setProperty('--sidebar-w', `${sidebarPx}px`)
  }, [sidebarPx])

  const columnRef = useCallback((element: HTMLElement | null) => {
    if (!element) return
    const observer = new ResizeObserver(() => {
      const state = store.get()
      if (hasWidePanel(state)) return setSidebarNarrow(false)
      // 侧栏没显示时按显示后的宽度估算；减去侧栏全宽是偏保守的，侧栏出现后不会马上又被收起
      const width = isSidebarShown(state) ? element.clientWidth : element.clientWidth - sidebarWidth()
      setSidebarNarrow(width < NARROW_COLUMN_PX)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const unwire = wireCoreEvents()
    const unwireTerminals = wireTerminalEvents()
    const stopTodoScheduler = startTodoScheduler()
    // 点了待办的系统通知：打开待办页，定位到那一条
    const offTodoFocus = window.diffra.onTodoFocus((todoId) => {
      openTodos()
      store.set((state) => ({ ...state, todoFocus: todoId }))
    })
    void initialize()
    return () => {
      unwire()
      unwireTerminals()
      stopTodoScheduler()
      offTodoFocus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 焦点在终端里时 Ctrl+K、Ctrl+B、Alt+← 等是 shell 的按键，只保留切换终端
      const inTerminal = event.target instanceof Element && event.target.closest('.xterm') !== null
      const arrow = event.key === 'ArrowLeft' ? 'back' : event.key === 'ArrowRight' ? 'forward' : null
      if (arrow && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (inTerminal) return
        event.preventDefault()
        runCommand(arrow)
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const command = CTRL_KEYS[event.key.toLowerCase()]
      if (!command || (inTerminal && command !== 'terminal')) return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKeyDown)
    const offMenu = window.diffra.onMenuCommand(runCommand)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      offMenu()
    }
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col bg-sidebar">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {route.name === 'settings' ? (
            <SettingsView section={route.section} />
          ) : (
            <>
              {sidebarShown && <Sidebar />}
              <main ref={route.name === 'home' || route.name === 'design' ? columnRef : undefined} className={cn('min-w-0 flex-1', INSET_PANEL, !sidebarShown && 'rounded-tl-none border-l-0')}>
                {route.name === 'home' && <HomeView key="home" projectPath={route.project} />}
                {route.name === 'design' && <HomeView key="design" design projectPath={route.project} />}
                {route.name === 'task' && <TaskView sessionId={route.sessionId} columnRef={columnRef} />}
                {route.name === 'todos' && <TodosView />}
              </main>
            </>
          )}
        </div>
      </div>
      <SearchDialog />
      <QuickTodo />
      <Toast />
    </TooltipProvider>
  )
}

function Toast() {
  const toast = useAppState((state) => state.toast)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => store.set((state) => (state.toast?.id === toast.id ? { ...state, toast: null } : state)), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])
  if (!toast) return null
  return (
    <div role="status" className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-lg">
      {toast.text}
    </div>
  )
}
