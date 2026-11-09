// 图标的重模块：只通过 useLobeIcons() 动态导入，不进主界面的入口
import { modelMappings } from '@lobehub/icons/es/features/modelConfig'
import { toc } from '@lobehub/icons/es/toc'
import type { ProviderConfig } from '../../../shared/settings'
import { LOBE_ICONS } from './lobe-icon-table'
import { type IconEntry, type ModelIconRule, modelIconId, providerIconId } from './model-icons'
import { cn } from 'cn'

const entries: IconEntry[] = toc
  .filter((item) => item.id in LOBE_ICONS)
  .map(({ id, title, fullTitle, group }) => ({ id, title, fullTitle, group }))

// 品牌入口把各个变体挂在 Mono 组件上再导出，所以模型匹配表里的 Icon 和表里的 Mono 是同一个对象，按引用反查 id
const idByMono = new Map<unknown, string>(Object.entries(LOBE_ICONS).map(([id, icon]) => [icon.Mono, id]))
const modelRules: ModelIconRule[] = modelMappings.flatMap((mapping) => {
  const id = idByMono.get(mapping.Icon)
  return id ? [{ id, patterns: mapping.keywords.map((keyword) => new RegExp(keyword, 'i')) }] : []
})
if (modelRules.length < modelMappings.length) {
  console.warn(`模型匹配表有 ${modelMappings.length - modelRules.length} 条反查不到图标 id，这些模型会用服务的图标`)
}

// 显示的名字：标题重名的（Azure 和 Microsoft 都叫 Azure，Grok 和 xAI 都叫 Grok）换成完整标题，还重名就用 id
const countBy = (texts: string[]) => texts.reduce((counts, text) => counts.set(text, (counts.get(text) ?? 0) + 1), new Map<string, number>())
const titleCounts = countBy(entries.map((entry) => entry.title.toLowerCase()))
const fullTitleCounts = countBy(entries.map((entry) => entry.fullTitle.toLowerCase()))
const labels = new Map(
  entries.map((entry) => [
    entry.id,
    titleCounts.get(entry.title.toLowerCase()) === 1 ? entry.title : fullTitleCounts.get(entry.fullTitle.toLowerCase()) === 1 ? entry.fullTitle : entry.id,
  ]),
)

// 彩色版的主体是近黑色，深色底上看不清，深色主题改用单色
const DARK_MONO = new Set(['AionLabs', 'CogVideo', 'CogView', 'LlmApi', 'Meshy', 'Targon', 'Unsloth'])

// 选择器里的清单：服务类、模型类
export function listIcons(): IconEntry[] {
  return entries.filter((entry) => entry.group === 'provider' || entry.group === 'model')
}

export function iconLabel(id: string): string | null {
  return labels.get(id) ?? null
}

export function matchProviderIcon(provider: Pick<ProviderConfig, 'icon' | 'presetId' | 'name' | 'baseUrl'>): string | null {
  return providerIconId(provider, entries)
}

export function matchModelIcon(modelId: string): string | null {
  return modelIconId(modelId, modelRules)
}

// 有彩色版用彩色，没有用单色（跟随 currentColor）；找不到返回 null
// SVG 里自带 <title>，不接鼠标事件，免得悬停时冒出浏览器原生提示
export function renderIcon(id: string, size: number, className?: string) {
  const icon = LOBE_ICONS[id]
  if (!icon) return null
  const { Mono, Color } = icon
  if (Color && DARK_MONO.has(id)) {
    return (
      <>
        <Color aria-hidden size={size} className={cn('pointer-events-none dark:hidden', className)} />
        <Mono aria-hidden size={size} className={cn('pointer-events-none hidden dark:inline', className)} />
      </>
    )
  }
  const Icon = Color ?? Mono
  return <Icon aria-hidden size={size} className={cn('pointer-events-none', className)} />
}
