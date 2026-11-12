import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Eye, MonitorSmartphone, ShieldAlert, SquareTerminal } from 'lucide-react'
import { cn } from 'cn'
import { canControl, REMOTE_LEVEL_LABELS, type RemoteLevel, type RemoteView } from '../../../../shared/remote'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FooterButton } from '@/features/shell/FooterButton'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { openSettings } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'

// 侧栏底部的「设备」和标题栏的提示（docs/decisions.md「左下角的设备和用量」）：点开是同一个设备面板，按方向列出配对过的设备。
// 一台设备和本机的关系：它连着本机（本机授权了它，incoming）、本机连着它（outgoing），互相配对时两样都有，合成一条
export interface DeviceEntry {
  deviceId: string
  name: string
  online: boolean
  lastSeenAt: string | null
  incoming: { level: RemoteLevel; projects: number; terminals: number; watching: string[]; lastActionAt: number | null } | null
  outgoing: boolean
}

const LEVEL_RANK: Record<RemoteLevel, number> = { view: 0, control: 1, full: 2 }
// 刚做过操作的设备：角标、头像闪这么久
const PULSE_MS = 4000
const NO_ENTRIES: DeviceEntry[] = []

export function deviceEntries(view: RemoteView | null): DeviceEntry[] {
  if (!view) return NO_ENTRIES
  const entries = new Map<string, DeviceEntry>()
  for (const grant of view.grants) {
    const level = grant.projects.reduce<RemoteLevel>((top, project) => (LEVEL_RANK[project.level] > LEVEL_RANK[top] ? project.level : top), 'view')
    entries.set(grant.deviceId, {
      deviceId: grant.deviceId,
      name: grant.name,
      // 关着「允许连接本机」时授权的设备连不进来
      online: grant.online && view.allowIncoming,
      lastSeenAt: grant.lastSeenAt,
      incoming: { level, projects: grant.projects.length, terminals: grant.terminals, watching: grant.watching, lastActionAt: grant.lastActionAt },
      outgoing: false,
    })
  }
  for (const peer of view.peers) {
    const existing = entries.get(peer.deviceId)
    if (existing) entries.set(peer.deviceId, { ...existing, online: existing.online || peer.online, outgoing: true })
    else entries.set(peer.deviceId, { deviceId: peer.deviceId, name: peer.name, online: peer.online, lastSeenAt: peer.lastSeenAt, incoming: null, outgoing: true })
  }
  // 能操作本机的在线设备排最前，再是在线的，离线的按最后在线时间
  const rank = (entry: DeviceEntry) => (controlling(entry) ? 0 : entry.online ? 1 : 2)
  return [...entries.values()].sort((a, b) => rank(a) - rank(b) || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
}

// 在线、能操作本机（可查看和操作、完全控制）
export function controlling(entry: DeviceEntry): boolean {
  return entry.online && entry.incoming !== null && canControl(entry.incoming.level)
}

function useDeviceEntries(): DeviceEntry[] {
  const view = useAppState((state) => state.remote)
  return useMemo(() => deviceEntries(view), [view])
}

// 刚做过操作的设备：到点再画一次，把闪的效果收掉
function useRecentAction(entries: DeviceEntry[]): (entry: DeviceEntry) => boolean {
  const [now, setNow] = useState(() => Date.now())
  const latest = Math.max(0, ...entries.map((entry) => entry.incoming?.lastActionAt ?? 0))
  useEffect(() => {
    const current = Date.now()
    setNow(current)
    const left = latest + PULSE_MS - current
    if (left <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), left)
    return () => window.clearTimeout(timer)
  }, [latest])
  return (entry) => entry.online && entry.incoming !== null && entry.incoming.lastActionAt !== null && now - entry.incoming.lastActionAt < PULSE_MS
}

const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

function DeviceAvatar({ entry, pulse }: { entry: DeviceEntry; pulse: boolean }) {
  const control = controlling(entry)
  return (
    <span
      className={cn(
        'relative flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
        control ? 'bg-warning-soft text-warning ring-2 ring-warning' : entry.online ? 'bg-muted text-foreground' : 'bg-muted text-muted-foreground opacity-60',
      )}
      data-state={control ? 'controlling' : entry.online ? 'online' : 'offline'}
    >
      {initialOf(entry.name)}
      {pulse && <span aria-hidden className="absolute -inset-0.5 animate-ping rounded-full ring-2 ring-warning" />}
    </span>
  )
}

// 侧栏底部的「设备」：右边是在线台数，有设备能操作本机时图标和台数是琥珀色
export function DevicesButton() {
  const entries = useDeviceEntries()
  const recent = useRecentAction(entries)
  const online = entries.filter((entry) => entry.online).length
  const control = entries.filter(controlling).length
  const pulse = entries.some(recent)
  const label = entries.length === 0 ? '设备：还没有配对的设备' : `设备：${online} 台在线${control > 0 ? `，${control} 台能操作本机` : ''}`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <FooterButton
          aria-label={label}
          icon={<MonitorSmartphone className="size-4" />}
          label="设备"
          warning={control > 0}
          data-testid="devices-button"
          data-state-level={control > 0 ? 'controlling' : online > 0 ? 'online' : 'idle'}
          meta={
            online > 0 && (
              <span className={cn('relative shrink-0 rounded-full px-1.5 text-[11px] leading-4.5 tabular-nums', control > 0 ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground')} data-testid="devices-badge">
                {online}
                {pulse && <span aria-hidden className="absolute inset-0 animate-ping rounded-full ring-1 ring-warning" />}
              </span>
            )
          }
        />
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={8} collisionPadding={8} className="w-80 p-0">
        <DevicesPanel entries={entries} recent={recent} />
      </PopoverContent>
    </Popover>
  )
}

// 标题栏右边：能操作本机的设备在线时一直显示（侧栏收起、在设置页时也看得到），点开是同一个设备面板
export function RemoteControlIndicator() {
  const entries = useDeviceEntries()
  const recent = useRecentAction(entries)
  const active = entries.filter(controlling)
  if (active.length === 0) return null
  const full = active.some((entry) => entry.incoming?.level === 'full')
  const terminals = active.reduce((sum, entry) => sum + (entry.incoming?.terminals ?? 0), 0)
  const label = active.length === 1 ? `「${active[0]!.name}」能操作本机` : `${active.length} 台设备能操作本机`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="mr-[6px] flex h-[26px] max-w-72 items-center gap-[6px] rounded-md bg-warning-soft px-[8px] text-[12px] text-warning hover:opacity-90" data-testid="remote-control-indicator">
          {full ? <ShieldAlert className="size-[14px] shrink-0" /> : <MonitorSmartphone className="size-[14px] shrink-0" />}
          <span className="truncate">
            {label}
            {terminals > 0 && ` · 开着 ${terminals} 个终端`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <DevicesPanel entries={entries} recent={recent} />
      </PopoverContent>
    </Popover>
  )
}

// 「刚刚操作过」「3 分钟前操作过」：被连接端只记最近一次操作的时刻，不记是什么操作
function actedText(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return '刚刚操作过'
  if (minutes < 60) return `${minutes} 分钟前操作过`
  return `${formatTime(at)} 操作过`
}

function DevicesPanel({ entries, recent }: { entries: DeviceEntry[]; recent(entry: DeviceEntry): boolean }) {
  const relay = useAppState((state) => state.remote?.relay ?? null)
  const lists = useAppState((state) => state.remoteLists)
  const [revoking, setRevoking] = useState<DeviceEntry | null>(null)
  const incoming = entries.filter((entry) => entry.incoming)
  const outgoing = entries.filter((entry) => !entry.incoming)
  // 中转只在连不上、出错时说一句；关着设备连接（没有要连的设备）时不提
  const relayProblem = relay?.state === 'error' ? relay.message : relay?.state === 'connecting' ? '中转连不上，正在重连…' : null

  const sub = (entry: DeviceEntry): string => {
    const seen = entry.lastSeenAt ? `${formatTime(entry.lastSeenAt)} 在线过` : '不在线'
    if (!entry.incoming) {
      const projects = lists[entry.deviceId]?.list?.projects.length
      return [entry.online ? '在线' : seen, projects !== undefined ? `开放了 ${projects} 个项目` : null].filter(Boolean).join(' · ')
    }
    const { projects, lastActionAt } = entry.incoming
    return [`${projects} 个项目`, !entry.online ? seen : lastActionAt !== null && Date.now() - lastActionAt < 3_600_000 ? actedText(lastActionAt) : '在线', entry.outgoing ? '本机也连着它' : null]
      .filter(Boolean)
      .join(' · ')
  }

  const row = (entry: DeviceEntry) => {
    const level = entry.incoming?.level
    const watching = entry.online ? (entry.incoming?.watching ?? []) : []
    const terminals = entry.online ? (entry.incoming?.terminals ?? 0) : 0
    return (
      <div key={entry.deviceId} className="flex items-start gap-2.5 px-3 py-2" data-testid="device-entry">
        <DeviceAvatar entry={entry} pulse={recent(entry)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm">{entry.name}</span>
            {level && (
              <span className={cn('shrink-0 rounded-md px-1.5 text-[10px] leading-4', canControl(level) ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground')} data-testid="device-level">
                {REMOTE_LEVEL_LABELS[level]}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{sub(entry)}</div>
          {(watching.length > 0 || terminals > 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {watching.length > 0 && (
                <span className="flex max-w-full min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground" data-testid="device-watching">
                  <Eye className="size-3 shrink-0" />
                  <span className="truncate">
                    正在看「{watching[0]}」{watching.length > 1 && ` 等 ${watching.length} 个`}
                  </span>
                </span>
              )}
              {terminals > 0 && (
                <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">
                  <SquareTerminal className="size-3" />
                  {terminals} 个终端
                </span>
              )}
            </div>
          )}
        </div>
        {controlling(entry) && (
          <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => setRevoking(entry)}>
            断开
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex max-h-[min(30rem,70vh)] flex-col" data-testid="devices-panel">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-sm font-bold">设备</span>
        <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => openSettings('devices')}>
          连接设置
          <ArrowRight className="size-3" />
        </button>
      </div>
      {relayProblem && <p className="px-3 pb-1 text-xs text-warning">{relayProblem}</p>}
      <div className="min-h-0 overflow-y-auto pb-1.5">
        {entries.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">还没有配对的设备。在「连接设置」里添加另一台电脑，或者允许别的电脑连接本机。</p>}
        {incoming.length > 0 && <p className="px-3 pt-1.5 text-[11px] text-muted-foreground">连着本机 · {incoming.length}</p>}
        {incoming.map(row)}
        {outgoing.length > 0 && <p className="px-3 pt-1.5 text-[11px] text-muted-foreground">本机连接的 · {outgoing.length}</p>}
        {outgoing.map(row)}
      </div>
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开「{revoking?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>撤销它的授权：它马上断开、看到本机离线，开着的终端结束，在等它回答的确认留在本机。要再连，得重新配对。</AlertDialogDescription>
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
    </div>
  )
}
