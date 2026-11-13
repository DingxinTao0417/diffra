import * as React from "react"
import { cn } from "cn"

import { Label } from "@/components/ui/label"

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ReadonlyField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm leading-none">{label}</p>
      <p
        className={cn(
          "h-8 truncate rounded-lg bg-muted/60 px-2.5 text-sm leading-8",
          mono && "font-mono"
        )}
      >
        {value}
      </p>
    </div>
  )
}

export { Field, ReadonlyField }
