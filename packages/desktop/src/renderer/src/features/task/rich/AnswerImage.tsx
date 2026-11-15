import { type ComponentProps, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { ChevronLeft, ChevronRight, Globe, ImageOff, Minus, PenLine, Plus, RotateCcw } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { errorMessage } from '@/lib/errors'
import { stripFileScheme } from '@/lib/file-url'
import { fillComposer } from '@/state/actions'
import { AnswerContext, AnswerLink } from '../answer-links'
import { StaticProjectContext, useStatic } from '../static-context'
import { marksText } from './annotations'
import { ImageAnnotator } from './ImageAnnotator'

const isWeb = (src: string) => /^https?:\/\//i.test(src)
const isData = (src: string) => /^data:image\//i.test(src)

// 项目里的图片读成 data: 地址（主窗口的 CSP 只放行 data:）；同一张只读一次
const projectImages = new Map<string, Promise<string>>()

export function useImageSource(src: string | undefined): { url: string | null; error: string | null } {
  const answer = useContext(AnswerContext)
  const staticProject = useContext(StaticProjectContext)
  const isStatic = useStatic()
  const project = answer?.project ?? staticProject
  const [state, setState] = useState<{ src: string; url: string | null; error: string | null } | null>(null)
  const local = src && !isWeb(src) && !isData(src) ? stripFileScheme(src) : null
  useEffect(() => {
    if (!local || !project) return
    const key = `${project}\n${local}`
    let pending = projectImages.get(key)
    if (!pending) {
      pending = window.diffra.readImage(project, decodeURIComponent(local)).then(({ mimeType, data }) => `data:${mimeType};base64,${data}`)
      projectImages.set(key, pending)
      pending.catch(() => projectImages.delete(key))
    }
    let stale = false
    pending.then(
      (url) => !stale && setState({ src: local, url, error: null }),
      (error: unknown) => !stale && setState({ src: local, url: null, error: errorMessage(error) }),
    )
    return () => {
      stale = true
    }
  }, [local, project])
  if (!src) return { url: null, error: '没有图片地址' }
  if (isData(src)) return { url: src, error: null }
  if (!local) return { url: null, error: null }
  if (!project) return { url: null, error: isStatic ? '分享版和远程任务的导出不带项目里的图片' : '远程任务的图片在对方电脑上' }
  return state?.src === local ? { url: state.url, error: state.error } : { url: null, error: null }
}

// 回答里的图片：data: 和项目里的图片直接显示，点开看大图（能缩放、左右切换同一段回答里的其他图）。
// 网络图片不加载（主窗口的 CSP 不放行外部图片，模型也可能被网页诱导，用图片地址把数据带出去），显示成可点的链接
export function AnswerImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const { url, error } = useImageSource(src)
  const [open, setOpen] = useState(false)
  // 在图上标注（第 685 步）：本机任务才有，标完连图带说明填进输入框
  const target = useContext(AnswerContext)
  const isStatic = useStatic()
  const [annotating, setAnnotating] = useState<{ url: string; alt: string } | null>(null)
  if (src && isWeb(src)) {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-0.5 align-middle text-sm" data-testid="web-image">
        <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <AnswerLink href={src}>{alt || '网络图片'}</AnswerLink>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{hostOf(src)}</span>
      </span>
    )
  }
  if (!url) {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 align-middle text-xs text-muted-foreground" data-testid="image-missing" title={error ?? undefined}>
        <ImageOff className="size-3.5 shrink-0" aria-hidden="true" />
        {error ? `${alt || src}（${error}）` : alt || src}
      </span>
    )
  }
  return (
    <>
      <button type="button" className="inline-block max-w-full overflow-hidden rounded-lg border align-top hover:opacity-90" aria-label={`查看大图：${alt || '图片'}`} onClick={() => setOpen(true)}>
        <img src={url} alt={alt ?? ''} className="max-h-80 max-w-full object-contain" data-testid="answer-image" data-answer-image="" loading="lazy" />
      </button>
      {open && (
        <Lightbox
          start={url}
          onClose={() => setOpen(false)}
          onAnnotate={
            target && !isStatic
              ? (image) => {
                  setOpen(false)
                  setAnnotating(image)
                }
              : undefined
          }
        />
      )}
      {annotating && target && (
        <ImageAnnotator
          src={annotating.url}
          title={annotating.alt || '标注图片'}
          doneLabel="填进输入框"
          onClose={() => setAnnotating(null)}
          onDone={({ image, marks }) => {
            setAnnotating(null)
            fillComposer(target.sessionId, marksText(marks, '我在这张图上'), { images: [image], files: [] })
          }}
        />
      )}
    </>
  )
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const MIN_ZOOM = 1
const MAX_ZOOM = 6

// 大图：同一段回答里的图片都能左右切换；滚轮、+/- 缩放，放大后拖动平移；Esc 关
function Lightbox({ start, onClose, onAnnotate }: { start: string; onClose(): void; onAnnotate?(image: { url: string; alt: string }): void }) {
  const [images, setImages] = useState<Array<{ url: string; alt: string }>>([{ url: start, alt: '' }])
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const anchor = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null)

  // 同一段回答（.markdown）里显示出来的图，按出现顺序
  useEffect(() => {
    const root = anchor.current?.closest('.markdown') ?? null
    const found = root ? [...root.querySelectorAll<HTMLImageElement>('img[data-answer-image]')].map((image) => ({ url: image.src, alt: image.alt })) : []
    if (found.length === 0) return
    setImages(found)
    setIndex(Math.max(0, found.findIndex((image) => image.url === start)))
  }, [start])

  const reset = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])
  const go = useCallback(
    (step: number) => {
      setIndex((current) => (current + step + images.length) % images.length)
      reset()
    },
    [images.length, reset],
  )
  const scale = (factor: number) => setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor)))
  const image = images[index] ?? images[0]!

  return (
    <>
      <span ref={anchor} hidden />
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="flex max-h-[92vh] max-w-[92vw] flex-col gap-2 sm:max-w-[92vw]"
          data-testid="lightbox"
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') go(1)
            else if (event.key === 'ArrowLeft') go(-1)
            else if (event.key === '+' || event.key === '=') scale(1.25)
            else if (event.key === '-') scale(0.8)
            else return
            event.preventDefault()
          }}
        >
          <DialogTitle className="truncate pr-8 text-base">
            {image.alt || '图片'}
            {images.length > 1 && <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{index + 1} / {images.length}</span>}
          </DialogTitle>
          <div
            className={cn('relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted/40', zoom > 1 && 'cursor-grab active:cursor-grabbing')}
            onWheel={(event) => scale(event.deltaY < 0 ? 1.15 : 1 / 1.15)}
            onPointerDown={(event) => {
              if (zoom <= 1) return
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { x: event.clientX, y: event.clientY, from: offset }
            }}
            onPointerMove={(event) => {
              const start = drag.current
              if (start) setOffset({ x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y })
            }}
            onPointerUp={() => (drag.current = null)}
          >
            <img src={image.url} alt={image.alt} draggable={false} className="max-h-[78vh] max-w-full object-contain select-none" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }} data-testid="lightbox-image" />
          </div>
          <div className="flex items-center justify-center gap-1">
            {images.length > 1 && (
              <Button variant="ghost" size="icon-sm" aria-label="上一张" onClick={() => go(-1)}>
                <ChevronLeft />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="缩小" disabled={zoom <= MIN_ZOOM} onClick={() => scale(0.8)}>
              <Minus />
            </Button>
            <span className="w-12 text-center text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <Button variant="ghost" size="icon-sm" aria-label="放大" disabled={zoom >= MAX_ZOOM} onClick={() => scale(1.25)}>
              <Plus />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="还原大小" disabled={zoom === 1} onClick={reset}>
              <RotateCcw />
            </Button>
            {onAnnotate && (
              <Button variant="ghost" size="sm" onClick={() => onAnnotate(image)}>
                <PenLine />
                标注
              </Button>
            )}
            {images.length > 1 && (
              <Button variant="ghost" size="icon-sm" aria-label="下一张" onClick={() => go(1)}>
                <ChevronRight />
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// 前后对比：一段里只有两张图、说明分别以「前」「后」（before / after）开头时，叠在一起用滑块对比
export function isBeforeAfter(alts: string[]): boolean {
  return alts.length === 2 && /^(前|改前|之前|修改前|before)/i.test(alts[0]!.trim()) && /^(后|改后|之后|修改后|after)/i.test(alts[1]!.trim())
}

export function CompareImages({ before, after }: { before: { src: string; alt: string }; after: { src: string; alt: string } }) {
  const first = useImageSource(before.src)
  const second = useImageSource(after.src)
  const [split, setSplit] = useState(50)
  if (!first.url || !second.url) {
    return (
      <span className="flex flex-wrap gap-2">
        <AnswerImage src={before.src} alt={before.alt} />
        <AnswerImage src={after.src} alt={after.alt} />
      </span>
    )
  }
  return (
    // 框按「后」那张图的大小（至少 12rem 宽，小图放大看得清），「前」那张铺满同一个框，按滑块位置裁掉右边
    <span className="block w-fit max-w-full" data-testid="image-compare">
      <span className="relative block overflow-hidden rounded-lg border select-none">
        <img src={second.url} alt={after.alt} className="block max-h-96 max-w-full min-w-48 object-contain" draggable={false} />
        <span className="absolute inset-0 block" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <img src={first.url} alt={before.alt} className="block size-full bg-background object-contain" draggable={false} />
        </span>
        <span className="pointer-events-none absolute inset-y-0 block w-px bg-foreground/70" style={{ left: `${split}%` }} />
        <span className="absolute top-1.5 left-1.5 rounded-sm bg-popover/90 px-1.5 text-xs">{before.alt}</span>
        <span className="absolute top-1.5 right-1.5 rounded-sm bg-popover/90 px-1.5 text-xs">{after.alt}</span>
      </span>
      <Slider className="mt-1.5" min={0} max={100} value={[split]} aria-label={`对比位置：左边「${before.alt}」，右边「${after.alt}」`} onValueChange={([value]) => setSplit(value ?? 50)} />
    </span>
  )
}
