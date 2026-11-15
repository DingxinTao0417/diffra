import { createContext, type CSSProperties, useContext, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Code, Columns2, Download, ExternalLink, History, Image as ImageIcon, Maximize2, Minimize2, Pin, PinOff, Presentation, Sparkles, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { snapshotImage } from '@/lib/images'
import type { VisualSnapshot } from '@/features/session/transcript'
import { fillComposer } from '@/state/actions'
import { AnswerContext, findProjectFile, openFilePreview } from './answer-links'
import { copyText } from './rich/BlockShell'
import { useReadOnly } from './read-only'
import { useStatic } from './static-context'
import { pinnedFrom } from './pins'
import { useThemeKey } from './rich/theme'
import visualKit from './visual-kit.js?raw'
import { VISUAL_SNAPSHOT_MAX_CHARS } from '@diffra/core/types'
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
  // 图表的四种颜色（diffra.chart 和模型自己画图都用），和对话里的图表块同一套
  ['--chart-1', '--chart-1'],
  ['--chart-2', '--chart-2'],
  ['--chart-3', '--chart-3'],
  ['--chart-4', '--chart-4'],
]
const MAX_HEIGHT = 4000
const MAX_FILL = 4000
// 高度这么久没再变算画好了，可以截快照
const SETTLE_MS = 1000

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

// 同一个任务里同名的可视化按出现顺序排成几版（第 668 步）：Conversation 提供，卡片据此切版本、对比上一版
export interface VisualVersion {
  id: string
  code: string
  snapshot?: VisualSnapshot
}
export const VisualHistoryContext = createContext<ReadonlyMap<string, VisualVersion[]>>(new Map())

interface FrameProps {
  title: string
  code: string
  sessionId: string
  // 放大、白板、演示时铺满容器，不按内容定高
  fill?: boolean
  // 演示模式现在显示到第几步（data-step），null 是全部显示
  step?: number | null
  onSteps?(count: number): void
  onLink(href: string): void
  // 高度一阵子没再变（画好了）时报一次，带上这个 iframe；主题变了重新挂载后会再报
  onSettled?(element: HTMLIFrameElement): void
  frameRef?(element: HTMLIFrameElement | null): void
  className?: string
  label?: string
}

// 一个沙箱 iframe：模型写的 HTML 在 visual.html 容器页里跑（能联网、能跑脚本，没有同源权限，碰不到应用的接口）。
// 高度跟着内容走；里面能用的动作只有白名单里的几样
export function VisualFrame({ title, code, sessionId, fill = false, step = null, onSteps, onLink, onSettled, frameRef, className, label }: FrameProps) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(120)
  // 远程会话里不填本机的输入框、不开链接（会话 id 是对方的）；内容本来就换成了占位
  const readOnly = useReadOnly()
  // 本机任务才有：diffra.openFile 在这个项目里找文件
  const answer = useContext(AnswerContext)
  // 真正生效的主题（深浅色、配色、字号）变了才重新渲染一次，令牌跟着换。以前看设置里的 appearance 对象：
  // 跟随系统时系统切深色它不变，可视化不换色；存别的设置（开关侧栏会存布局）时它换了个对象，可视化无故重载、里面的状态丢掉（第 666 步）
  const theme = useThemeKey()
  const steps = useRef(onSteps)
  steps.current = onSteps
  const settled = useRef(onSettled)
  settled.current = onSettled
  const settleTimer = useRef<number | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const data = event.data as { type?: unknown; height?: unknown; text?: unknown; href?: unknown; path?: unknown; line?: unknown; count?: unknown } | null
      if (data?.type === 'diffra-visual-ready') target.postMessage({ type: 'diffra-visual', html: visualDocument(title, code) }, '*')
      else if (data?.type === 'diffra-visual-height' && typeof data.height === 'number') {
        setHeight(Math.min(Math.max(Math.ceil(data.height), 40), MAX_HEIGHT))
        if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
        settleTimer.current = window.setTimeout(() => frame.current && settled.current?.(frame.current), SETTLE_MS)
      }
      else if (data?.type === 'diffra-visual-steps' && typeof data.count === 'number') steps.current?.(Math.max(0, Math.floor(data.count)))
      else if (readOnly) return
      else if (data?.type === 'diffra-visual-fill' && typeof data.text === 'string' && data.text.trim()) fillComposer(sessionId, data.text.slice(0, MAX_FILL))
      else if (data?.type === 'diffra-visual-link' && typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) onLink(data.href)
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
  }, [title, code, sessionId, readOnly, answer, onLink])
  // 只在卸载时清：上面的监听在流式输出时跟着 answer 一直重建，在那里清的话，内容不再变高就再也等不到「画好了」，不截快照
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    },
    [],
  )

  // 演示模式：告诉页面显示到第几步
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'diffra-visual-step', step }, '*')
  }, [step])

  return (
    <iframe
      key={theme}
      ref={(element) => {
        frame.current = element
        frameRef?.(element)
      }}
      title={label ?? title}
      // 没有 allow-same-origin：页面是不透明来源，拿不到主界面的 DOM、存储和 window.diffra
      sandbox="allow-scripts allow-modals"
      src={new URL('./visual.html', window.location.href).toString()}
      className={cn('w-full border-0 bg-transparent', fill && 'min-h-0 flex-1', className)}
      style={fill ? undefined : ({ height } satisfies CSSProperties)}
    />
  )
}

// 对话里的可视化卡片：可以放大、演示、另存为 HTML 或 PNG、看代码、固定到白板；同名的有几版时能切换、和上一版对比、从某一版接着改。
// 里面的按钮能把文字填进输入框，链接要先确认
export function VisualCard({ id, title, code, sessionId, snapshot }: { id: string; title: string; code: string; sessionId: string; snapshot?: VisualSnapshot }) {
  const frame = useRef<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [compare, setCompare] = useState(false)
  const [presenting, setPresenting] = useState(false)
  const readOnly = useReadOnly()
  const versions = useContext(VisualHistoryContext).get(title) ?? [{ id, code, snapshot }]
  const own = Math.max(0, versions.findIndex((version) => version.id === id))
  const [index, setIndex] = useState(own)
  const current = versions[Math.min(index, versions.length - 1)] ?? { id, code, snapshot }
  const previous = index > 0 ? versions[index - 1] : null
  const pinned = useAppState((state) => state.pinned.some((item) => item.sessionId === sessionId && item.id === id))
  // 远程会话里可视化的代码换成了占位，有快照就显示快照；静态渲染（导出、分享）不跑脚本，也用快照
  const isStatic = useStatic()
  const image = readOnly || isStatic ? current.snapshot : undefined
  const onSettled = useSnapshot(sessionId, id, !readOnly && !snapshot && index === own && !expanded && !compare && !showCode && !presenting)

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setExpanded(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const saveHtml = () => {
    const url = URL.createObjectURL(new Blob([visualDocument(title, current.code)], { type: 'text/html' }))
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
  const togglePin = () =>
    store.set((state) => ({
      ...state,
      pinned: pinned ? state.pinned.filter((item) => !(item.sessionId === sessionId && item.id === id)) : [...state.pinned, { kind: 'visual' as const, sessionId, id, title, code: current.code, ...pinnedFrom(sessionId, frame.current) }],
      panel: pinned ? state.panel : 'visuals',
    }))

  return (
    <div
      className={cn('flex flex-col gap-1.5', expanded ? 'fixed inset-4 z-50 rounded-xl border bg-background p-3 shadow-overlay' : 'rounded-xl border px-3 py-2.5')}
      data-testid="visual"
      data-expanded={expanded}
      data-version={index + 1}
    >
      <div className="flex items-center gap-2 text-sm">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-bold">{title}</span>
        {versions.length > 1 && (
          <span className="flex shrink-0 items-center text-xs text-muted-foreground" data-testid="visual-versions">
            <CardAction label="上一版" disabled={index === 0} onClick={() => setIndex(index - 1)}>
              <ChevronLeft className="size-3.5" />
            </CardAction>
            <span className="tabular-nums">
              第 {index + 1}/{versions.length} 版
            </span>
            <CardAction label="下一版" disabled={index === versions.length - 1} onClick={() => setIndex(index + 1)}>
              <ChevronRight className="size-3.5" />
            </CardAction>
            {previous && (
              <CardAction label={compare ? '不对比' : '和上一版对比'} pressed={compare} onClick={() => setCompare(!compare)}>
                <Columns2 className="size-3.5" />
              </CardAction>
            )}
            {!readOnly && index !== versions.length - 1 && (
              <CardAction label="从这一版接着改" onClick={() => fillComposer(sessionId, `回到可视化「${title}」的第 ${index + 1} 版，在它的基础上接着改：`)}>
                <History className="size-3.5" />
              </CardAction>
            )}
          </span>
        )}
        <CardAction label={showCode ? '看效果' : '看代码'} onClick={() => setShowCode(!showCode)}>
          <Code className="size-3.5" />
        </CardAction>
        {!image && (
          <CardAction label="演示" onClick={() => setPresenting(true)}>
            <Presentation className="size-3.5" />
          </CardAction>
        )}
        {!readOnly && (
          <CardAction label={pinned ? '从白板取下' : '固定到白板'} pressed={pinned} onClick={togglePin}>
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </CardAction>
        )}
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
      {link && <LinkConfirm link={link} sessionId={sessionId} onDone={() => setLink(null)} />}
      {showCode && (
        <pre className={cn('overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap', expanded ? 'min-h-0 flex-1' : 'max-h-96')}>{current.code}</pre>
      )}
      <div className={cn(showCode && 'hidden', compare && previous ? 'grid grid-cols-2 gap-3' : 'flex flex-col', expanded && 'min-h-0 flex-1')} data-testid="visual-frames">
        {compare && previous && (
          <div className={cn('flex min-w-0 flex-col gap-1', expanded && 'min-h-0')}>
            <span className="text-xs text-muted-foreground">第 {index} 版</span>
            {readOnly && previous.snapshot ? (
              <SnapshotImage title={`${title}（第 ${index} 版）`} snapshot={previous.snapshot} fill={expanded} />
            ) : (
              <VisualFrame key={previous.id} title={title} code={previous.code} sessionId={sessionId} fill={expanded} onLink={setLink} label={`${title}（第 ${index} 版）`} />
            )}
          </div>
        )}
        <div className={cn('flex min-w-0 flex-col gap-1', expanded && 'min-h-0 flex-1')}>
          {compare && previous && <span className="text-xs text-muted-foreground">第 {index + 1} 版</span>}
          {isStatic && !image ? (
            <p className="text-sm text-muted-foreground" data-testid="visual-no-snapshot">
              （这张可视化还没有快照，在 Diffra 里打开才能看）
            </p>
          ) : image ? (
            <SnapshotImage
              title={title}
              snapshot={image}
              fill={expanded}
              imageRef={(element) => {
                frame.current = element
              }}
            />
          ) : (
            <VisualFrame
              key={current.id}
              title={title}
              code={current.code}
              sessionId={sessionId}
              fill={expanded}
              onLink={setLink}
              onSettled={onSettled}
              frameRef={(element) => {
                frame.current = element
              }}
            />
          )}
        </div>
      </div>
      {presenting && <VisualPresentation title={title} code={current.code} sessionId={sessionId} onClose={() => setPresenting(false)} />}
    </div>
  )
}

function SnapshotImage({ title, snapshot, fill, imageRef }: { title: string; snapshot: VisualSnapshot; fill: boolean; imageRef?(element: HTMLImageElement | null): void }) {
  return (
    <img
      ref={imageRef}
      src={`data:${snapshot.mimeType};base64,${snapshot.data}`}
      alt={title}
      className={cn('w-full', fill && 'min-h-0 flex-1 object-contain object-top')}
      data-testid="visual-snapshot"
    />
  )
}

// 可视化的快照（第 670 步）：本机画好后（高度一秒没再变）、整张露在窗口里没被挡住、鼠标不在上面时截一次，压成 WebP 记回会话；
// 远程设备不跑可视化的脚本，显示这张图。比窗口还高的截不全，不截；截的时候滚动了就作废，下次再截
function useSnapshot(sessionId: string, id: string, enabled: boolean): (element: HTMLIFrameElement) => void {
  const [element, setElement] = useState<HTMLIFrameElement | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (!enabled || !element || started.current) return
    const boxOf = () => {
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    }
    const attempt = () => {
      if (started.current || document.visibilityState !== 'visible' || element.matches(':hover')) return
      const box = boxOf()
      const points = [
        [box.x + 2, box.y + 2],
        [box.x + box.width - 3, box.y + 2],
        [box.x + 2, box.y + box.height - 3],
        [box.x + box.width - 3, box.y + box.height - 3],
        [box.x + box.width / 2, box.y + box.height / 2],
      ] as const
      if (box.width < 8 || box.height < 8 || !points.every(([x, y]) => document.elementFromPoint(x, y) === element)) return
      started.current = true
      window.diffra
        .captureVisual(box)
        .then(async (png) => {
          const moved = JSON.stringify(boxOf()) !== JSON.stringify(box)
          if (!png || moved) {
            started.current = false
            return
          }
          const image = await snapshotImage(png, VISUAL_SNAPSHOT_MAX_CHARS)
          if (image) await window.diffra.recordVisualSnapshot(sessionId, id, image)
        })
        .catch((error: unknown) => console.error('[visual] 快照没记下', error))
    }
    let timer: number | null = null
    const observer = new IntersectionObserver(([entry]) => {
      if (timer !== null) window.clearInterval(timer)
      timer = entry?.isIntersecting ? window.setInterval(attempt, 1000) : null
      if (entry?.isIntersecting) attempt()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (timer !== null) window.clearInterval(timer)
    }
  }, [enabled, element, sessionId, id])
  return setElement
}

// 可视化里的链接不直接打开，先问用内置浏览器、系统浏览器，还是不打开
export function LinkConfirm({ link, sessionId, onDone }: { link: string; sessionId: string; onDone(): void }) {
  const open = (where: 'browser' | 'system') => {
    if (where === 'system') window.diffra.openExternal(link).catch((error: unknown) => showToast(errorMessage(error)))
    else {
      store.set((state) => ({ ...state, panel: 'browser' }))
      window.diffra.browserNavigate(sessionId, link).catch((error: unknown) => showToast(errorMessage(error)))
    }
    onDone()
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs" data-testid="visual-link">
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={link}>
        打开 {link}？
      </span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => open('browser')}>
        内置浏览器
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => open('system')}>
        系统浏览器
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="不打开" className="size-6" onClick={onDone}>
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

// 演示时页面里的链接不打开（没有地方问用户）
const ignoreLink = () => undefined

// 演示模式（第 669 步）：铺满窗口、不要工具栏；页面里带 data-step 的元素按 →、空格、PageDown 一步步出现，←、PageUp 退回，Esc 结束
export function VisualPresentation({ title, code, sessionId, onClose }: { title: string; code: string; sessionId: string; onClose(): void }) {
  const [count, setCount] = useState(0)
  const [step, setStep] = useState<number | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (count > 0 && ['ArrowRight', ' ', 'PageDown', 'Enter'].includes(event.key)) setStep((current) => Math.min(count, (current ?? 0) + 1))
      else if (count > 0 && ['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) setStep((current) => Math.max(1, (current ?? 1) - 1))
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [count, onClose])
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background p-6" role="dialog" aria-modal="true" aria-label={`演示：${title}`} data-testid="visual-presentation">
      <VisualFrame
        title={title}
        code={code}
        sessionId={sessionId}
        fill
        step={step}
        onLink={ignoreLink}
        onSteps={(total) => {
          setCount(total)
          setStep(total > 0 ? 1 : null)
        }}
      />
      <div className="pointer-events-none absolute right-4 bottom-4 flex items-center gap-2 text-xs text-muted-foreground opacity-60 hover:opacity-100">
        {count > 0 && (
          <span className="tabular-nums" data-testid="visual-presentation-step">
            {step ?? count}/{count}
          </span>
        )}
        <span className="pointer-events-auto">
          <CardAction label="结束演示" onClick={onClose}>
            <X className="size-3.5" />
          </CardAction>
        </span>
      </div>
    </div>
  )
}

function CardAction({ label, onClick, disabled, pressed, children }: { label: string; onClick(): void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} disabled={disabled} className={cn('size-7 text-muted-foreground', pressed && 'bg-accent text-foreground')} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
