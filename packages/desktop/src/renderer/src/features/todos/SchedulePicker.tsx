import { useState } from 'react'
import { Bell, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/segmented'
import { addDays, atTime, dateInputValue, formatClock, fromInputs, startOfDay, timePresets } from '@/lib/todo-time'

export type ScheduleKind = 'remind' | 'send'

// 定时：几个快捷时间，或自己选日期和时间；到时只提醒，还是发给任务（allowSend 时可选）。
// 点快捷时间直接定下；自己选的点「确定」。onClear 有值时出「取消定时」
export function SchedulePicker({
  value,
  kind: initialKind = 'remind',
  allowSend = false,
  onPick,
  onClear,
  children,
  align = 'end',
}: {
  value: Date | null
  kind?: ScheduleKind
  allowSend?: boolean
  onPick(at: Date, kind: ScheduleKind): void
  onClear?: () => void
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<ScheduleKind>(initialKind)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const now = new Date()
  const custom = fromInputs(date, time)
  const pick = (at: Date) => {
    setOpen(false)
    onPick(at, kind)
  }
  return (
    <Popover
      modal
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // 打开时从现有时间开始改；没有就默认明早 9 点
          const start = value ?? atTime(addDays(startOfDay(now), 1), 9)
          setDate(dateInputValue(start))
          setTime(formatClock(start))
          setKind(initialKind)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-3" data-testid="schedule-picker" aria-label="定时">
        <div className="flex flex-col gap-3">
          {allowSend && (
            <Segmented<ScheduleKind>
              label="到时做什么"
              size="sm"
              value={kind}
              options={[
                { value: 'remind', label: '到时提醒我' },
                { value: 'send', label: '到时发给任务…' },
              ]}
              onChange={setKind}
            />
          )}
          <div className="grid grid-cols-2 gap-1.5">
            {timePresets(now).map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => pick(preset.at)}
              >
                {kind === 'send' ? <Send className="size-3 text-muted-foreground" /> : <Bell className="size-3 text-muted-foreground" />}
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <input
              type="date"
              aria-label="日期"
              value={date}
              min={dateInputValue(now)}
              onChange={(event) => setDate(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 outline-none focus:border-ring/60"
            />
            <input
              type="time"
              aria-label="时间"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="h-8 w-24 rounded-md border bg-background px-2 outline-none focus:border-ring/60"
            />
          </div>
          {custom && custom.getTime() <= now.getTime() && <p className="text-xs text-warning">这个时间已经过了</p>}
          <div className="flex items-center justify-between">
            {onClear && value ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => {
                  setOpen(false)
                  onClear()
                }}
              >
                取消定时
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" disabled={!custom || custom.getTime() <= now.getTime()} onClick={() => custom && pick(custom)}>
              确定
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
