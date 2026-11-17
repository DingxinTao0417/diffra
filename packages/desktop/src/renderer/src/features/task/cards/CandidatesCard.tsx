import { type FormEvent, useState } from 'react'
import type { CandidateRunView, CandidateSpec } from '@diffra/core/types'
import { Columns2, GitFork, LoaderCircle } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { DiffCounts } from '@/features/session/DiffView'
import { DiffLines } from '@/features/session/DiffLines'
import { errorMessage } from '@/lib/errors'
import { parseUnifiedDiff } from '@/lib/unified-diff'
import { applyCandidate, discardCandidates } from '@/state/actions'
import { useReadOnly } from '../read-only'
import { CardShell } from './CardShell'

// 多候选方案（v2）：每个候选在自己的 git worktree 里做完，这张卡片上看改动、并排比较、选一个应用回项目或全部放弃。
// 候选各自的过程在上面的「候选方案 X」卡片里（和子智能体一样）

const RUN_LABELS: Record<CandidateRunView['status'], string> = {
  running: '生成中',
  ready: '等你选',
  applied: '已应用',
  discarded: '已放弃',
  cancelled: '已停止',
  failed: '没有能用的',
}

// 候选的改动：按需取（diff 可能很大），取一次留着
function useCandidateDiff(sessionId: string, runTurnId: string) {
  const [diffs, setDiffs] = useState<Record<string, { state: 'loading' } | { state: 'ready'; text: string } | { state: 'error'; message: string }>>({})
  const load = (candidateId: string) => {
    if (diffs[candidateId]) return
    setDiffs((current) => ({ ...current, [candidateId]: { state: 'loading' } }))
    window.diffra
      .candidateDiff(sessionId, runTurnId, candidateId)
      .then((text) => setDiffs((current) => ({ ...current, [candidateId]: { state: 'ready', text } })))
      .catch((error: unknown) => setDiffs((current) => ({ ...current, [candidateId]: { state: 'error', message: errorMessage(error) } })))
  }
  return { diffs, load }
}

function CandidateDiff({ diff }: { diff: ReturnType<typeof useCandidateDiff>['diffs'][string] | undefined }) {
  if (!diff || diff.state === 'loading')
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        正在读取改动…
      </p>
    )
  if (diff.state === 'error') return <p className="text-xs text-destructive">{diff.message}</p>
  const files = parseUnifiedDiff(diff.text)
  if (files.length === 0) return <p className="text-xs text-muted-foreground">没有改动</p>
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="candidate-diff">
      {files.map((file) => (
        <div key={file.path} className="min-w-0 overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
              {file.path}
            </span>
            {file.binary ? <span className="text-muted-foreground">二进制文件</span> : <DiffCounts added={file.added} removed={file.removed} />}
          </div>
          {!file.binary && <DiffLines hunks={file.hunks} className="max-h-72 overflow-y-auto" />}
        </div>
      ))}
    </div>
  )
}

export function CandidatesCard({ run, sessionId, running }: { run: CandidateRunView; sessionId: string; running: boolean }) {
  const readOnly = useReadOnly()
  const { diffs, load } = useCandidateDiff(sessionId, run.turnId)
  const [open, setOpen] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const done = run.candidates.filter((candidate) => candidate.status === 'done' && (candidate.stats?.files ?? 0) > 0)
  // 卡片第一次出现时候选还在跑，没有做完的：选过的不在做完的里面时退回前两个做完的
  const [picked, setPair] = useState<[string, string] | null>(null)
  const valid = (id: string | undefined) => (id && done.some((candidate) => candidate.id === id) ? id : null)
  const pair: [string, string] = [valid(picked?.[0]) ?? done[0]?.id ?? '', valid(picked?.[1]) ?? done[1]?.id ?? '']
  const ready = run.status === 'ready' && !readOnly
  const toggle = (id: string) => {
    if (open === id) return setOpen(null)
    setOpen(id)
    load(id)
  }
  const compare = () => {
    setComparing(!comparing)
    for (const id of pair) if (id) load(id)
  }
  return (
    <CardShell
      data-testid="candidates-card"
      data-status={run.status}
      icon={<GitFork className="size-4 shrink-0 text-muted-foreground" />}
      title="候选方案"
      subtitle={RUN_LABELS[run.status]}
    >
      <ul className="flex flex-col divide-y rounded-lg border" aria-label="候选方案">
        {run.candidates.map((candidate) => (
          <li key={candidate.id} className="flex flex-col gap-1.5 px-3 py-2.5" data-testid="candidate" data-status={candidate.status}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-bold">{candidate.name}</span>
              {run.appliedId === candidate.id && <Badge variant="secondary">已应用</Badge>}
              {candidate.status === 'running' && (
                <Badge variant="outline">
                  <LoaderCircle className="animate-spin" />
                  进行中
                </Badge>
              )}
              {candidate.status === 'failed' && <Badge variant="destructive">没做完</Badge>}
              {candidate.status === 'cancelled' && <Badge variant="outline">已停止</Badge>}
              {candidate.stats && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {candidate.stats.files} 个文件
                  <DiffCounts added={candidate.stats.added} removed={candidate.stats.removed} />
                </span>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                {ready && candidate.status === 'done' && (candidate.stats?.files ?? 0) > 0 && (
                  <>
                    <Button variant="ghost" size="sm" aria-expanded={open === candidate.id} onClick={() => toggle(candidate.id)}>
                      {open === candidate.id ? '收起改动' : '看改动'}
                    </Button>
                    <Button size="sm" disabled={running} onClick={() => void applyCandidate(sessionId, run.turnId, candidate)}>
                      应用这个
                    </Button>
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{candidate.approach}</p>
            {candidate.error && <p className="text-xs break-words text-destructive">{candidate.error}</p>}
            {candidate.summary && <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap">{candidate.summary}</p>}
            {open === candidate.id && <CandidateDiff diff={diffs[candidate.id]} />}
          </li>
        ))}
      </ul>
      {run.conflicts && run.conflicts.length > 0 && (
        <p className="text-sm text-destructive" data-testid="candidate-conflicts">
          上次应用没合上，项目里这些文件在生成之后又改过：{run.conflicts.join('、')}
        </p>
      )}
      {ready && (
        <div className="flex flex-wrap items-center gap-2">
          {done.length >= 2 && (
            <Button variant="outline" size="sm" aria-pressed={comparing} onClick={compare}>
              <Columns2 className="size-3.5" />
              {comparing ? '收起比较' : '并排比较'}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={running} onClick={() => void discardCandidates(sessionId, run.turnId)}>
            全部放弃
          </Button>
          <span className="text-xs text-muted-foreground">应用前会检查项目有没有又改过同一处；应用后能撤销，没选的候选会清掉。</span>
        </div>
      )}
      {ready && comparing && (
        // 窄的时候上下排
        <div className="grid min-w-0 gap-3 @min-[720px]:grid-cols-2" data-testid="candidate-compare">
          {pair.map((id, side) => (
            <div key={side} className="flex min-w-0 flex-col gap-2">
              <Segmented
                label={side === 0 ? '左边的候选' : '右边的候选'}
                value={id}
                options={done.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
                onChange={(next) => {
                  const updated: [string, string] = side === 0 ? [next, pair[1]] : [pair[0], next]
                  setPair(updated)
                  load(next)
                }}
              />
              <CandidateDiff diff={diffs[id]} />
            </div>
          ))}
        </div>
      )}
    </CardShell>
  )
}

const DEFAULT_SPECS: CandidateSpec[] = [
  { name: '方案 A', approach: '按计划直接实现' },
  { name: '方案 B', approach: '用尽量少的改动实现，只改必要的地方' },
  { name: '方案 C', approach: '先保证可读性和可测试，必要时补上测试' },
]

// 生成候选方案前填几个、每个叫什么、什么思路
export function CandidatesDialog({ open, onCancel, onSubmit }: { open: boolean; onCancel(): void; onSubmit(specs: CandidateSpec[]): void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>生成候选方案</DialogTitle>
          <DialogDescription>每个候选在项目的一份独立副本（git worktree）里按自己的思路做，项目本身不动；做完后比较，选一个应用回项目。每个候选都会调用模型，花的 token 是单做一次的几倍。</DialogDescription>
        </DialogHeader>
        {open && <CandidatesForm onCancel={onCancel} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  )
}

function CandidatesForm({ onCancel, onSubmit }: { onCancel(): void; onSubmit(specs: CandidateSpec[]): void }) {
  const [count, setCount] = useState(2)
  const [specs, setSpecs] = useState(DEFAULT_SPECS)
  const chosen = specs.slice(0, count)
  const valid = chosen.every((spec) => spec.name.trim() && spec.approach.trim()) && new Set(chosen.map((spec) => spec.name.trim())).size === chosen.length
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid) onSubmit(chosen.map((spec) => ({ name: spec.name.trim(), approach: spec.approach.trim() })))
  }
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-4" aria-label="候选方案设置">
      <DialogBody className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-sm">几个候选</span>
          <Segmented label="几个候选" value={String(count)} options={[{ value: '2', label: '2 个' }, { value: '3', label: '3 个' }]} onChange={(value) => setCount(Number(value))} />
        </div>
        {chosen.map((spec, index) => (
          <div key={index} className={cn('space-y-1.5 rounded-lg border p-3')}>
            <Label htmlFor={`candidate-name-${index}`}>第 {index + 1} 个</Label>
            <Input
              id={`candidate-name-${index}`}
              aria-label={`第 ${index + 1} 个候选的名字`}
              maxLength={40}
              value={spec.name}
              onChange={(event) => setSpecs((current) => current.map((item, position) => (position === index ? { ...item, name: event.target.value } : item)))}
            />
            <Textarea
              aria-label={`第 ${index + 1} 个候选的思路`}
              className="min-h-14"
              maxLength={2000}
              value={spec.approach}
              onChange={(event) => setSpecs((current) => current.map((item, position) => (position === index ? { ...item, approach: event.target.value } : item)))}
            />
          </div>
        ))}
        {!valid && <p className="text-xs text-destructive">每个候选都要有名字和思路，名字不能重复。</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={!valid}>
          开始生成
        </Button>
      </DialogFooter>
    </form>
  )
}
