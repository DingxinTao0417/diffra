import * as React from "react"
import { cn } from "cn"

const NEXT_KEYS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "default",
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange(value: T): void
  size?: "sm" | "default"
}) {
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex((option) => option.value === value)

  // 单选组语义：方向键移动即选中，焦点跟到新选中的那一项
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return
    const current = Math.max(selected, 0)
    let next: number
    if (event.key in NEXT_KEYS) next = (current + NEXT_KEYS[event.key] + options.length) % options.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = options.length - 1
    else return
    event.preventDefault()
    buttons.current[next]?.focus()
    if (next !== selected) onChange(options[next].value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="segmented"
      className="inline-flex rounded-lg bg-muted p-0.5"
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const checked = index === selected
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // 没有选中项时让第一项可以 Tab 进来
            tabIndex={checked || (selected === -1 && index === 0) ? 0 : -1}
            className={cn(
              "rounded-md whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
              checked
                ? "bg-background font-medium text-foreground shadow-sm dark:bg-accent"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
