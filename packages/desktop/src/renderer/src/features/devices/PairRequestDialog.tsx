import { useState } from 'react'
import type { RemotePairRequest, RemoteProjectGrant } from '../../../../shared/remote'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errorMessage } from '@/lib/errors'
import { showToast, useAppState } from '@/state/store'
import { describeGrants, ProjectGrantPicker } from './ProjectGrantPicker'

// 有设备凭邀请串连上来：在哪个页面都弹出来，本机的人看着名称和指纹点允许或拒绝。默认一个项目都不开放
export function PairRequestDialog() {
  const request = useAppState((state) => state.remote?.requests[0] ?? null)
  if (!request) return null
  // 换了一个请求就重新挂载，选择从头开始
  return <RequestDialog key={request.deviceId} request={request} />
}

function RequestDialog({ request }: { request: RemotePairRequest }) {
  const [projects, setProjects] = useState<RemoteProjectGrant[]>([])
  const [busy, setBusy] = useState(false)

  const respond = async (approved: boolean) => {
    setBusy(true)
    try {
      await window.diffra.respondRemoteRequest(request.deviceId, approved, approved ? projects : [])
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
