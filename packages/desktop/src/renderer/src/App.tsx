import { TopBar } from '@/components/TopBar'
import { ModelSettings } from '@/features/models/ModelSettings'

export function App() {
  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-6">
          <ModelSettings />
        </div>
      </main>
    </div>
  )
}
