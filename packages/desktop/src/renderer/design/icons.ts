import { icons as lucide, info as lucideInfo } from '@iconify-json/lucide'
import { createIconifyProvider, type IconProvider } from '@open-pencil/core/icons'

// 设计页断网，引擎默认的 Iconify 图标源要联网取图标。这里给它一个读内置 Lucide 图标数据的客户端
// （取图标、图标集列表、浏览、搜索四个接口），引擎其余的图标逻辑（绘制、预览、换色）照常用。别的图标集一律当作没有
const PREFIX = lucide.prefix
const names = Object.keys(lucide.icons)
const aliases = lucide.aliases ?? {}
const DEFAULT_SEARCH_LIMIT = 5

// 按名字找：查询词拆成几段，名字（含别名）里都出现才算；名字以查询开头、短的排前面
function find(query: string): string[] {
  const words = query.toLowerCase().split(/[\s,_-]+/).filter(Boolean)
  if (words.length === 0) return []
  const hits = [...names, ...Object.keys(aliases)].filter((name) => words.every((word) => name.includes(word)))
  hits.sort((a, b) => Number(b.startsWith(words[0]!)) - Number(a.startsWith(words[0]!)) || a.length - b.length)
  return [...new Set(hits.map((name) => aliases[name]?.parent ?? name))]
}

const localClient = {
  async fetchCollection(prefix: string, iconNames: string[]) {
    if (prefix !== PREFIX) return { prefix, icons: {}, not_found: iconNames }
    const icons: Record<string, (typeof lucide.icons)[string]> = {}
    const found: Record<string, { parent: string }> = {}
    const missing: string[] = []
    for (const name of iconNames) {
      const target = aliases[name]?.parent ?? name
      const icon = lucide.icons[target]
      if (!icon) {
        missing.push(name)
        continue
      }
      icons[target] = icon
      if (target !== name) found[name] = { parent: target }
    }
    return { prefix, icons, aliases: found, width: lucide.width, height: lucide.height, not_found: missing }
  },
  async collections() {
    return [{ prefix: PREFIX, name: lucideInfo.name, total: lucideInfo.total ?? names.length, category: lucideInfo.category ?? null, license: lucideInfo.license?.title ?? null, multicolor: false }]
  },
  async collectionIcons(prefix: string) {
    return prefix === PREFIX ? names.map((name) => `${PREFIX}:${name}`) : []
  },
  async search(query: string, options?: { limit?: number; prefix?: string }) {
    const hits = options?.prefix && options.prefix !== PREFIX ? [] : find(query)
    return {
      icons: hits.slice(0, options?.limit ?? DEFAULT_SEARCH_LIMIT).map((name) => `${PREFIX}:${name}`),
      total: hits.length,
      collections: hits.length > 0 ? { [PREFIX]: { name: lucideInfo.name, total: lucideInfo.total ?? names.length } } : {},
    }
  },
}

export function createLocalIcons(): IconProvider {
  return createIconifyProvider(localClient as Parameters<typeof createIconifyProvider>[0])
}

// 给智能体的说明里用：内置的是哪套图标、名字怎么写
export const ICON_SET_HINT = `Icons: only the built-in "${PREFIX}" set (Lucide, ${names.length} icons) works offline; name icons as ${PREFIX}:<name>, e.g. ${PREFIX}:house, ${PREFIX}:search, ${PREFIX}:bell. Other icon sets cannot be loaded.`
