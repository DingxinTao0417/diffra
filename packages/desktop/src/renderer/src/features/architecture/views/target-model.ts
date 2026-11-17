import { type BlockDiagram, type DiagramBlock, diagramBlocks, type DiagramGroup, type TargetArchitecture, type TargetRule, type TargetViolation } from '@diffra/core/architecture'
import { emptyDiagram, newId } from '../diagram/diagram-model'

// 从现在的应用架构图复制一份当目标：层、分组、方块和认领的代码都照搬，加上「只能依赖同层或下层」「不许循环依赖」
export function targetFromDiagram(diagram: BlockDiagram): TargetArchitecture {
  const copy: BlockDiagram = structuredClone(diagram)
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    diagram: { ...copy, source: 'model', generatedAt: new Date().toISOString() },
    rules: [
      { id: newId('rule'), kind: 'layers', strict: false },
      { id: newId('rule'), kind: 'no-cycles' },
    ],
  }
}

export function emptyTarget(): TargetArchitecture {
  return { version: 1, updatedAt: new Date().toISOString(), diagram: emptyDiagram('application'), rules: [{ id: newId('rule'), kind: 'layers', strict: false }] }
}

export const blockNamer = (diagram: BlockDiagram) => {
  const names = new Map(diagramBlocks(diagram).map(({ block }) => [block.id, block.name]))
  return (id: string) => names.get(id) ?? id
}

// 规则按含义比较（id 每次提案都可能不同）
export function ruleKey(rule: TargetRule, name: (id: string) => string): string {
  switch (rule.kind) {
    case 'layers':
      return `layers:${rule.strict}`
    case 'no-cycles':
      return 'no-cycles'
    case 'forbid':
    case 'allow':
      return `${rule.kind}:${name(rule.from)}>${name(rule.to)}`
    case 'external':
      return `external:${rule.package}:${rule.only.map(name).sort().join(',')}`
  }
}

export function describeRule(rule: TargetRule, name: (id: string) => string): string {
  switch (rule.kind) {
    case 'layers':
      return rule.strict ? '只能依赖紧挨着的下一层' : '只能依赖同层或下层'
    case 'no-cycles':
      return '方块之间不许循环依赖'
    case 'forbid':
      return `「${name(rule.from)}」不许依赖「${name(rule.to)}」${rule.note ? `（${rule.note}）` : ''}`
    case 'allow':
      return `例外：「${name(rule.from)}」可以依赖「${name(rule.to)}」${rule.note ? `（${rule.note}）` : ''}`
    case 'external':
      return `「${rule.package}」只许${rule.only.map((id) => `「${name(id)}」`).join('、')}使用${rule.note ? `（${rule.note}）` : ''}`
  }
}

// 方块在图里的位置，按名字表示：层和分组，或者右侧竖栏
interface Place {
  layer: string | null
  group: string | null
  side: string | null
}

function places(diagram: BlockDiagram): Map<string, { block: DiagramBlock; place: Place }> {
  const result = new Map<string, { block: DiagramBlock; place: Place }>()
  for (const layer of diagram.layers) for (const group of layer.groups) for (const block of group.blocks) result.set(block.name, { block, place: { layer: layer.name, group: group.name, side: null } })
  for (const side of diagram.sides) for (const block of side.blocks) result.set(block.name, { block, place: { layer: null, group: null, side: side.name } })
  return result
}

const placeText = (place: Place) => (place.side ? `右侧「${place.side}」` : `「${place.layer}」层${place.group ? ` · ${place.group}` : ''}`)
const samePlace = (a: Place, b: Place) => a.layer === b.layer && a.group === b.group && a.side === b.side

export type ChangeKind = 'added' | 'removed' | 'changed'

export interface ProposalChange {
  key: string
  area: 'layer' | 'block' | 'rule'
  kind: ChangeKind
  title: string
  detail: string
}

const EMPTY: TargetArchitecture = { version: 1, updatedAt: '', diagram: { kind: 'application', source: 'model', generatedAt: '', model: null, fingerprint: '', layers: [], sides: [], connectors: [], dropped: 0 }, rules: [] }

// 提案和现在的目标架构逐条对比：层和方块按名字对，规则按含义对
export function diffTargets(current: TargetArchitecture | null, proposal: TargetArchitecture): ProposalChange[] {
  const base = current ?? EMPTY
  const changes: ProposalChange[] = []
  for (const layer of proposal.diagram.layers) {
    const old = base.diagram.layers.find((item) => item.name === layer.name)
    if (!old) changes.push({ key: `layer:+:${layer.name}`, area: 'layer', kind: 'added', title: layer.name, detail: layer.description })
    else if (old.description !== layer.description) changes.push({ key: `layer:~:${layer.name}`, area: 'layer', kind: 'changed', title: layer.name, detail: layer.description })
  }
  for (const layer of base.diagram.layers) if (!proposal.diagram.layers.some((item) => item.name === layer.name)) changes.push({ key: `layer:-:${layer.name}`, area: 'layer', kind: 'removed', title: layer.name, detail: layer.description })
  const before = places(base.diagram)
  const after = places(proposal.diagram)
  for (const [name, { block, place }] of after) {
    const old = before.get(name)
    const summary = `${placeText(place)} · ${block.paths.join('、') || '还没写路径'}`
    if (!old) changes.push({ key: `block:+:${name}`, area: 'block', kind: 'added', title: name, detail: `${summary}${block.description ? ` — ${block.description}` : ''}` })
    else if (!samePlace(old.place, place) || old.block.description !== block.description || old.block.paths.join('\n') !== block.paths.join('\n')) {
      changes.push({ key: `block:~:${name}`, area: 'block', kind: 'changed', title: name, detail: `${placeText(old.place)} · ${old.block.paths.join('、')} → ${summary}` })
    }
  }
  for (const [name, { block }] of before) if (!after.has(name)) changes.push({ key: `block:-:${name}`, area: 'block', kind: 'removed', title: name, detail: block.paths.join('、') })
  const baseName = blockNamer(base.diagram)
  const proposalName = blockNamer(proposal.diagram)
  const baseRules = new Map(base.rules.map((rule) => [ruleKey(rule, baseName), rule]))
  const proposalRules = new Map(proposal.rules.map((rule) => [ruleKey(rule, proposalName), rule]))
  for (const [key, rule] of proposalRules) if (!baseRules.has(key)) changes.push({ key: `rule:+:${key}`, area: 'rule', kind: 'added', title: describeRule(rule, proposalName), detail: '' })
  for (const [key, rule] of baseRules) if (!proposalRules.has(key)) changes.push({ key: `rule:-:${key}`, area: 'rule', kind: 'removed', title: describeRule(rule, baseName), detail: '' })
  return changes
}

// 只采用勾选的改动，其余保持现在的样子
export function applyChanges(current: TargetArchitecture | null, proposal: TargetArchitecture, accepted: ReadonlySet<string>): TargetArchitecture {
  const base = current ?? EMPTY
  const take = (key: string) => accepted.has(key)
  const result: BlockDiagram = structuredClone(base.diagram)

  // 层：先删接受删除的（里面剩下的方块后面再安置），再按提案的位置插入接受新增的，改说明
  const homeless: Array<{ block: DiagramBlock; place: Place }> = []
  for (const layer of [...result.layers]) {
    if (!take(`layer:-:${layer.name}`)) continue
    for (const group of layer.groups) for (const block of group.blocks) homeless.push({ block, place: { layer: layer.name, group: group.name, side: null } })
    result.layers = result.layers.filter((item) => item.id !== layer.id)
  }
  proposal.diagram.layers.forEach((layer, at) => {
    const existing = result.layers.find((item) => item.name === layer.name)
    if (existing) {
      if (take(`layer:~:${layer.name}`)) existing.description = layer.description
      return
    }
    if (take(`layer:+:${layer.name}`)) result.layers.splice(Math.min(at, result.layers.length), 0, { id: layer.id, name: layer.name, description: layer.description, groups: [], pinned: true })
  })

  const remove = (name: string) => {
    for (const layer of result.layers) for (const group of layer.groups) group.blocks = group.blocks.filter((item) => item.name !== name)
    for (const side of result.sides) side.blocks = side.blocks.filter((item) => item.name !== name)
  }
  const proposalSides = new Map(proposal.diagram.sides.map((side) => [side.name, side]))
  const put = (block: DiagramBlock, place: Place) => {
    if (place.side) {
      let side = result.sides.find((item) => item.name === place.side)
      if (!side) {
        const template = proposalSides.get(place.side)
        side = { id: template?.id ?? newId('side'), name: place.side, description: template?.description ?? '', from: result.layers[0]?.id ?? '', to: result.layers[result.layers.length - 1]?.id ?? '', blocks: [], pinned: true }
        result.sides.push(side)
      }
      side.blocks.push(block)
      return
    }
    const layer = result.layers.find((item) => item.name === place.layer) ?? result.layers[result.layers.length - 1]
    if (!layer) return
    let group: DiagramGroup | undefined = layer.groups.find((item) => item.name === (place.group ?? ''))
    if (!group) {
      group = { id: newId('group'), name: place.group ?? '', blocks: [], pinned: true }
      layer.groups.push(group)
    }
    group.blocks.push(block)
  }

  const after = places(proposal.diagram)
  for (const [name, { block, place }] of after) {
    if (take(`block:+:${name}`)) put(structuredClone(block), place)
    else if (take(`block:~:${name}`)) {
      const old = places(result).get(name) ?? homeless.find((item) => item.block.name === name)
      remove(name)
      put({ ...(old?.block ?? block), description: block.description, paths: block.paths }, place)
    }
  }
  const before = places(base.diagram)
  for (const name of before.keys()) if (take(`block:-:${name}`)) remove(name)
  // 删掉的层里没另作安排的方块：放到最下面一层
  const placed = places(result)
  for (const item of homeless) if (!placed.has(item.block.name) && !take(`block:-:${item.block.name}`)) put(item.block, { layer: null, group: item.place.group, side: null })
  for (const layer of result.layers) layer.groups = layer.groups.filter((group) => group.blocks.length > 0 || group.pinned)

  // 相邻两层的连线：标签优先用提案的
  result.connectors = result.layers.slice(0, -1).map((layer, at) => {
    const next = result.layers[at + 1]!
    const fromProposal = proposal.diagram.connectors.find((item) => proposal.diagram.layers.find((candidate) => candidate.id === item.from)?.name === layer.name && proposal.diagram.layers.find((candidate) => candidate.id === item.to)?.name === next.name)
    const existing = result.connectors.find((item) => item.from === layer.id && item.to === next.id)
    return { from: layer.id, to: next.id, label: fromProposal?.label || existing?.label || '' }
  })
  const layerIds = new Set(result.layers.map((layer) => layer.id))
  for (const side of result.sides) {
    if (!layerIds.has(side.from)) side.from = result.layers[0]?.id ?? side.from
    if (!layerIds.has(side.to)) side.to = result.layers[result.layers.length - 1]?.id ?? side.to
  }

  // 规则：规则里的方块 id 换成结果图里同名方块的 id
  const resultIds = new Map(diagramBlocks(result).map(({ block }) => [block.name, block.id]))
  const baseName = blockNamer(base.diagram)
  const proposalName = blockNamer(proposal.diagram)
  const toResult = (id: string, namer: (id: string) => string) => resultIds.get(namer(id)) ?? null
  const proposalKeys = new Set(proposal.rules.map((rule) => ruleKey(rule, proposalName)))
  const baseKeys = new Set(base.rules.map((rule) => ruleKey(rule, baseName)))
  const rules: TargetRule[] = []
  const remap = (rule: TargetRule, namer: (id: string) => string): TargetRule | null => {
    if (rule.kind === 'forbid' || rule.kind === 'allow') {
      const from = toResult(rule.from, namer)
      const to = toResult(rule.to, namer)
      return from && to ? { ...rule, from, to } : null
    }
    if (rule.kind === 'external') {
      const only = rule.only.flatMap((id) => toResult(id, namer) ?? [])
      return only.length > 0 ? { ...rule, only } : null
    }
    return rule
  }
  for (const rule of base.rules) {
    const key = ruleKey(rule, baseName)
    if (proposalKeys.has(key) || !take(`rule:-:${key}`)) {
      const mapped = remap(rule, baseName)
      if (mapped) rules.push(mapped)
    }
  }
  for (const rule of proposal.rules) {
    const key = ruleKey(rule, proposalName)
    if (baseKeys.has(key) || !take(`rule:+:${key}`)) continue
    const mapped = remap(rule, proposalName)
    if (mapped) rules.push(mapped)
  }
  return { version: 1, updatedAt: new Date().toISOString(), diagram: result, rules }
}

// 一处违规生成的重构任务说明
export function violationPrompt(violation: TargetViolation, files: (index: number) => string, block: (id: string) => { name: string; paths: string[] }): string {
  const lines = violation.edges.slice(0, 30).map((edge) => (violation.kind === 'external' ? `- ${files(edge.from)}:${edge.line}（${edge.specifier}）` : `- ${files(edge.from)}:${edge.line} 依赖 ${files(edge.to)}（${edge.specifier}）`))
  const more = violation.edges.length > 30 ? `\n…还有 ${violation.edges.length - 30} 处` : ''
  const describe = (id: string) => `「${block(id).name}」的代码在 ${block(id).paths.join('、') || '（没有路径）'}`
  const scope = violation.kind === 'external' ? '' : `\n${describe(violation.from)}，${describe(violation.to)}。`
  const goal =
    violation.kind === 'external'
      ? '目标：把这个外部包的使用收拢到允许的方块里，别处通过那个方块提供的接口用它。'
      : violation.kind === 'cycle'
        ? '目标：拆掉这个循环依赖，一般是把共同依赖的部分挪到更下层，或者反过来用接口、回调、事件解耦。'
        : '目标：去掉这些依赖，让依赖方向符合目标架构（共用的部分挪到下层，或者通过接口、依赖注入反转依赖）。'
  return `按目标架构重构：${violation.message}${scope}\n\n涉及的地方（共 ${violation.edges.length} 处）：\n${lines.join('\n')}${more}\n\n${goal}改动保持行为不变；改完确认没有引入新的违规或循环依赖，跑一遍项目的检查。先出计划再动手。`
}
