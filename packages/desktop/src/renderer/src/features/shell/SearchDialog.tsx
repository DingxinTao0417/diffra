import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import type { SessionSearchResult } from '@diffra/core/types'
import { Search } from 'lucide-react'
import { cn } from 'cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { folderName, formatTime } from '@/lib/format'
import { openTask } from '@/state/actions'
import { store, useAppState } from '@/state/store'

const RECENT_LIMIT = 8

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
  const [results, setResults] = useState<SessionSearchResult[] | null>(null)
  const [selected, setSelected] = useState(0)

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

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResults(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      window.diffra.searchSessions(text).then(
        (found) => {
          if (stale) return
          setResults(found)
          setSelected(0)
        },
        (error: unknown) => console.error('搜索任务失败', error),
      )
    }, 150)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])

  const list = results ?? recent
  const pick = (item: SessionSearchResult | undefined) => {
    if (!item) return
    onClose()
    void openTask(item)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, list.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(list[selected])
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 text-muted-foreground" />
        <input
          aria-label="搜索任务"
          autoFocus
          value={query}
          placeholder="搜索任务标题和对话内容"
          className="h-12 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="text-xs text-muted-foreground">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
      </div>
      <div className="max-h-96 overflow-y-auto p-2" role="listbox" aria-label="搜索结果">
        {!results && <div className="px-2 py-1 text-xs text-muted-foreground">最近的任务</div>}
        {list.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{results ? '没有找到相关的任务' : '还没有任务'}</p>}
        {list.map((item, index) => (
          <button
            key={item.sessionId}
            type="button"
            role="option"
            aria-selected={index === selected}
            className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left', index === selected && 'bg-accent')}
            onMouseEnter={() => setSelected(index)}
            onClick={() => pick(item)}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">{item.title}</div>
              {item.snippet && <div className="truncate text-xs text-muted-foreground">{item.snippet}</div>}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{folderName(item.cwd)}</span>
            <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">{formatTime(item.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
