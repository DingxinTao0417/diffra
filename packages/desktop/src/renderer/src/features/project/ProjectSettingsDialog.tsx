import { type FormEvent, useRef, useState } from 'react'
import type { CheckDetection, CheckRunResult, DetectedCheck } from '@diffra/core/types'
import { Check, LoaderCircle, Play, ScanSearch, ShieldAlert, X } from 'lucide-react'
import type { ProjectState } from '../../../../shared/ipc'
import { DEFAULT_SECURITY, effectiveSecurity, type ProjectHooks, type ProjectSecurity, type SecuritySettings } from '../../../../shared/settings'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { useAppState } from '@/state/store'

interface ProjectSettingsDialogProps {
  project: ProjectState | null
  open: boolean
  onClose(): void
  onSaved(project: ProjectState): void
}

export function ProjectSettingsDialog({ project, open, onClose, onSaved }: ProjectSettingsDialogProps) {
  return (
    <Dialog open={open && project !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>项目设置</DialogTitle>
          <DialogDescription>
            <span className="block truncate font-mono text-xs" title={project?.path}>
              {project?.path}
            </span>
            保存在 Diffra 里，不往项目仓库写文件。改动对新任务生效。
          </DialogDescription>
        </DialogHeader>
        {open && project && <ProjectSettingsForm project={project} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

const KIND_LABELS: Record<DetectedCheck['kind'], string> = { typecheck: '类型检查', lint: 'Lint', test: '测试' }

// 三个钩子的时机和能用的环境变量（core 的 session/hooks.ts）
const HOOK_FIELDS: Array<{ key: keyof ProjectHooks; label: string; placeholder: string; hint: string }> = [
  { key: 'afterEdit', label: '改完文件后', placeholder: '例如 npx prettier --write "$DIFFRA_FILE"', hint: '智能体每改完一个文件跑一次，$DIFFRA_FILE 是那个文件。钩子改了文件（比如格式化）会告诉智能体重读。' },
  { key: 'beforeCommand', label: '执行命令前', placeholder: '例如 case "$DIFFRA_COMMAND" in *deploy*) echo 不许部署; exit 2;; esac', hint: '智能体每条命令执行前跑一次，$DIFFRA_COMMAND 是那条命令。退出码 2 表示拦下，输出作为理由告诉智能体。' },
  { key: 'turnEnd', label: '一轮结束时', placeholder: '例如 发通知的命令', hint: '每轮结束跑一次，不等它跑完。$DIFFRA_STOP 是停下的原因，正常结束是 done。' },
]

type Detection = { state: 'loading' } | { state: 'ready'; result: CheckDetection } | { state: 'error'; message: string }

interface Suggestion {
  command: string
  checks: DetectedCheck[]
}

// core 用 ` && ` 把检测到的命令连成建议值（detect.ts 的 chain），拆开才能对回每条的来源。
// 只有一栏完成检查：有测试时建议类型检查、lint 加测试，没有测试时就是类型检查和 lint
function suggestionOf(result: CheckDetection): Suggestion | null {
  const command = result.beforeFinish ?? result.afterEdit
  if (command === null) return null
  return { command, checks: command.split(' && ').flatMap((part) => result.checks.filter((check) => check.command === part)) }
}

// 按项目单独设的安全开关（v2）
const PROJECT_SECURITY_KEYS: Array<{ key: keyof SecuritySettings; label: string }> = [
  { key: 'staticCheck', label: '静态检查' },
  { key: 'taint', label: '污点分析' },
  { key: 'licenses', label: '依赖许可证' },
  { key: 'semgrep', label: 'Semgrep' },
  { key: 'lightScan', label: '轻量扫描' },
  { key: 'deepScan', label: '深度扫描' },
  { key: 'review', label: '规范审查' },
]

function ProjectSettingsForm({ project, onClose, onSaved }: Omit<ProjectSettingsDialogProps, 'open' | 'project'> & { project: ProjectState }) {
  // 第 431 步以前存的快速检查只在没填完成检查时当完成检查用，这里按实际会跑的那条显示，保存时只存完成检查
  const savedFinish = project.checks.beforeFinish ?? project.checks.afterEdit ?? ''
  const [finish, setFinish] = useState(savedFinish)
  const [readOnly, setReadOnly] = useState(project.readOnlyPaths.join(', '))
  const [allowed, setAllowed] = useState(project.allowedCommands.join(', '))
  const [hooks, setHooks] = useState<ProjectHooks>(project.hooks)
  const [security, setSecurity] = useState<ProjectSecurity>(project.security)
  const globalSecurity = useAppState((state) => state.settings?.security ?? DEFAULT_SECURITY)
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

  const suggestion = detection?.state === 'ready' ? suggestionOf(detection.result) : null
  const notes = detection?.state === 'ready' ? detection.result.notes : []
  const noChecks = detection?.state === 'ready' && detection.result.checks.length === 0
  const showTrustNote = finish.trim() !== savedFinish && finish.trim() !== ''

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await window.diffra.saveProject(project.path, {
        checks: { afterEdit: null, beforeFinish: finish.trim() || null },
        readOnlyPaths: readOnly.split(/[,，\s]+/).filter(Boolean),
        // 命令键里有空格（pnpm test），只按逗号和换行分
        allowedCommands: allowed.split(/[,，\n]+/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean),
        hooks: { afterEdit: hooks.afterEdit?.trim() || null, beforeCommand: hooks.beforeCommand?.trim() || null, turnEnd: hooks.turnEnd?.trim() || null },
        security,
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
    <form onSubmit={save} className="flex min-h-0 flex-col gap-4">
      {/* 滚动区会裁掉贴边控件的焦点环，上下留 4px 再用负边距抵消 */}
      <DialogBody className="space-y-5">
        <section className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-sm font-bold">检查命令</h3>
              <Button type="button" size="sm" variant="outline" onClick={() => void detect()} disabled={detection?.state === 'loading'}>
                {detection?.state === 'loading' ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
                自动检测
              </Button>
            </div>
            {(!detection || detection.state === 'error' || noChecks || notes.length > 0) && (
              <div className="space-y-2" data-testid="check-detection">
                {!detection && <p className="text-xs text-muted-foreground">按 package.json、pyproject.toml 等配置找项目里已有的类型检查、lint 和测试，只读文件，不执行。</p>}
                {detection?.state === 'error' && <p className="text-xs text-destructive">{detection.message}</p>}
                {noChecks && <p className="text-xs text-muted-foreground">没有识别到可用的检查命令。</p>}
                {notes.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                    {notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <CheckField
            id="check-before-finish"
            label="完成检查"
            hint="智能体做完、调用完成时跑一次，改的过程中不跑；不填就不自动检查。"
            placeholder="例如 pnpm typecheck && pnpm test"
            value={finish}
            onChange={setFinish}
            suggestion={suggestion}
            projectPath={project.path}
          />
          {showTrustNote && (
            <div className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm" role="note">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>保存后这条命令会在任务里自动运行，不再逐次确认。只保存你信任的命令。</p>
            </div>
          )}
        </section>
        <section className="space-y-1.5 border-t pt-5">
          <h3>
            <Label htmlFor="read-only-paths" className="font-bold">
              禁止修改的目录
            </Label>
          </h3>
          <Input
            id="read-only-paths"
            placeholder="例如 data, uploads"
            aria-describedby="read-only-paths-hint"
            value={readOnly}
            onChange={(event) => setReadOnly(event.target.value)}
          />
          <p id="read-only-paths-hint" className="text-xs text-muted-foreground">
            相对项目根目录，多个用逗号或空格分隔。
          </p>
        </section>
        <section className="space-y-1.5 border-t pt-5">
          <h3>
            <Label htmlFor="allowed-commands" className="font-bold">
              始终允许的命令
            </Label>
          </h3>
          <Input
            id="allowed-commands"
            placeholder="例如 pnpm test, git commit"
            aria-describedby="allowed-commands-hint"
            value={allowed}
            onChange={(event) => setAllowed(event.target.value)}
          />
          <p id="allowed-commands-hint" className="text-xs text-muted-foreground">
            这个项目的任务里，这些同类命令不再逐次确认（程序名加第一个子命令）。在确认框里选「这个项目里始终允许同类命令」会加到这里；删掉就恢复询问。多个用逗号分隔。
          </p>
        </section>
        <section className="space-y-3 border-t pt-5">
          <div className="space-y-1">
            <h3 className="text-sm font-bold">钩子</h3>
            <p className="text-xs text-muted-foreground">在固定的时机替你跑一条命令（在项目目录里，Git Bash，最长 1 分钟），不逐次确认。不填就不跑。</p>
          </div>
          {HOOK_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`hook-${field.key}`}>{field.label}</Label>
              <Input
                id={`hook-${field.key}`}
                className="font-mono text-xs"
                placeholder={field.placeholder}
                aria-describedby={`hook-${field.key}-hint`}
                value={hooks[field.key] ?? ''}
                onChange={(event) => setHooks({ ...hooks, [field.key]: event.target.value })}
              />
              <p id={`hook-${field.key}-hint`} className="text-xs text-muted-foreground">
                {field.hint}
              </p>
            </div>
          ))}
        </section>
        <section className="space-y-3 border-t pt-5" data-testid="project-security">
          <div className="space-y-1">
            <h3 className="text-sm font-bold">安全检查</h3>
            <p className="text-xs text-muted-foreground">这个项目单独开或关哪几样；「跟设置」就用「设置 → 安全」里的。改了对这个项目已经打开的任务立即生效。</p>
          </div>
          {PROJECT_SECURITY_KEYS.map(({ key, label }) => {
            const value = security[key]
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  {label}
                  <span className="ml-1.5 text-xs text-muted-foreground">设置里{effectiveSecurity(globalSecurity, undefined)[key] ? '开着' : '关着'}</span>
                </span>
                <Segmented<'inherit' | 'on' | 'off'>
                  label={`${label}（这个项目）`}
                  size="sm"
                  value={value === undefined ? 'inherit' : value ? 'on' : 'off'}
                  options={[
                    { value: 'inherit', label: '跟设置' },
                    { value: 'on', label: '开' },
                    { value: 'off', label: '关' },
                  ]}
                  onChange={(next) =>
                    setSecurity((current) => {
                      const { [key]: _old, ...rest } = current
                      return next === 'inherit' ? rest : { ...rest, [key]: next === 'on' }
                    })
                  }
                />
              </div>
            )
          })}
        </section>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          保存项目设置
        </Button>
      </DialogFooter>
    </form>
  )
}

interface CheckFieldProps {
  id: string
  label: string
  hint: string
  placeholder: string
  value: string
  onChange(value: string): void
  suggestion: Suggestion | null
  projectPath: string
}

// 检查命令输入框，带「试运行」：结果对应当时输入框里的命令，改了命令就清掉
function CheckField({ id, label, hint, placeholder, value, onChange, suggestion, projectPath }: CheckFieldProps) {
  const [run, setRun] = useState<{ command: string; state: 'running' } | { command: string; state: 'done'; result: CheckRunResult } | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
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
        <Input ref={inputRef} id={id} placeholder={placeholder} aria-describedby={`${id}-hint`} value={value} onChange={(event) => onChange(event.target.value)} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" disabled={!command || current?.state === 'running'} onClick={() => void tryRun()}>
              {current?.state === 'running' ? <LoaderCircle className="animate-spin" /> : <Play />}
              试运行
            </Button>
          </TooltipTrigger>
          <TooltipContent>在项目目录里跑一次这条命令。</TooltipContent>
        </Tooltip>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {suggestion && (
        <div className="space-y-0.5 border-l-2 pl-3 text-xs" data-testid={`${id}-suggestion`}>
          {/* 按钮换成「已填入」时行高不变，下面的内容不跳 */}
          <div className="flex min-h-6 items-center gap-2">
            <span className="min-w-0 flex-1 break-words">
              建议：<code className="font-mono">{suggestion.command}</code>
            </span>
            {command === suggestion.command ? (
              <span className="shrink-0 text-muted-foreground">已填入</span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={`填入${label}`}
                onClick={() => {
                  onChange(suggestion.command)
                  // 按钮马上换成「已填入」，焦点留在它上面会被弹窗收回到容器，键盘用户得从头 Tab；挪到刚填好的输入框
                  inputRef.current?.focus()
                }}
              >
                填入
              </Button>
            )}
          </div>
          {suggestion.checks.map((check) => (
            <p key={check.command} className="break-words text-muted-foreground">
              {KIND_LABELS[check.kind]}：{check.source}
              {check.script && (
                <>
                  {'，实际运行：'}
                  <code className="font-mono">{check.script}</code>
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {current?.state === 'running' && <p className="text-xs text-muted-foreground">正在运行，最长 5 分钟…</p>}
      {current?.state === 'done' && (
        <div className="text-xs" data-testid={`${id}-result`}>
          {/* success-color-allow: 用户主动试运行检查命令的结果 */}
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
