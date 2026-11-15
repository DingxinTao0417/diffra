import { type RefObject, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

// 回答内搜索（第 675 步）：Ctrl+F（Mac 上 ⌘F）在对话里找字，命中处用浏览器的自定义高亮标出来（不改 DOM），
// 回车、Shift+回车上下跳，Esc 关掉。按需渲染跳过的轮次里的字也找得到（还在 DOM 里），收起的过程组里的不在 DOM 里，找不到
const MAX_MATCHES = 1000
const ALL = 'diffra-search'
const CURRENT = 'diffra-search-current'

type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): void }
const highlights = (): HighlightRegistry | null => ((globalThis.CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null)
const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight

// 文字节点按顺序拼起来找：高亮的代码、加粗的字会把一个词拆进几个元素，逐个节点找会漏；命中后再换回起止节点
function findRanges(root: HTMLElement, query: string, skip: HTMLElement | null): Range[] {
  const needle = query.toLowerCase()
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (skip?.contains(node) || node.parentElement?.closest('script, style, [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? ''
    const lower = value.toLowerCase()
    nodes.push(node as Text)
    starts.push(text.length)
    // 少数字符转小写后长度会变，那样的节点按原文比，位置才对得上
    text += lower.length === value.length ? lower : value
  }
  // 找出 offset 落在哪个节点里：最后一个起点不大于它的（结尾那一端取起点小于它的）
  const nodeAt = (offset: number, end: boolean) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (end ? starts[middle]! < offset : starts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return low
  }
  const ranges: Range[] = []
  for (let index = text.indexOf(needle); index >= 0 && ranges.length < MAX_MATCHES; index = text.indexOf(needle, index + needle.length)) {
    const first = nodeAt(index, false)
    const last = nodeAt(index + needle.length, true)
    const range = document.createRange()
    range.setStart(nodes[first]!, index - starts[first]!)
    range.setEnd(nodes[last]!, index + needle.length - starts[last]!)
    ranges.push(range)
  }
  return ranges
}

// 跳到命中处：放在可视区上面三分之一。在按需渲染跳过的轮次里时先滚到那一轮，等它画出来再算位置
function reveal(container: HTMLElement, range: Range) {
  const place = () => {
    const rect = range.getBoundingClientRect()
    if (rect.height === 0) return false
    const box = container.getBoundingClientRect()
    if (rect.top < box.top + 24 || rect.bottom > box.bottom - 24) container.scrollTop += rect.top - box.top - container.clientHeight / 3
    return true
  }
  if (place()) return
  const turn = range.startContainer.parentElement?.closest<HTMLElement>('[data-turn-id]')
  if (turn) container.scrollTop = turn.offsetTop - 16
  requestAnimationFrame(() => requestAnimationFrame(() => place()))
}

export function ConversationSearch({ root, version }: { root: RefObject<HTMLElement | null>; version: unknown }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)
  const bar = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // 改了要找的字：找到后跳到第一个；内容变了重新找时不跳
  const jump = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      // 代码编辑器、终端有自己的查找
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest('.cm-editor, .xterm')) return
      event.preventDefault()
      setOpen(true)
      requestAnimationFrame(() => input.current?.select())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 字变了、对话内容变了（流式输出、往前翻页）重新找；当前那一个尽量留在原处
  useEffect(() => {
    const element = root.current
    if (!open || !element || !query.trim()) {
      setRanges([])
      return
    }
    const found = findRanges(element, query.trim(), bar.current)
    setRanges(found)
    setCurrent((index) => Math.min(index, Math.max(0, found.length - 1)))
    if (jump.current && found[0]) reveal(element, found[0])
    jump.current = false
  }, [open, query, version, root])

  useEffect(() => {
    const registry = highlights()
    if (!registry || !Highlight) return
    if (ranges.length === 0) {
      registry.delete(ALL)
      registry.delete(CURRENT)
      return
    }
    registry.set(ALL, new Highlight(...ranges))
    const range = ranges[current]
    if (range) registry.set(CURRENT, new Highlight(range))
    return () => {
      registry.delete(ALL)
      registry.delete(CURRENT)
    }
  }, [ranges, current])

  const go = (step: number) => {
    if (ranges.length === 0 || !root.current) return
    const next = (current + step + ranges.length) % ranges.length
    setCurrent(next)
    reveal(root.current, ranges[next]!)
  }
  const close = () => {
    setOpen(false)
    setQuery('')
    setCurrent(0)
  }

  if (!open) return null
  const status = !query.trim() ? '' : ranges.length === 0 ? '没有找到' : `${current + 1}/${ranges.length}${ranges.length >= MAX_MATCHES ? '+' : ''}`
  return (
    <div ref={bar} role="search" className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-2.5 shadow-overlay" data-testid="conversation-search">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        value={query}
        aria-label="在对话里搜索"
        placeholder="在对话里搜索"
        className="h-7 w-44 min-w-0 bg-transparent text-sm outline-none"
        onChange={(event) => {
          jump.current = true
          setQuery(event.target.value)
          setCurrent(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            go(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="min-w-12 text-right text-xs text-muted-foreground tabular-nums" aria-live="polite" data-testid="conversation-search-count">
        {status}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="上一个" disabled={ranges.length === 0} onClick={() => go(-1)}>
        <ChevronUp />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="下一个" disabled={ranges.length === 0} onClick={() => go(1)}>
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="关闭搜索" onClick={close}>
        <X />
      </Button>
    </div>
  )
}
