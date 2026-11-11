import { useMemo, useState } from 'react'
import { type BlockKind, diagramBlocks } from '@diffra/core/architecture'
import { ArrowRight, CircleAlert, CornerRightDown, FileCode2, LoaderCircle, MessageSquarePlus, PanelRightClose, Sparkles, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { showToast } from '@/state/store'
import { interpretModule } from './architecture-store'
import { blockFocus, diagramOf, useArch } from './context'
import { blockLinks, blockPlace, findBlockIn, updateBlock } from './diagram/diagram-model'
import { formatCount } from './graph'
import { edgesBetween, filesOf, neighbourDirs, parseSelection } from './selection'
import { draftTask } from './tasks'

const MAX_LIST = 8
const MAX_EDGE_ROWS = 200

// 右边的检查器：选中的目录、文件、依赖线、外部包是什么，和谁有关系，能做什么。
// scope 为 true 时没选中东西，看的是依赖图当前所在的范围本身
export function Inspector({ focus, scope = false, onCollapse }: { focus: string; scope?: boolean; onCollapse(): void }) {
  const { go } = useArch()
  const selection = parseSelection(focus)
  return (
    <div className="flex h-full flex-col" data-testid="architecture-inspector">
      <div className="flex items-center gap-1 px-2 pt-2">
        <span className="flex-1 px-2 text-xs text-muted-foreground">{scope ? '当前范围' : ''}</span>
        {!scope && (
          <Button variant="ghost" size="icon" className="size-7" aria-label="取消选中" title="取消选中" onClick={() => go({ focus: null }, false)}>
            <X className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-7" aria-label="收起右侧栏" title="收起右侧栏" onClick={onCollapse}>
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 text-sm">
        {selection?.kind === 'edge' && <EdgeDetails from={selection.from} to={selection.to} />}
        {selection?.kind === 'external' && <ExternalDetails name={selection.name} ecosystem={selection.ecosystem} />}
        {selection?.kind === 'system' && <SystemDetails name={selection.name} />}
        {selection?.kind === 'block' && <BlockDetails diagram={selection.diagram} id={selection.id} />}
        {selection && (selection.kind === 'dir' || selection.kind === 'package' || selection.kind === 'file' || selection.kind === 'project' || selection.kind === 'glob') && <NodeDetails id={focus} />}
        {!selection && <div className="text-muted-foreground">选中的东西已经不在这次分析里了</div>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function NodeDetails({ id }: { id: string }) {
  const context = useArch()
  const { index, analysis, interpretation, evaluation, target, project, go, peek, route, diagrams } = context
  const selection = parseSelection(id)!
  const path = selection.kind === 'dir' || selection.kind === 'file' ? selection.path : selection.kind === 'package' ? selection.dir : ''
  const files = useMemo(() => filesOf(index, id, context), [index, id, context])
  const fileSet = useMemo(() => new Set(files), [files])
  const file = selection.kind === 'file' ? index.file(path) : null
  const pkg = selection.kind === 'package' ? index.packageByDir.get(path) : null
  // 应用架构图里认领这个路径的方块
  const owner = useMemo(() => (diagrams.application ? (diagramBlocks(diagrams.application).find(({ block }) => block.paths.includes(path))?.block ?? null) : null), [diagrams, path])
  const note = interpretation?.notes[path]
  const [explaining, setExplaining] = useState(false)

  const stats = useMemo(() => {
    let lines = 0
    let churn = 0
    for (const at of files) {
      lines += analysis.files[at]!.lines
      churn += analysis.files[at]!.churn
    }
    return { lines, churn }
  }, [files, analysis])
  const outgoing = useMemo(() => neighbourDirs(index, files, 'out'), [index, files])
  const incoming = useMemo(() => neighbourDirs(index, files, 'in'), [index, files])
  const externals = useMemo(
    () =>
      analysis.externals
        .map((external) => ({ external, count: external.uses.filter((use) => fileSet.has(use.file)).length }))
        .filter((item) => item.count > 0 && !item.external.builtin)
        .sort((a, b) => b.count - a.count),
    [analysis, fileSet],
  )
  const commits = useMemo(() => {
    const picked = new Set<number>()
    for (const at of files) for (const commit of analysis.files[at]!.commits) picked.add(commit)
    return [...picked].sort((a, b) => a - b).slice(0, 6).map((at) => analysis.commits[at]!)
  }, [files, analysis])
  const violations = useMemo(() => (evaluation?.violations ?? []).filter((violation) => violation.edges.some((edge) => fileSet.has(edge.from) || fileSet.has(edge.to))), [evaluation, fileSet])
  const cycles = useMemo(() => index.fileCycles.filter((cycle) => cycle.some((at) => fileSet.has(at))), [index, fileSet])
  const component = file && evaluation ? evaluation.componentOfFile[index.fileIndex.get(file.path)!] : null

  const explain = async () => {
    setExplaining(true)
    try {
      await interpretModule(project.id, path)
    } catch (error) {
      showToast(`解读失败：${errorMessage(error)}`)
    } finally {
      setExplaining(false)
    }
  }

  const title = selection.kind === 'project' ? project.name : (pkg?.name ?? path.split('/').pop() ?? path)
  return (
    <>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {file && <FileCode2 className="size-4 shrink-0 text-muted-foreground" />}
          <h2 className="min-w-0 truncate text-base font-semibold" title={path}>
            {title}
          </h2>
          {pkg && <Badge variant="secondary">{pkg.ecosystem === 'none' ? '根目录' : pkg.ecosystem}</Badge>}
          {file?.entry && <Badge variant="outline">入口</Badge>}
        </div>
        {path && <div className="font-mono text-xs break-all text-muted-foreground">{path}</div>}
        {owner && (
          <button type="button" className="block text-left text-xs font-medium hover:underline" onClick={() => go({ tab: 'diagram', diagram: 'application', focus: blockFocus('application', owner.id) })}>
            应用架构图里的「{owner.name}」
          </button>
        )}
        {owner?.description && <p className="text-xs text-muted-foreground">{owner.description}</p>}
        {pkg?.description && <p className="text-xs text-muted-foreground">{pkg.description}</p>}
        {component && target && <div className="text-xs text-muted-foreground">目标架构里属于「{findBlockIn(target.diagram, component)?.name ?? component}」</div>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {selection.kind !== 'file' && (
          <Button size="xs" variant="outline" onClick={() => go({ tab: 'dependencies', section: 'graph', scope: selection.kind === 'project' ? 'project' : `dir:${index.collapse(path)}`, focus: null })}>
            <CornerRightDown className="size-3" />
            进入
          </Button>
        )}
        {file && (
          <>
            <Button size="xs" variant="outline" onClick={() => go({ tab: 'dependencies', section: 'graph', scope: `file:${file.path}`, focus: null })}>
              <CornerRightDown className="size-3" />
              看符号
            </Button>
            <Button size="xs" variant="outline" onClick={() => peek(file.path, 1)}>
              <FileCode2 className="size-3" />
              看代码
            </Button>
          </>
        )}
        <Button size="xs" variant="outline" onClick={() => draftTask(project.path, `关于 ${path || '整个项目'}：\n`)}>
          <MessageSquarePlus className="size-3" />
          在这里开任务
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg border p-2 text-center">
        <Metric label="文件" value={formatCount(files.length)} />
        <Metric label="代码行" value={formatCount(stats.lines)} />
        <Metric label={`近 ${analysis.churnDays} 天改动`} value={formatCount(stats.churn)} />
      </div>

      <Section title="模型解读">
        {note ? (
          <div className="space-y-2 text-xs">
            <p className="whitespace-pre-wrap">{note.summary}</p>
            {note.responsibilities.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4">
                {note.responsibilities.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {note.keyFiles.length > 0 && (
              <div className="space-y-0.5">
                {note.keyFiles.map((item) => (
                  <button key={item.path} type="button" className="block w-full truncate text-left hover:underline" onClick={() => go({ focus: `file:${item.path}` }, false)}>
                    <span className="font-mono">{item.path.split('/').pop()}</span>
                    <span className="text-muted-foreground"> — {item.role}</span>
                  </button>
                ))}
              </div>
            )}
            {note.risks.length > 0 && (
              <div className="space-y-0.5 text-warning">
                {note.risks.map((risk) => (
                  <div key={risk} className="flex gap-1">
                    <CircleAlert className="mt-0.5 size-3 shrink-0" />
                    {risk}
                  </div>
                ))}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              {note.model.modelId} · {formatTime(note.generatedAt)}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">让模型读这里的代码，说清楚它负责什么、关键文件和结构上的风险。</p>
        )}
        <Button size="xs" variant="outline" disabled={explaining} onClick={() => void explain()} data-testid="architecture-explain">
          {explaining ? <LoaderCircle className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          {explaining ? '解读中…' : note ? '重新解读' : '解读这里'}
        </Button>
      </Section>

      {file && file.symbols.length > 0 && (
        <Section title={`符号（${file.symbols.length}）`}>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {file.symbols.map((symbol) => (
              <button key={`${symbol.parent}.${symbol.name}.${symbol.line}`} type="button" className="flex w-full items-center gap-2 rounded px-1 text-left text-xs hover:bg-accent" onClick={() => peek(file.path, symbol.line)}>
                <span className="w-12 shrink-0 text-muted-foreground">{symbol.kind}</span>
                <span className={symbol.exported ? 'min-w-0 truncate font-mono' : 'min-w-0 truncate font-mono text-muted-foreground'}>
                  {symbol.parent ? `${symbol.parent}.` : ''}
                  {symbol.name}
                </span>
                <span className="ml-auto text-muted-foreground tabular-nums">{symbol.line}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <DirList title="依赖" items={outgoing} onPick={(dir) => go({ focus: `edge:${id}>dir:${dir}` }, false)} empty="不依赖范围外的代码" />
      <DirList title="被谁依赖" items={incoming} onPick={(dir) => go({ focus: `edge:dir:${dir}>${id}` }, false)} empty="没有别的代码依赖它" />

      {externals.length > 0 && (
        <Section title="用到的外部包">
          <div className="flex flex-wrap gap-1">
            {externals.slice(0, 20).map(({ external, count }) => (
              <button key={`${external.ecosystem}:${external.name}`} type="button" onClick={() => go({ focus: `external:${external.ecosystem}:${external.name}` }, false)}>
                <Badge variant="outline" className="font-mono hover:bg-accent">
                  {external.name} · {count}
                </Badge>
              </button>
            ))}
          </div>
        </Section>
      )}

      {cycles.length > 0 && (
        <Section title="循环依赖">
          {cycles.slice(0, 4).map((cycle, at) => (
            <div key={at} className="rounded-md border border-warning/40 bg-warning-soft p-2 text-xs">
              {cycle.slice(0, 6).map((file) => analysis.files[file]!.path.split('/').pop()).join(' → ')}
              {cycle.length > 6 ? ` …共 ${cycle.length} 个文件` : ' → …'}
            </div>
          ))}
        </Section>
      )}

      {violations.length > 0 && (
        <Section title="违反目标架构">
          {violations.slice(0, 6).map((violation) => (
            <button key={`${violation.ruleId}:${violation.from}:${violation.to}`} type="button" className="block w-full rounded-md border border-destructive/40 p-2 text-left text-xs hover:bg-accent" onClick={() => go({ tab: 'target', focus: null })}>
              {violation.message}
              <span className="text-muted-foreground"> · {violation.edges.length} 处</span>
            </button>
          ))}
        </Section>
      )}

      {commits.length > 0 && (
        <Section title="最近的提交">
          <div className="space-y-1">
            {commits.map((commit) => (
              <div key={commit.hash} className="text-xs">
                <span className="font-mono text-muted-foreground">{commit.hash.slice(0, 7)}</span> {commit.subject}
                <span className="text-muted-foreground"> · {formatTime(commit.date)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {route.tab === 'dependencies' && selection.kind === 'file' && <div className="text-[11px] text-muted-foreground">双击节点看文件里的符号</div>}
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

function DirList({ title, items, onPick, empty }: { title: string; items: Array<{ dir: string; count: number }>; onPick(dir: string): void; empty: string }) {
  const [all, setAll] = useState(false)
  return (
    <Section title={`${title}（${items.length} 个目录）`}>
      {items.length === 0 && <div className="text-xs text-muted-foreground">{empty}</div>}
      {(all ? items : items.slice(0, MAX_LIST)).map((item) => (
        <button key={item.dir} type="button" className="flex w-full items-center gap-2 rounded px-1 text-left text-xs hover:bg-accent" onClick={() => onPick(item.dir)}>
          <span className="min-w-0 flex-1 truncate font-mono" title={item.dir}>
            {item.dir || '（根目录）'}
          </span>
          <span className="text-muted-foreground tabular-nums">{item.count}</span>
        </button>
      ))}
      {!all && items.length > MAX_LIST && (
        <Button variant="ghost" size="xs" onClick={() => setAll(true)}>
          还有 {items.length - MAX_LIST} 个
        </Button>
      )}
    </Section>
  )
}

// 一条依赖线背后的每条 import，点了看代码
function EdgeDetails({ from, to }: { from: string; to: string }) {
  const context = useArch()
  const { index, analysis, go, peek } = context
  const edges = useMemo(() => edgesBetween(index, filesOf(index, from, context), filesOf(index, to, context)), [index, from, to, context])
  const label = (id: string) => {
    const selection = parseSelection(id)
    if (!selection) return id
    if (selection.kind === 'package') return index.packageByDir.get(selection.dir)?.name ?? selection.dir
    if (selection.kind === 'dir' || selection.kind === 'file') return selection.path || '（根目录）'
    if (selection.kind === 'block') {
      const diagram = diagramOf(context, selection.diagram)
      return (diagram && findBlockIn(diagram, selection.id)?.name) ?? id
    }
    if (selection.kind === 'glob') return selection.pattern
    return id
  }
  const imports = edges.reduce((sum, edge) => sum + analysis.edges[edge]!.imports.length, 0)
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">依赖</h2>
        <div className="flex flex-wrap items-center gap-1 font-mono text-xs">
          <button type="button" className="hover:underline" onClick={() => go({ focus: from }, false)}>
            {label(from)}
          </button>
          <ArrowRight className="size-3 text-muted-foreground" />
          <button type="button" className="hover:underline" onClick={() => go({ focus: to }, false)}>
            {label(to)}
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          {edges.length} 对文件，{imports} 条 import
        </div>
      </div>
      <div className="space-y-2" data-testid="architecture-edge-imports">
        {edges.slice(0, MAX_EDGE_ROWS).map((edgeIndex) => {
          const edge = analysis.edges[edgeIndex]!
          const source = analysis.files[edge.from]!
          return (
            <div key={edgeIndex} className="space-y-0.5 rounded-md border p-2 text-xs">
              <div className="truncate font-mono" title={`${source.path} → ${analysis.files[edge.to]!.path}`}>
                {source.path.split('/').pop()} <span className="text-muted-foreground">→</span> {analysis.files[edge.to]!.path.split('/').pop()}
              </div>
              {edge.imports.map((item) => (
                <button key={`${item.line}:${item.specifier}`} type="button" className="flex w-full gap-2 rounded px-1 text-left font-mono hover:bg-accent" onClick={() => peek(source.path, item.line)}>
                  <span className="w-8 shrink-0 text-right text-muted-foreground">{item.line}</span>
                  <span className="min-w-0 truncate">
                    {item.kind === 'type' ? 'type ' : ''}
                    {item.names.length > 0 ? `{ ${item.names.join(', ')} } ` : ''}
                    <span className="text-muted-foreground">{item.specifier}</span>
                  </span>
                </button>
              ))}
            </div>
          )
        })}
        {edges.length > MAX_EDGE_ROWS && <div className="text-xs text-muted-foreground">只列前 {MAX_EDGE_ROWS} 对</div>}
      </div>
    </>
  )
}

function ExternalDetails({ name, ecosystem }: { name: string; ecosystem: string }) {
  const { analysis, interpretation, peek } = useArch()
  const external = analysis.externals.find((item) => item.name === name && item.ecosystem === ecosystem)
  const system = interpretation?.externalSystems.find((item) => item.packages.includes(name))
  if (!external) return <div className="text-muted-foreground">这次分析里没有 {name}</div>
  return (
    <>
      <div className="space-y-1">
        <h2 className="font-mono text-base font-semibold break-all">{name}</h2>
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary">{ecosystem}</Badge>
          {external.builtin && <Badge variant="outline">语言自带</Badge>}
          {!external.builtin && <Badge variant="outline">{external.declared ? '清单里声明了' : '清单里没声明'}</Badge>}
        </div>
        {system && <p className="text-xs text-muted-foreground">用来和「{system.name}」打交道：{system.description}</p>}
      </div>
      <Section title={`使用的地方（${external.count}）`}>
        {external.uses.map((use) => (
          <button key={`${use.file}:${use.line}`} type="button" className="flex w-full gap-2 rounded px-1 text-left font-mono text-xs hover:bg-accent" onClick={() => peek(analysis.files[use.file]!.path, use.line)}>
            <span className="min-w-0 flex-1 truncate">{analysis.files[use.file]!.path}</span>
            <span className="text-muted-foreground">{use.line}</span>
          </button>
        ))}
        {external.count > external.uses.length && <div className="text-xs text-muted-foreground">只记了前 {external.uses.length} 处</div>}
      </Section>
    </>
  )
}

function SystemDetails({ name }: { name: string }) {
  const { interpretation, peek } = useArch()
  const system = interpretation?.externalSystems.find((item) => item.name === name)
  if (!system) return <div className="text-muted-foreground">解读里没有「{name}」</div>
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{system.name}</h2>
        <Badge variant="secondary">{system.kind}</Badge>
        <p className="text-xs text-muted-foreground">{system.description}</p>
      </div>
      {system.packages.length > 0 && (
        <Section title="用到的外部包">
          <div className="flex flex-wrap gap-1">
            {system.packages.map((item) => (
              <Badge key={item} variant="outline" className="font-mono">
                {item}
              </Badge>
            ))}
          </div>
        </Section>
      )}
      {system.anchors.length > 0 && (
        <Section title="代码位置">
          {system.anchors.map((anchor) => (
            <button key={`${anchor.path}:${anchor.line}`} type="button" className="flex w-full gap-2 rounded px-1 text-left font-mono text-xs hover:bg-accent" onClick={() => peek(anchor.path, anchor.line)}>
              <span className="min-w-0 flex-1 truncate">{anchor.symbol ?? anchor.path}</span>
              <span className="text-muted-foreground">
                {anchor.path.split('/').pop()}:{anchor.line}
              </span>
            </button>
          ))}
        </Section>
      )}
    </>
  )
}

const BLOCK_KINDS: Array<{ value: BlockKind; label: string }> = [
  { value: 'code', label: '项目代码' },
  { value: 'tech', label: '技术或外部包' },
  { value: 'external', label: '项目外的系统' },
  { value: 'store', label: '数据存储' },
]
const DIAGRAM_LABELS = { application: '应用架构图', technology: '技术架构图', system: '系统架构图', target: '目标架构' } as const

// 架构图里的一个方块：说明、认领的代码、和别的方块的依赖；编辑模式下在这里改说明、类型、路径和外部包
function BlockDetails({ diagram: kind, id }: { diagram: keyof typeof DIAGRAM_LABELS; id: string }) {
  const context = useArch()
  const { index, analysis, project, evaluation, draft, setDraft, go, peek } = context
  const diagram = diagramOf(context, kind)
  const block = diagram ? findBlockIn(diagram, id) : null
  const editing = draft?.kind === kind
  // 和图上方块的数字一致：几个方块都认领时文件只算给最具体的那个
  const files = useMemo(() => (diagram && block ? index.owners(diagram).flatMap((owner, at) => (owner === block.id ? [at] : [])) : []), [index, diagram, block])
  const links = useMemo(() => (diagram && kind !== 'technology' ? blockLinks(index, diagram) : new Map<string, number>()), [index, diagram, kind])
  if (!diagram || !block) return <div className="text-muted-foreground">这个方块已经不在图里了</div>
  const place = blockPlace(diagram, id)
  const name = (other: string) => findBlockIn(diagram, other)?.name ?? other
  const uses = [...links].flatMap(([key, count]) => (key.startsWith(`${id}>`) ? [{ id: key.slice(id.length + 1), count }] : [])).sort((a, b) => b.count - a.count)
  const usedBy = [...links].flatMap(([key, count]) => (key.endsWith(`>${id}`) ? [{ id: key.slice(0, key.length - id.length - 1), count }] : [])).sort((a, b) => b.count - a.count)
  const lines = files.reduce((sum, at) => sum + analysis.files[at]!.lines, 0)
  // 技术方块、外部系统列的外部包在代码里用到的地方
  const packageUses = block.packages.flatMap((item) => {
    const external = analysis.externals.find((candidate) => candidate.name === item)
    return external ? [{ name: item, uses: external.uses, count: external.count }] : []
  })
  const violations = kind === 'target' ? (evaluation?.violations ?? []).filter((item) => item.from === id || item.to === id) : []
  const edit = (change: Parameters<typeof updateBlock>[2]) => {
    if (draft) setDraft({ ...draft, diagram: updateBlock(draft.diagram, id, change), dirty: true })
  }
  const lineList = (text: string) => text.split('\n').map((item) => item.trim()).filter(Boolean)
  // 依赖图只认三张架构图里的方块；目标架构的方块按路径找文件
  const graphKind = kind === 'target' ? null : kind

  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{block.name}</h2>
        <div className="text-xs text-muted-foreground">
          {DIAGRAM_LABELS[kind]} · {place.layer ? `「${place.layer.name}」层${place.group?.name ? ` · ${place.group.name}` : ''}` : place.side ? `右侧「${place.side.name}」` : ''}
          {block.pinned && ' · 手改过'}
        </div>
        {block.unverified && <div className="text-xs text-warning">模型给的代码路径或外部包和分析结果对不上，可能是编的；在编辑里改成真实的路径</div>}
      </div>

      {editing ? (
        <div className="space-y-3 text-xs" data-testid="block-editor">
          <label className="block space-y-1">
            <span className="text-muted-foreground">名字</span>
            <Input className="h-8" value={block.name} onChange={(event) => edit({ name: event.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground">类型</span>
            <select className="h-8 w-full rounded-md border bg-background px-2" value={block.kind} onChange={(event) => edit({ kind: event.target.value as BlockKind })}>
              {BLOCK_KINDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground">说明</span>
            <Textarea className="min-h-16 text-xs" value={block.description} onChange={(event) => edit({ description: event.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground">认领的代码（一行一个：目录、文件或通配符）· 现在 {files.length} 个文件</span>
            <Textarea className="min-h-20 font-mono text-xs" value={block.paths.join('\n')} placeholder="packages/core/src/session" aria-label="认领的代码" onChange={(event) => edit({ paths: lineList(event.target.value) })} />
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground">外部包（一行一个）</span>
            <Textarea className="min-h-12 font-mono text-xs" value={block.packages.join('\n')} aria-label="外部包" onChange={(event) => edit({ packages: lineList(event.target.value) })} />
          </label>
        </div>
      ) : (
        <>
          {block.description && <p className="text-xs">{block.description}</p>}
          <div className="flex flex-wrap gap-1.5">
            {block.paths.length > 0 && graphKind && (
              <Button size="xs" variant="outline" onClick={() => go({ tab: 'dependencies', section: 'graph', scope: `block:${graphKind}:${id}`, focus: null })}>
                <CornerRightDown className="size-3" />
                进入依赖图
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => draftTask(project.path, `关于「${block.name}」（${block.paths.join('、') || block.packages.join('、') || '架构图里的方块'}）：\n`)}>
              <MessageSquarePlus className="size-3" />
              在这里开任务
            </Button>
          </div>
          {block.paths.length > 0 && (
            <div className="grid grid-cols-2 gap-2 rounded-lg border p-2 text-center">
              <Metric label="文件" value={formatCount(files.length)} />
              <Metric label="代码行" value={formatCount(lines)} />
            </div>
          )}
          {block.paths.length > 0 && (
            <Section title="认领的代码">
              {block.paths.map((path) => {
                const file = index.file(path)
                const dir = index.module(path)
                return (
                  <button
                    key={path}
                    type="button"
                    disabled={!file && !dir}
                    className="block w-full truncate rounded px-1 text-left font-mono text-xs hover:bg-accent disabled:hover:bg-transparent"
                    onClick={() => (file ? peek(path, 1) : go({ tab: 'dependencies', section: 'graph', scope: `dir:${index.collapse(path)}`, focus: null }))}
                  >
                    {path}
                  </button>
                )
              })}
            </Section>
          )}
          {block.packages.length > 0 && (
            <Section title="外部包">
              <div className="flex flex-wrap gap-1">
                {block.packages.map((item) => {
                  const external = analysis.externals.find((candidate) => candidate.name === item)
                  return (
                    <button key={item} type="button" disabled={!external} onClick={() => external && go({ focus: `external:${external.ecosystem}:${external.name}` }, false)}>
                      <Badge variant="outline" className="font-mono hover:bg-accent">
                        {item}
                        {external ? ` · ${external.count}` : ''}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            </Section>
          )}
          {packageUses.length > 0 && (
            <Section title={`用到的地方（${packageUses.reduce((sum, item) => sum + item.count, 0)}）`}>
              {packageUses.map(({ name: packageName, uses: places, count }) => (
                <div key={packageName} className="space-y-0.5">
                  {packageUses.length > 1 && <div className="font-mono text-[11px] text-muted-foreground">{packageName} · {count}</div>}
                  {places.map((use) => (
                    <button key={`${use.file}:${use.line}`} type="button" className="flex w-full gap-2 rounded px-1 text-left font-mono text-xs hover:bg-accent" onClick={() => peek(analysis.files[use.file]!.path, use.line)}>
                      <span className="min-w-0 flex-1 truncate">{analysis.files[use.file]!.path}</span>
                      <span className="text-muted-foreground">{use.line}</span>
                    </button>
                  ))}
                  {count > places.length && <div className="text-[11px] text-muted-foreground">只记了前 {places.length} 处</div>}
                </div>
              ))}
            </Section>
          )}
          {uses.length + usedBy.length > 0 && (
            <>
              <Section title={`依赖的方块（${uses.length}）`}>
                {uses.map((item) => (
                  <button key={item.id} type="button" className="flex w-full justify-between rounded px-1 text-left text-xs hover:bg-accent" onClick={() => go({ focus: `edge:block:${kind}:${id}>block:${kind}:${item.id}` }, false)}>
                    <span>{name(item.id)}</span>
                    <span className="text-muted-foreground tabular-nums">{item.count}</span>
                  </button>
                ))}
              </Section>
              <Section title={`被哪些方块依赖（${usedBy.length}）`}>
                {usedBy.map((item) => (
                  <button key={item.id} type="button" className="flex w-full justify-between rounded px-1 text-left text-xs hover:bg-accent" onClick={() => go({ focus: `edge:block:${kind}:${item.id}>block:${kind}:${id}` }, false)}>
                    <span>{name(item.id)}</span>
                    <span className="text-muted-foreground tabular-nums">{item.count}</span>
                  </button>
                ))}
              </Section>
            </>
          )}
          {violations.length > 0 && (
            <Section title="违反目标架构">
              {violations.slice(0, 6).map((violation) => (
                <div key={`${violation.ruleId}:${violation.from}:${violation.to}`} className="rounded-md border border-destructive/40 p-2 text-xs">
                  {violation.message}
                  <span className="text-muted-foreground"> · {violation.edges.length} 处</span>
                </div>
              ))}
            </Section>
          )}
        </>
      )}
    </>
  )
}
