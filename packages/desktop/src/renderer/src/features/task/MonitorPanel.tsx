import { useState } from 'react'
import type { ProjectState } from '../../../../shared/ipc'
import { cn } from 'cn'
import { DiffCounts } from '@/features/session/DiffView'
import { useMcpStatus } from '@/features/mcp/useMcpStatus'
import { ProjectSettingsDialog } from '@/features/project/ProjectSettingsDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { taskStatus } from '@/lib/task-status'
import { openSettings, runDeepScan } from '@/state/actions'
import { type LiveTask, store, useAppState } from '@/state/store'
import type { TaskDiff } from './useTaskDiff'

const COLLAPSED_CHANGED_FILE_LIMIT = 10

interface MonitorPanelProps {
  task: LiveTask
  project: ProjectState | null
  branch: string | null
  diff: TaskDiff | null
  onProjectSaved(project: ProjectState): void
  // 点了深度扫描，由任务页弹确认框
  onDeepScan(scope: 'task' | 'project'): void
}

export function MonitorPanel({ task, project, branch, diff, onProjectSaved, onDeepScan }: MonitorPanelProps) {
  const [editing, setEditing] = useState(false)
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const filesExpanded = expandedSessionId === task.sessionId
  const deepScanEnabled = useAppState((state) => state.settings?.security.deepScan ?? false)
  const mcp = useMcpStatus({ sessionId: task.sessionId })
  const status = taskStatus(task).label
  const checks = project?.checks

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4.5 overflow-y-auto border-l bg-sidebar/50 p-4 text-sm" data-testid="monitor-panel">
      <div className="flex items-center justify-between">
        <span className="font-semibold">任务监控</span>
        <span className="text-xs text-muted-foreground">
          {task.turns.length} 轮 · {status}
        </span>
      </div>

      {/* 每轮没调 finish 时 core 都会写一句 blocked 原因；没定义完成条件时只在主动暂停等待时显示原因 */}
      {task.progress && (task.progress.requirements.length > 0 || (task.progress.status === 'waiting' && task.progress.reason)) && (
        <Section title="完成条件">
          {task.progress.reason && <p className="text-muted-foreground">{task.progress.reason}</p>}
          {task.progress.requirements.map((item) => (
            <Row key={item.id} dot={item.receiptId ? 'ok' : 'off'} label={item.title} value={item.receiptId ? '证据已核对' : '待完成'} />
          ))}
        </Section>
      )}

      <Section title="模型">
        <Row label="编码" value={task.modelLabel} />
        <Row label="规划" value={task.planLabel ?? '同编码模型'} />
        <Row label="兜底" value={task.fallbackLabel ?? '未设置'} />
        <LinkButton onClick={() => openSettings('models')}>模型与角色</LinkButton>
      </Section>

      <Section title="检查">
        {checks && (
          <>
            <Row dot={checks.afterEdit ? 'ok' : 'off'} label="快速检查" value={checks.afterEdit ?? '未配置'} mono={!!checks.afterEdit} />
            <Row
              dot={checks.beforeFinish || checks.afterEdit ? 'ok' : 'off'}
              label="完成检查"
              value={checks.beforeFinish ?? (checks.afterEdit ? '同快速检查' : '未配置')}
              mono={!!checks.beforeFinish}
            />
          </>
        )}
        <LinkButton onClick={() => setEditing(true)}>编辑检查命令</LinkButton>
      </Section>

      <Section
        title={diff?.state === 'ready' ? `本任务改动 · ${diff.files.length} 个文件` : '本任务改动'}
        action={task.info.checkpoints ? <LinkButton onClick={() => store.set((state) => ({ ...state, panel: 'review' }))}>审阅</LinkButton> : undefined}
      >
        {!task.info.checkpoints && <p className="text-muted-foreground">检查点不可用（需要 Git），看不到改动汇总</p>}
        {diff?.state === 'loading' && <p className="text-muted-foreground">正在读取…</p>}
        {diff?.state === 'error' && <p className="text-destructive">{diff.message}</p>}
        {diff?.state === 'ready' && diff.files.length === 0 && <p className="text-muted-foreground">还没有改动文件</p>}
        {diff?.state === 'ready' &&
          diff.files.slice(0, filesExpanded ? diff.files.length : COLLAPSED_CHANGED_FILE_LIMIT).map((file) => (
            <div key={file.path} className="flex items-center gap-2" data-testid="monitor-file">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                {file.path}
              </span>
              {file.binary ? <span className="text-xs text-muted-foreground">二进制</span> : <DiffCounts added={file.added} removed={file.removed} />}
            </div>
          ))}
        {diff?.state === 'ready' && diff.files.length > COLLAPSED_CHANGED_FILE_LIMIT && (
          <button
            type="button"
            aria-expanded={filesExpanded}
            className="self-start text-xs text-primary hover:underline"
            onClick={() => setExpandedSessionId(filesExpanded ? null : task.sessionId)}
          >
            {filesExpanded ? '收起改动列表' : `展开全部（剩余 ${diff.files.length - COLLAPSED_CHANGED_FILE_LIMIT} 个）`}
          </button>
        )}
      </Section>

      <Section title="规范">
        <div data-testid="monitor-rule-packs">{task.info.rulePacks.length > 0 ? task.info.rulePacks.join('、') : '没有选中的规则包'}</div>
        <Row dot="ok" label="完成前规范审查已开" />
      </Section>

      <Section title="安全">
        <Row dot={task.info.security.staticCheck ? 'ok' : 'off'} label="静态检查" value={task.info.security.staticCheck ? '完成前自动检查' : '未开'} />
        <Row dot={task.info.security.lightScan ? 'ok' : 'off'} label="轻量扫描" value={task.info.security.lightScan ? '完成前自动扫描' : '未开'} />
        <LinkButton onClick={() => openSettings('security')}>安全设置</LinkButton>
      </Section>

      {mcp.statuses && mcp.statuses.length > 0 && (
        <Section title="MCP">
          {mcp.statuses.map((server) => (
            <Row
              key={server.name}
              dot={server.state === 'connected' ? 'ok' : 'off'}
              label={server.name}
              value={server.state === 'connected' ? `${server.tools.length} 个工具` : '连接失败'}
              tone={server.state === 'connected' ? undefined : 'bad'}
            />
          ))}
          <div className="flex gap-3">
            {mcp.statuses.some((server) => server.state === 'failed') && <LinkButton onClick={mcp.retry}>重新连接</LinkButton>}
            <LinkButton onClick={() => openSettings('mcp')}>MCP 设置</LinkButton>
          </div>
        </Section>
      )}

      {deepScanEnabled && (
        <Section title="深度扫描">
          <div className="text-xs leading-relaxed text-muted-foreground">只读地跨文件追踪数据流，出一份报告，勾选后交给智能体修复。</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={task.running || task.turns.length === 0} onClick={() => onDeepScan('task')}>
              扫描本任务改动
            </Button>
            <Button size="sm" variant="outline" disabled={task.running} onClick={() => onDeepScan('project')}>
              扫描整个项目
            </Button>
          </div>
        </Section>
      )}

      <Section title="项目保护">
        <Row label="禁止修改的目录" value={project && project.readOnlyPaths.length > 0 ? project.readOnlyPaths.join(', ') : '无'} mono={!!project?.readOnlyPaths.length} />
        <div className="text-foreground/80">.env、私钥等密钥文件不会读进模型</div>
      </Section>

      <Section title="环境">
        <Row label="分支" value={branch ?? '不是 Git 仓库'} />
        <Row label="检查点" value={task.info.checkpoints ? '可撤销' : '不可用（需要 Git）'} tone={task.info.checkpoints ? 'ok' : 'bad'} />
        <Row label="命令执行" value={task.info.bashPath ? 'Git Bash' : '没找到 Git Bash'} tone={task.info.bashPath ? undefined : 'bad'} />
      </Section>

      <ProjectSettingsDialog project={project} open={editing} onClose={() => setEditing(false)} onSaved={onProjectSaved} />
    </aside>
  )
}

// 任务监控里的按钮和输入框的斜杠命令都从这里确认，扫描要花不少调用
export function DeepScanDialog({ sessionId, scope, onClose }: { sessionId: string; scope: 'task' | 'project' | null; onClose(): void }) {
  return (
    <Dialog open={scope !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{scope === 'project' ? '深度扫描整个项目？' : '深度扫描本任务改动？'}</DialogTitle>
          <DialogDescription>
            评审模型会读代码、搜索，跨文件追踪数据流，通常要调用模型十几到几十次、几分钟，用量在「设置 → 用量」里能看到。扫描只读，不改文件、不执行命令。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (scope) void runDeepScan(sessionId, scope)
              onClose()
            }}
          >
            开始扫描
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center">
        <span className="flex-1 text-xs text-muted-foreground">{title}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({ dot, label, value, mono, tone }: { dot?: 'ok' | 'off'; label: string; value?: string; mono?: boolean; tone?: 'ok' | 'bad' }) {
  return (
    <div className="flex items-center gap-2">
      {dot && <span className={cn('size-1.75 shrink-0 rounded-full', dot === 'ok' ? 'bg-success' : 'bg-muted-foreground/40')} />}
      <span className="flex-1">{label}</span>
      {value && (
        <span
          className={cn(
            'max-w-40 truncate',
            mono ? 'font-mono text-xs' : 'text-muted-foreground',
            tone === 'ok' && 'text-success',
            tone === 'bad' && 'text-destructive',
          )}
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  )
}

function LinkButton({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" className="self-start text-xs text-primary hover:underline" onClick={onClick}>
      {children}
    </button>
  )
}
