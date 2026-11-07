import { cn } from 'cn'

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors', checked ? 'bg-primary' : 'bg-input')}
    >
      <span className={cn('size-4 rounded-full bg-background shadow-sm transition-transform', checked && 'translate-x-4')} />
    </button>
  )
}
