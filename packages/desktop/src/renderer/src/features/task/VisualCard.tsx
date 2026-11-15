import { useContext, useEffect, useRef, useState } from 'react'
import { Code, Download, ExternalLink, Image as ImageIcon, Maximize2, Minimize2, Sparkles, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { fillComposer } from '@/state/actions'
import { AnswerContext, findProjectFile, openFilePreview } from './answer-links'
import { copyText } from './rich/BlockShell'
import { useReadOnly } from './read-only'
import { useThemeKey } from './rich/theme'
import visualKit from './visual-kit.js?raw'
import { showToast, store } from '@/state/store'

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
  // 图表的四种颜色（diffra.chart 和模型自己画图都用），和对话里的图表块同一套
  ['--chart-1', '--chart-1'],
  ['--chart-2', '--chart-2'],
  ['--chart-3', '--chart-3'],
  ['--chart-4', '--chart-4'],
]
const MAX_HEIGHT = 4000
const MAX_FILL = 4000

function themeCss(): string {
  const style = getComputedStyle(document.documentElement)
  const vars = TOKENS.map(([name, source]) => `${name}:${style.getPropertyValue(source).trim()};`).join('')
  const dark = document.documentElement.classList.contains('dark')
  // 滚动条槽位一直留着：不然出不出滚动条会让内容宽度来回变，按宽度缩放的图（SVG）高度跟着变，高度报告和滚动条互相触发
  return `:root{${vars}color-scheme:${dark ? 'dark' : 'light'}}html{scrollbar-gutter:stable}html,body{margin:0;background:transparent}body{padding:4px 2px;color:var(--fg);font:14px/1.6 var(--font-sans)}*{box-sizing:border-box}`
}

// 在容器页里跑的那段：报内容高度、diffra.fill 把文字交给输入框、点链接先交给主界面确认。放在最前面，用户代码一开始就能用。
// 高度按 body 自己的高度报（第 667 步）：以前报 html 的 scrollHeight，它不会小于 iframe 当前的高度，内容变矮后卡片留着一大块空白；
// 也只盯 html 的大小（就是视口），内容后来变高（字体加载、脚本加的元素）不再报，里面出滚动条。内容超出 body（绝对定位的）时仍按 scrollHeight
const RUNTIME = `<script>(function(){
var send=function(message){parent.postMessage(message,'*')};
var report=function(){var body=document.body,style=getComputedStyle(body),own=body.getBoundingClientRect().height+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0),root=document.documentElement;send({type:'diffra-visual-height',height:Math.ceil(root.scrollHeight>root.clientHeight+1?Math.max(own,root.scrollHeight):own)})};
new ResizeObserver(report).observe(document.body);new ResizeObserver(report).observe(document.documentElement);window.addEventListener('load',report);
window.diffra={fill:function(text){send({type:'diffra-visual-fill',text:String(text)})}};
window.sendPrompt=window.diffra.fill;
document.addEventListener('click',function(event){var link=event.target&&event.target.closest&&event.target.closest('a[href]');if(!link)return;event.preventDefault();if(/^https?:/i.test(link.href))send({type:'diffra-visual-link',href:link.href})},true);
window.open=function(url){if(url&&/^https?:/i.test(String(url)))send({type:'diffra-visual-link',href:String(url)});return null};
})()</script>`

export function visualDocument(title: string, code: string, css = themeCss()): string {
  const escaped = title.replace(/[<&]/g, (char) => (char === '<' ? '&lt;' : '&amp;'))
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>${css}</style></head><body>${RUNTIME}<script>${visualKit}</script>${code}</body></html>`
}

const MAX_COPY = 100_000

// 对话里的可视化：模型写的 HTML 在沙箱 iframe 里的容器页跑（能联网、能跑脚本，没有同源权限，碰不到应用的接口）。
// 高度跟着内容走；可以放大、另存为 HTML 或 PNG、看代码；里面的按钮能把文字填进输入框，链接要先确认
export function VisualCard({ title, code, sessionId }: { title: string; code: string; sessionId: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const [expanded, setExpanded] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  // 远程会话里不填本机的输入框、不开链接（会话 id 是对方的）；内容本来就换成了占位
  const readOnly = useReadOnly()
  // 本机任务才有：diffra.openFile 在这个项目里找文件
  const answer = useContext(AnswerContext)
  // 真正生效的主题（深浅色、配色、字号）变了才重新渲染一次，令牌跟着换。以前看设置里的 appearance 对象：
  // 跟随系统时系统切深色它不变，可视化不换色；存别的设置（开关侧栏会存布局）时它换了个对象，可视化无故重载、里面的状态丢掉（第 666 步）
  const theme = useThemeKey()
  const [version, setVersion] = useState(0)
  useEffect(() => setVersion((current) => current + 1), [theme])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const data = event.data as { type?: unknown; height?: unknown; text?: unknown; href?: unknown; path?: unknown; line?: unknown } | null
      if (data?.type === 'diffra-visual-ready') target.postMessage({ type: 'diffra-visual', html: visualDocument(title, code) }, '*')
      else if (data?.type === 'diffra-visual-height' && typeof data.height === 'number') setHeight(Math.min(Math.max(Math.ceil(data.height), 40), MAX_HEIGHT))
      else if (readOnly) return
      else if (data?.type === 'diffra-visual-fill' && typeof data.text === 'string' && data.text.trim()) fillComposer(sessionId, data.text.slice(0, MAX_FILL))
      else if (data?.type === 'diffra-visual-link' && typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) setLink(data.href)
      else if (data?.type === 'diffra-visual-copy' && typeof data.text === 'string') copyText(data.text.slice(0, MAX_COPY), '已复制')
      else if (data?.type === 'diffra-visual-open-file' && typeof data.path === 'string' && answer) {
        // 只开项目里的文件：主进程查过在项目目录里才算
        const line = typeof data.line === 'number' && data.line > 0 ? Math.floor(data.line) : null
        findProjectFile(answer, data.path).then(
          (file) => (file ? openFilePreview(answer.project, file.relative, line) : showToast(`项目里没有这个文件：${String(data.path).slice(0, 200)}`)),
          (error: unknown) => showToast(errorMessage(error)),
        )
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [title, code, sessionId, readOnly, answer])

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
