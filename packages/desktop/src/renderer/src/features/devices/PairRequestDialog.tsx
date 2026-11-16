import { useState } from 'react'
import { REMOTE_DEVICE_CONNECTION_ENABLED, type RemotePairRequest, type RemoteProjectGrant } from '../../../../shared/remote'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errorMessage } from '@/lib/errors'
import { showToast, useAppState } from '@/state/store'
import { describeGrants, ProjectGrantPicker } from './ProjectGrantPicker'

// 允许对方同步待办（v2）：和项目授权分开，两台电脑的待办合在一起；对方那边也要打开才同步
export function TodoSyncChoice({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(value) => onChange(value === true)} aria-label="允许同步待办" />
      <span>
        允许同步待办
        <span className="block text-xs text-muted-foreground">两台电脑的待办合在一起，谁改得晚用谁的（图片附件和定时发给任务的不同步）。对方也打开「同步待办」才会同步。</span>
      </span>
    </label>
  )
}

// 有设备凭邀请串连上来：在哪个页面都弹出来，本机的人看着名称和指纹点允许或拒绝。默认一个项目都不开放
export function PairRequestDialog() {
  const request = useAppState((state) => state.remote?.requests[0] ?? null)
  if (!REMOTE_DEVICE_CONNECTION_ENABLED || !request) return null
  // 换了一个请求就重新挂载，选择从头开始
  return <RequestDialog key={request.deviceId} request={request} />
}

function RequestDialog({ request }: { request: RemotePairRequest }) {
  const [projects, setProjects] = useState<RemoteProjectGrant[]>([])
  const [todos, setTodos] = useState(false)
  const [busy, setBusy] = useState(false)

  const respond = async (approved: boolean) => {
    setBusy(true)
    try {
      await window.diffra.respondRemoteRequest(request.deviceId, approved, approved ? projects : [], approved && todos)
      showToast(approved ? `已允许「${request.name}」连接本机` : `已拒绝「${request.name}」`)
    } catch (error) {
      showToast(errorMessage(error))
      setBusy(false)
    }
  }

  return (
    // 关掉对话框算拒绝：不留没处理的请求
    <Dialog open onOpenChange={(open) => !open && !busy && void respond(false)}>
      <DialogContent className="sm:max-w-lg" data-testid="pair-request">
        <DialogHeader>
          <DialogTitle>设备「{request.name}」请求连接本机</DialogTitle>
          <DialogDescription>
            对方的指纹是 <span className="font-mono font-bold text-foreground" data-testid="pair-request-fingerprint">{request.fingerprint}</span>，可以和对方核对（对方添加设备时能看到它自己的指纹）。不认识这台设备就拒绝。
          </DialogDescription>
        </DialogHeader>
        {request.previous && (
          <p className="rounded-lg bg-soft px-3 py-2 text-xs text-muted-foreground">
            这台设备以前配对过，原来的授权：{describeGrants(request.previous)}。这次会换成下面选的。
          </p>
        )}
        <div className="space-y-2">
          <div className="text-sm font-bold">开放哪些项目</div>
          <ProjectGrantPicker value={projects} onChange={setProjects} />
          <p className="text-xs text-muted-foreground">不勾选就什么都看不到，之后可以在「设置 → 设备连接 → 允许连接本机」里改。</p>
        </div>
        <TodoSyncChoice checked={todos} onChange={setTodos} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void respond(false)}>
            拒绝
          </Button>
          <Button disabled={busy} onClick={() => void respond(true)}>
            允许
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
