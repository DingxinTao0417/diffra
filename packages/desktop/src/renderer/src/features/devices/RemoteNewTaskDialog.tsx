import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { navigate } from '@/state/actions'
import { createRemoteTask } from './remote-tasks'

interface RemoteNewTaskDialogProps {
  deviceId: string
  deviceName: string
  projectId: string
  projectName: string
  onClose(): void
}

// 在对方开放「可查看和操作」的项目里新建任务：对方在后台建好、跑第一轮，本机打开它
export function RemoteNewTaskDialog({ deviceId, deviceName, projectId, projectName, onClose }: RemoteNewTaskDialogProps) {
  const [text, setText] = useState('')
  const [creating, setCreating] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!text.trim() || creating) return
    setCreating(true)
    const sessionId = await createRemoteTask(deviceId, projectId, text.trim())
    setCreating(false)
    if (!sessionId) return
    onClose()
    navigate({ name: 'remote-task', deviceId, sessionId })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>在「{projectName}」新建任务</DialogTitle>
          <DialogDescription>在「{deviceName}」上运行，用对方的模型和权限设置。</DialogDescription>
        </DialogHeader>
        <form id="remote-new-task" onSubmit={(event) => void submit(event)}>
          <Textarea aria-label="新任务要做什么" value={text} onChange={(event) => setText(event.target.value)} rows={4} disabled={creating} autoFocus />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="remote-new-task" disabled={!text.trim() || creating}>
            {creating ? '新建中…' : '新建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
