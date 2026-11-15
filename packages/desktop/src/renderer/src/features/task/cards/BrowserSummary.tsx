import { useContext, useState } from 'react'
import { Globe, ImageOff, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { TranscriptItem } from '@/features/session/transcript'
import { store } from '@/state/store'
import { AnswerContext } from '../answer-links'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const textOf = (item: ToolItem) => item.content.flatMap((content) => (content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [])).join('\n')

export const isBrowserStep = (item: TranscriptItem): item is ToolItem => item.kind === 'tool' && item.title.startsWith('浏览器 ')

// 一组过程里的浏览器操作：最近一张截图、当前网址、几步操作、控制台报错和失败的请求（第 662 步）。
// 收起时也显示，不用一步步展开；点「浏览器面板」回到这个任务的内置浏览器
export function BrowserSummary({ items }: { items: ToolItem[] }) {
  const target = useContext(AnswerContext)
  const [zoom, setZoom] = useState(false)
  const steps = items.filter(isBrowserStep)
  if (steps.length === 0) return null
  const shot = steps.findLast((item) => item.browserShot)?.browserShot
  const url = steps
    .map((item) => /^浏览器 (?:打开|新标签页) (\S+)/.exec(item.title)?.[1] ?? null)
    .filter(Boolean)
    .at(-1)
  const consoleErrors = steps.filter((item) => item.title === '浏览器 控制台').flatMap((item) => textOf(item).split('\n').filter((line) => /^\[error\]/i.test(line)))
  const failedRequests = steps.filter((item) => item.title === '浏览器 网络请求').flatMap((item) => textOf(item).split('\n').filter((line) => /^(?:[45]\d\d|\S*失败\()/.test(line)))
  const failedSteps = steps.filter((item) => item.status === 'failed').length
  const image = shot && shot !== 'omitted' ? `data:${shot.mimeType};base64,${shot.data}` : null
  return (
    <div className="ml-5 flex gap-3 rounded-lg border px-2.5 py-2 text-xs" data-testid="browser-summary">
      {shot &&
        (image ? (
          <button type="button" className="shrink-0 overflow-hidden rounded-md border hover:opacity-90" aria-label="看大图：最近一张浏览器截图" onClick={() => setZoom(true)}>
            <img src={image} alt="最近一张浏览器截图" className="h-20 w-32 object-cover object-top" data-testid="browser-shot" />
          </button>
        ) : (
          <span className="flex h-20 w-32 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground" title="远程会话不同步截图">
            <ImageOff className="size-4" aria-hidden="true" />
          </span>
        ))}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-center gap-1.5">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate font-mono" title={url ?? undefined}>
            {url ?? '内置浏览器'}
          </span>
        </p>
        <p className="text-muted-foreground tabular-nums">
          浏览器操作 {steps.length} 步{failedSteps > 0 && <span className="text-destructive"> · {failedSteps} 步失败</span>}
        </p>
        {consoleErrors.length > 0 && (
          <p className="min-w-0 truncate text-destructive" title={consoleErrors.join('\n')} data-testid="browser-console-errors">
            控制台报错 {consoleErrors.length} 条：{consoleErrors[0]!.replace(/^\[error\]\s*/i, '')}
          </p>
        )}
        {failedRequests.length > 0 && (
          <p className="min-w-0 truncate text-warning" title={failedRequests.join('\n')} data-testid="browser-failed-requests">
            失败的请求 {failedRequests.length} 个：{failedRequests[0]}
          </p>
        )}
        {target && (
          <Button variant="ghost" size="xs" className="-ml-2 self-start text-muted-foreground" onClick={() => store.set((state) => ({ ...state, panel: 'browser' }))}>
            <PanelRight />
            在浏览器面板看
          </Button>
        )}
      </div>
      {image && (
        <Dialog open={zoom} onOpenChange={setZoom}>
          <DialogContent className="max-h-[90vh] max-w-[90vw] sm:max-w-[90vw]">
            <DialogTitle className="truncate pr-8 text-base">{url ?? '浏览器截图'}</DialogTitle>
            <img src={image} alt="浏览器截图" className="max-h-[78vh] max-w-full object-contain" />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
