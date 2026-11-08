import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'

export function SettingsHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// testid、role 等属性落在框本身上，e2e 按它们在框内找控件
export function SettingsGroup({ title, className, children, ...props }: ComponentProps<'div'> & { title?: string }) {
  return (
    <section data-slot="settings-group" className="[[data-slot=settings-group]+&]:mt-8">
      {title && <h2 className="mb-2 text-sm font-semibold">{title}</h2>}
      <div className={cn('divide-y rounded-xl border bg-card', className)} {...props}>
        {children}
      </div>
    </section>
  )
}

export function SettingsRow({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 px-4 py-3', className)}>
      <div className="min-w-0">
        <div className="text-base">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children && <div className="flex items-center justify-end gap-2">{children}</div>}
    </div>
  )
}
