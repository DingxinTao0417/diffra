import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { BrandIcon } from './BrandIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ALIASES, useLobeIcons } from '@/lib/model-icons'
import { cn } from 'cn'

const COLUMNS = 8

const aliasesById = new Map<string, string[]>()
for (const [alias, id] of ALIASES) aliasesById.set(id, [...(aliasesById.get(id) ?? []), alias])

interface IconPickerProps {
  // 用户自选的图标 id，null 表示自动匹配
  value: string | null
  matched: string | null
  fallbackText: string
  open: boolean
  onOpenChange(open: boolean): void
  onChange(icon: string | null): void
}

export function IconPicker({ value, matched, fallbackText, open, onOpenChange, onChange }: IconPickerProps) {
  const icons = useLobeIcons()
  const [filter, setFilter] = useState('')
  const [peek, setPeek] = useState<string | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const entries = useMemo(() => icons?.listIcons() ?? [], [icons])
  const current = value ?? matched
  const titleOf = (id: string | null) => (id ? (icons?.iconLabel(id) ?? id) : null)
  const currentTitle = titleOf(current)
  const query = filter.trim().toLowerCase()
  const shown =
    query === ''
      ? entries
      : entries.filter((entry) => [entry.id, entry.title, entry.fullTitle, ...(aliasesById.get(entry.id) ?? [])].some((text) => text.toLowerCase().includes(query)))

  // 打开时清空搜索；放在渲染里比较，外面直接改 open（点「没认出来」的提示）也算
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFilter('')
      setPeek(null)
    }
  }

  // 第 0 项是自动匹配，后面是网格
  const options = [null, ...(icons === null ? [] : shown.map((entry) => entry.id))]
  const selected = options.indexOf(value)
  const tabStop = selected === -1 ? 0 : selected

  const choose = (icon: string | null) => {
    onChange(icon)
    onOpenChange(false)
  }

  // 方向键只移动焦点不选中，选中会关掉弹层；上下在网格里按行走，第一行再往上回到自动匹配
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = radios.current.indexOf(event.target as HTMLButtonElement)
    if (index === -1) return
    const last = options.length - 1
    let next: number
    if (event.key === 'ArrowLeft') next = index - 1
    else if (event.key === 'ArrowRight') next = index + 1
    else if (event.key === 'ArrowUp') next = index <= COLUMNS ? 0 : index - COLUMNS
    else if (event.key === 'ArrowDown') next = index === 0 ? 1 : index + COLUMNS <= last ? index + COLUMNS : index
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    radios.current[Math.min(Math.max(next, 0), last)]?.focus()
  }

  return (
    // 内容在 Dialog 外的 portal 里，非模态时 Dialog 的滚动锁会吞掉网格的滚轮
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" data-testid="provider-icon-button" aria-label={currentTitle ? `更换图标（当前：${currentTitle}）` : '更换图标'}>
          <BrandIcon id={current} fallbackText={fallbackText} size={20} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" data-testid="icon-picker" aria-label="选择图标">
        <Input
          aria-label="搜索图标"
          placeholder="搜索图标"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (query === '' || icons === null || shown.length === 0) return
            event.preventDefault()
            choose(shown[0].id)
          }}
        />
        <div role="radiogroup" aria-label="图标" className="flex flex-col gap-2.5" onKeyDown={onKeyDown}>
          <button
            ref={(element) => {
              radios.current[0] = element
            }}
            type="button"
            role="radio"
            data-testid="icon-option-auto"
            aria-label="选择图标：自动匹配"
            aria-checked={value === null}
            tabIndex={tabStop === 0 ? 0 : -1}
            onClick={() => choose(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
              value === null && 'bg-soft hover:bg-soft',
            )}
          >
            <BrandIcon id={matched} fallbackText={fallbackText} size={20} />
            <span className="flex-1">自动匹配</span>
            <span className="truncate text-xs text-muted-foreground">{titleOf(matched) ?? '没认出来'}</span>
          </button>
          {icons === null ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">正在加载图标…</p>
          ) : shown.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的图标</p>
          ) : (
            <div className="-mx-1 grid max-h-64 grid-cols-8 gap-1 overflow-y-auto px-1 py-0.5">
              {shown.map((entry, position) => {
                const index = position + 1
                const label = titleOf(entry.id) ?? entry.id
                const unpeek = () => setPeek((id) => (id === entry.id ? null : id))
                return (
                  <button
                    key={entry.id}
                    ref={(element) => {
                      radios.current[index] = element
                    }}
                    type="button"
                    role="radio"
                    data-testid="icon-option"
                    data-icon-id={entry.id}
                    aria-label={`选择图标：${label}`}
                    aria-checked={value === entry.id}
                    tabIndex={tabStop === index ? 0 : -1}
                    onClick={() => choose(entry.id)}
                    onMouseEnter={() => setPeek(entry.id)}
                    onMouseLeave={unpeek}
                    onFocus={() => setPeek(entry.id)}
                    onBlur={unpeek}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                      value === entry.id && 'bg-soft hover:bg-soft',
                    )}
                  >
                    <BrandIcon id={entry.id} fallbackText={label} size={20} />
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {icons !== null && shown.length > 0 && (
          <p aria-hidden className="h-4 truncate px-1 text-xs text-muted-foreground">
            {titleOf(peek ?? value)}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
