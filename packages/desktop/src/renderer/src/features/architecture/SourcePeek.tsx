import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { useArch } from './context'

// 只读地看一个文件，停在那一行并标出来；要改就用系统默认的程序打开
export function SourcePeek({ path, line, onClose }: { path: string; line: number | null; onClose(): void }) {
  const { project } = useArch()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const target = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    window.diffra
      .readArchitectureSource(project.id, path)
      .then((result) => alive && setText(result.text))
      .catch((reason: unknown) => alive && setError(errorMessage(reason)))
    return () => {
      alive = false
    }
  }, [project.id, path])

  useEffect(() => {
    if (text !== null) target.current?.scrollIntoView({ block: 'center' })
  }, [text])

  const lines = text?.split('\n') ?? []
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl" data-testid="architecture-source">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {path}
            {line ? `:${line}` : ''}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            只读预览
            <Button
              variant="ghost"
              size="xs"
              onClick={() => window.diffra.openArchitectureFile(project.id, path).catch((reason: unknown) => showToast(errorMessage(reason)))}
            >
              <ExternalLink className="size-3" />
              用默认程序打开
            </Button>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 font-mono text-xs leading-5">
          {error && <div className="p-3 text-destructive">{error}</div>}
          {text === null && !error && <div className="p-3 text-muted-foreground">读取中…</div>}
          {lines.map((content, at) => (
            <div key={at} ref={at + 1 === line ? target : undefined} className={cn('flex', at + 1 === line && 'bg-highlight')}>
              <span className="w-12 shrink-0 pr-3 text-right text-muted-foreground select-none">{at + 1}</span>
              <span className="pr-3 whitespace-pre">{content || ' '}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
