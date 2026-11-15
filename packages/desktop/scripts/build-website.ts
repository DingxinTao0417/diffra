// 生成官网：node scripts/build-website.ts → out/website/
// - website/layout.html 是公共页头页脚，website/pages/*.html 是各页正文，website/public/ 原样拷到网站根目录
// - 更新日志页（按 tag 从提交信息生成）、第三方许可页（从 NOTICE.md 生成）、sitemap.xml、robots.txt 也在这里生成
// 只是拼静态文件，不用网站框架
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChangelogRelease } from '../src/shared/changelog.ts'
import { readChangelog } from './changelog.ts'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const websiteDir = resolve(desktopDir, '../../website')
export const WEBSITE_OUT = join(desktopDir, 'out', 'website')
export const SITE_ORIGIN = 'https://diffra.dev'

const NAV = [
  { href: '/#features', label: '功能', page: null },
  { href: '/docs.html', label: '文档', page: 'docs.html' },
  { href: '/changelog.html', label: '更新日志', page: 'changelog.html', keep: true },
  { href: '/download.html', label: '下载', page: 'download.html', button: true },
]

interface Page {
  // 输出的文件名，也是网址路径
  file: string
  title: string
  description: string
  body: () => string
  // 不进 sitemap、不让搜索引擎收录
  hidden?: boolean
}

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

// WebP 的像素尺寸：有损（VP8）、无损（VP8L）、扩展（VP8X）三种文件头
export function webpSize(file: string): { width: number; height: number } {
  const data = readFileSync(file)
  const chunk = data.toString('ascii', 12, 16)
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`${file} 不是 WebP`)
  if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = data.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
  throw new Error(`${file} 的 WebP 格式认不出来（${chunk}）`)
}

// 页面里的产品截图写成 width="{{shot:名字}}"，换成真实的宽高，图片加载前就占好位置
const pageBody = (name: string) => () =>
  readFileSync(join(websiteDir, 'pages', name), 'utf8').replace(/width="\{\{shot:([\w-]+)\}\}"/g, (_match, shot: string) => {
    const { width, height } = webpSize(join(websiteDir, 'public', 'assets', 'shots', `${shot}-light.webp`))
    return `width="${width}" height="${height}"`
  })

function changelogBody(releases: ChangelogRelease[]): string {
  const list = (title: string, items: string[]) => (items.length > 0 ? `<h3>${title}</h3>\n<ul>\n${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')}\n</ul>` : '')
  const entries = releases
    .map(
      (release) => `<article class="release-entry" id="v${escapeHtml(release.version)}">
<div><h2>${escapeHtml(release.version)}</h2><span class="date">${escapeHtml(release.date)}</span></div>
<div>
${list('新增', release.added)}
${list('修复', release.fixed)}
</div>
</article>`,
    )
    .join('\n')
  return `<div class="container narrow">
<header class="page-head">
<h1>更新日志</h1>
<p>每个版本新增和修复了什么。应用会在后台自动更新，重启一下就是最新版。</p>
</header>
<div class="prose">
${entries}
</div>
</div>`
}

// NOTICE.md 里的表格：| 组件 | 许可 | 出处 | 用法 |
function licensesBody(): string {
  const rows = readFileSync(join(desktopDir, 'NOTICE.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/`/g, '')))
  const cell = (text: string) => escapeHtml(text).replace(/(https:\/\/[^\s，]+)/g, '<a href="$1" rel="noopener">$1</a>')
  return `<div class="container narrow">
<header class="page-head">
<h1>第三方许可</h1>
<p>Diffra 用到的、需要注明出处的开源组件。</p>
</header>
<div class="prose">
<table>
<thead><tr><th>组件</th><th>许可</th><th>出处</th></tr></thead>
<tbody>
${rows.map(([name = '', license = '', source = '']) => `<tr><td>${cell(name)}</td><td>${cell(license)}</td><td>${cell(source)}</td></tr>`).join('\n')}
</tbody>
</table>
<p>Diffra 基于 Electron 和 Chromium 构建，它们的许可随安装包附带，在安装目录的 <code>LICENSE.electron.txt</code> 和 <code>LICENSES.chromium.html</code> 里。</p>
<p>模型服务商的名字和标志属于各自的所有者，Diffra 只用它们表示「支持接入」，和这些服务商没有合作或隶属关系。</p>
</div>
</div>`
}

function pages(): Page[] {
  const releases = readChangelog()
  return [
    { file: 'index.html', title: 'Diffra · Windows 和 Mac 上的编程智能体', description: '描述任务，Diffra 在你的项目里读代码、改代码、跑检查，做完给你看改动。每一轮都能撤销，模型用你自己的 API Key。', body: pageBody('index.html') },
    { file: 'download.html', title: '下载 Diffra · Windows 和 Mac', description: '下载 Diffra 的 Windows 版和 Mac 版：版本、大小、系统要求、校验值和安装说明。', body: pageBody('download.html') },
    { file: 'docs.html', title: '快速开始 · Diffra', description: '五分钟用上 Diffra：安装、接入模型、开始第一个任务，以及权限模式和浏览器扩展。', body: pageBody('docs.html') },
    { file: 'changelog.html', title: '更新日志 · Diffra', description: 'Diffra 每个版本新增和修复了什么。', body: () => changelogBody(releases) },
    { file: 'privacy.html', title: '隐私政策 · Diffra', description: 'Diffra 处理哪些数据、发到哪里、官网记录什么。', body: pageBody('privacy.html') },
    { file: 'terms.html', title: '用户协议 · Diffra', description: '使用 Diffra 的条款。', body: pageBody('terms.html') },
    { file: 'licenses.html', title: '第三方许可 · Diffra', description: 'Diffra 用到的开源组件和许可。', body: licensesBody },
    { file: 'browser-extension-privacy.html', title: '浏览器扩展隐私政策 · Diffra', description: 'Diffra 浏览器扩展处理哪些数据、发到哪里、不做什么。', body: pageBody('browser-extension-privacy.html') },
    { file: '404.html', title: '页面不存在 · Diffra', description: '这个页面不存在。', body: pageBody('404.html'), hidden: true },
  ]
}

function navHtml(file: string): string {
  return NAV.map((item) => {
    const classes = [item.button ? 'button' : '', item.keep ? 'keep' : ''].filter(Boolean).join(' ')
    const current = item.page === file ? ' aria-current="page"' : ''
    return `      <a href="${item.href}"${classes ? ` class="${classes}"` : ''}${current}>${item.label}</a>`
  }).join('\n')
}

export function buildWebsite(): string[] {
  const layout = readFileSync(join(websiteDir, 'layout.html'), 'utf8')
  // 只清空里面的文件，不删目录本身：本地预览的静态服务可能正开在这个目录里
  mkdirSync(WEBSITE_OUT, { recursive: true })
  for (const name of readdirSync(WEBSITE_OUT)) rmSync(join(WEBSITE_OUT, name), { recursive: true, force: true })
  cpSync(join(websiteDir, 'public'), WEBSITE_OUT, { recursive: true })
  const all = pages()
  for (const page of all) {
    const values: Record<string, string> = {
      title: escapeHtml(page.title),
      description: escapeHtml(page.description),
      url: `${SITE_ORIGIN}/${page.file === 'index.html' ? '' : page.file}`,
      head: page.hidden ? '<meta name="robots" content="noindex">' : '',
      nav: navHtml(page.file),
      body: page.body(),
      year: String(new Date().getFullYear()),
    }
    const html = layout.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = values[key]
      if (value === undefined) throw new Error(`layout.html 里的 ${match} 没有对应的值`)
      return value
    })
    writeFileSync(join(WEBSITE_OUT, page.file), html)
  }
  const listed = all.filter((page) => !page.hidden)
  writeFileSync(
    join(WEBSITE_OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map((page) => `  <url><loc>${SITE_ORIGIN}/${page.file === 'index.html' ? '' : page.file}</loc></url>`).join('\n')}\n</urlset>\n`,
  )
  writeFileSync(join(WEBSITE_OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`)
  const broken = brokenLinks(all.map((page) => page.file))
  if (broken.length > 0) throw new Error(`站内链接有错：\n${broken.join('\n')}`)
  return all.map((page) => page.file)
}

// 站内链接（/ 开头的 href、src、srcset）要指向生成出来的文件；带 # 的要在那个页面里有这个 id
function brokenLinks(files: string[]): string[] {
  const html = new Map(files.map((file) => [file, readFileSync(join(WEBSITE_OUT, file), 'utf8')]))
  const ids = (file: string) => new Set([...(html.get(file) ?? '').matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))
  const broken: string[] = []
  for (const [file, text] of html) {
    for (const [, link = ''] of text.matchAll(/(?:href|src|srcset)="(\/[^"]*)"/g)) {
      const [path = '', hash] = link.split('#')
      const target = path === '/' ? 'index.html' : path.slice(1)
      if (!existsSync(join(WEBSITE_OUT, target))) broken.push(`${file}：${link}（没有 ${target}）`)
      else if (hash && target.endsWith('.html') && !ids(target).has(hash)) broken.push(`${file}：${link}（${target} 里没有 id="${hash}"）`)
    }
  }
  return broken
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = buildWebsite()
    console.log(`官网：${files.length} 个页面，生成到 ${WEBSITE_OUT}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
