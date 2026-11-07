import { useEffect } from 'react'
import { cn } from 'cn'
import type { MenuCommand } from '../../shared/ipc'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HomeView } from '@/features/home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { SearchDialog } from '@/features/shell/SearchDialog'
import { Sidebar } from '@/features/shell/Sidebar'
import { TitleBar } from '@/features/shell/TitleBar'
import { TaskView } from '@/features/task/TaskView'
import { toggleTerminalPanel, wireTerminalEvents } from '@/features/terminal/terminals'
import { errorMessage } from '@/lib/errors'
import { INSET_PANEL } from '@/lib/shell'
import { initialize, moveHistory, openHome, openSettings, pickProject, wireCoreEvents } from '@/state/actions'
import { showToast, store, useAppState } from '@/state/store'

const TOAST_MS = 3000

// 快捷键和中文菜单共用
function runCommand(command: MenuCommand): void {
  switch (command) {
    case 'new-task':
      return openHome()
    case 'open-project':
      pickProject().then(
        (picked) => picked && openHome(picked),
        (error: unknown) => showToast(errorMessage(error)),
      )
      return
    case 'settings':
      return openSettings()
    case 'toggle-sidebar':
      if (store.get().route.name !== 'settings') store.set((state) => ({ ...state, sidebarOpen: !state.sidebarOpen }))
      return
    case 'search':
      return store.set((state) => ({ ...state, searchOpen: !state.searchOpen }))
    case 'terminal': {
      // 终端面板只在任务页上有
      const { route, live } = store.get()
      const project = route.name === 'task' ? live[route.sessionId]?.project : undefined
      if (project) toggleTerminalPanel(project)
      return
    }
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

const CTRL_KEYS: Record<string, MenuCommand> = { k: 'search', b: 'toggle-sidebar', ',': 'settings', '`': 'terminal' }

export function App() {
  const route = useAppState((state) => state.route)
  const sidebarOpen = useAppState((state) => state.sidebarOpen)

  useEffect(() => {
    const unwire = wireCoreEvents()
    const unwireTerminals = wireTerminalEvents()
    void initialize()
    return () => {
      unwire()
      unwireTerminals()
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
              {sidebarOpen && <Sidebar />}
              <main className={cn('min-w-0 flex-1', INSET_PANEL, !sidebarOpen && 'rounded-tl-none border-l-0')}>
                {route.name === 'home' && <HomeView projectPath={route.project} />}
                {route.name === 'task' && <TaskView sessionId={route.sessionId} />}
              </main>
            </>
          )}
        </div>
      </div>
      <SearchDialog />
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
    <div role="status" className="fixed bottom-6 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-lg">
      {toast.text}
    </div>
  )
}
