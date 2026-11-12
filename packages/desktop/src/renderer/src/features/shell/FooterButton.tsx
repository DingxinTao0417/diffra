import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'

// 侧栏最底下的一行（SidebarFooter）：样子和侧栏上面「设计」「架构」那几行一样，右边可以写一点状态（meta）。
// warning 时图标是琥珀色（有设备能操作本机）；aria-pressed 表示当前页（设置）
export function FooterButton({ icon, label, meta, warning = false, className, ...props }: ComponentProps<'button'> & { icon: ReactNode; label: string; meta?: ReactNode; warning?: boolean }) {
  return (
    <button
      type="button"
      className={cn('flex h-8.5 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent aria-expanded:bg-accent aria-pressed:bg-soft aria-pressed:hover:bg-soft', className)}
      {...props}
    >
      <span className={cn('flex shrink-0', warning && 'text-warning')}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta}
    </button>
  )
}
