import { FileText } from 'lucide-react'
import { cn } from 'cn'
import { DiffCounts } from '@/features/session/DiffView'
import { formatDuration } from '@/lib/format'
import { CardShell } from './CardShell'
import { LocationLink } from './LocationLink'

// 每轮报告（第 661 步）：按这一轮的记录拼，不再调模型——改了什么、为什么（用户的要求）、验证了什么（检查、测试、命令）、风险、下一步。
// 能复制、导出成 Markdown（写 PR 说明、交接用）

export interface TurnReportData {
  request: string
  files: Array<{ path: string; added: number; removed: number }>
  checks: Array<{ name: string; state: 'passed' | 'failed' | 'attention' }>
  tests: Array<{ command: string; passed: number; failed: number; skipped: number }>
  commands: { total: number; failed: string[] }
  risks: string[]
  next: string[]
  durationMs: number | null
}

const CHECK_STATE: Record<TurnReportData['checks'][number]['state'], string> = { passed: '通过', failed: '没通过', attention: '需要留意' }

export function reportMarkdown(data: TurnReportData): string {
  const lines = ['# 本轮报告', '', '## 要求', '', data.request.trim(), '', '## 改了什么', '']
  lines.push(...(data.files.length > 0 ? data.files.map((file) => `- \`${file.path}\` +${file.added} −${file.removed}`) : ['没有改文件']), '', '## 验证了什么', '')
  lines.push(...data.checks.map((check) => `- ${check.name}：${CHECK_STATE[check.state]}`))
  lines.push(...data.tests.map((test) => `- 测试 \`${test.command}\`：通过 ${test.passed}，失败 ${test.failed}${test.skipped ? `，跳过 ${test.skipped}` : ''}`))
  lines.push(`- 跑了 ${data.commands.total} 条命令${data.commands.failed.length > 0 ? `，${data.commands.failed.length} 条失败` : ''}`, '')
  lines.push('## 风险', '', ...(data.risks.length > 0 ? data.risks.map((risk) => `- ${risk}`) : ['没有发现']), '')
  if (data.next.length > 0) lines.push('## 下一步', '', ...data.next.map((step) => `- ${step}`), '')
  return lines.join('\n')
}

export function TurnReport({ data }: { data: TurnReportData }) {
  return (
    <CardShell
      data-testid="turn-report"
      icon={<FileText className="size-4 shrink-0 text-muted-foreground" />}
      title="本轮报告"
      subtitle={data.durationMs !== null ? `用时 ${formatDuration(data.durationMs)}` : undefined}
      copy={{ label: '复制报告', text: () => reportMarkdown(data) }}
      exportMarkdown={{ name: '本轮报告', text: () => reportMarkdown(data) }}
    >
      <Section title="要求">
        <p className="line-clamp-3 break-words whitespace-pre-wrap">{data.request}</p>
      </Section>
      <Section title={`改了什么 · ${data.files.length} 个文件`}>
        {data.files.length === 0 ? (
          <p className="text-muted-foreground">没有改文件</p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="turn-report-files">
            {data.files.map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-2">
                <LocationLink location={file.path} className="min-w-0 truncate font-mono text-xs" />
                <DiffCounts added={file.added} removed={file.removed} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="验证了什么">
        <ul className="flex flex-col gap-0.5" data-testid="turn-report-checks">
          {data.checks.map((check, index) => (
            <li key={index}>
              {check.name}：<span className={cn(check.state === 'failed' && 'text-destructive', check.state === 'attention' && 'text-warning')}>{CHECK_STATE[check.state]}</span>
            </li>
          ))}
          {data.tests.map((test, index) => (
            <li key={`test-${index}`} className="min-w-0 truncate">
              测试 <code className="font-mono text-xs">{test.command}</code>：通过 {test.passed}
              {test.failed > 0 && <span className="text-destructive">，失败 {test.failed}</span>}
              {test.skipped > 0 && `，跳过 ${test.skipped}`}
            </li>
          ))}
          <li className="text-muted-foreground">
            跑了 {data.commands.total} 条命令{data.commands.failed.length > 0 && `，${data.commands.failed.length} 条失败`}
          </li>
        </ul>
      </Section>
      <Section title="风险">
        {data.risks.length === 0 ? (
          <p className="text-muted-foreground">没有发现</p>
        ) : (
          <ul className="list-disc pl-4" data-testid="turn-report-risks">
            {data.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        )}
      </Section>
      {data.next.length > 0 && (
        <Section title="下一步">
          <ul className="list-disc pl-4">
            {data.next.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </Section>
      )}
    </CardShell>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}
