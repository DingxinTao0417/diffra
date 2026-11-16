import type { AnalysisPhase, AnalysisProgress, ArchitectureThumbnail, LanguageStat } from '@diffra/core/architecture'
import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cancelRun } from './architecture-store'
import { layerHue, layerTint } from './diagram/BlockDiagram'

// 语言的颜色跟着语言走，不按排名分配；四种常见语言用图表色，其余用图表色和前景色混出来的变体
const LANGUAGE_COLORS: Record<string, string> = {
  typescript: 'var(--chart-1)',
  javascript: 'var(--chart-2)',
  python: 'var(--chart-3)',
  go: 'var(--chart-4)',
  vue: 'color-mix(in oklab, var(--chart-2) 55%, var(--foreground))',
  java: 'color-mix(in oklab, var(--chart-3) 55%, var(--foreground))',
  rust: 'color-mix(in oklab, var(--chart-4) 55%, var(--foreground))',
}

export const languageColor = (language: string) => LANGUAGE_COLORS[language] ?? 'var(--muted-foreground)'

const LANGUAGE_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', vue: 'Vue', kotlin: 'Kotlin', csharp: 'C#', cpp: 'C++', c: 'C', php: 'PHP', ruby: 'Ruby', swift: 'Swift', dart: 'Dart', scala: 'Scala', sql: 'SQL', svelte: 'Svelte' }
export const languageName = (language: string) => LANGUAGE_NAMES[language] ?? language

// 按代码行数的语言占比条，下面列前几种
export function LanguageBar({ languages, limit = 4 }: { languages: LanguageStat[]; limit?: number }) {
  const total = languages.reduce((sum, item) => sum + item.lines, 0) || 1
  const shown = languages.slice(0, limit)
  return (
    <div className="space-y-1.5">
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted" role="img" aria-label={languages.map((item) => `${languageName(item.language)} ${Math.round((item.lines / total) * 100)}%`).join('，')}>
        {languages.map((item) => (
          <span key={item.language} className="h-full" style={{ width: `${(item.lines / total) * 100}%`, background: languageColor(item.language) }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {shown.map((item) => (
          <span key={item.language} className="flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ background: languageColor(item.language) }} />
            {languageName(item.language)} {Math.round((item.lines / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  )
}

// 卡片上的缩略图：应用架构图每层一行，左边层名，右边方块名
export function Thumbnail({ thumbnail }: { thumbnail: ArchitectureThumbnail }) {
  return (
    <div className="flex h-full flex-col justify-center gap-1 p-2.5" aria-hidden data-testid="architecture-thumbnail">
      {thumbnail.layers.map((layer, at) => (
        <div key={at} className="flex min-h-0 items-center gap-1 overflow-hidden">
          <span className="w-14 shrink-0 truncate rounded-sm border-l-2 px-1 text-[9px] leading-4" style={{ background: layerTint(at, 18), borderLeftColor: layerHue(at) }}>
            {layer.name}
          </span>
          <span className="flex min-w-0 flex-1 gap-0.5 overflow-hidden rounded-sm px-0.5 py-px" style={{ background: layerTint(at, 6) }}>
            {layer.blocks.map((name, index) => (
              <span key={index} className="max-w-16 shrink-0 truncate rounded-xs border bg-card px-1 text-[9px] leading-[14px]" data-testid="architecture-thumbnail-block">
                {name}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

export const PHASE_LABELS: Record<AnalysisPhase, string> = {
  listing: '列出文件',
  manifests: '读取清单',
  parsing: '解析代码',
  resolving: '解析依赖',
  history: '读取提交历史',
  saving: '保存结果',
  interpreting: '模型解读中',
  tracing: '运行时追踪中',
}

export function RunProgress({ progress, compact = false }: { progress: AnalysisProgress; compact?: boolean }) {
  const ratio = progress.total > 0 ? progress.done / progress.total : null
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-testid="architecture-progress">
      <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      <span className="shrink-0">
        {PHASE_LABELS[progress.phase]}
        {ratio !== null && ` ${progress.done}/${progress.total}`}
      </span>
      {!compact && ratio !== null && (
        <span className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full bg-foreground/50 transition-[width]" style={{ width: `${ratio * 100}%` }} />
        </span>
      )}
      <Button variant="ghost" size="xs" className="ml-auto shrink-0" onClick={() => void cancelRun(progress.projectId)}>
        <X className="size-3" />
        取消
      </Button>
    </div>
  )
}
