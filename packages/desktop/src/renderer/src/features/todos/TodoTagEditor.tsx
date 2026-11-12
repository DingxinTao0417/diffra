import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from 'cn'
import { normalizeTodoTags, TODO_MAX_TAGS, TODO_MAX_TAG_INPUT } from '../../../../shared/todos'
import { useAppState } from '@/state/store'

const MAX_SUGGESTIONS = 12

// 待办标签：Enter 或逗号确认，退格在空输入时删掉最后一个；记下之前和记下之后都能改。
// 输入框有焦点时下面列出已有的标签（按输入过滤），点一下就加上，不用每次手打
export function TodoTagEditor({
  tags,
  onChange,
  autoFocus = false,
  placeholder = '添加标签',
  className,
}: {
  tags: string[]
  onChange(tags: string[]): void
  autoFocus?: boolean
  placeholder?: string
  className?: string
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const todos = useAppState((state) => state.todos)
  const suggestions = useMemo(() => {
    const chosen = new Set(tags.map((tag) => tag.toLowerCase()))
    const words = text.trim().replace(/^#+/, '').toLowerCase()
    const known = [...new Set((todos ?? []).flatMap((todo) => todo.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    return known.filter((tag) => !chosen.has(tag.toLowerCase()) && tag.toLowerCase().includes(words)).slice(0, MAX_SUGGESTIONS)
  }, [todos, tags, text])
  const commit = () => {
    if (text.trim() === '') return
    onChange(normalizeTodoTags([...tags, text]))
    setText('')
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="todo-tag-editor">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-0.5 rounded-full bg-soft py-0.5 pr-0.5 pl-1.5 text-xs text-foreground"
            data-testid="todo-tag"
          >
            #{tag}
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background/60 hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}
        {tags.length < TODO_MAX_TAGS && (
          <input
            aria-label={placeholder}
            value={text}
            autoFocus={autoFocus}
            maxLength={TODO_MAX_TAG_INPUT}
            placeholder={placeholder}
            className="h-6 min-w-20 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              const value = event.target.value
              // 中文输入法里打出的逗号不一定触发 keydown，输入完直接拆成标签
              if (/[,，]$/.test(value)) {
                onChange(normalizeTodoTags([...tags, value]))
                setText('')
              } else {
                setText(value)
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              commit()
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                event.preventDefault()
                event.stopPropagation()
                commit()
              } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
                event.preventDefault()
                onChange(tags.slice(0, -1))
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setText('')
                event.currentTarget.blur()
              }
            }}
          />
        )}
      </div>
      {focused && suggestions.length > 0 && tags.length < TODO_MAX_TAGS && (
        <div className="flex flex-wrap items-center gap-1" data-testid="todo-tag-suggestions">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              // 不让输入框先失焦：失焦会收起这一行
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(normalizeTodoTags([...tags, tag]))
                setText('')
              }}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
