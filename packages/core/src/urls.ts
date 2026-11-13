// 内置浏览器的网址处理，智能体工具和桌面端地址栏共用

export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase()
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(lower) || lower.endsWith('.localhost')
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.localhost):\d+[^\s'"\x1b]*/

// 开发服务器输出里的第一个本地地址（终端里的开发服务器、转到后台的命令共用）；0.0.0.0 换成 localhost 才打得开
export function localUrlIn(output: string): string | null {
  const match = LOCAL_URL.exec(output)
  return match ? match[0].replace('0.0.0.0', 'localhost').replace(/[.,;)]+$/, '') : null
}

// 没写协议时本地地址按 http，其他按 https；只允许 http(s)
export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  const host = text.split(/[/:?#]/)[0] ?? ''
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${isLocalHost(host) ? 'http' : 'https'}://${text}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) URLs can be opened, not ${url.protocol}`)
  return url.toString()
}
