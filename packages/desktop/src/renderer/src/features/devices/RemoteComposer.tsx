import { type KeyboardEvent, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface RemoteComposerProps {
  deviceName: string
  running: boolean
  disabled: boolean
  // 发出去了返回 true，输入框才清空；失败的原因由调用方提示
  onSend(text: string): Promise<boolean>
  onStop(): void
}

// 远程任务页的输入框：只发文字（不带图片、Skill，不能选目标模式和先出计划），在对方电脑上用对方的模型和权限设置跑；
// 对方在跑时发的排在这一轮后面。Enter 发送，Shift+Enter 换行，和本机输入框一样
export function RemoteComposer({ deviceName, running, disabled, onSend, onStop }: RemoteComposerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const canSend = text.trim().length > 0 && !sending && !disabled

  async function send() {
    if (!canSend) return
    setSending(true)
    if (await onSend(text.trim())) setText('')
    setSending(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <div className="rounded-2xl border border-input bg-card px-3 pt-2 pb-2.5 focus-within:border-ring/60 dark:border-input/50 dark:focus-within:border-ring" data-testid="remote-composer">
      <Textarea
        aria-label="发给对方的消息"
        placeholder={`发给「${deviceName}」上的这个任务`}
        value={text}
        rows={2}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-60 min-h-12 resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">在对方电脑上运行，用对方的模型和权限设置</span>
        {running && (
          <Button variant="outline" size="icon-sm" aria-label="停止" onClick={onStop} disabled={disabled}>
            <Square className="size-3.5" />
          </Button>
        )}
        <Button size="icon-sm" aria-label="发送" onClick={() => void send()} disabled={!canSend}>
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  )
}
