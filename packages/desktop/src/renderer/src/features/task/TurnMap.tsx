import { type ReactNode, type RefObject, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import type { TranscriptItem } from '@/features/session/transcript'

// 对话地图（第 691 步）：一轮里做了什么一眼看全——步骤（工具调用按种类分组）、改了的文件、回答里的图表和卡片、要你拿主意的地方（提问、决策卡、方案对比）。
// 点一项滚到它在对话里的位置：工具调用和改动走 onLocate（收起的过程组会展开、闪一下底色），回答里的块直接滚过去、闪一圈边框

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type Target = { item: string } | { element: HTMLElement }
type Entry = { key: string; label: string; failed?: boolean; target: Target }

// 一个种类最多先列这么多，多的点「还有 N 个」
const PER_GROUP = 24
// Diffra 自己的检查、审查和完成卡（cardOf 是对话里决定怎么画这张卡的那个分类）
const CHECK_CARDS = new Set(['check', 'review', 'architecture', 'security', 'deep-scan', 'verify', 'finish'])
// 按这个顺序认（检查命令也是 execute，先认成检查），显示时检查排在智能体自己的步骤后面（DISPLAY_ORDER）
const TOOL_GROUPS: Array<{ label: string; match(item: ToolItem, card: string | null): boolean }> = [
  { label: '检查', match: (_item, card) => card !== null && CHECK_CARDS.has(card) },
  { label: '读', match: (item) => item.toolKind === 'read' },
  { label: '搜索', match: (item) => item.toolKind === 'search' },
  { label: '改', match: (item) => item.toolKind === 'edit' || item.toolKind === 'delete' || item.toolKind === 'move' || item.content.some((content) => content.type === 'diff') },
  { label: '命令', match: (item) => item.toolKind === 'execute' },
  { label: '网页', match: (item) => item.toolKind === 'fetch' },
  { label: '子智能体', match: (item) => Boolean(item.agentCard) },
  { label: '其他', match: () => true },
]
const DISPLAY_ORDER = ['读', '搜索', '改', '命令', '网页', '子智能体', '检查', '其他']
// 回答里不算「图表和卡片」的块：代码、补丁、JSON、日志是原文
const PLAIN_KINDS = new Set(['code', 'diff', 'json', 'log'])
const DECISION_KINDS = new Set(['decision', 'compare'])
const ASK_PREFIX = '提问 '

export function TurnMap({ items, files, root, cardOf, onLocate, onClose }: { items: TranscriptItem[]; files: Array<{ path: string; added: number; removed: number }>; root: RefObject<HTMLElement | null>; cardOf(item: ToolItem): string | null; onLocate(id: string): void; onClose(): void }) {
  const [blocks, setBlocks] = useState<Array<{ kind: string; title: string; element: HTMLElement }>>([])
  // 回答里的块从页面上找（富块、流程图、插件块都有 data-kind）。按需加载的块（图表、架构图）晚一点才画出来，回答也可能还在写：
  // 地图开着时看着这一轮的 DOM，块真的变了才更新（地图自己的变化不算，不然会来回触发）
  useEffect(() => {
    const section = root.current
    if (!section) return
    const collect = () => {
      const found = [...section.querySelectorAll<HTMLElement>('[data-testid="agent-message"] [data-kind]')].filter((element) => !PLAIN_KINDS.has(element.dataset.kind ?? '') && !element.parentElement?.closest('[data-kind]'))
      const next = found.map((element) => ({ kind: element.dataset.kind!, title: titleOf(element), element }))
      setBlocks((current) => (current.length === next.length && current.every((block, index) => block.element === next[index]!.element && block.title === next[index]!.title) ? current : next))
    }
    collect()
    const observer = new MutationObserver(collect)
    observer.observe(section, { subtree: true, childList: true })
    return () => observer.disconnect()
  }, [root])

  const tools = useMemo(() => items.filter((item): item is ToolItem => item.kind === 'tool' && !item.parentId), [items])
  const steps = useMemo(() => {
    const plain = tools.filter((item) => !item.visual && !item.title.startsWith(ASK_PREFIX))
    const groups = TOOL_GROUPS.map((group) => ({ label: group.label, entries: [] as Entry[] }))
    for (const item of plain) {
      const card = cardOf(item)
      const index = TOOL_GROUPS.findIndex((group) => group.match(item, card))
      groups[index]!.entries.push({ key: item.id, label: item.title, failed: item.status === 'failed' || item.succeeded === false, target: { item: item.id } })
    }
    return groups.filter((group) => group.entries.length > 0).sort((a, b) => DISPLAY_ORDER.indexOf(a.label) - DISPLAY_ORDER.indexOf(b.label))
  }, [tools, cardOf])
  // 改了的文件指向最后一次改它的那一步
  const fileEntries = useMemo<Entry[]>(
    () =>
      files.flatMap((file) => {
        const last = tools.findLast((item) => item.content.some((content) => content.type === 'diff' && content.path === file.path))
        return last ? [{ key: file.path, label: `${file.path.split(/[\\/]/).pop()} +${file.added} −${file.removed}`, target: { item: last.id } }] : []
      }),
    [files, tools],
  )
  const charts: Entry[] = [
    ...tools.filter((item) => item.visual).map((item) => ({ key: item.id, label: item.visual!.title, target: { item: item.id } })),
    ...blocks.filter((block) => !DECISION_KINDS.has(block.kind)).map((block, index) => ({ key: `block-${index}`, label: block.title, target: { element: block.element } })),
  ]
  const decisions: Entry[] = [
    ...tools.filter((item) => item.title.startsWith(ASK_PREFIX)).map((item) => ({ key: item.id, label: item.title.slice(ASK_PREFIX.length), target: { item: item.id } })),
    ...blocks.filter((block) => DECISION_KINDS.has(block.kind)).map((block, index) => ({ key: `decision-${index}`, label: block.title, target: { element: block.element } })),
  ]
  const go = (target: Target) => ('item' in target ? onLocate(target.item) : scrollToElement(target.element))
  const empty = steps.length === 0 && fileEntries.length === 0 && charts.length === 0 && decisions.length === 0

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm" role="region" aria-label="这一轮的地图" data-testid="turn-map">
      <div className="flex items-center gap-2">
        <span className="font-bold">这一轮的地图</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {tools.length} 步 · {files.length} 个文件 · {charts.length} 张图表和卡片
        </span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="收起这一轮的地图" onClick={onClose}>
          <X />
        </Button>
      </div>
      {empty && <p className="text-muted-foreground">这一轮没有工具调用、改动或图表。</p>}
      {steps.length > 0 && (
        <MapSection label="步骤" testId="turn-map-steps">
          <div className="flex flex-col gap-1">
            {steps.map((group) => (
              <Group key={group.label} label={`${group.label} ${group.entries.length}`} entries={group.entries} onGo={go} />
            ))}
          </div>
        </MapSection>
      )}
      {fileEntries.length > 0 && (
        <MapSection label="文件" testId="turn-map-files">
          <Group entries={fileEntries} onGo={go} />
        </MapSection>
      )}
      {charts.length > 0 && (
        <MapSection label="图表和卡片" testId="turn-map-charts">
          <Group entries={charts} onGo={go} />
        </MapSection>
      )}
      {decisions.length > 0 && (
        <MapSection label="要你定的" testId="turn-map-decisions">
          <Group entries={decisions} onGo={go} />
        </MapSection>
      )}
    </div>
  )
}

function MapSection({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2" data-testid={testId}>
      <span className="pt-0.5 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Group({ label, entries, onGo }: { label?: string; entries: Entry[]; onGo(target: Target): void }) {
  const [all, setAll] = useState(false)
  const shown = all ? entries : entries.slice(0, PER_GROUP)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {label && <span className="mr-0.5 text-xs text-muted-foreground tabular-nums">{label}</span>}
      {shown.map((entry) => (
        <button
          key={entry.key}
          type="button"
          title={entry.label}
          className={cn('max-w-64 truncate rounded-md border px-1.5 py-0.5 text-xs hover:bg-muted', entry.failed && 'border-destructive/40 text-destructive')}
          data-testid="turn-map-entry"
          onClick={() => onGo(entry.target)}
        >
          {entry.failed ? `${entry.label}（失败）` : entry.label}
        </button>
      ))}
      {entries.length > shown.length && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          还有 {entries.length - shown.length} 个
        </button>
      )}
    </div>
  )
}

// 块的标题：BlockShell 标题栏里的标题，或者块自己的 figcaption；都没有用种类
function titleOf(element: HTMLElement): string {
  const caption = element.querySelector(':scope > figcaption')
  const title = caption?.querySelector(':scope > span.min-w-0') ?? caption?.firstElementChild ?? caption
  return title?.textContent?.trim() || KIND_NAMES[element.dataset.kind!.replace(/^chart-.*/, 'chart')] || element.dataset.kind!
}

const KIND_NAMES: Record<string, string> = { chart: '图表', metrics: '指标卡', table: '表格', timeline: '时间线', steps: '步骤', compare: '方案对比', filetree: '文件树', keyvalue: '键值表', todos: '后续事项', annotate: '图上标注', decision: '决策卡', depgraph: '架构图', mermaid: '流程图' }

// 滚到对话里的这个块：和定位工具调用一样，只滚对话这一栏（scrollIntoView 会连带滚动外壳），闪一圈边框
function scrollToElement(element: HTMLElement) {
  const scroller = element.closest<HTMLElement>('[data-conversation-scroll]')
  const smooth = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  if (scroller) scroller.scrollTo({ top: scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3, behavior: smooth })
  element.animate([{ boxShadow: '0 0 0 3px var(--ring)' }, { boxShadow: '0 0 0 3px transparent' }], { duration: 1500, easing: 'ease-out' })
}
