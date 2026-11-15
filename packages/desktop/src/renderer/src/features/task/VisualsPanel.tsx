import { type MouseEvent, useState } from 'react'
import { Columns2, LayoutDashboard, PinOff, Rows2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type PinnedItem, useAppState } from '@/state/store'
import { Markdown } from './Markdown'
import { unpinItem } from './pins'
import { SidePanel } from './SidePanel'
import { LinkConfirm, VisualFrame } from './VisualCard'

// 白板（第 668 步起可视化，第 677 步起回答里的富块和过程卡片）：对话里点「固定到白板」的东西排在右侧栏，一列或两列并排看，
// 能把不同轮次的放在一起对比，对话往下翻也还在。只在内存里，退出应用就没了
export function VisualsPanel({ sessionId }: { sessionId: string }) {
  const all = useAppState((state) => state.pinned)
  const pinned = all.filter((item) => item.sessionId === sessionId)
  const [columns, setColumns] = useState<1 | 2>(2)
  return (
    <SidePanel
      width="wide"
      testId="visuals-panel"
      title="白板"
      controls={
        pinned.length > 1 && (
          <PanelAction label={columns === 2 ? '排成一列' : '两列并排'} onClick={() => setColumns(columns === 2 ? 1 : 2)}>
            {columns === 2 ? <Rows2 /> : <Columns2 />}
          </PanelAction>
        )
      }
    >
      {pinned.length === 0 ? (
        <EmptyState icon={LayoutDashboard} title="还没有固定的内容" description="在对话里的可视化、图表、表格或卡片上点「固定到白板」，它会排在这里，方便跨轮对照。" variant="plain" className="my-auto" />
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

// 卡片快照里的链接点了不跳（会把整个窗口导航走）
const stopLinks = (event: MouseEvent) => {
  if ((event.target as HTMLElement).closest('a')) event.preventDefault()
}

function PinnedCard({ item }: { item: PinnedItem }) {
  const [link, setLink] = useState<string | null>(null)
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-2.5 py-2" data-testid="pinned-visual" data-kind={item.kind} aria-label={item.title}>
      <header className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-bold">{item.title}</span>
        {item.from && <span className="shrink-0 text-xs text-muted-foreground">{item.from}</span>}
        <PanelAction label="从白板取下" onClick={() => unpinItem(item.sessionId, item.id)}>
          <PinOff />
        </PanelAction>
      </header>
      {item.kind === 'visual' && (
        <>
          {link && <LinkConfirm link={link} sessionId={item.sessionId} onDone={() => setLink(null)} />}
          <VisualFrame title={item.title} code={item.code} sessionId={item.sessionId} onLink={setLink} />
        </>
      )}
      {item.kind === 'block' && <Markdown text={item.text} />}
      {/* 我们自己画出来、去掉了按钮和脚本的卡片（static-html.tsx 的 snapshotHtml），不是模型给的 HTML */}
      {item.kind === 'card' && <div className="min-w-0 overflow-x-auto" onClickCapture={stopLinks} dangerouslySetInnerHTML={{ __html: item.html }} />}
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
