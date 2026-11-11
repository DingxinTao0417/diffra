import { useMemo, useState } from 'react'
import type { TargetArchitecture } from '@diffra/core/architecture'
import { LoaderCircle, Sparkles } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { saveTarget } from '../architecture-store'
import { useArch } from '../context'
import { applyChanges, type ChangeKind, diffTargets } from './target-model'

const KIND_LABELS: Record<ChangeKind, string> = { added: '新增', removed: '删除', changed: '修改' }
const AREA_LABELS = { layer: '层', block: '方块', rule: '规则' } as const

// 让模型按现状提一份目标架构：先写原则，拿到后和现在的逐条对比，勾选要的再保存
export function ProposalDialog({ onClose }: { onClose(): void }) {
  const { project, target } = useArch()
  const [principles, setPrinciples] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<{ target: TargetArchitecture; rationale: string } | null>(null)
  const changes = useMemo(() => (proposal ? diffTargets(target, proposal.target) : []), [proposal, target])
  const [accepted, setAccepted] = useState<Set<string>>(new Set())

  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.diffra.proposeTargetArchitecture(project.id, principles)
      setProposal(result)
      setAccepted(new Set(diffTargets(target, result.target).map((change) => change.key)))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!proposal) return
    await saveTarget(project.id, applyChanges(target, proposal.target, accepted))
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl" data-testid="architecture-proposal">
        <DialogHeader>
          <DialogTitle>让模型提目标架构</DialogTitle>
          <DialogDescription>模型读一份压缩过的结构摘要（目录、依赖、关键文件的符号），按现状和你的原则给方案。用「规划」角色的模型。</DialogDescription>
        </DialogHeader>
        {!proposal ? (
          <div className="space-y-2">
            <Textarea
              autoFocus
              value={principles}
              onChange={(event) => setPrinciples(event.target.value)}
              placeholder={'可以不写。比如：\n- 界面不直接碰文件系统和网络，都走主进程\n- 模型调用只在 core 里\n- 以后要加插件系统'}
              className="min-h-32"
              aria-label="原则"
            />
            {error && <div className="text-sm text-destructive">{error}</div>}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <p className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{proposal.rationale}</p>
            {changes.length === 0 && <p className="text-sm text-muted-foreground">提案和现在的目标架构一样</p>}
            {(['layer', 'block', 'rule'] as const).map((area) => {
              const items = changes.filter((change) => change.area === area)
              if (items.length === 0) return null
              return (
                <section key={area} className="space-y-1.5">
                  <h3 className="text-sm font-semibold">{AREA_LABELS[area]}</h3>
                  {items.map((change) => (
                    <label key={change.key} className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
                      <Checkbox
                        className="mt-0.5"
                        checked={accepted.has(change.key)}
                        onCheckedChange={(checked) =>
                          setAccepted((current) => {
                            const next = new Set(current)
                            if (checked) next.add(change.key)
                            else next.delete(change.key)
                            return next
                          })
                        }
                      />
                      <span className={cn('shrink-0 rounded px-1 text-xs', change.kind === 'removed' ? 'bg-destructive-soft' : change.kind === 'added' ? 'bg-muted' : 'bg-warning-soft')}>{KIND_LABELS[change.kind]}</span>
                      <span className="min-w-0">
                        <span className="font-medium">{change.title}</span>
                        {change.detail && <span className="block text-xs text-muted-foreground">{change.detail}</span>}
                      </span>
                    </label>
                  ))}
                </section>
              )
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          {!proposal ? (
            <Button disabled={busy} onClick={() => void ask()}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {busy ? '模型在想，大约一两分钟' : '生成方案'}
            </Button>
          ) : (
            <Button disabled={accepted.size === 0} onClick={() => void apply()} data-testid="architecture-proposal-apply">
              采用选中的 {accepted.size} 条
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
