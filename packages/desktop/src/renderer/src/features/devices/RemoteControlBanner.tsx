import { useState } from 'react'
import { MonitorSmartphone } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { showToast, useAppState } from '@/state/store'
import type { RemoteGrantView } from '../../../../shared/remote'

const NO_GRANTS: never[] = []

// 本机是被连接端：能操作本机的设备在线时一直提示，随时能断开（撤销授权）。「可查看和操作」等于把以本机账户跑命令的能力交给对方
export function RemoteControlBanner() {
  const allowIncoming = useAppState((state) => state.remote?.allowIncoming ?? false)
  const grants = useAppState((state) => state.remote?.grants ?? NO_GRANTS)
  const [revoking, setRevoking] = useState<RemoteGrantView | null>(null)
  const controlling = allowIncoming ? grants.filter((grant) => grant.online && grant.projects.some((project) => project.level === 'control')) : []
  if (controlling.length === 0 && !revoking) return null
  return (
    <>
      {controlling.map((grant) => {
        const count = grant.projects.filter((project) => project.level === 'control').length
        return (
          <div key={grant.deviceId} role="status" className="flex shrink-0 items-center gap-2 border-b border-sidebar-border px-4 py-1.5 text-sm" data-testid="remote-control-banner">
            <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              「{grant.name}」在线，可以在本机的 {count} 个项目里发消息、新建任务、回答确认
            </span>
            <Button variant="ghost" size="sm" onClick={() => setRevoking(grant)}>
              断开这台设备
            </Button>
          </div>
        )
      })}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开「{revoking?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>撤销它的授权：它马上断开、看到本机离线，在等它回答的确认留在本机。要再连，得重新配对。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive-solid"
              onClick={() => revoking && window.diffra.revokeRemoteDevice(revoking.deviceId).catch((error: unknown) => showToast(errorMessage(error)))}
            >
              断开
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
