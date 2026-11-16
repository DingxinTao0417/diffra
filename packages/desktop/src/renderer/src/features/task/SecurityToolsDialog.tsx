import { useEffect, useMemo, useState } from 'react'
import type { SecurityTool, SecurityToolReport, SecurityToolsInfo, ToolFinding } from '@diffra/core/types'
import { LoaderCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { formatDuration } from '@/lib/format'
import { fillComposer } from '@/state/actions'

// 任务页「更多安全检查」（v2 · M10）：依赖许可证、外部扫描器（本机装了 Semgrep、CodeQL 才能用）、对本机服务的动态测试。
// 手动发起，跑完列出问题，勾选的填进输入框交给智能体处理
export type SecurityDialogKind = 'licenses' | 'scanners' | 'dynamic'

const TITLES: Record<SecurityDialogKind, { title: string; description: string }> = {
  licenses: { title: '依赖许可证', description: '读本机装好的依赖（node_modules、项目的虚拟环境、Go 模块缓存），列出每个依赖的许可证，标出强传染（GPL、AGPL……）和认不出的。不联网。' },
  scanners: { title: '外部扫描器', description: '用本机装的 Semgrep 或 CodeQL 扫整个项目。Diffra 不自带它们；CodeQL 只许用在开源代码、或者有 GitHub Advanced Security 授权的代码上。' },
  dynamic: { title: '动态测试', description: '对本机跑着的服务发探测请求：反射型 XSS、开放跳转、路径穿越、SQL 报错、堆栈泄露、缺安全响应头。只发 GET、只许本机地址；有副作用的 GET 接口也会被调到。' },
}

const SEVERITY: Record<ToolFinding['severity'], { label: string; variant: 'destructive' | 'warning' | 'outline' }> = {
  high: { label: '高危', variant: 'destructive' },
  medium: { label: '中危', variant: 'warning' },
  low: { label: '提示', variant: 'outline' },
}

const LICENSE_KINDS: Record<string, string> = { permissive: '宽松', 'weak-copyleft': '弱传染', 'strong-copyleft': '强传染', unknown: '认不出' }

export function SecurityToolsDialog({ sessionId, cwd, kind, onClose }: { sessionId: string; cwd: string; kind: SecurityDialogKind | null; onClose(): void }) {
  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="security-tools">
        {kind && <SecurityToolsBody key={kind} sessionId={sessionId} cwd={cwd} kind={kind} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function SecurityToolsBody({ sessionId, cwd, kind, onClose }: { sessionId: string; cwd: string; kind: SecurityDialogKind; onClose(): void }) {
  const [info, setInfo] = useState<SecurityToolsInfo | null>(null)
  const [scanner, setScanner] = useState<'semgrep' | 'codeql'>('semgrep')
  const [licensed, setLicensed] = useState(false)
  const [baseUrl, setBaseUrl] = useState('http://localhost:3000')
  const [routes, setRoutes] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const [report, setReport] = useState<SecurityToolReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (kind === 'licenses') return
    let cancelled = false
    window.diffra
      .securityTools(cwd)
      .then((value) => {
        if (cancelled) return
        setInfo(value)
        setRoutes((current) => current || value.routes.join('\n'))
        if (!value.semgrep && value.codeql) setScanner('codeql')
      })
      .catch((caught: unknown) => !cancelled && setError(errorMessage(caught)))
    return () => {
      cancelled = true
    }
  }, [cwd, kind])

  const tool: SecurityTool = kind === 'scanners' ? scanner : kind
  const installed = kind !== 'scanners' || (info !== null && info[scanner] !== null)
  const canRun = running === null && installed && (tool !== 'codeql' || licensed) && (kind !== 'dynamic' || baseUrl.trim() !== '')

  const start = async () => {
    const runId = crypto.randomUUID()
    setRunning(runId)
    setError(null)
    setReport(null)
    try {
      const result = await window.diffra.runSecurityTool({
        cwd,
        runId,
        tool,
        ...(tool === 'dynamic' ? { baseUrl: baseUrl.trim(), routes: routes.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('/')) } : {}),
        ...(tool === 'codeql' ? { codeqlLicensed: licensed } : {}),
      })
      setReport(result)
      setSelected(new Set(result.findings.flatMap((item, index) => (item.severity === 'low' ? [] : [index]))))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setRunning(null)
    }
  }

  const send = () => {
    if (!report) return
    const picked = report.findings.filter((_, index) => selected.has(index))
    const intro = tool === 'licenses' ? '下面这些依赖的许可证要处理：换成许可证合适的库，或者说明为什么能接受。' : `请修复${TITLES[kind].title}（${tool === 'semgrep' ? 'Semgrep' : tool === 'codeql' ? 'CodeQL' : '探测本机服务'}）发现的这些问题，改完说明怎么验证：`
    const lines = picked.map((item) => `- [${SEVERITY[item.severity].label}] ${item.ruleId} ${item.path}${item.line !== null ? `:${item.line}` : ''} ${item.message}`)
    fillComposer(sessionId, `${intro}\n${lines.join('\n')}`)
    onClose()
  }

  const findings = report?.findings ?? []
  const licenses = useMemo(() => report?.licenses?.dependencies ?? [], [report])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{TITLES[kind].title}</DialogTitle>
        <DialogDescription>{TITLES[kind].description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {kind === 'scanners' && (
          <div className="space-y-2">
            <Segmented<'semgrep' | 'codeql'>
              label="用哪个扫描器"
              size="sm"
              value={scanner}
              options={[
                { value: 'semgrep', label: `Semgrep${info && !info.semgrep ? '（没装）' : ''}` },
                { value: 'codeql', label: `CodeQL${info && !info.codeql ? '（没装）' : ''}` },
              ]}
              onChange={setScanner}
            />
            <p className="text-xs text-muted-foreground" data-testid="scanner-status">
              {info === null ? '正在看本机装了哪些…' : info[scanner] ? `本机的 ${scanner === 'semgrep' ? 'Semgrep' : 'CodeQL'}：${info[scanner]}` : scanner === 'semgrep' ? '本机没装 Semgrep（pip install semgrep，或 brew install semgrep），装好后重新打开这个窗口。' : '本机没装 CodeQL 命令行（从 GitHub 的 codeql-action 发布页下载），装好后重新打开这个窗口。'}
            </p>
            {scanner === 'codeql' && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={licensed} onCheckedChange={(value) => setLicensed(value === true)} aria-label="确认可以用 CodeQL" />
                <span>
                  确认这个项目可以用 CodeQL
                  <span className="block text-xs text-muted-foreground">开源项目，或者你们有 GitHub Advanced Security 授权。建数据库、跑查询可能要几分钟到半小时，第一次会联网下载查询包。</span>
                </span>
              </label>
            )}
          </div>
        )}
        {kind === 'dynamic' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dynamic-base">本机服务的地址</Label>
              <Input id="dynamic-base" className="font-mono text-xs" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:3000" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dynamic-routes">要探测的接口（一行一个，以 / 开头）</Label>
              <Textarea id="dynamic-routes" rows={5} className="max-h-40 font-mono text-xs" value={routes} onChange={(event) => setRoutes(event.target.value)} placeholder={info === null ? '正在从代码里认接口…' : '/'} />
              <p className="text-xs text-muted-foreground">{info === null ? '' : info.routes.length > 0 ? `从代码里认出 ${info.routes.length} 个 GET 接口，路径参数换成了 1。` : '代码里没认出接口，只探测首页；可以自己填。'}</p>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {running && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="security-tools-running">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            正在跑…
            <Button size="xs" variant="ghost" onClick={() => void window.diffra.cancelSecurityTool(running)}>
              取消
            </Button>
          </div>
        )}
        {report && (
          <div className="space-y-3" data-testid="security-tools-report">
            <p className="text-xs text-muted-foreground">
              用了 {formatDuration(report.durationMs)}，发现 {findings.length} 个问题。{report.notes.join('；')}
            </p>
            {findings.length > 0 && (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {findings.map((item, index) => (
                  <li key={`${item.ruleId}:${item.path}:${item.line}:${index}`} className="flex items-start gap-2 text-xs" data-testid="security-tools-finding">
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(index)}
                      aria-label={`选中 ${item.ruleId} ${item.path}`}
                      onCheckedChange={(value) =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (value === true) next.add(index)
                          else next.delete(index)
                          return next
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <Badge variant={SEVERITY[item.severity].variant} className="mr-1.5">
                        {SEVERITY[item.severity].label}
                      </Badge>
                      <span className="font-mono">{item.ruleId}</span> <span className="font-mono text-muted-foreground">{item.path}{item.line !== null ? `:${item.line}` : ''}</span>
                      <span className="block break-words">{item.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {licenses.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">全部 {licenses.length} 个依赖的许可证</summary>
                <table className="mt-1 w-full">
                  <tbody>
                    {licenses.map((item) => (
                      <tr key={`${item.ecosystem}:${item.name}`} className="border-b border-border/50">
                        <td className="py-0.5 font-mono">{item.name}</td>
                        <td className="text-muted-foreground">{item.version ?? ''}</td>
                        <td>{item.license ?? '没写'}</td>
                        <td className="text-muted-foreground">{LICENSE_KINDS[item.kind]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
        {report && findings.length > 0 ? (
          <Button disabled={selected.size === 0} onClick={send}>
            填进输入框（{selected.size}）
          </Button>
        ) : (
          <Button disabled={!canRun} onClick={() => void start()}>
            {kind === 'dynamic' ? '开始测试' : '开始扫描'}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
