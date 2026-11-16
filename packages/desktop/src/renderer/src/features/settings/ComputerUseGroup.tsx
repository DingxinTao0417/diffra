import { useEffect, useState } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import type { ComputerAuditEntry, ComputerStatus, ComputerUseSettings } from '../../../../shared/settings'
import { cn } from 'cn'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { showToast } from '@/state/store'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

const SHOWN = 30

// 电脑操控（v2 · M5）：默认关；第一次打开先讲清楚再确认；最近的操作记录（审计）在这里看、能清空
export function ComputerUseGroup({ value, onSave }: { value: ComputerUseSettings; onSave(next: ComputerUseSettings): Promise<void> }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [audit, setAudit] = useState<ComputerAuditEntry[] | null>(null)
  const [expanded, setExpanded] = useState(false)

  const loadAudit = () => window.diffra.computerAudit().then(setAudit, (error: unknown) => showToast(`读取操作记录失败：${errorMessage(error)}`))
  useEffect(() => {
    window.diffra.computerStatus().then(setStatus, (error: unknown) => console.error('读取电脑操控状态失败', error))
    void loadAudit()
  }, [])

  const toggle = (enabled: boolean) => {
    if (enabled && !value.acknowledged) return setConfirming(true)
    void onSave({ ...value, enabled })
  }
  const clear = async () => {
    try {
      await window.diffra.clearComputerAudit()
      setAudit([])
    } catch (error) {
      showToast(`清空失败：${errorMessage(error)}`)
    }
  }
  const unsupported = status !== null && !status.supported
  const shown = audit ? (expanded ? audit : audit.slice(0, SHOWN)) : []

  return (
    <SettingsGroup title="电脑操控">
      <SettingsRow
        label={
          <span className="flex items-center gap-2">
            让智能体操作这台电脑
            {unsupported && <Badge variant="warning">这个系统不支持</Badge>}
          </span>
        }
        hint={
          unsupported
            ? 'Linux 上暂不支持。'
            : `开了以后，新任务里智能体能截主屏幕、移动鼠标、点击、输入和按键。看屏幕每个任务问一次，鼠标键盘每一步都问（选了「完全放行」的任务不问）；停止任务或关掉这里马上停。${status?.platform === 'darwin' ? 'Mac 上还要在「系统设置 → 隐私与安全性」里给 Diffra 屏幕录制和辅助功能权限。' : ''}`
        }
      >
        <Switch label="让智能体操作这台电脑" checked={value.enabled && !unsupported} disabled={unsupported} onChange={toggle} />
      </SettingsRow>
      <div className="px-4 py-3" data-testid="computer-audit">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-base">最近的操作</div>
            <div className="mt-0.5 text-xs text-muted-foreground">智能体每次截屏、点击、输入、按键都记在这里（输入的文字只记字数），只存在本机。</div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" onClick={() => void loadAudit()}>
              刷新
            </Button>
            <Button size="sm" variant="ghost" disabled={!audit || audit.length === 0} onClick={() => void clear()}>
              清空记录
            </Button>
          </div>
        </div>
        {audit === null ? (
          <p className="mt-2 text-xs text-muted-foreground">正在读取…</p>
        ) : audit.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">还没有操作记录。</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs" aria-label="电脑操控记录">
            {shown.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex min-w-0 items-start gap-2" data-testid="computer-audit-entry" data-ok={entry.ok}>
                {entry.ok ? <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                <span className="w-12 shrink-0 text-muted-foreground tabular-nums">{formatTime(entry.at)}</span>
                <span className={cn('min-w-0 flex-1 break-words', !entry.ok && 'text-destructive')}>
                  {entry.detail}
                  {entry.error && `：${entry.error}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {audit && audit.length > SHOWN && (
          <Button size="xs" variant="ghost" className="mt-1 -ml-2 text-muted-foreground" onClick={() => setExpanded((current) => !current)}>
            {expanded ? '收起' : `显示全部 ${audit.length} 条`}
          </Button>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>让智能体操作这台电脑？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>打开后，新任务里的智能体能截你的主屏幕（截图会发给模型），移动鼠标、点击、拖动、输入文字和按快捷键，像你自己在操作一样。</p>
                <p>它看屏幕前每个任务问你一次，动鼠标键盘的每一步都会先问你；如果任务选了「完全放行」就不问。屏幕上的内容可能让它做错事，请看清楚再允许。</p>
                <p>随时可以停止任务，或者回到这里关掉，关掉马上生效。每一步都记在「最近的操作」里。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不开</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onSave({ enabled: true, acknowledged: true })}>我明白了，打开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  )
}
