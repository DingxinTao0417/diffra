import { useState } from 'react'
import type { CatalogPlugin } from '../../../../shared/extensions'
import type { PluginPrepared } from '../../../../shared/ipc'
import type { PluginView } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { ExtensionRow, initialOf, RowPanel } from './parts'
import { PluginReview } from './PluginReview'

// 目录里的一个插件（第 598 步）：点「安装」先从仓库取回（只取插件所在的子目录）；带钩子的展开给用户看过、选了要不要允许再装，没有钩子的直接装
export function CatalogPluginRow({ entry, installed, onInstalled }: { entry: CatalogPlugin; installed: boolean; onInstalled(plugins: PluginView[]): void }) {
  const [state, setState] = useState<{ step: 'idle' } | { step: 'fetching' } | { step: 'review'; prepared: PluginPrepared } | { step: 'installing'; prepared: PluginPrepared }>({ step: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const commit = async (prepared: PluginPrepared, allowHooks: boolean) => {
    setState({ step: 'installing', prepared })
    try {
      onInstalled(await window.diffra.commitPlugin(prepared.token, allowHooks))
      setState({ step: 'idle' })
    } catch (caught) {
      setError(errorMessage(caught))
      setState({ step: 'idle' })
    }
  }

  const install = async () => {
    setError(null)
    setState({ step: 'fetching' })
    try {
      const prepared = await window.diffra.preparePlugin({ kind: 'catalog', id: entry.id })
      if (!prepared) return setState({ step: 'idle' })
      if (prepared.info.hooks.length === 0) await commit(prepared, false)
      else setState({ step: 'review', prepared })
    } catch (caught) {
      setError(errorMessage(caught))
      setState({ step: 'idle' })
    }
  }

  const cancel = (prepared: PluginPrepared) => {
    setState({ step: 'idle' })
    window.diffra.discardPlugin(prepared.token).catch((caught: unknown) => console.error('放弃安装插件失败', caught))
  }

  const reviewing = state.step === 'review' || state.step === 'installing' ? state.prepared : null
  const busy = state.step === 'fetching' || state.step === 'installing'
  const action = installed ? (
    <span className="text-xs text-muted-foreground">已安装</span>
  ) : entry.unavailable ? (
    <Button size="sm" variant="outline" disabled>
      下一版支持
    </Button>
  ) : reviewing ? null : (
    <Button size="sm" variant="outline" aria-label={`安装 ${entry.name}`} disabled={busy} onClick={() => void install()}>
      {state.step === 'fetching' ? '正在获取…' : state.step === 'installing' ? '正在安装…' : '安装'}
    </Button>
  )
  return (
    <ExtensionRow
      testId="catalog-plugin"
      initial={initialOf(entry.name)}
      dark={entry.group === 'vendor'}
      name={entry.name}
      badge={entry.publisher}
      wide={reviewing !== null}
      detail={
        <>
          <span className="block truncate">
            {entry.description} · {entry.contents}
          </span>
          {(entry.unavailable ?? entry.note) && <span className="block truncate">{entry.unavailable ?? entry.note}</span>}
          {error && <span className="mt-0.5 block text-destructive break-words whitespace-pre-wrap">{error}</span>}
        </>
      }
      actions={action}
    >
      {reviewing && (
        <RowPanel>
          <PluginReview prepared={reviewing} busy={state.step === 'installing'} onInstall={(allow) => void commit(reviewing, allow)} onCancel={() => cancel(reviewing)} />
        </RowPanel>
      )}
    </ExtensionRow>
  )
}
