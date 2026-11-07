import { Switch as SwitchPrimitive } from "radix-ui"

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange(value: boolean): void
  disabled?: boolean
}) {
  // 关闭态轨道用 70% 的 muted-foreground：浅色和深色下对卡片底都不低于 3:1
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      aria-label={label}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className="inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/70 data-[state=unchecked]:enabled:hover:bg-muted-foreground/80"
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform motion-reduce:transition-none data-[state=checked]:translate-x-4"
      />
    </SwitchPrimitive.Root>
  )
}
