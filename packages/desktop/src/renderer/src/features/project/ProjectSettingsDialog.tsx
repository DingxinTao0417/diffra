import { type FormEvent, useEffect, useState } from 'react'
import type { CheckDetection, CheckRunResult, DetectedCheck } from '@diffra/core/types'
import { Check, LoaderCircle, Play, ScanSearch, X } from 'lucide-react'
import type { ProjectState } from '../../../../shared/ipc'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage } from '@/lib/errors'
import { folderName } from '@/lib/format'

interface ProjectSettingsDialogProps {
  project: ProjectState | null
  open: boolean
  // 打开时自动识别检查命令（首页提示「检测到检查命令」时）
  detectOnOpen?: boolean
  onClose(): void
  onSaved(project: ProjectState): void
}

export function ProjectSettingsDialog({ project, open, detectOnOpen, onClose, onSaved }: ProjectSettingsDialogProps) {
  return (
    <Dialog open={open && project !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>项目设置 · {project ? folderName(project.path) : ''}</DialogTitle>
          <DialogDescription>保存在 Diffra 里，不往项目仓库写文件。新建或重新打开的任务按新设置运行。</DialogDescription>
        </DialogHeader>
        {open && project && <ProjectSettingsForm project={project} detectOnOpen={detectOnOpen ?? false} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

const KIND_LABELS: Record<DetectedCheck['kind'], string> = { typecheck: '类型检查', lint: 'Lint', test: '测试' }

type Detection = { state: 'loading' } | { state: 'ready'; result: CheckDetection } | { state: 'error'; message: string }

function ProjectSettingsForm({
  project,
  detectOnOpen,
  onClose,
  onSaved,
}: Omit<ProjectSettingsDialogProps, 'open' | 'project' | 'detectOnOpen'> & { project: ProjectState; detectOnOpen: boolean }) {
  const [afterEdit, setAfterEdit] = useState(project.checks.afterEdit ?? '')
  const [beforeFinish, setBeforeFinish] = useState(project.checks.beforeFinish ?? '')
  const [readOnly, setReadOnly] = useState(project.readOnlyPaths.join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detection, setDetection] = useState<Detection | null>(null)

  const detect = async () => {
    setDetection({ state: 'loading' })
    try {
      setDetection({ state: 'ready', result: await window.diffra.detectChecks(project.path) })
    } catch (caught) {
      setDetection({ state: 'error', message: errorMessage(caught) })
    }
  }

  // 只在打开时识别一次
  useEffect(() => {
    if (detectOnOpen) void detect()
  }, [])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await window.diffra.saveProject(project.path, {
        checks: { afterEdit: afterEdit.trim() || null, beforeFinish: beforeFinish.trim() || null },
        readOnlyPaths: readOnly.split(/[,，\s]+/).filter(Boolean),
      })
      onSaved(updated)
      onClose()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3" data-testid="check-detection">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm font-medium">自动识别检查命令</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void detect()} disabled={detection?.state === 'loading'}>
            {detection?.state === 'loading' ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
            自动检测
          </Button>
        </div>
        {!detection && <p className="text-xs text-muted-foreground">按 package.json、pyproject.toml 等配置找项目里已有的类型检查、lint 和测试，只读文件，不执行。</p>}
        {detection?.state === 'error' && <p className="text-xs text-destructive">{detection.message}</p>}
        {detection?.state === 'ready' && (
          <DetectionResult
            result={detection.result}
            onApply={(result) => {
              setAfterEdit(result.afterEdit ?? '')
              setBeforeFinish(result.beforeFinish ?? '')
            }}
          />
        )}
      </div>

      <CheckField
        id="check-after-edit"
        label="快速检查（每步改动后）"
        placeholder="例如 pnpm typecheck；不填就不跑"
        value={afterEdit}
        onChange={setAfterEdit}
        projectPath={project.path}
      />
      <CheckField
        id="check-before-finish"
        label="完成检查（完成时）"
        placeholder="例如 pnpm test；不填就用快速检查"
        value={beforeFinish}
        onChange={setBeforeFinish}
        projectPath={project.path}
      />
      <div className="space-y-1.5">
        <Label htmlFor="read-only-paths">禁止修改的目录</Label>
        <Input id="read-only-paths" placeholder="例如 data, uploads（相对项目根目录）" value={readOnly} onChange={(event) => setReadOnly(event.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">检查命令在任务里自动运行，不再逐次确认，保存前请确认它们是你信任的命令。</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          保存项目设置
        </Button>
      </DialogFooter>
    </form>
  )
}

function DetectionResult({ result, onApply }: { result: CheckDetection; onApply(result: CheckDetection): void }) {
  return (
    <div className="space-y-2 text-sm">
      {result.checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有识别到可用的检查命令。</p>
      ) : (
        <ul className="space-y-1.5">
          {result.checks.map((check) => (
            <li key={check.command} className="space-y-0.5" data-testid="detected-check">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs text-muted-foreground">{KIND_LABELS[check.kind]}</span>
                <code className="font-mono text-xs">{check.command}</code>
              </div>
              <div className="text-xs text-muted-foreground">
                {check.source}
                {check.script && (
                  <>
                    {'，实际运行：'}
                    <code className="font-mono">{check.script}</code>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          · {note}
        </p>
      ))}
      {result.checks.length > 0 && (
        <Button type="button" size="sm" onClick={() => onApply(result)}>
          填入下面的检查命令
        </Button>
      )}
    </div>
  )
}

interface CheckFieldProps {
  id: string
  label: string
  placeholder: string
  value: string
  onChange(value: string): void
  projectPath: string
}

// 检查命令输入框，带「试运行」：结果对应当时输入框里的命令，改了命令就清掉
function CheckField({ id, label, placeholder, value, onChange, projectPath }: CheckFieldProps) {
  const [run, setRun] = useState<{ command: string; state: 'running' } | { command: string; state: 'done'; result: CheckRunResult } | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  const command = value.trim()
  const current = run?.command === command ? run : null

  const tryRun = async () => {
    setRun({ command, state: 'running' })
    setShowOutput(false)
    try {
      setRun({ command, state: 'done', result: await window.diffra.runCheck(projectPath, command) })
    } catch (caught) {
      setRun({ command, state: 'done', result: { passed: false, summary: errorMessage(caught) } })
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
        <Button type="button" variant="outline" disabled={!command || current?.state === 'running'} onClick={() => void tryRun()} title="在项目目录里跑一次这条命令">
          {current?.state === 'running' ? <LoaderCircle className="animate-spin" /> : <Play />}
          试运行
        </Button>
      </div>
      {current?.state === 'running' && <p className="text-xs text-muted-foreground">正在运行，最长 5 分钟…</p>}
      {current?.state === 'done' && (
        <div className="text-xs" data-testid={`${id}-result`}>
          <button type="button" className={cn('flex items-center gap-1', current.result.passed ? 'text-success' : 'text-destructive')} onClick={() => setShowOutput(!showOutput)}>
            {current.result.passed ? <Check className="size-3.5" /> : <X className="size-3.5" />}
            {current.result.passed ? '通过' : '没通过'}
            <span className="text-muted-foreground">· {showOutput ? '收起输出' : '查看输出'}</span>
          </button>
          {showOutput && <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap">{current.result.summary}</pre>}
        </div>
      )}
    </div>
  )
}
