import { Box } from 'lucide-react'
import { useLobeIcons } from '@/lib/model-icons'
import { cn } from 'cn'

interface BrandIconProps {
  // Lobe Icons 的图标 id；null 或找不到时显示首字母方块，20 及以下太小写不下字，换成通用图标
  id: string | null
  fallbackText: string
  size?: number
  className?: string
}

export function BrandIcon({ id, fallbackText, size = 32, className }: BrandIconProps) {
  const icons = useLobeIcons()
  const icon = icons && id ? icons.renderIcon(id, size, cn('shrink-0', className)) : null
  if (icon) return icon
  if (size <= 20) return <Box aria-hidden size={size} className={cn('shrink-0 text-muted-foreground', className)} />
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center bg-muted text-sm font-bold text-muted-foreground', className)}
      style={{ width: size, height: size, borderRadius: size / 4 }}
    >
      {fallbackText.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}
