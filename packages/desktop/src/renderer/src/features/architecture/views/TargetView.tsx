import { useMemo, useState } from 'react'
import { diagramBlocks } from '@diffra/core/architecture'
import { ClipboardList, Copy, FilePlus2, LoaderCircle, MessageSquarePlus, PencilLine, Sparkles, Target, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { saveTarget } from '../architecture-store'
import { blockFocus, useArch } from '../context'
import { BlockDiagramView } from '../diagram/BlockDiagram'
import { blockOverlays, findBlockIn, relatedBlocks, updateBlock } from '../diagram/diagram-model'
import { draftTask, todoFromArchitecture } from '../tasks'
import { ProposalDialog } from './ProposalDialog'
import { emptyTarget, targetFromDiagram, violationPrompt } from './target-model'
import { TargetRules } from './TargetRules'

type Section = 'compare' | 'gaps' | 'rules'

// 目标架构：用和应用架构图同一种方块图画出项目该长成的样子，再加依赖规则。现状叠在图上看差距，差距能直接变成重构任务或待办
export function TargetView() {
  const { target, evaluation, index, diagrams, project, draft, setDraft } = useArch()
  const [section, setSection] = useState<Section>('compare')
  const [proposing, setProposing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  if (!target || !evaluation) {
    return (
      <div className="h-full overflow-y-auto" data-testid="architecture-target-start">
        <div className="mx-auto max-w-3xl space-y-5 p-8">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Target className="size-5 text-muted-foreground" />
              目标架构
            </h2>
            <p className="text-sm text-muted-foreground">
              用分层方块图画出这个项目应该长成什么样：分几层、有哪些方块（按路径认领代码）、谁能依赖谁。之后每次分析都会把现状叠在图上，列出违规和差距；任务里改出违反规则的依赖也会被打回。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <StartOption
              icon={<Copy className="size-5" />}
              title="从应用架构图复制"
              description="照搬现在的分层和方块，再在上面改"
              disabled={!diagrams.application}
              onClick={() => diagrams.application && void saveTarget(project.id, targetFromDiagram(diagrams.application))}
            />
            <StartOption icon={<FilePlus2 className="size-5" />} title="从空白开始" description="三层空架子，自己加方块、写路径" onClick={() => void saveTarget(project.id, emptyTarget())} />
            <StartOption icon={<Sparkles className="size-5" />} title="让模型提方案" description="说说你的原则，模型按现状画一张，逐条决定要不要" onClick={() => setProposing(true)} />
          </div>
        </div>
        {proposing && <ProposalDialog onClose={() => setProposing(false)} />}
      </div>
    )
  }
  const editing = draft?.kind === 'target'
  const unassignedDirs = new Set(evaluation.unassigned.map((at) => index.analysis.files[at]!.module)).size
  const save = async () => {
    if (!draft) return
    await saveTarget(project.id, { ...target, updatedAt: new Date().toISOString(), diagram: draft.diagram })
    setDraft(null)
  }
  return (
    <div className="flex h-full flex-col" data-testid="architecture-target">
      <div className="flex items-center gap-3 overflow-hidden border-b px-4 py-2 text-xs whitespace-nowrap [&>*:not(:last-child)]:shrink-0">
        <Segmented<Section>
          label="目标架构视图"
          size="sm"
          value={section}
          options={[
            { value: 'compare', label: '对比' },
            { value: 'gaps', label: `差距（${evaluation.violations.length + evaluation.planned.length + unassignedDirs}）` },
            { value: 'rules', label: `规则（${target.rules.length}）` },
          ]}
          onChange={(value) => {
            if (draft?.dirty) return
            setDraft(null)
            setSection(value)
          }}
        />
        {section === 'compare' &&
          (editing ? (
            <>
              <Button size="xs" disabled={!draft.dirty} onClick={() => void save()} data-testid="target-save">
                保存
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                {draft.dirty ? '放弃改动' : '退出编辑'}
              </Button>
            </>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setDraft({ kind: 'target', diagram: target.diagram, dirty: false })} data-testid="target-edit">
              <PencilLine className="size-3" />
              编辑
            </Button>
          ))}
        <Button size="xs" variant="outline" disabled={editing} onClick={() => setProposing(true)}>
          <Sparkles className="size-3" />
          让模型提方案
        </Button>
        <Button
          size="xs"
          variant={confirmDelete ? 'destructive' : 'ghost'}
          disabled={editing}
          onBlur={() => setConfirmDelete(false)}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true)
              return
            }
            void saveTarget(project.id, null)
          }}
        >
          <Trash2 className="size-3" />
          {confirmDelete ? '再点一次删除' : '删除'}
        </Button>
        <span className="ml-auto min-w-0 truncate text-muted-foreground">
          {diagramBlocks(target.diagram).length} 个方块 · {target.rules.length} 条规则
          {evaluation.violations.length > 0 ? <span className="text-destructive"> · {evaluation.violations.length} 处违规</span> : ' · 没有违规'}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {section === 'compare' && <Compare onGaps={() => setSection('gaps')} />}
        {section === 'gaps' && <GapList />}
        {section === 'rules' && <TargetRules />}
      </div>
      {proposing && <ProposalDialog onClose={() => setProposing(false)} />}
    </div>
  )
}

function StartOption({ icon, title, description, disabled, onClick }: { icon: React.ReactNode; title: string; description: string; disabled?: boolean; onClick(): void }) {
  return (
    <button type="button" disabled={disabled} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent disabled:opacity-50" onClick={onClick}>
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-bold">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  )
}

// 目标架构图上叠现状：方块上是认领到的文件数，违规的方块标红、带违规条数，还没有代码的方块是虚线
function Compare({ onGaps }: { onGaps(): void }) {
  const { target, evaluation, index, draft, setDraft, route, go } = useArch()
  const editing = draft?.kind === 'target'
  const diagram = editing ? draft.diagram : target!.diagram
  const overlays = useMemo(() => {
    const result = blockOverlays(index, diagram)
    for (const violation of evaluation!.violations) {
      const overlay = result.get(violation.from)
      if (overlay) overlay.violations += violation.edges.length
    }
    for (const { block } of diagramBlocks(diagram)) {
      const overlay = result.get(block.id)
      if (overlay && block.kind !== 'external') overlay.planned = overlay.files === 0
    }
    return result
  }, [index, diagram, evaluation])
  const links = useMemo(() => new Map(evaluation!.links.map((link) => [`${link.from}>${link.to}`, link.count])), [evaluation])
  const selected = route.focus?.startsWith('block:target:') ? route.focus.slice(13) : null
  const related = selected && !editing ? relatedBlocks(links, selected) : null
  const unassigned = evaluation!.unassigned.length
  return (
    <div className="h-full overflow-auto p-4" data-testid="target-compare">
      <div className="mb-2 text-xs text-muted-foreground">
        {editing ? '拖动方块换组、换层，双击改名；选中方块后在右边改认领的代码。保存后重新对比' : '方块上的数字是现状里认领到的文件；红框是有依赖违反规则，虚线是计划了还没有代码；选中方块后标出它和别的方块之间实际的依赖'}
      </div>
      <BlockDiagramView
        diagram={diagram}
        overlays={overlays}
        selected={selected}
        related={related}
        onChange={editing ? (next) => setDraft({ kind: 'target', diagram: next, dirty: true }) : undefined}
        onSelect={(id) => go({ focus: id ? blockFocus('target', id) : null }, false)}
        onOpen={(id) => go({ focus: blockFocus('target', id) }, false)}
      />
      {unassigned > 0 && !editing && (
        <button type="button" className="mt-4 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-accent" onClick={onGaps}>
          <Badge variant="outline">{unassigned} 个文件</Badge>
          没被任何方块认领，到差距里归到方块
        </button>
      )}
    </div>
  )
}

// 差距：违规的依赖、还没有代码的方块、没被认领的代码。违规和新方块能生成重构任务或派到待办；没认领的目录直接归到方块
function GapList() {
  const { target, evaluation, analysis, project, peek } = useArch()
  const diagram = target!.diagram
  const blockInfo = (id: string) => {
    const item = findBlockIn(diagram, id)
    return { name: item?.name ?? (id || '未归属的代码'), paths: item?.paths ?? [] }
  }
  const unassigned = useMemo(() => {
    const dirs = new Map<string, number>()
    for (const file of evaluation!.unassigned) {
      const dir = analysis.files[file]!.module
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
    }
    // 只列最上面一层没被认领的目录：子目录跟着父目录走
    const all = [...dirs.keys()]
    const tops = all.filter((dir) => !all.some((other) => other !== dir && (other === '' ? dir !== '' : dir.startsWith(`${other}/`))))
    return tops.map((dir) => ({ dir, files: [...dirs].filter(([other]) => other === dir || dir === '' || other.startsWith(`${dir}/`)).reduce((sum, [, count]) => sum + count, 0) }))
  }, [evaluation, analysis])
  const codeBlocks = diagramBlocks(diagram).filter(({ block }) => block.kind !== 'external')
  const claim = (dir: string, blockId: string) => {
    const block = findBlockIn(diagram, blockId)
    if (!block) return
    void saveTarget(project.id, { ...target!, updatedAt: new Date().toISOString(), diagram: updateBlock(diagram, blockId, { paths: [...block.paths, dir || '**'] }) })
  }
  const plannedPrompt = (id: string) => {
    const item = findBlockIn(diagram, id)!
    const layer = diagram.layers.find((candidate) => candidate.groups.some((group) => group.blocks.some((block) => block.id === id)))?.name
    return `按目标架构新建「${item.name}」${layer ? `（${layer}层）` : ''}：${item.description || '（没写说明）'}\n代码放在：${item.paths.join('、') || '（还没定路径）'}\n遵守目标架构的依赖规则：只依赖同层或下层的方块。先出计划再动手。`
  }
  const files = (at: number) => analysis.files[at]!.path
  const total = evaluation!.violations.length + evaluation!.planned.length + unassigned.length
  return (
    <div className="h-full overflow-y-auto" data-testid="architecture-gaps">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {total === 0 && <p className="text-sm text-muted-foreground">现状和目标架构一致：没有违规，没有没认领的代码，方块都有代码了。</p>}
        {evaluation!.violations.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-bold">违反规则的依赖（{evaluation!.violations.length}）</h3>
            {evaluation!.violations.map((violation) => {
              const prompt = violationPrompt(violation, files, blockInfo)
              return (
                <div key={`${violation.ruleId}:${violation.from}:${violation.to}`} className="space-y-2 rounded-lg border border-destructive/30 p-3" data-testid="architecture-gap">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-sm">{violation.message}</span>
                    <Badge variant="outline">{violation.edges.length} 处</Badge>
                  </div>
                  <div className="space-y-0.5">
                    {violation.edges.slice(0, 5).map((edge) => (
                      <button key={`${edge.from}:${edge.line}:${edge.to}`} type="button" className="block w-full truncate text-left font-mono text-xs text-muted-foreground hover:text-foreground" onClick={() => peek(files(edge.from), edge.line)}>
                        {files(edge.from)}:{edge.line}
                      </button>
                    ))}
                    {violation.edges.length > 5 && <span className="text-xs text-muted-foreground">…还有 {violation.edges.length - 5} 处</span>}
                  </div>
                  <GapActions projectPath={project.path} prompt={prompt} todo={`架构：${violation.message}`} />
                </div>
              )
            })}
          </section>
        )}
        {evaluation!.planned.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-bold">计划了还没有代码的方块（{evaluation!.planned.length}）</h3>
            {evaluation!.planned.map((id) => (
              <div key={id} className="space-y-2 rounded-lg border border-dashed p-3">
                <div className="text-sm">
                  <span className="font-bold">{blockInfo(id).name}</span>
                  <span className="text-muted-foreground"> · {blockInfo(id).paths.join('、') || '还没写路径'}</span>
                </div>
                <GapActions projectPath={project.path} prompt={plannedPrompt(id)} todo={`架构：新建「${blockInfo(id).name}」`} />
              </div>
            ))}
          </section>
        )}
        {unassigned.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-bold">没被任何方块认领的代码（{unassigned.length} 个目录）</h3>
            <p className="text-xs text-muted-foreground">归到一个方块，就把这个目录加进它认领的代码。</p>
            {unassigned.map((item) => (
              <div key={item.dir} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={item.dir}>
                  {item.dir || '（根目录）'} <span className="text-muted-foreground">· {item.files} 个文件</span>
                </span>
                <Select onValueChange={(value) => claim(item.dir, value)}>
                  <SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label={`把 ${item.dir || '根目录'} 归到方块`}>
                    <SelectValue placeholder="归到方块…" />
                  </SelectTrigger>
                  <SelectContent>
                    {codeBlocks.map(({ block }) => (
                      <SelectItem key={block.id} value={block.id}>
                        {block.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

function GapActions({ projectPath, prompt, todo }: { projectPath: string; prompt: string; todo: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="xs" variant="outline" onClick={() => draftTask(projectPath, prompt)}>
        <MessageSquarePlus className="size-3" />
        生成重构任务
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          await todoFromArchitecture(projectPath, todo, prompt).finally(() => setBusy(false))
        }}
      >
        {busy ? <LoaderCircle className="size-3 animate-spin" /> : <ClipboardList className="size-3" />}
        派到待办
      </Button>
    </div>
  )
}
