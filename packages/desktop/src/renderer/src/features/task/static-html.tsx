import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StaticContext } from './static-context'

// 统一静态渲染（第 671 步）：用对话里同一套组件在屏幕外渲染一遍，等代码高亮、公式、流程图、图表都画好，取出 HTML，
// 配上应用此刻的样式和主题（深浅色、配色、字号），成一份不带脚本、不联网的单文件 HTML。导出、分享都用它；
// 远程设备本来就按同一份数据用同一套组件渲染。可视化换成快照（没有快照的写明），只有图标的按钮去掉

// DOM 这么久没变、也没有还在加载的块（aria-busy）就算画好了；最多等这么久
const SETTLE_MS = 500
const MAX_WAIT_MS = 15_000

// 公式：KaTeX 的字体在应用的资源目录里，单文件带不走，改用浏览器自己排的 MathML（KaTeX 同时输出了这一份）
const STATIC_CSS = `
html,body{height:auto;overflow:visible}
body{margin:0}
.diffra-static{box-sizing:border-box;max-width:var(--content-max);margin:0 auto;padding:32px 16px;display:flex;flex-direction:column;gap:1.75rem}
.katex .katex-html{display:none}
.katex .katex-mathml{position:static;clip:auto;width:auto;height:auto;overflow:visible;padding:0;border:0}
`

export async function renderStaticHtml(node: ReactNode, title: string): Promise<string> {
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.inert = true
  // 屏幕外、和对话列一样宽：图表、流程图按容器宽度画
  container.style.cssText = 'position:fixed;left:-100000px;top:0;width:var(--content-max);pointer-events:none'
  document.body.append(container)
  const root = createRoot(container)
  try {
    root.render(
      <StaticContext.Provider value={true}>
        <TooltipProvider>{node}</TooltipProvider>
      </StaticContext.Provider>,
    )
    await settled(container)
    return documentOf(title, cleaned(container))
  } finally {
    root.unmount()
    container.remove()
  }
}

async function settled(container: HTMLElement): Promise<void> {
  let changedAt = Date.now()
  const observer = new MutationObserver(() => (changedAt = Date.now()))
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true })
  const started = Date.now()
  try {
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (Date.now() - changedAt >= SETTLE_MS && container.childElementCount > 0 && !container.querySelector('[aria-busy="true"]')) return
    }
  } finally {
    observer.disconnect()
  }
}

function cleaned(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement
  // 克隆不带画布上的像素：换成图片
  const canvases = [...container.querySelectorAll('canvas')]
  copy.querySelectorAll('canvas').forEach((canvas, index) => {
    const image = document.createElement('img')
    image.src = canvases[index]?.toDataURL() ?? ''
    image.width = canvas.width
    image.height = canvas.height
    canvas.replaceWith(image)
  })
  for (const element of copy.querySelectorAll('iframe, script, [data-static-omit]')) element.remove()
  // 只有图标的按钮（复制、展开、另存为……）在静态页里点了没用；带字的留着当说明
  for (const button of copy.querySelectorAll('button')) if (!button.textContent?.trim()) button.remove()
  for (const element of copy.querySelectorAll('[tabindex]')) element.removeAttribute('tabindex')
  return copy.innerHTML
}

function documentOf(title: string, body: string): string {
  // 主题在 <html> 上：.dark、data-palette、data-font、data-width 和内联的变量
  const attributes = [...document.documentElement.attributes].map((attribute) => ` ${attribute.name}="${escapeHtml(attribute.value)}"`).join('')
  // 不带脚本、不联网：图片只认 data:
  const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
  const css = `${appCss()}${STATIC_CSS}`.replace(/<\/style/gi, '<\\/style')
  return `<!doctype html><html${attributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><main class="diffra-static">${body}</main></body></html>`
}

// 应用此刻加载着的样式（按需加载的公式样式也在里面）；字体文件带不走，@font-face 不要
function appCss(): string {
  return [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules].filter((rule) => !(rule instanceof CSSFontFaceRule)).map((rule) => rule.cssText)
      } catch {
        return []
      }
    })
    .join('\n')
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
}
