// 把 Diffra 浏览器扩展的商店包传到 Chrome 应用商店和 Edge 加载项商店并提交审核：node scripts/publish-extension.ts
// 先跑 build-extension.ts --store 打出 release/diffra-browser-extension-<版本>.zip。
// 哪个商店的凭据没配就跳过那个商店；商店里的条目要先在后台手动建好（API 只能更新已有的条目）。
//   Chrome：CWS_CLIENT_ID、CWS_CLIENT_SECRET、CWS_REFRESH_TOKEN、CWS_PUBLISHER_ID、CWS_EXTENSION_ID
//   Edge：EDGE_CLIENT_ID、EDGE_API_KEY、EDGE_PRODUCT_ID
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const REQUEST_TIMEOUT_MS = 120_000
const POLL_MS = 5_000
const POLL_LIMIT = 60

const manifest = JSON.parse(readFileSync(join(root, 'browser-extension', 'manifest.json'), 'utf8')) as { version: string }
const zipPath = join(root, 'release', `diffra-browser-extension-${manifest.version}.zip`)
const zip = readFileSync(zipPath)

function env(names: string[]): Record<string, string> | null {
  const values = Object.fromEntries(names.map((name) => [name, process.env[name] ?? '']))
  const missing = names.filter((name) => !values[name])
  if (missing.length === names.length) return null
  if (missing.length > 0) throw new Error(`缺少 ${missing.join('、')}`)
  return values
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} 失败：${response.status} ${await response.text()}`)
  return response
}

async function publishChrome(): Promise<void> {
  const config = env(['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID'])
  if (!config) return console.log('Chrome 应用商店：没配凭据，跳过')
  const token = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.CWS_CLIENT_ID!, client_secret: config.CWS_CLIENT_SECRET!, refresh_token: config.CWS_REFRESH_TOKEN!, grant_type: 'refresh_token' }),
  }).then((response) => response.json() as Promise<{ access_token: string }>)
  const item = `publishers/${config.CWS_PUBLISHER_ID}/items/${config.CWS_EXTENSION_ID}`
  const headers = { authorization: `Bearer ${token.access_token}` }
  // 商店要求清单里的版本号比线上的大，否则上传失败
  const upload = await request(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: zip })
  console.log('Chrome 应用商店：已上传', await upload.text())
  const publish = await request(`https://chromewebstore.googleapis.com/v2/${item}:publish`, { method: 'POST', headers })
  console.log('Chrome 应用商店：已提交审核', await publish.text())
}

async function waitOperation(url: string, headers: Record<string, string>, label: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt++) {
    const status = (await request(url, { headers }).then((response) => response.json())) as { status?: string; message?: string; errors?: unknown }
    if (status.status === 'Succeeded') return
    if (status.status === 'Failed') throw new Error(`${label}失败：${status.message ?? ''} ${JSON.stringify(status.errors ?? '')}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`${label}等了 ${(POLL_MS * POLL_LIMIT) / 1000} 秒还没结果`)
}

async function publishEdge(): Promise<void> {
  const config = env(['EDGE_CLIENT_ID', 'EDGE_API_KEY', 'EDGE_PRODUCT_ID'])
  if (!config) return console.log('Edge 加载项商店：没配凭据，跳过')
  const base = `https://api.addons.microsoftedge.microsoft.com/v1/products/${config.EDGE_PRODUCT_ID}/submissions`
  const headers = { authorization: `ApiKey ${config.EDGE_API_KEY}`, 'x-clientid': config.EDGE_CLIENT_ID! }
  const operationOf = (response: Response) => response.headers.get('location')?.split('/').pop() ?? ''
  const upload = await request(`${base}/draft/package`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: zip })
  await waitOperation(`${base}/draft/package/operations/${operationOf(upload)}`, headers, 'Edge 上传')
  console.log('Edge 加载项商店：已上传')
  const publish = await request(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ notes: `Diffra 浏览器扩展 ${manifest.version}` }) })
  await waitOperation(`${base}/operations/${operationOf(publish)}`, headers, 'Edge 提交审核')
  console.log('Edge 加载项商店：已提交审核')
}

// 两个商店互不影响：一个失败另一个照样传，最后有失败就退出码 1
const results = await Promise.allSettled([publishChrome(), publishEdge()])
for (const result of results) if (result.status === 'rejected') console.error(result.reason)
if (results.some((result) => result.status === 'rejected')) process.exit(1)
