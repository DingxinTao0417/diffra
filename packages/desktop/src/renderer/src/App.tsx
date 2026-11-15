import { useCallback, useEffect, useLayoutEffect } from 'react'
import { cn } from 'cn'
import type { MenuCommand } from '../../shared/ipc'
import { REMOTE_DEVICE_CONNECTION_ENABLED } from '../../shared/remote'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ArchitectureView } from '@/features/architecture/ArchitectureView'
import { ExtensionsView } from '@/features/extensions/ExtensionsView'
import { HomeView } from '@/features/home/HomeView'
import { UpdateNoticeDialog } from '@/features/settings/Changelog'
import { PairRequestDialog } from '@/features/devices/PairRequestDialog'
import { RemoteTaskView } from '@/features/devices/RemoteTaskView'
import { SettingsView } from '@/features/settings/SettingsView'
import { SearchDialog } from '@/features/shell/SearchDialog'
import { openProjectFolder, Sidebar } from '@/features/shell/Sidebar'
import { TitleBar } from '@/features/shell/TitleBar'
import { TaskView } from '@/features/task/TaskView'
import { toggleTerminalPanel, wireTerminalEvents } from '@/features/terminal/terminals'
import { QuickTodo, TodosView } from '@/features/todos/TodosView'
import { errorMessage } from '@/lib/errors'
import { IS_MAC } from '@/lib/platform'
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

// Mac：⌘K、⌘B、⌘,、⌘J；终端开关是 ⌃`；后退前进是 ⌘[、⌘]。Ctrl+K、Ctrl+B 这些在 Mac 的输入框里是移动光标的按键，不拦；
// ⌥← 在输入框里是按词移动，也不拦。焦点在终端里时同样只保留切换终端
const MAC_CMD_KEYS: Record<string, MenuCommand> = { k: 'search', b: 'toggle-sidebar', ',': 'settings', j: 'quick-todo', '[': 'back', ']': 'forward' }

function onMacKeyDown(event: KeyboardEvent, inTerminal: boolean): void {
  if (event.altKey || event.shiftKey) return
  let command: MenuCommand | undefined
  if (event.ctrlKey && !event.metaKey && event.key === '`') command = 'terminal'
  else if (event.metaKey && !event.ctrlKey) command = MAC_CMD_KEYS[event.key.toLowerCase()]
  if (!command || (inTerminal && command !== 'terminal')) return
  event.preventDefault()
  runCommand(command)
}

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
      if (IS_MAC) return onMacKeyDown(event, inTerminal)
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
              {/* Mac 没有单独的顶栏：侧栏在时内容面板顶到窗口上沿（留 8px）；侧栏收起时顶上留一条放红绿灯和按钮（MAC_CHROME_HEIGHT） */}
              <main ref={route.name === 'home' || route.name === 'design' ? columnRef : undefined} className={cn('min-w-0 flex-1', INSET_PANEL, !sidebarShown && 'rounded-tl-none border-l-0', IS_MAC && (sidebarShown ? 'mt-2' : 'border-t-0 pt-[40px]'))}>
                {route.name === 'home' && <HomeView key="home" projectPath={route.project} />}
                {route.name === 'design' && <HomeView key="design" design projectPath={route.project} />}
                {route.name === 'task' && <TaskView sessionId={route.sessionId} columnRef={columnRef} />}
                {REMOTE_DEVICE_CONNECTION_ENABLED && route.name === 'remote-task' && (
                  <RemoteTaskView key={`${route.deviceId}/${route.sessionId}`} deviceId={route.deviceId} sessionId={route.sessionId} />
                )}
                {route.name === 'todos' && <TodosView />}
                {route.name === 'extensions' && <ExtensionsView tab={route.tab} />}
                {route.name === 'architecture' && <ArchitectureView route={route} />}
              </main>
            </>
          )}
        </div>
      </div>
      <SearchDialog />
      <QuickTodo />
      <UpdateNoticeDialog />
      {REMOTE_DEVICE_CONNECTION_ENABLED && <PairRequestDialog />}
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
    <div role="status" className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-overlay">
      {toast.text}
    </div>
  )
}
