import * as React from "react"
import { cn } from "cn"

type EmptyStateIcon =
  | React.ReactNode
  | React.ComponentType<{ className?: string }>

// lucide 图标是 forwardRef 对象而不是函数，要和已经渲染好的元素区分开
function isIconComponent(
  icon: EmptyStateIcon
): icon is React.ComponentType<{ className?: string }> {
  return (
    typeof icon === "function" ||
    (typeof icon === "object" &&
      icon !== null &&
      "$$typeof" in icon &&
      !React.isValidElement(icon))
  )
}

// muted：独立放在页面或面板里；card：和旁边的设置组、卡片并排时用同样的边框框起来；plain：已经在别的框里（设置组、对话区）
const VARIANTS = {
  muted: "rounded-xl bg-muted/40",
  card: "rounded-xl border bg-card",
  plain: "",
}

function EmptyState({
  icon,
  title,
  description,
  variant = "muted",
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  icon?: EmptyStateIcon
  title: string
  description?: React.ReactNode
  variant?: keyof typeof VARIANTS
}) {
  const Icon = isIconComponent(icon) ? icon : null

  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center px-6 py-10 text-center",
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      {icon != null && icon !== false && (
        <div
          aria-hidden
          className="mb-3 flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border [&_svg]:size-5"
        >
          {Icon ? <Icon className="size-5" /> : (icon as React.ReactNode)}
        </div>
      )}
      <p className="text-base font-bold text-foreground">{title}</p>
      {description != null && description !== false && (
        <div className="mt-1 max-w-md text-sm text-balance text-muted-foreground">
          {description}
        </div>
      )}
      {children != null && children !== false && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {children}
        </div>
      )}
    </div>
  )
}

export { EmptyState }
