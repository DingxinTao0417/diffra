import { type PointerEvent, useEffect, useRef, useState } from 'react'
import type { AnnotateMark, AnnotateShape } from '@diffra/core/rich'
import type { PromptImage } from '@diffra/core/types'
import { Trash2, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { prepareImage } from '@/lib/images'
import { showToast } from '@/state/store'
import { drawMarks, MarkLayer, SHAPE_NAMES, useDisplayWidth } from './annotations'

const TOOLS: Array<{ value: AnnotateShape; label: string }> = (['box', 'circle', 'arrow', 'pin'] as const).map((value) => ({ value, label: SHAPE_NAMES[value] }))
// 拖得太短（屏幕上不到这么多像素）当成手滑，不留
const MIN_DRAG = 6

// 在图上标注（第 685 步）：框、圈、箭头、编号，每处可以写一句说明；完成后把画好标注的图和说明交给调用方（填进输入框或替换附件）
export function ImageAnnotator({ src, title, initial = [], doneLabel, onClose, onDone }: { src: string; title: string; initial?: AnnotateMark[]; doneLabel: string; onClose(): void; onDone(result: { image: PromptImage; marks: AnnotateMark[] }): void }) {
  const [marks, setMarks] = useState<AnnotateMark[]>(initial)
  const [tool, setTool] = useState<AnnotateShape>('box')
  const [draft, setDraft] = useState<AnnotateMark | null>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [frame, displayWidth] = useDisplayWidth<HTMLDivElement>()
  const start = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    let stale = false
    const image = new Image()
    image.src = src
    image.decode().then(
      () => !stale && setNatural({ width: image.naturalWidth, height: image.naturalHeight }),
      () => !stale && setError('读不了这张图片'),
    )
    return () => {
      stale = true
    }
  }, [src])

  const pointOf = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)), rect }
  }
  const shapeFrom = (from: { x: number; y: number }, to: { x: number; y: number }): AnnotateMark =>
    tool === 'arrow' ? { shape: 'arrow', x: from.x, y: from.y, x2: to.x, y2: to.y } : { shape: tool === 'circle' ? 'circle' : 'box', x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) }

  const undo = () => setMarks((current) => current.slice(0, -1))
  const scale = natural && displayWidth > 0 ? displayWidth / natural.width : 0

  const finish = async () => {
    if (!natural || scale === 0) return
    setSaving(true)
    try {
      const image = new Image()
      image.src = src
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = natural.width
      canvas.height = natural.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('画布不可用')
      context.drawImage(image, 0, 0)
      drawMarks(context, marks, natural.width, natural.height, 1 / scale)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('导出图片失败'))), 'image/png'))
      onDone({ image: await prepareImage(blob), marks })
    } catch (failure) {
      showToast(`没能保存标注：${errorMessage(failure)}`)
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] max-w-[92vw] flex-col gap-3 sm:max-w-[92vw]"
        data-testid="image-annotator"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLInputElement)) {
            event.preventDefault()
            undo()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{title}</DialogTitle>
          <DialogDescription>在图上拖出框、圈或箭头，点一下放编号；每处可以写一句说明。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<AnnotateShape> label="标注工具" size="sm" value={tool} options={TOOLS} onChange={setTool} />
          <Button variant="ghost" size="sm" disabled={marks.length === 0} onClick={undo}>
            <Undo2 />
            撤销
          </Button>
          <Button variant="ghost" size="sm" disabled={marks.length === 0} onClick={() => setMarks([])}>
            <Trash2 />
            清空
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto md:flex-row">
          <div className="flex min-w-0 flex-1 items-start justify-center rounded-lg bg-muted/40 p-2">
            {error ? (
              <p className="self-center py-12 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : (
              <div ref={frame} className="relative inline-block max-w-full touch-none select-none">
                <img src={src} alt={title} draggable={false} className="block max-h-[62vh] max-w-full" data-testid="annotator-image" />
                {natural && scale > 0 && <MarkLayer marks={draft ? [...marks, draft] : marks} width={natural.width} height={natural.height} scale={scale} />}
                <div
                  className="absolute inset-0 cursor-crosshair"
                  role="application"
                  aria-label={`在图上画${SHAPE_NAMES[tool]}`}
                  data-testid="annotator-surface"
                  onPointerDown={(event) => {
                    if (!natural || event.button !== 0) return
                    const point = pointOf(event)
                    if (tool === 'pin') {
                      setMarks((current) => [...current, { shape: 'pin', x: point.x, y: point.y }])
                      return
                    }
                    event.currentTarget.setPointerCapture(event.pointerId)
                    start.current = point
                  }}
                  onPointerMove={(event) => {
                    if (start.current) setDraft(shapeFrom(start.current, pointOf(event)))
                  }}
                  onPointerUp={(event) => {
                    const from = start.current
                    start.current = null
                    setDraft(null)
                    if (!from) return
                    const to = pointOf(event)
                    const dx = Math.abs(to.x - from.x) * to.rect.width
                    const dy = Math.abs(to.y - from.y) * to.rect.height
                    const big = tool === 'arrow' ? Math.hypot(dx, dy) >= MIN_DRAG * 2 : dx >= MIN_DRAG && dy >= MIN_DRAG
                    if (big) setMarks((current) => [...current, shapeFrom(from, to)])
                  }}
                  onPointerCancel={() => {
                    start.current = null
                    setDraft(null)
                  }}
                />
              </div>
            )}
          </div>
          <ol className="flex shrink-0 flex-col gap-1.5 md:w-72" aria-label="标注说明" data-testid="annotator-notes">
            {marks.length === 0 && <li className="py-2 text-sm text-muted-foreground">还没有标注</li>}
            {marks.map((mark, index) => (
              <li key={index} className="flex items-center gap-1.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-[11px] font-bold text-destructive-foreground tabular-nums" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="w-8 shrink-0 text-xs text-muted-foreground">{SHAPE_NAMES[mark.shape]}</span>
                <Input
                  className="h-7 min-w-0 flex-1 text-sm"
                  aria-label={`标注 ${index + 1} 的说明`}
                  placeholder="说明（可不写）"
                  maxLength={500}
                  value={mark.note ?? ''}
                  onChange={(event) => {
                    const note = event.target.value
                    setMarks((current) => current.map((item, at) => (at === index ? { ...item, note: note || undefined } : item)))
                  }}
                />
                <Button variant="ghost" size="icon-xs" aria-label={`删除标注 ${index + 1}`} onClick={() => setMarks((current) => current.filter((_, at) => at !== index))}>
                  <X />
                </Button>
              </li>
            ))}
          </ol>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={marks.length === 0 || !natural || saving} onClick={() => void finish()}>
            {saving ? '正在保存…' : doneLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
