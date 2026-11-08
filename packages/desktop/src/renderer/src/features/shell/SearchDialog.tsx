import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import type { SessionSearchResult } from '@diffra/core/types'
import { Search } from 'lucide-react'
import { cn } from 'cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { folderName, formatTime } from '@/lib/format'
import { openTask } from '@/state/actions'
import { store, useAppState } from '@/state/store'

const RECENT_LIMIT = 8

interface Searched {
  text: string
  items: SessionSearchResult[]
  failed: boolean
}

export function SearchDialog() {
  const open = useAppState((state) => state.searchOpen)
  const close = () => store.set((state) => ({ ...state, searchOpen: false }))
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">搜索任务</DialogTitle>
        <DialogDescription className="sr-only">按标题和对话内容搜索任务</DialogDescription>
        {open && <SearchBody onClose={close} />}
      </DialogContent>
    </Dialog>
  )
}

function SearchBody({ onClose }: { onClose(): void }) {
  const tasks = useAppState((state) => state.tasks)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState<Searched | null>(null)
  const [selected, setSelected] = useState(0)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`

  // 没输入时列出最近的任务
  const recent = useMemo<SessionSearchResult[]>(
    () =>
      [...tasks]
        .filter((task) => !task.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT_LIMIT)
        .map((task) => ({ sessionId: task.sessionId, cwd: task.cwd, title: task.title, updatedAt: task.updatedAt, snippet: '' })),
    [tasks],
  )

  const text = query.trim()
  useEffect(() => {
    if (!text) {
      setSearched(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      window.diffra.searchSessions(text).then(
        (found) => {
          if (stale) return
          setSearched({ text, items: found, failed: false })
          setSelected(0)
        },
        (error: unknown) => {
          console.error('搜索任务失败', error)
          if (stale) return
          setSearched({ text, items: [], failed: true })
          setSelected(0)
        },
      )
    }, 150)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text])

  // 搜索期间继续显示上一次的结果，不回落到最近任务，列表不会来回跳
  const searching = text !== '' && searched?.text !== text
  const list = text ? (searched?.items ?? []) : recent
  const highlight = text ? (searched?.text ?? '') : ''
  const heading = !text ? '最近的任务' : searching ? '搜索中…' : '搜索结果'
  const emptyText = !text ? '还没有任务' : searching ? '' : searched?.failed ? '搜索失败，请重试' : '没有找到相关任务'

  const pick = (item: SessionSearchResult | undefined) => {
    if (!item) return
    onClose()
    void openTask(item)
  }

  const move = (next: number) => {
    setSelected(next)
    document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (list.length > 0) move(Math.min(selected + 1, list.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (list.length > 0) move(Math.max(selected - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(list[selected])
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="搜索任务"
          aria-autocomplete="list"
          aria-expanded={list.length > 0}
          aria-controls={listId}
          aria-activedescendant={list[selected] ? optionId(selected) : undefined}
          autoFocus
          value={query}
          placeholder="搜索任务标题和对话内容"
          className="h-12 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className={cn('flex max-h-96 flex-col overflow-y-auto p-2', text && 'min-h-64')}>
        <div aria-live="polite" className="px-3 py-1 text-xs text-muted-foreground">
          {heading}
        </div>
        <div id={listId} role="listbox" aria-label="搜索结果" className="flex shrink-0 flex-col">
          {list.map((item, index) => {
            const showSnippet = item.snippet !== '' && item.snippet !== item.title
            return (
              <div
                key={item.sessionId}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                className={cn('flex cursor-default flex-col gap-0.5 rounded-lg px-3 py-2', index === selected && 'bg-accent')}
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => setSelected(index)}
                onClick={() => pick(item)}
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{highlightMatch(item.title, showSnippet ? '' : highlight)}</span>
                  <span className={cn('max-w-44 shrink-0 truncate rounded-sm px-1.5 text-xs text-muted-foreground', index === selected ? 'bg-background/60' : 'bg-muted')}>{folderName(item.cwd)}</span>
                  <span className="min-w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatTime(item.updatedAt)}</span>
                </div>
                {showSnippet && <div className="truncate text-xs text-muted-foreground">{highlightMatch(item.snippet, highlight)}</div>}
              </div>
            )
          })}
        </div>
        {list.length === 0 && emptyText && <p className="flex flex-1 items-center justify-center px-3 py-6 text-sm text-muted-foreground">{emptyText}</p>}
      </div>
      <div className="flex items-center gap-4 border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd>打开
        </span>
        <span className="inline-flex items-center gap-1.5">
          <KbdGroup>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </KbdGroup>
          选择
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>Esc</Kbd>关闭
        </span>
      </div>
    </div>
  )
}

// 和 core 的搜索一致：不区分大小写的子串匹配
function highlightMatch(value: string, needle: string): ReactNode {
  if (!needle) return value
  const lower = value.toLowerCase()
  const target = needle.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let at = lower.indexOf(target)
  while (at >= 0) {
    if (at > from) parts.push(value.slice(from, at))
    parts.push(
      <mark key={at} className="rounded-sm bg-highlight px-0.5 text-foreground">
        {value.slice(at, at + target.length)}
      </mark>,
    )
    from = at + target.length
    at = lower.indexOf(target, from)
  }
  if (parts.length === 0) return value
  if (from < value.length) parts.push(value.slice(from))
  return parts
}
