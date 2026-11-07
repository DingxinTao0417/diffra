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

function EmptyState({
  icon,
  title,
  description,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  icon?: EmptyStateIcon
  title: string
  description?: React.ReactNode
}) {
  const Icon = isIconComponent(icon) ? icon : null

  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center rounded-xl bg-muted/40 px-6 py-10 text-center",
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
      <p className="text-base text-foreground">{title}</p>
      {description != null && description !== false && (
        <div className="mt-1 max-w-[44ch] text-sm text-balance text-muted-foreground">
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
