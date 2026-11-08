import { cn } from 'cn'
import type { DiffLine } from '@/lib/unified-diff'

const MARKERS: Record<DiffLine['kind'], string> = { add: '+', remove: '−', context: '' }

const ROW_CLASSES: Record<DiffLine['kind'], string> = {
  add: 'bg-diff-add shadow-[inset_2px_0_0_var(--diff-add-fg)]',
  remove: 'bg-diff-del shadow-[inset_2px_0_0_var(--diff-del-fg)]',
  context: '',
}

const MARKER_CLASSES: Record<DiffLine['kind'], string> = { add: 'text-diff-add-fg', remove: 'text-diff-del-fg', context: '' }

// 对话里的改动卡片和审阅面板共用的代码区：旧行号 | 新行号 | 标记 | 代码。
// 新建文件没有旧行号、删除文件没有新行号，那一列整列不画，把宽度留给代码
export function DiffLines({ hunks, className, ...props }: React.ComponentProps<'div'> & { hunks: DiffLine[][] }) {
  const lines = hunks.flat()
  const hasOld = lines.some((line) => line.oldLine !== null)
  const hasNew = lines.some((line) => line.newLine !== null)
  const maxLine = lines.reduce((max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0), 0)
  const gutter = `calc(${Math.max(3, String(maxLine).length)}ch + 0.75rem)`
  // 每行单独是一个 grid，列宽固定写进 style，各行才能对齐；外层 w-max 让底色铺满横向滚动后的整行
  const columns = [hasOld && gutter, hasNew && gutter, '1.25rem', '1fr'].filter(Boolean).join(' ')
  return (
    <div className={cn('overflow-x-auto font-mono text-xs leading-5', className)} {...props}>
      <div className="w-max min-w-full">
        {hunks.map((hunk, index) => (
          <div key={index}>
            <div className="px-3 text-muted-foreground select-none">{hunkHeader(hunk)}</div>
            {hunk.map((line, lineIndex) => (
              <div key={lineIndex} className={cn('grid', ROW_CLASSES[line.kind])} style={{ gridTemplateColumns: columns }}>
                {hasOld && <span className="pr-2 text-right text-muted-foreground tabular-nums select-none">{line.oldLine}</span>}
                {hasNew && <span className="pr-2 text-right text-muted-foreground tabular-nums select-none">{line.newLine}</span>}
                <span className={cn('text-center select-none', MARKER_CLASSES[line.kind])}>{MARKERS[line.kind]}</span>
                <span className="pr-4 whitespace-pre">{line.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// 带 3 行上下文时，只有某一侧文件为空才会出现 0 行的一侧，起始行按 git 的写法记 0
function hunkHeader(lines: DiffLine[]): string {
  const range = (numbers: (number | null)[]) => {
    const present = numbers.filter((value) => value !== null)
    return `${present[0] ?? 0},${present.length}`
  }
  return `@@ -${range(lines.map((line) => line.oldLine))} +${range(lines.map((line) => line.newLine))} @@`
}
