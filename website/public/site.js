// 读更新源上的 latest.yml / latest-mac.yml，填版本号、大小、发布日期和校验值（更新源只允许 https://diffra.dev 跨域读 .yml）。
// 还没有发布过版本时下载按钮先不能点；读不到时保留页面里的默认文字，按钮照样能下载
// 首页的下载按钮和版本说明标了 data-follow-platform：用 Mac 打开时换成 Mac 版的
;(() => {
  const RELEASES = [
    {
      attribute: 'data-release',
      buttons: '[data-download]',
      url: 'https://update.diffra.dev/win/latest.yml',
      system: 'Windows 10 / 11 · 64 位',
      // Windows 的 latest.yml 只有一个安装包，取顶层的 sha512 和 size
      file: (text, field) => ({ sha512: field(/^sha512: (.+)$/m), size: Number(field(/^\s+size: (\d+)$/m)) }),
    },
    {
      attribute: 'data-release-mac',
      buttons: '[data-download-mac]',
      url: 'https://update.diffra.dev/mac/latest-mac.yml',
      system: 'macOS 12 及以上 · Apple 芯片（M 系列）',
      // Mac 的 latest-mac.yml 顶层是自动更新用的 zip，官网要的是 dmg 那一项
      file: (text) => {
        const match = /- url: \S+\.dmg\s+sha512: (\S+)\s+size: (\d+)/.exec(text)
        return { sha512: match?.[1], size: Number(match?.[2]) }
      },
    },
  ]

  // iPad 的 Safari 也自称 Mac，用触点数区分
  const IS_MAC = /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints < 2
  if (IS_MAC) {
    for (const element of document.querySelectorAll('[data-follow-platform]')) {
      if (element.hasAttribute('data-release')) {
        element.removeAttribute('data-release')
        element.setAttribute('data-release-mac', 'summary')
        element.textContent = RELEASES[1].system
      }
      if (element.hasAttribute('data-download')) {
        element.removeAttribute('data-download')
        element.setAttribute('data-download-mac', '')
        element.setAttribute('href', '/download.html#mac')
        const label = element.querySelector('[data-download-label]') ?? element
        label.textContent = '下载 Mac 版'
      }
    }
  }

  const load = async ({ attribute, buttons, url, system, file }) => {
    if (!document.querySelector(`[${attribute}]`)) return
    const set = (name, text) => {
      for (const element of document.querySelectorAll(`[${attribute}="${name}"]`)) element.textContent = text
    }
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.status === 404) {
        set('summary', '还没有发布版本，敬请期待')
        for (const button of document.querySelectorAll(buttons)) button.setAttribute('aria-disabled', 'true')
        return
      }
      if (!response.ok) return
      const text = await response.text()
      const field = (pattern) => pattern.exec(text)?.[1]?.trim()
      const version = field(/^version: (.+)$/m)
      if (!version) return
      const { sha512, size } = file(text, field)
      const date = field(/^releaseDate: '?([^'\n]+)'?$/m)
      const megabytes = size ? `${Math.round(size / 1024 / 1024)} MB` : ''
      const day = date ? new Date(date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
      set('summary', ['版本 ' + version, megabytes, system].filter(Boolean).join(' · '))
      set('version', version)
      if (megabytes) set('size', megabytes)
      if (day) set('date', day)
      if (sha512) set('sha512', sha512)
    } catch {
      // 网络不通或被拦：保留默认文字
    }
  }
  for (const release of RELEASES) void load(release)
})()
