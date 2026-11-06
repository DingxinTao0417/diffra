import { useState } from 'react'
import { Bot, Settings2 } from 'lucide-react'
import { TopBar } from '@/components/TopBar'
import { Button } from '@/components/ui/button'
import { ModelSettings } from '@/features/models/ModelSettings'
import { SessionView } from '@/features/session/SessionView'

type View = 'session' | 'models'

export function App() {
  const [view, setView] = useState<View>('session')

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <nav className="w-40 shrink-0 space-y-1 border-r p-3">
          <Button variant={view === 'session' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setView('session')}>
            <Bot />
            会话
          </Button>
          <Button variant={view === 'models' ? 'secondary' : 'ghost'} className="w-full justify-start" onClick={() => setView('models')}>
            <Settings2 />
            模型
          </Button>
        </nav>
        {/* 两个页面都保持挂载，切换时会话进度不丢 */}
        <main className="min-w-0 flex-1">
          <div hidden={view !== 'session'} className="h-full">
            <SessionView onOpenModels={() => setView('models')} />
          </div>
          <div hidden={view !== 'models'} className="h-full overflow-y-auto">
            <div className="mx-auto max-w-4xl p-6">
              <ModelSettings />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
