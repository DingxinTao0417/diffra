import { useState } from 'react'
import { Columns2, LayoutDashboard, PinOff, Rows2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type PinnedVisual, store, useAppState } from '@/state/store'
import { SidePanel } from './SidePanel'
import { LinkConfirm, VisualFrame } from './VisualCard'

// 可视化白板（第 668 步）：对话里点「固定到白板」的可视化排在右侧栏，一列或两列并排看，对话往下翻也还在。只在内存里，退出应用就没了
export function VisualsPanel({ sessionId }: { sessionId: string }) {
  const all = useAppState((state) => state.pinnedVisuals)
  const pinned = all.filter((item) => item.sessionId === sessionId)
  const [columns, setColumns] = useState<1 | 2>(2)
  return (
    <SidePanel
      width="wide"
      testId="visuals-panel"
      title="可视化白板"
      controls={
        pinned.length > 1 && (
          <PanelAction label={columns === 2 ? '排成一列' : '两列并排'} onClick={() => setColumns(columns === 2 ? 1 : 2)}>
            {columns === 2 ? <Rows2 /> : <Columns2 />}
          </PanelAction>
        )
      }
    >
      {pinned.length === 0 ? (
        <EmptyState icon={LayoutDashboard} title="还没有固定的可视化" description="在对话里的可视化卡片上点「固定到白板」，它会排在这里，方便并排对照。" variant="plain" className="my-auto" />
      ) : (
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {pinned.map((item) => (
            <PinnedCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </SidePanel>
  )
}

function PinnedCard({ item }: { item: PinnedVisual }) {
  const [link, setLink] = useState<string | null>(null)
  const unpin = () => store.set((state) => ({ ...state, pinnedVisuals: state.pinnedVisuals.filter((entry) => !(entry.sessionId === item.sessionId && entry.id === item.id)) }))
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-2.5 py-2" data-testid="pinned-visual" aria-label={item.title}>
      <header className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-bold">{item.title}</span>
        <PanelAction label="从白板取下" onClick={unpin}>
          <PinOff />
        </PanelAction>
      </header>
      {link && <LinkConfirm link={link} sessionId={item.sessionId} onDone={() => setLink(null)} />}
      <VisualFrame title={item.title} code={item.code} sessionId={item.sessionId} onLink={setLink} />
    </section>
  )
}

function PanelAction({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
