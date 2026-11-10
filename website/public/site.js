// 读更新源上的 latest.yml，填版本号、大小、发布日期和校验值（更新源只允许 https://diffra.dev 跨域读 .yml）。
// 还没有发布过版本时下载按钮先不能点；读不到时保留页面里的默认文字，按钮照样能下载
;(async () => {
  const fields = document.querySelectorAll('[data-release]')
  if (fields.length === 0) return
  const set = (name, text) => {
    for (const element of document.querySelectorAll(`[data-release="${name}"]`)) element.textContent = text
  }
  try {
    const response = await fetch('https://update.diffra.dev/win/latest.yml', { cache: 'no-store' })
    if (response.status === 404) {
      set('summary', '还没有发布版本，敬请期待')
      for (const button of document.querySelectorAll('[data-download]')) button.setAttribute('aria-disabled', 'true')
      return
    }
    if (!response.ok) return
    const text = await response.text()
    const field = (pattern) => pattern.exec(text)?.[1]?.trim()
    const version = field(/^version: (.+)$/m)
    if (!version) return
    const size = Number(field(/^\s+size: (\d+)$/m))
    const sha512 = field(/^sha512: (.+)$/m)
    const date = field(/^releaseDate: '?([^'\n]+)'?$/m)
    const megabytes = size ? `${Math.round(size / 1024 / 1024)} MB` : ''
    const day = date ? new Date(date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
    set('summary', ['版本 ' + version, megabytes, 'Windows 10 / 11 · 64 位'].filter(Boolean).join(' · '))
    set('version', version)
    if (megabytes) set('size', megabytes)
    if (day) set('date', day)
    if (sha512) set('sha512', sha512)
  } catch {
    // 网络不通或被拦：保留默认文字
  }
})()
