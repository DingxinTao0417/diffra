import { Settings } from 'lucide-react'
import { DevicesButton } from '@/features/devices/DevicesOverview'
import { openSettings } from '@/state/actions'
import { useAppState } from '@/state/store'
import { FooterButton } from './FooterButton'
import { UsageButton } from './UsageMenu'

// 侧栏最底下：设备、用量、设置，竖着排，和上面的入口一个样子（docs/decisions.md「左下角的设备和用量」）
export function SidebarFooter() {
  const settingsOpen = useAppState((state) => state.route.name === 'settings')
  return (
    <div className="flex flex-col gap-0.5" data-testid="sidebar-footer">
      <DevicesButton />
      <UsageButton />
      <FooterButton aria-pressed={settingsOpen} icon={<Settings className="size-4" />} label="设置" onClick={() => openSettings()} />
    </div>
  )
}
