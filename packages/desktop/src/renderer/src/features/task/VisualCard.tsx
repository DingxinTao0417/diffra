import { useEffect, useRef, useState } from 'react'
import { Code, Download, ExternalLink, Image as ImageIcon, Maximize2, Minimize2, Sparkles, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { fillComposer } from '@/state/actions'
import { showToast, store, useAppState } from '@/state/store'

// 主题令牌：按应用当前的深浅色和配色取值，给模型写的代码用（名字在 show_visual 的说明里）
const TOKENS: Array<[string, string]> = [
  ['--bg', '--background'],
  ['--fg', '--foreground'],
  ['--muted', '--muted-foreground'],
  ['--border', '--border'],
  ['--card', '--card'],
  // primary-color-allow: 把主题色交给可视化，由模型决定怎么用
  ['--primary', '--primary'],
  // primary-color-allow: 同上，主题色上的文字色
  ['--on-primary', '--primary-foreground'],
  ['--soft', '--soft'],
  ['--accent', '--accent'],
  ['--warning', '--warning'],
  ['--danger', '--destructive'],
  // success-color-allow: 把主题的成功色交给可视化（比如图表里表示通过）
  ['--success', '--success'],
  ['--font-sans', '--font-sans'],
  ['--font-mono', '--font-mono'],
]
const MAX_HEIGHT = 4000
const MAX_FILL = 4000

function themeCss(): string {
  const style = getComputedStyle(document.documentElement)
  const vars = TOKENS.map(([name, source]) => `${name}:${style.getPropertyValue(source).trim()};`).join('')
  const dark = document.documentElement.classList.contains('dark')
  return `:root{${vars}color-scheme:${dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent}body{padding:4px 2px;color:var(--fg);font:14px/1.6 var(--font-sans)}*{box-sizing:border-box}`
}

// 在容器页里跑的那段：报内容高度、diffra.fill 把文字交给输入框、点链接先交给主界面确认。放在最前面，用户代码一开始就能用
const RUNTIME = `<script>(function(){
var send=function(message){parent.postMessage(message,'*')};
var report=function(){send({type:'diffra-visual-height',height:Math.ceil(document.documentElement.scrollHeight)})};
new ResizeObserver(report).observe(document.documentElement);window.addEventListener('load',report);
window.diffra={fill:function(text){send({type:'diffra-visual-fill',text:String(text)})}};
window.sendPrompt=window.diffra.fill;
document.addEventListener('click',function(event){var link=event.target&&event.target.closest&&event.target.closest('a[href]');if(!link)return;event.preventDefault();if(/^https?:/i.test(link.href))send({type:'diffra-visual-link',href:link.href})},true);
window.open=function(url){if(url&&/^https?:/i.test(String(url)))send({type:'diffra-visual-link',href:String(url)});return null};
})()</script>`

export function visualDocument(title: string, code: string, css = themeCss()): string {
  const escaped = title.replace(/[<&]/g, (char) => (char === '<' ? '&lt;' : '&amp;'))
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>${css}</style></head><body>${RUNTIME}${code}</body></html>`
}

// 对话里的可视化：模型写的 HTML 在沙箱 iframe 里的容器页跑（能联网、能跑脚本，没有同源权限，碰不到应用的接口）。
// 高度跟着内容走；可以放大、另存为 HTML 或 PNG、看代码；里面的按钮能把文字填进输入框，链接要先确认
export function VisualCard({ title, code, sessionId }: { title: string; code: string; sessionId: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const [expanded, setExpanded] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  // 主题、配色变了就重新渲染一次，令牌跟着换
  const appearance = useAppState((state) => state.settings?.appearance)
  const [version, setVersion] = useState(0)
  useEffect(() => setVersion((current) => current + 1), [appearance])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const data = event.data as { type?: unknown; height?: unknown; text?: unknown; href?: unknown } | null
      if (data?.type === 'diffra-visual-ready') target.postMessage({ type: 'diffra-visual', html: visualDocument(title, code) }, '*')
      else if (data?.type === 'diffra-visual-height' && typeof data.height === 'number') setHeight(Math.min(Math.max(Math.ceil(data.height), 40), MAX_HEIGHT))
      else if (data?.type === 'diffra-visual-fill' && typeof data.text === 'string' && data.text.trim()) fillComposer(sessionId, data.text.slice(0, MAX_FILL))
      else if (data?.type === 'diffra-visual-link' && typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) setLink(data.href)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [title, code, sessionId])

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setExpanded(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const saveHtml = () => {
    const url = URL.createObjectURL(new Blob([visualDocument(title, code)], { type: 'text/html' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.html`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  const savePng = () => {
    const rect = frame.current?.getBoundingClientRect()
    if (!rect) return
    window.diffra
      .saveVisualPng({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, title)
      .catch((error: unknown) => showToast(`保存图片失败：${errorMessage(error)}`))
  }
  const openLink = (where: 'browser' | 'system') => {
    if (!link) return
    if (where === 'system') window.diffra.openExternal(link).catch((error: unknown) => showToast(errorMessage(error)))
    else {
      store.set((state) => ({ ...state, panel: 'browser' }))
      window.diffra.browserNavigate(sessionId, link).catch((error: unknown) => showToast(errorMessage(error)))
    }
    setLink(null)
  }

  return (
    <div
      className={cn('flex flex-col gap-1.5', expanded ? 'fixed inset-4 z-50 rounded-xl border bg-background p-3 shadow-overlay' : 'rounded-xl border px-3 py-2.5')}
      data-testid="visual"
      data-expanded={expanded}
    >
      <div className="flex items-center gap-2 text-sm">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-bold">{title}</span>
        <CardAction label={showCode ? '看效果' : '看代码'} onClick={() => setShowCode(!showCode)}>
          <Code className="size-3.5" />
        </CardAction>
        <CardAction label="另存为 HTML" onClick={saveHtml}>
          <Download className="size-3.5" />
        </CardAction>
        <CardAction label="另存为 PNG" onClick={savePng}>
          <ImageIcon className="size-3.5" />
        </CardAction>
        <CardAction label={expanded ? '收起' : '放大'} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </CardAction>
      </div>
      {link && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs" data-testid="visual-link">
          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={link}>
            打开 {link}？
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => openLink('browser')}>
            内置浏览器
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => openLink('system')}>
            系统浏览器
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="不打开" className="size-6" onClick={() => setLink(null)}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
      {showCode && (
        <pre className={cn('overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap', expanded ? 'min-h-0 flex-1' : 'max-h-96')}>{code}</pre>
      )}
      <iframe
        key={version}
        ref={frame}
        title={title}
        // 没有 allow-same-origin：页面是不透明来源，拿不到主界面的 DOM、存储和 window.diffra
        sandbox="allow-scripts allow-modals"
        src={new URL('./visual.html', window.location.href).toString()}
        className={cn('w-full border-0 bg-transparent', showCode && 'hidden', expanded && 'min-h-0 flex-1')}
        style={expanded ? undefined : { height }}
      />
    </div>
  )
}

function CardAction({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} className="size-7 text-muted-foreground" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
