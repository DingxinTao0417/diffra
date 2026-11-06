import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HomeView } from '@/features/home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { SearchDialog } from '@/features/shell/SearchDialog'
import { Sidebar } from '@/features/shell/Sidebar'
import { TaskView } from '@/features/task/TaskView'
import { toggleTerminalPanel, wireTerminalEvents } from '@/features/terminal/terminals'
import { initialize, openSettings, wireCoreEvents } from '@/state/actions'
import { store, useAppState } from '@/state/store'

const TOAST_MS = 3000

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
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      // 焦点在终端里时 Ctrl+K、Ctrl+B 等是 shell 的按键，只保留切换终端
      const inTerminal = event.target instanceof Element && event.target.closest('.xterm') !== null
      if (inTerminal && key !== '`') return
      if (key === 'k') {
        event.preventDefault()
        store.set((state) => ({ ...state, searchOpen: !state.searchOpen }))
      } else if (key === 'b') {
        event.preventDefault()
        store.set((state) => ({ ...state, sidebarOpen: !state.sidebarOpen }))
      } else if (key === ',') {
        event.preventDefault()
        openSettings()
      } else if (key === '`') {
        // 终端面板只在任务页上有
        const { route, live } = store.get()
        const project = route.name === 'task' ? live[route.sessionId]?.project : undefined
        if (project) {
          event.preventDefault()
          toggleTerminalPanel(project)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen bg-background">
        {sidebarOpen && route.name !== 'settings' && <Sidebar />}
        <main className="min-w-0 flex-1">
          {route.name === 'home' && <HomeView projectPath={route.project} />}
          {route.name === 'task' && <TaskView sessionId={route.sessionId} />}
          {route.name === 'settings' && <SettingsView section={route.section} />}
        </main>
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
