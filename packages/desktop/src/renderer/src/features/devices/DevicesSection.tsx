import { type FormEvent, useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import type { RemoteAuditEntry, RemoteDeviceView, RemoteGrantView, RemoteProjectGrant, RemoteRelayStatus, RemoteView } from '../../../../shared/remote'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/features/models/ProviderDialog'
import { SettingsGroup, SettingsHeader, SettingsRow } from '@/features/settings/SettingsLayout'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { showToast, useAppState } from '@/state/store'
import { describeGrants, ProjectGrantPicker } from './ProjectGrantPicker'

type Tab = 'connect' | 'allow'

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'connect', label: '连接其他设备' },
  { value: 'allow', label: '允许连接本机' },
]

const run = (action: () => Promise<unknown>) => action().catch((error: unknown) => showToast(errorMessage(error)))

// 设置 → 设备连接：连接别人的 Diffra，或者允许别人的 Diffra 连接本机（docs/decisions.md「设备连接」）
export function DevicesSection() {
  const remote = useAppState((state) => state.remote)
  const [tab, setTab] = useState<Tab>('connect')
  if (!remote) return null
  return (
    <>
      <SettingsHeader
        title="设备连接"
        description="连接其他电脑上的 Diffra，或者允许其他电脑上的 Diffra 连接本机。经 relay.diffra.dev 中转，内容端到端加密，服务器看不到。"
        actions={<RelayBadge status={remote.relay} />}
      />
      {remote.unavailable && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{remote.unavailable}</AlertDescription>
        </Alert>
      )}
      <Segmented<Tab> label="设备连接" value={tab} options={TABS} onChange={(next) => setTab(next)} />
      <div className="mt-6">{tab === 'connect' ? <ConnectTab remote={remote} /> : <AllowTab remote={remote} />}</div>
    </>
  )
}

function RelayBadge({ status }: { status: RemoteRelayStatus }) {
  const [variant, text] =
    status.state === 'online' ? (['secondary', '已连上中转'] as const) : status.state === 'connecting' ? (['outline', '正在连接中转…'] as const) : status.state === 'error' ? (['warning', status.message] as const) : (['outline', '没连中转'] as const)
  return (
    <Badge variant={variant} data-testid="relay-status" data-state={status.state}>
      {text}
    </Badge>
  )
}

function OnlineBadge({ device }: { device: RemoteDeviceView }) {
  return device.online ? (
    <Badge variant="secondary" data-testid="device-online">
      在线
    </Badge>
  ) : (
    <Badge variant="outline" data-testid="device-offline">
      离线
    </Badge>
  )
}

function deviceHint(device: RemoteDeviceView, extra?: string): string {
  return [`指纹 ${device.fingerprint}`, extra, device.online || !device.lastSeenAt ? null : `最后在线 ${formatTime(device.lastSeenAt)}`].filter(Boolean).join(' · ')
}

function ConnectTab({ remote }: { remote: RemoteView }) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<RemoteDeviceView | null>(null)
  return (
    <>
      <SettingsGroup title="已添加的设备" data-testid="peers">
        {remote.peers.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">还没有添加设备。在对方电脑的「允许连接本机」里生成邀请串，再点下面的「添加设备」粘贴进来。</div>}
        {remote.peers.map((peer) => (
          <SettingsRow
            key={peer.deviceId}
            label={
              <span className="flex items-center gap-2" data-testid="peer">
                {peer.name}
                <OnlineBadge device={peer} />
              </span>
            }
            hint={deviceHint(peer, `配对于 ${formatTime(peer.pairedAt)}`)}
          >
            <Button variant="outline" size="sm" onClick={() => setRemoving(peer)}>
              删除
            </Button>
          </SettingsRow>
        ))}
      </SettingsGroup>
      <Button className="mt-4" disabled={remote.unavailable !== null} onClick={() => setAdding(true)}>
        添加设备
      </Button>
      <AddDeviceDialog open={adding} onOpenChange={setAdding} fingerprint={remote.self?.fingerprint ?? null} />
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除设备「{removing?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>本机不再连接它。要再连，得请对方重新生成邀请串。对方那边的授权要对方自己撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive-solid" onClick={() => removing && void run(() => window.diffra.removeRemotePeer(removing.deviceId))}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AddDeviceDialog({ open, onOpenChange, fingerprint }: { open: boolean; onOpenChange(open: boolean): void; fingerprint: string | null }) {
  const [invite, setInvite] = useState('')
  const [name, setName] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setInvite('')
    setName('')
    setError(null)
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setWaiting(true)
    setError(null)
    try {
      const result = await window.diffra.addRemoteDevice(invite.trim(), name.trim() || null)
      if (result.ok) {
        showToast(`已添加「${result.device.name}」`)
        onOpenChange(false)
      } else setError(result.error)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setWaiting(false)
    }
  }

  const close = (next: boolean) => {
    if (!next && waiting) void run(() => window.diffra.cancelAddRemoteDevice())
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加设备</DialogTitle>
          <DialogDescription>在对方电脑的「设置 → 设备连接 → 允许连接本机」里生成邀请串，复制过来粘贴到这里。</DialogDescription>
        </DialogHeader>
        <form id="add-device" onSubmit={(event) => void submit(event)} className="space-y-4">
          <Field id="remote-invite" label="邀请串">
            <Textarea id="remote-invite" value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="diffra-XXXX-XXXX-…" rows={3} className="font-mono" disabled={waiting} required />
          </Field>
          <Field id="remote-name" label="显示名称" hint="不填就用对方给自己起的名字。">
            <Input id="remote-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} disabled={waiting} />
          </Field>
        </form>
        {waiting && (
          <p className="rounded-lg bg-soft px-3 py-2 text-sm" role="status">
            正在连接对方，等对方点允许…
            {fingerprint && (
              <>
                对方会看到本机的指纹 <span className="font-mono font-bold" data-testid="self-fingerprint">{fingerprint}</span>，可以念给对方核对。
              </>
            )}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            取消
          </Button>
          <Button type="submit" form="add-device" disabled={waiting || !invite.trim()}>
            {waiting ? '等对方确认…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AllowTab({ remote }: { remote: RemoteView }) {
  const [editing, setEditing] = useState<RemoteGrantView | null>(null)
  const [revoking, setRevoking] = useState<RemoteGrantView | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const disabled = remote.unavailable !== null
  return (
    <>
      <SettingsGroup title="连接方式">
        <SettingsRow label="允许连接本机" hint="打开后，你授权过的设备可以经中转连接本机；关掉后它们都看到本机离线。">
          <Switch label="允许连接本机" checked={remote.allowIncoming} disabled={disabled} onChange={(enabled) => void run(() => window.diffra.setRemoteAllowIncoming(enabled))} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="本机">
        <NameRow name={remote.name} disabled={disabled} />
        <SettingsRow label="指纹" hint="配对时对方会看到它，可以用来核对。">
          <span className="font-mono text-sm" data-testid="host-fingerprint">
            {remote.self?.fingerprint ?? '打开「允许连接本机」后生成'}
          </span>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="配对新设备">
        <SettingsRow label="邀请串" hint="发给对方，在对方 Diffra 的「连接其他设备 → 添加设备」里粘贴。10 分钟内有效，只能用一次；对方连上后你还要在弹窗里点允许，并选开放哪些项目。">
          {!remote.invite && (
            <Button variant="outline" size="sm" disabled={disabled || !remote.allowIncoming} onClick={() => void run(() => window.diffra.createRemoteInvite())}>
              生成邀请串
            </Button>
          )}
        </SettingsRow>
        {remote.invite && (
          <div className="flex items-start gap-2 px-4 py-3">
            <code className="min-w-0 flex-1 rounded-md bg-soft px-2 py-1.5 font-mono text-sm break-all select-all" data-testid="invite-text">
              {remote.invite.text}
            </code>
            <Button
              variant="outline"
              size="sm"
              aria-label="复制邀请串"
              onClick={() => {
                const text = remote.invite?.text ?? ''
                navigator.clipboard.writeText(text).then(
                  () => showToast('已复制邀请串'),
                  (error: unknown) => showToast(errorMessage(error)),
                )
              }}
            >
              <Copy className="size-3.5" />
              复制
            </Button>
            <Button variant="outline" size="sm" onClick={() => void run(() => window.diffra.cancelRemoteInvite())}>
              作废
            </Button>
          </div>
        )}
        {remote.invite && <div className="px-4 pb-3 text-xs text-muted-foreground">{formatTime(remote.invite.expiresAt)} 前有效</div>}
      </SettingsGroup>
      <SettingsGroup title="已授权设备" data-testid="grants">
        {remote.grants.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">还没有设备与本机配对。生成邀请串后，在另一台设备上添加本机。</div>}
        {remote.grants.map((grant) => (
          <SettingsRow
            key={grant.deviceId}
            label={
              <span className="flex items-center gap-2" data-testid="grant">
                {grant.name}
                <OnlineBadge device={grant} />
              </span>
            }
            hint={deviceHint(grant, `开放：${describeGrants(grant.projects)}`)}
          >
            <Button variant="outline" size="sm" onClick={() => setEditing(grant)}>
              修改授权
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRevoking(grant)}>
              撤销
            </Button>
          </SettingsRow>
        ))}
      </SettingsGroup>
      <SettingsGroup title="记录和身份">
        <SettingsRow label="操作记录" hint="配对、修改授权、撤销都会记下来。">
          <Button variant="outline" size="sm" onClick={() => setAuditOpen(true)}>
            查看
          </Button>
        </SettingsRow>
        <SettingsRow label="重置本机身份" hint="换一套新密钥：设备 ID 和指纹都会变，所有配对作废，要重新配对。">
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setResetting(true)}>
            重置
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {editing && <GrantDialog grant={editing} onClose={() => setEditing(null)} />}
      {auditOpen && <AuditDialog onClose={() => setAuditOpen(false)} />}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销「{revoking?.name}」的授权？</AlertDialogTitle>
            <AlertDialogDescription>它马上断开、看到本机离线。要再连，得重新配对。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive-solid" onClick={() => revoking && void run(() => window.diffra.revokeRemoteDevice(revoking.deviceId))}>
              撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={resetting} onOpenChange={setResetting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置本机身份？</AlertDialogTitle>
            <AlertDialogDescription>本机的设备 ID 和指纹都会变，授权给别人的设备和本机添加的设备全部作废，「允许连接本机」也会关掉。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive-solid" onClick={() => void run(() => window.diffra.resetRemoteIdentity())}>
              重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function NameRow({ name, disabled }: { name: string; disabled: boolean }) {
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const save = () => {
    const next = draft.trim()
    if (!next || next === name) return setDraft(name)
    void run(() => window.diffra.setRemoteName(next))
  }
  return (
    <SettingsRow label="名称" hint="对方看到的本机名字。">
      <Input aria-label="本机名称" value={draft} maxLength={60} disabled={disabled} className="h-8 w-56" onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => event.key === 'Enter' && save()} />
    </SettingsRow>
  )
}

function GrantDialog({ grant, onClose }: { grant: RemoteGrantView; onClose(): void }) {
  const [projects, setProjects] = useState<RemoteProjectGrant[]>(grant.projects)
  const save = async () => {
    try {
      await window.diffra.updateRemoteGrant(grant.deviceId, projects)
      onClose()
    } catch (error) {
      showToast(errorMessage(error))
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>修改「{grant.name}」的授权</DialogTitle>
          <DialogDescription>指纹 {grant.fingerprint}。取消勾选的项目，对方马上看不到。</DialogDescription>
        </DialogHeader>
        <ProjectGrantPicker value={projects} onChange={setProjects} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AuditDialog({ onClose }: { onClose(): void }) {
  const [entries, setEntries] = useState<RemoteAuditEntry[] | null>(null)
  useEffect(() => {
    window.diffra.getRemoteAudit().then(setEntries, (error: unknown) => {
      showToast(errorMessage(error))
      setEntries([])
    })
  }, [])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>操作记录</DialogTitle>
          <DialogDescription>最近 200 条，新的在前。</DialogDescription>
        </DialogHeader>
        {entries === null ? (
          <p className="text-sm text-muted-foreground">读取中…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有记录。</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border text-sm" data-testid="audit">
            {entries.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="px-3 py-2">
                <div className="flex gap-2 text-xs text-muted-foreground">
                  <span>{formatTime(entry.at)}</span>
                  <span>{entry.name}</span>
                </div>
                <div className="break-all">{entry.action}</div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
