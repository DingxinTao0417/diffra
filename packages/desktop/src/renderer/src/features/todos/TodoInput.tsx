import { useMemo, useState } from 'react'
import { AlarmClock, Check, ChevronDown, Folder, FolderDot, FolderOpen, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { errorMessage } from '@/lib/errors'
import { folderName } from '@/lib/format'
import { formatDue } from '@/lib/todo-time'
import { useNow } from '@/lib/use-now'
import { addTodo, pickProject } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'
import { SchedulePicker } from './SchedulePicker'
import { TodoTagEditor } from './TodoTagEditor'

const PROJECT_MENU = 'flex h-7 max-w-48 items-center gap-1 rounded-md border bg-background px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground'

// 记待办的输入框：回车保存；旁边的闹钟先定个提醒时间（定时发送在记下以后从那一条上设）。defaultAt 是日历里选中的那天
export function TodoInput({
  autoFocus = false,
  placeholder = '记下一个点子，回车保存',
  defaultAt,
  className,
  showMeta = true,
}: {
  autoFocus?: boolean
  placeholder?: string
  defaultAt?: Date
  className?: string
  // 日历右边很窄，只保留记一条的输入框；标签和项目可以在列表里再改
  showMeta?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [at, setAt] = useState<Date | null>(null)
  const [project, setProject] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const now = useNow()
  const due = at ?? defaultAt ?? null
  const submit = () => {
    if (!draft.trim()) return
    void addTodo(draft, due ?? undefined, { project, tags })
    setDraft('')
    setAt(null)
    setTags([])
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <div className={cn('flex h-11 w-full items-center gap-1 rounded-xl border bg-background pr-1.5 pl-4 focus-within:border-ring/60', className)}>
        <input
          aria-label="新待办"
          value={draft}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent outline-none"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
        />
        {at && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-soft px-2 py-0.5 text-xs" data-testid="todo-input-due">
            提醒 {formatDue(at.toISOString(), now)}
            <button type="button" aria-label="不定时间" className="text-muted-foreground hover:text-foreground" onClick={() => setAt(null)}>
              <X className="size-3" />
            </button>
          </span>
        )}
        <SchedulePicker value={due} onPick={(picked) => setAt(picked)}>
          <Button variant="ghost" size="icon-sm" aria-label="定个提醒时间" className="text-muted-foreground">
            <AlarmClock className="size-4" />
          </Button>
        </SchedulePicker>
      </div>
      {showMeta && (
        <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
          <TodoProjectPicker value={project} onChange={setProject} />
          <TodoTagEditor tags={tags} onChange={setTags} className="min-w-48 flex-1" />
        </div>
      )}
    </div>
  )
}

// 记待办时指定一个已有项目；不要求这个项目已经固定在侧边栏里
function TodoProjectPicker({ value, onChange }: { value: string | null; onChange(path: string | null): void }) {
  const projects = useAppState((state) => state.projects)
  const tasks = useAppState((state) => state.tasks)
  const known = useMemo(() => {
    const seen = new Set<string>()
    return [...(value ? [value] : []), ...projects, ...tasks.filter((task) => !task.noProject).map((task) => task.cwd)].filter((path) => {
      const key = path.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [value, projects, tasks])
  const chooseFolder = () => {
    void pickProject().then(
      (picked) => picked && onChange(picked),
      (error: unknown) => showToast(`选择项目失败：${errorMessage(error)}`),
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="待办项目" data-testid="todo-project-picker" className={PROJECT_MENU}>
          {value ? <Folder className="size-3.5 shrink-0" /> : <FolderDot className="size-3.5 shrink-0" />}
          <span className="truncate">{value ? folderName(value) : '无项目'}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-64">
        <DropdownMenuLabel>固定项目</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <FolderDot />
          <span className="flex-1">无项目</span>
          {/* primary-color-allow: 选中标记 */}
          {value === null && <Check className="text-primary" />}
        </DropdownMenuItem>
        {known.map((path) => (
          <DropdownMenuItem key={path} title={path} onSelect={() => onChange(path)}>
            <Folder />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{folderName(path)}</span>
              <span className="truncate text-xs text-muted-foreground">{path}</span>
            </span>
            {/* primary-color-allow: 选中标记 */}
            {value === path && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={chooseFolder}>
          <FolderOpen />
          选择文件夹…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
