import { useContext, useState } from 'react'
import type { AnnotateData, AnnotateMark } from '@diffra/core/rich'
import { ImageOff, PenLine, ScanSearch } from 'lucide-react'
import { cn } from 'cn'
import { imageUrl } from '@/lib/images'
import { fillComposer } from '@/state/actions'
import { AnswerContext } from '../answer-links'
import { useStatic } from '../static-context'
import { useImageSource } from './AnswerImage'
import { MarkLayer, marksText, PromptImagesContext, SHAPE_NAMES, useDisplayWidth } from './annotations'
import { BlockShell, ShellAction } from './BlockShell'
import { ImageAnnotator } from './ImageAnnotator'

// 模型给的图上标注（第 685 步）：图片上叠框、圈、箭头、编号，下面按编号列出说明，点编号或说明互相对上。
// 本机任务能「在图上接着标」：带着模型的标注打开标注编辑，画完连图带说明填进输入框
export function AnnotateBlock({ data }: { data: AnnotateData }) {
  const { url, error } = useAnnotateImage(data.image)
  const target = useContext(AnswerContext)
  const isStatic = useStatic()
  const [active, setActive] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const title = data.title ?? '图上标注'
  const editable = target !== null && !isStatic && url !== null
  return (
    <BlockShell
      testId="rich-annotate"
      kind="annotate"
      tone="card"
      icon={<ScanSearch className="size-3.5 shrink-0" />}
      title={title}
      meta={<span className="shrink-0 tabular-nums">{data.marks.length} 处</span>}
      actions={
        editable && (
          <ShellAction label="在图上接着标" onClick={() => setEditing(true)}>
            <PenLine />
          </ShellAction>
        )
      }
      expand={url ? () => <AnnotatedImage url={url} alt={title} marks={data.marks} active={active} onSelect={setActive} large /> : undefined}
    >
      <div className="flex flex-col gap-3 p-3">
        {url ? (
          <AnnotatedImage url={url} alt={title} marks={data.marks} active={active} onSelect={setActive} />
        ) : error ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="annotate-missing">
            <ImageOff className="size-4 shrink-0" aria-hidden="true" />
            图片没显示出来：{error}
          </p>
        ) : (
          <div className="h-40 animate-pulse rounded-md bg-muted" aria-busy="true" aria-label="正在读取图片" />
        )}
        <ol className="flex flex-col gap-1" data-testid="annotate-notes">
          {data.marks.map((mark, index) => (
            <li key={index}>
              <button
                type="button"
                className={cn('flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted', active === index && 'bg-muted')}
                aria-pressed={active === index}
                onClick={() => setActive(active === index ? null : index)}
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-[11px] font-bold text-destructive-foreground tabular-nums">{index + 1}</span>
                <span className="min-w-0 break-words">{mark.note ?? <span className="text-muted-foreground">{SHAPE_NAMES[mark.shape]}</span>}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {editing && url && target && (
        <ImageAnnotator
          src={url}
          title={title}
          initial={data.marks}
          doneLabel="填进输入框"
          onClose={() => setEditing(false)}
          onDone={({ image, marks }) => {
            setEditing(false)
            fillComposer(target.sessionId, marksText(marks, '我在这张图上'), { images: [image], files: [] })
          }}
        />
      )}
    </BlockShell>
  )
}

// image 写 "@图片1" 指这一轮提问里的第一张图；其余和回答里的图片一样（项目里的图片、data: 地址）
function useAnnotateImage(image: string): { url: string | null; error: string | null } {
  const prompt = useContext(PromptImagesContext)
  const mention = /^@图片(\d+)$/.exec(image)
  const project = useImageSource(mention ? undefined : image)
  if (!mention) return project
  const found = prompt.images[Number(mention[1]) - 1]
  if (found) return { url: imageUrl(found), error: null }
  return { url: null, error: prompt.omitted ? '提问里的图片没有带过来' : `这一轮提问里没有${image}` }
}

function AnnotatedImage({ url, alt, marks, active, onSelect, large = false }: { url: string; alt: string; marks: AnnotateMark[]; active: number | null; onSelect(index: number | null): void; large?: boolean }) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [frame, width] = useDisplayWidth<HTMLDivElement>()
  return (
    <div ref={frame} className="relative inline-block max-w-full self-start">
      <img
        src={url}
        alt={alt}
        className={cn('block max-w-full rounded-md', large ? 'max-h-[80vh]' : 'max-h-[28rem]')}
        data-testid="annotate-image"
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      />
      {natural && width > 0 && <MarkLayer marks={marks} width={natural.width} height={natural.height} scale={width / natural.width} active={active} onSelect={(index) => onSelect(active === index ? null : index)} />}
    </div>
  )
}
