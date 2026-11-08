import { type ComponentProps, type ReactNode, useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from 'cn'

export function SettingsHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export type SavedFlash = { shown: boolean; withNote: boolean }

// 自动保存成功后在页头短暂提示；连续改动会重新计时
export function useSavedFlash(): [SavedFlash, (withNote?: boolean) => void] {
  const [flash, setFlash] = useState({ at: 0, withNote: false })
  useEffect(() => {
    if (flash.at === 0) return
    // 隐藏时保留 withNote，附加说明跟着一起淡出
    const timer = setTimeout(() => setFlash((current) => ({ ...current, at: 0 })), 3000)
    return () => clearTimeout(timer)
  }, [flash.at])
  return [{ shown: flash.at !== 0, withNote: flash.withNote }, (withNote = false) => setFlash({ at: Date.now(), withNote })]
}

export function SavedHint({ saved, note }: { saved: SavedFlash; note?: string }) {
  // 看得见的部分只做淡出；读屏靠单独的 status 区域在内容变化时播报。
  // 附加说明一直占位，第一次出现时不挤动副标题
  return (
    <span className="flex h-8 items-center">
      <span
        aria-hidden="true"
        className={cn('flex items-center gap-2 text-xs text-muted-foreground', saved.shown ? 'opacity-100' : 'opacity-0 transition-opacity duration-300 motion-reduce:transition-none')}
      >
        <span className="flex items-center gap-1">
          <Check className="size-3.5" />
          已保存
        </span>
        {note && <span className={cn(!saved.withNote && 'invisible')}>{note}</span>}
      </span>
      <span role="status" className="sr-only">{saved.shown ? (note && saved.withNote ? `已保存，${note}` : '已保存') : ''}</span>
    </span>
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
