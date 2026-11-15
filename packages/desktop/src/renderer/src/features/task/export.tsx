import type { ReactNode } from 'react'
import { FileCode, FileImage, FileText, FileType } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { Turn } from '@/features/session/transcript'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { downloadBlob, safeFileName } from './rich/download'
import { renderStaticHtml } from './static-html'

// 导出（第 678 步）：一轮或整个任务存成 Markdown、HTML、PDF、图片。HTML、PDF、图片都从统一静态渲染来（第 671 步，带主题、图表、公式、可视化快照）；
// PDF、图片由主进程在看不见的窗口里打开那份 HTML 打印、截图。Markdown 从数据拼：提问、回答原文（富块照样是围栏）、过程步骤的标题、可视化快照
export type ExportFormat = 'markdown' | 'html' | 'pdf' | 'png'

const FORMATS: Array<{ format: ExportFormat; label: string; icon: ReactNode }> = [
  { format: 'markdown', label: 'Markdown', icon: <FileText /> },
  { format: 'html', label: 'HTML', icon: <FileCode /> },
  { format: 'pdf', label: 'PDF', icon: <FileType /> },
  { format: 'png', label: '图片（PNG）', icon: <FileImage /> },
]

const MAX_STEPS = 30

export function turnsMarkdown(title: string, turns: Turn[]): string {
  const lines = [`# ${title}`, '']
  turns.forEach((turn, index) => {
    if (turns.length > 1) lines.push(`## 第 ${index + 1} 轮`, '')
    lines.push(...turn.prompt.trim().split('\n').map((line) => `> ${line}`), '')
    const steps: string[] = []
    for (const item of turn.items) {
      if (item.kind === 'agent' && item.text.trim()) lines.push(item.text.trim(), '')
      else if (item.kind === 'tool' && item.visual) {
        const snapshot = item.visualSnapshot
        lines.push(snapshot ? `![${item.visual.title}](data:${snapshot.mimeType};base64,${snapshot.data})` : `（可视化「${item.visual.title}」，在 Diffra 里打开才能看）`, '')
      } else if (item.kind === 'tool' && !item.parentId) steps.push(item.title)
    }
    if (steps.length > 0) {
      lines.push('过程：', '', ...steps.slice(0, MAX_STEPS).map((step) => `- ${step}`))
      if (steps.length > MAX_STEPS) lines.push(`- …还有 ${steps.length - MAX_STEPS} 步`)
      lines.push('')
    }
  })
  return `${lines.join('\n').trimEnd()}\n`
}

// render 给出要导出的那几轮（StaticTurns），HTML、PDF、图片用
export async function exportTurns(format: ExportFormat, title: string, turns: Turn[], render: () => ReactNode): Promise<void> {
  const name = safeFileName(title)
  try {
    if (format === 'markdown') return downloadBlob(new Blob([turnsMarkdown(title, turns)], { type: 'text/markdown' }), `${name}.md`)
    const html = await renderStaticHtml(render(), title)
    if (format === 'html') return downloadBlob(new Blob([html], { type: 'text/html' }), `${name}.html`)
    const result = await window.diffra.exportDocument(html, format, name)
    if (result.saved && result.truncated) showToast('太长了，图片只存了前面一部分；完整的请导出 PDF')
  } catch (error) {
    showToast(`导出失败：${errorMessage(error)}`)
  }
}

// 每一轮操作栏的「导出这一轮」
export function ExportMenu({ onExport, children }: { onExport(format: ExportFormat): void; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        {FORMATS.map((item) => (
          <DropdownMenuItem key={item.format} onSelect={() => onExport(item.format)}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// 任务菜单里的「导出整个任务」
export function ExportSubmenu({ label, onExport }: { label: string; onExport(format: ExportFormat): void }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FileText />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {FORMATS.map((item) => (
          <DropdownMenuItem key={item.format} onSelect={() => onExport(item.format)}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
