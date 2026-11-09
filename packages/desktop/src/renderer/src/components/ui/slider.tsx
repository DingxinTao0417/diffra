import * as React from "react"
import { cn } from "cn"
import { Slider as SliderPrimitive } from "radix-ui"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  step = 1,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-valuetext": ariaValuetext,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const values = value ?? defaultValue ?? [min]
  const count = values.length
  // 档位不多时每档画一个点；位置按 Radix 让滑块不出界的偏移算，和滑块中心对齐
  const stepCount = Math.round((max - min) / step)
  const marks = count === 1 && stepCount > 0 && stepCount <= 10 ? Array.from({ length: stepCount + 1 }, (_, index) => index) : []
  const current = Math.round(((values[0] ?? min) - min) / step)
  // role=slider 在滑块上而不在外层，名称和取值文字要落到滑块上读屏才念得出
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      step={step}
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-4 w-full grow overflow-hidden rounded-full bg-input"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute h-full bg-primary"
        />
      </SliderPrimitive.Track>
      {marks.map((index) =>
        index === current ? null : (
          <span
            key={index}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
              index < current ? "bg-primary-foreground/70" : "bg-muted-foreground/50"
            )}
            style={{ left: `calc(${(index / stepCount) * 100}% + ${10 - (index / stepCount) * 20}px)` }}
          />
        )
      )}
      {Array.from({ length: count }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          data-slot="slider-thumb"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-valuetext={ariaValuetext}
          className="block size-5 shrink-0 cursor-grab rounded-full border border-border bg-white shadow-md transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:cursor-grabbing data-disabled:pointer-events-none"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
