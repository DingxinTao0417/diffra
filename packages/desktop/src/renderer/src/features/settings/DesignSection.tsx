import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { SettingsGroup, SettingsHeader, SettingsRow } from './SettingsLayout'

type Provider = 'pexels' | 'unsplash'

const PROVIDERS: Array<{ id: Provider; label: string; hint: string; apply: string }> = [
  { id: 'pexels', label: 'Pexels', hint: '在 pexels.com/api 免费申请，填 API Key。', apply: 'https://www.pexels.com/api/' },
  { id: 'unsplash', label: 'Unsplash', hint: '在 unsplash.com/developers 建一个应用，填 Access Key。', apply: 'https://unsplash.com/developers' },
]

// 设计（v2 · M11）：图库的 API Key。填了以后设计任务里智能体能直接搜图（design_find_photos），对话里显示缩略图；
// Key 加密存在本机，只在主进程里用，不进设置文件和日志
export function DesignSection() {
  const [hints, setHints] = useState<Record<Provider, string | null> | null>(null)
  const [drafts, setDrafts] = useState<Record<Provider, string>>({ pexels: '', unsplash: '' })

  const load = () =>
    window.diffra
      .stockKeys()
      .then(setHints)
      .catch((error: unknown) => showToast(`读取图库设置失败：${errorMessage(error)}`))
  useEffect(() => {
    void load()
  }, [])

  const save = async (provider: Provider, key: string | null) => {
    try {
      await window.diffra.setStockKey(provider, key)
      setDrafts((current) => ({ ...current, [provider]: '' }))
      await load()
      showToast(key ? '已保存，新开的设计任务能搜图了' : '已删除')
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <SettingsHeader title="设计" description="设计任务里用到的图库。填了 Key，智能体能直接搜免费图片放进设计稿，对话里显示缩略图；用的时候要写上摄影师。" />
      <SettingsGroup title="图库" data-testid="stock-keys">
        {PROVIDERS.map((provider) => {
          const hint = hints?.[provider.id] ?? null
          return (
            <SettingsRow key={provider.id} label={provider.label} hint={hint ? `已填：${hint}` : provider.hint}>
              <Input
                type="password"
                aria-label={`${provider.label} 的 Key`}
                className="h-8 w-56"
                placeholder={hint ? '换一个 Key' : '粘贴 Key'}
                value={drafts[provider.id]}
                onChange={(event) => setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
              />
              <Button size="sm" disabled={!drafts[provider.id].trim()} onClick={() => void save(provider.id, drafts[provider.id].trim())}>
                保存
              </Button>
              {hint && (
                <Button size="sm" variant="ghost" onClick={() => void save(provider.id, null)}>
                  删除
                </Button>
              )}
            </SettingsRow>
          )
        })}
      </SettingsGroup>
      <p className="mt-4 text-sm text-muted-foreground">图片按各图库的许可使用：Pexels 和 Unsplash 的图片都能免费商用、不强制署名，但要求写明来源和摄影师。下载量大时注意各图库的限流。</p>
    </>
  )
}
