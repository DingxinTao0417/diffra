// 内置浏览器的网址处理，智能体工具和桌面端地址栏共用

export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase()
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(lower) || lower.endsWith('.localhost')
}

// 没写协议时本地地址按 http，其他按 https；只允许 http(s)
export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  const host = text.split(/[/:?#]/)[0] ?? ''
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${isLocalHost(host) ? 'http' : 'https'}://${text}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) URLs can be opened, not ${url.protocol}`)
  return url.toString()
}
