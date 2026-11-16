import type { StockPhoto, StockPhotoParams, StockPhotoResult } from '@diffra/core/types'
import type { SecretStore } from './secret-store'
import { testOverridesAllowed } from './test-overrides'

// 设计任务里找图（v2 · M11）：用用户自己的 Pexels / Unsplash API Key 搜。Key 存在 SecretStore（stock:pexels、stock:unsplash），
// 只在主进程里用，不进设置文件、日志和 core。缩略图在这里下载成 data: 地址（界面的 CSP 只许本地和 data 图片，也不让界面直连外网）
export const STOCK_PROVIDERS = ['pexels', 'unsplash'] as const
export type StockProvider = (typeof STOCK_PROVIDERS)[number]
export const stockKeyId = (provider: StockProvider) => `stock:${provider}`

const REQUEST_TIMEOUT_MS = 15_000
const THUMB_TIMEOUT_MS = 10_000
const MAX_THUMB_BYTES = 120 * 1024
const THUMB_TYPES = /^image\/(jpeg|png|webp)$/

// e2e 用本机的假图库；只在测试允许改写时认
function baseUrl(provider: StockProvider): string {
  const override = testOverridesAllowed() ? process.env[provider === 'pexels' ? 'DIFFRA_PEXELS_URL' : 'DIFFRA_UNSPLASH_URL'] : undefined
  return override ?? (provider === 'pexels' ? 'https://api.pexels.com' : 'https://api.unsplash.com')
}

async function fetchJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) })
  if (response.status === 401 || response.status === 403) throw new Error('Key 不对或没有权限')
  if (response.status === 429) throw new Error('请求太多，被限流了，过一会儿再试')
  if (!response.ok) throw new Error(`返回 ${response.status}`)
  return response.json()
}

async function thumbnail(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(THUMB_TIMEOUT_MS)]) })
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!response.ok || !THUMB_TYPES.test(type)) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > MAX_THUMB_BYTES ? null : `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

type Found = Omit<StockPhoto, 'thumb'> & { thumbUrl: string }

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

async function searchPexels(key: string, params: Omit<StockPhotoParams, 'sessionId'>, signal: AbortSignal): Promise<Found[]> {
  const url = new URL('/v1/search', baseUrl('pexels'))
  url.searchParams.set('query', params.query)
  url.searchParams.set('per_page', String(params.count))
  if (params.orientation) url.searchParams.set('orientation', params.orientation)
  const body = (await fetchJson(url.toString(), { Authorization: key }, signal)) as { photos?: Array<Record<string, unknown>> }
  return (body.photos ?? []).flatMap((photo) => {
    const src = (photo.src ?? {}) as Record<string, unknown>
    const large = text(src.large2x) || text(src.large) || text(src.original)
    const thumb = text(src.tiny) || text(src.small)
    if (!large || !thumb) return []
    return [{ provider: 'pexels' as const, url: large, thumbUrl: thumb, width: num(photo.width), height: num(photo.height), alt: text(photo.alt), photographer: text(photo.photographer), photographerUrl: text(photo.photographer_url), pageUrl: text(photo.url) }]
  })
}

async function searchUnsplash(key: string, params: Omit<StockPhotoParams, 'sessionId'>, signal: AbortSignal): Promise<Found[]> {
  const url = new URL('/search/photos', baseUrl('unsplash'))
  url.searchParams.set('query', params.query)
  url.searchParams.set('per_page', String(params.count))
  if (params.orientation) url.searchParams.set('orientation', params.orientation === 'square' ? 'squarish' : params.orientation)
  const body = (await fetchJson(url.toString(), { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' }, signal)) as { results?: Array<Record<string, unknown>> }
  return (body.results ?? []).flatMap((photo) => {
    const urls = (photo.urls ?? {}) as Record<string, unknown>
    const user = (photo.user ?? {}) as Record<string, unknown>
    const links = (photo.links ?? {}) as Record<string, unknown>
    const userLinks = (user.links ?? {}) as Record<string, unknown>
    const large = text(urls.regular) || text(urls.full)
    const thumb = text(urls.thumb) || text(urls.small)
    if (!large || !thumb) return []
    return [{ provider: 'unsplash' as const, url: large, thumbUrl: thumb, width: num(photo.width), height: num(photo.height), alt: text(photo.alt_description) || text(photo.description), photographer: text(user.name), photographerUrl: text(userLinks.html), pageUrl: text(links.html) }]
  })
}

export async function configuredStockProviders(secrets: SecretStore): Promise<StockProvider[]> {
  const found: StockProvider[] = []
  for (const provider of STOCK_PROVIDERS) if (await secrets.get(stockKeyId(provider))) found.push(provider)
  return found
}

// 填了 Key 的图库都搜，各取一半；一个失败另一个照样返回
export async function searchStockPhotos(secrets: SecretStore, params: Omit<StockPhotoParams, 'sessionId'>, signal: AbortSignal): Promise<StockPhotoResult> {
  const providers = await configuredStockProviders(secrets)
  if (providers.length === 0) throw new Error('没有填图库的 API Key（设置 → 设计）')
  const each = Math.max(1, Math.ceil(params.count / providers.length))
  const errors: string[] = []
  const lists = await Promise.all(
    providers.map(async (provider) => {
      const key = (await secrets.get(stockKeyId(provider)))!
      try {
        return await (provider === 'pexels' ? searchPexels : searchUnsplash)(key, { ...params, count: each }, signal)
      } catch (error) {
        errors.push(`${provider === 'pexels' ? 'Pexels' : 'Unsplash'}：${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }),
  )
  const found = lists.flat().slice(0, params.count)
  const photos: StockPhoto[] = []
  // 缩略图并发取，最多四个一批
  for (let index = 0; index < found.length; index += 4) {
    const batch = found.slice(index, index + 4)
    const thumbs = await Promise.all(batch.map((item) => thumbnail(item.thumbUrl, signal)))
    batch.forEach(({ thumbUrl: _thumbUrl, ...item }, at) => photos.push({ ...item, thumb: thumbs[at] ?? '' }))
  }
  return { photos, errors }
}
