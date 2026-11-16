import type { SystemSettings } from '../../../../shared/settings'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/errors'
import { IS_MAC } from '@/lib/platform'
import { showToast, store, useAppState } from '@/state/store'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

// 托盘和开机自启（v2 · M7）：关窗口留在托盘里默认开、开机自启默认关，改了马上生效
export function StartupGroup() {
  const system = useAppState((state) => state.settings?.system ?? null)
  if (!system) return null
  const save = async (next: SystemSettings) => {
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, system: next } } : state))
    try {
      const settings = await window.diffra.savePreferences({ system: next })
      store.set((state) => ({ ...state, settings }))
    } catch (error) {
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, system } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }
  return (
    <SettingsGroup title="启动和后台">
      <SettingsRow
        label={IS_MAC ? '在菜单栏显示图标' : '关掉窗口时留在托盘里'}
        hint={
          IS_MAC
            ? '菜单栏里的图标能打开窗口、新建任务、看几个任务在跑、退出。关掉窗口本来就会留在后台。'
            : '关掉窗口后 Diffra 留在任务栏右下角的托盘里，任务接着跑；点托盘图标打开，右键能新建任务、看几个任务在跑、退出。'
        }
      >
        <Switch label={IS_MAC ? '在菜单栏显示图标' : '关掉窗口时留在托盘里'} checked={system.tray} onChange={(tray) => void save({ ...system, tray })} />
      </SettingsRow>
      <SettingsRow label="开机时自动启动" hint={system.tray ? '登录系统后自动打开 Diffra，不弹窗口，直接留在托盘里。' : '登录系统后自动打开 Diffra。打开上面一项的话会直接留在托盘里、不弹窗口。'}>
        <Switch label="开机时自动启动" checked={system.launchAtLogin} onChange={(launchAtLogin) => void save({ ...system, launchAtLogin })} />
      </SettingsRow>
    </SettingsGroup>
  )
}
