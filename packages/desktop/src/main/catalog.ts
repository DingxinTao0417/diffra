import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { CATALOG_UPDATED_AT, type CatalogView } from '../shared/extensions'
import { builtinCatalog, type CatalogDocument, parseCatalog } from './catalog-schema'
import { readJsonFile, writeJsonFileAtomic, WriteQueue } from './json-file'
import { testOverridesAllowed } from './test-overrides'

// 扩展目录联网更新（v2 · M4）：官网的 extensions/catalog.json 是构建官网时从内置目录生成的同一份格式。
// 扩展页打开时取，带 ETag，没变就是 304；取到的逐项校验，认不出或不安全的项丢掉，其余照用；比内置目录新才用。
// 取不到时用上次缓存的，没有缓存用内置的。目录只决定「能装什么」，已经装上的服务器、插件在设置里，目录怎么变都不动它们
const CATALOG_URL = 'https://diffra.dev/extensions/catalog.json'
const FETCH_TIMEOUT_MS = 15_000
const MAX_BYTES = 2_000_000
// 一小时内查过就不再查，除非用户点「检查更新」
const CHECK_INTERVAL_MS = 60 * 60_000

function catalogUrl(): string {
  return (testOverridesAllowed() ? process.env.DIFFRA_CATALOG_URL : undefined) ?? CATALOG_URL
}

function parseLogged(raw: unknown): CatalogDocument {
  const { document, dropped } = parseCatalog(raw)
  for (const entry of dropped) console.warn(`[catalog] 丢掉认不出的目录项 ${entry.kind}:${entry.id}`, entry.reason)
  return document
}

const cacheSchema = z.object({ etag: z.string().nullable(), fetchedAt: z.string(), document: z.unknown() })

interface Cache {
  etag: string | null
  fetchedAt: string
  document: CatalogDocument
}

const cachePath = () => join(app.getPath('userData'), 'extensions-catalog.json')
const writes = new WriteQueue()

let cache: Cache | null = null
let cacheLoaded = false
let lastError: string | null = null
let lastCheck = 0
let checking: Promise<void> | null = null

async function loadCache(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const content = await readJsonFile(cachePath(), cacheSchema)
    if (content.state === 'loaded') cache = { ...content.value, document: parseLogged(content.value.document) }
    else if (content.state === 'invalid') console.warn('[catalog] 缓存的目录读不出来，忽略', content.error)
  } catch (error) {
    console.warn('[catalog] 缓存的目录读不出来，忽略', error)
  }
}

// 联网取到的目录比内置的新（或一样新）才用：用户装了新版本、官网还没更新时，不拿旧目录盖掉新的
export function catalogView(): CatalogView {
  const online = cache && cache.document.updatedAt >= CATALOG_UPDATED_AT ? cache : null
  const document = online?.document ?? builtinCatalog()
  return {
    mcp: document.mcp,
    plugins: document.plugins,
    updatedAt: document.updatedAt,
    source: online ? (lastError ? 'cache' : 'online') : 'builtin',
    fetchedAt: cache?.fetchedAt ?? null,
    error: lastError,
  }
}

// 界面上一句话的原因；完整的错误进日志
function failure(error: unknown): string {
  if (error instanceof z.ZodError) return '目录格式不对'
  if (error instanceof SyntaxError) return '目录不是 JSON'
  if (error instanceof Error && error.name === 'TimeoutError') return '超时'
  // Node 的 fetch 连不上（断网、DNS、拒绝连接）时是 TypeError: fetch failed
  if (error instanceof TypeError) return '连不上'
  return error instanceof Error ? error.message : String(error)
}

async function check(): Promise<void> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (cache?.etag) headers['If-None-Match'] = cache.etag
  try {
    const response = await fetch(catalogUrl(), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status === 304 && cache) {
      cache = { ...cache, fetchedAt: new Date().toISOString() }
    } else if (response.ok) {
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_BYTES) throw new Error('目录文件太大')
      const body = await response.text()
      if (body.length > MAX_BYTES) throw new Error('目录文件太大')
      cache = { etag: response.headers.get('etag'), fetchedAt: new Date().toISOString(), document: parseLogged(JSON.parse(body)) }
    } else {
      throw new Error(`HTTP ${response.status}`)
    }
    lastError = null
    const saved = cache
    await writes.run(() => writeJsonFileAtomic(cachePath(), saved))
  } catch (error) {
    lastError = failure(error)
    console.warn('[catalog] 联网取扩展目录失败，用缓存或内置的', error)
  } finally {
    lastCheck = Date.now()
  }
}

// mode：cached 只读缓存不联网（扩展页先显示出来）；check 超过一小时没查就查；force 现在查
export async function loadCatalog(mode: 'cached' | 'check' | 'force'): Promise<CatalogView> {
  await loadCache()
  if (mode === 'force' || (mode === 'check' && Date.now() - lastCheck > CHECK_INTERVAL_MS)) {
    checking ??= check().finally(() => (checking = null))
    await checking
  }
  return catalogView()
}
