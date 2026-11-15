import { useEffect } from 'react'
import { Pause, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TranscriptItem } from '@/features/session/transcript'

// 时间轴回放（第 681 步）：一轮里的每一步（提问、思考、工具调用、回答、提醒）按发生的顺序排成刻度，拖动或播放时对话里只显示到那一步为止。
// 记录里没有每一步的时刻（只有这一轮的开始和结束），按顺序一步一步走
const PLAY_MS = 900

export function stepLabel(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return '提问'
    case 'agent':
      return `回答：${item.text.trim().split('\n')[0]?.slice(0, 40) ?? ''}`
    case 'thought':
      return '思考'
    case 'tool':
      return item.title
    case 'notice':
      return item.title
  }
}

interface TurnReplayProps {
  items: TranscriptItem[]
  // 显示到第几步（从 1 起，第 1 步是提问）
  step: number
  onStep(step: number): void
  playing: boolean
  onPlaying(playing: boolean): void
  onClose(): void
}

export function TurnReplay({ items, step, onStep, playing, onPlaying, onClose }: TurnReplayProps) {
  const total = items.length
  // 播放：一步一步往后走，到最后停下
  useEffect(() => {
    if (!playing) return
    if (step >= total) {
      onPlaying(false)
      return
    }
    const timer = window.setTimeout(() => onStep(step + 1), PLAY_MS)
    return () => window.clearTimeout(timer)
  }, [playing, step, total, onStep, onPlaying])

  const current = items[step - 1]
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 px-3 py-2 text-xs" role="group" aria-label="回放这一轮" data-testid="turn-replay">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={playing ? '暂停' : '播放'}
          onClick={() => {
            if (!playing && step >= total) onStep(1)
            onPlaying(!playing)
          }}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <input
          type="range"
          min={1}
          max={total}
          step={1}
          value={step}
          aria-label="回放到第几步"
          aria-valuetext={`第 ${step} 步，共 ${total} 步`}
          className="min-w-0 flex-1 accent-foreground"
          onChange={(event) => {
            onPlaying(false)
            onStep(Number(event.target.value))
          }}
          data-testid="turn-replay-slider"
        />
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {step}/{total}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="退出回放" onClick={onClose}>
          <X />
        </Button>
      </div>
      <p className="truncate text-muted-foreground" data-testid="turn-replay-step">
        第 {step} 步：{current ? stepLabel(current) : ''}
      </p>
    </div>
  )
}
