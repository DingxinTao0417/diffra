import { z } from 'zod'
import { type ArchitectureDiagrams, type BlockDiagram, DIAGRAM_KINDS, diagramBlocks, type DiagramKind, type TargetArchitecture, targetParts } from './model.js'
import { diagramSchema, targetSchema } from './schemas.js'

// 把架构定义放进仓库、和团队共享（v2 · M9）：用户点「导出到仓库」才写，写在项目根的 .diffra/ 下。
// architecture.json 给 Diffra 读（别人打开这个项目时可以导入），architecture.md 给人看（Mermaid 图加规则说明），一起提交到版本库
export const SHARED_DIR = '.diffra'
export const SHARED_JSON = '.diffra/architecture.json'
export const SHARED_MARKDOWN = '.diffra/architecture.md'
export const SHARED_FORMAT = 'diffra-architecture'

export interface SharedArchitecture {
  format: typeof SHARED_FORMAT
  version: 1
  exportedAt: string
  project: string
  diagrams: ArchitectureDiagrams
  target: TargetArchitecture | null
}

export const sharedSchema = z.object({
  format: z.literal(SHARED_FORMAT),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  project: z.string().max(200),
  diagrams: z.object({ application: diagramSchema.optional(), technology: diagramSchema.optional(), system: diagramSchema.optional() }),
  target: targetSchema.nullable(),
})

// 仓库里那份和本机的状态：没有、读不了（格式不对）、有（和本机一样不一样）
export type SharedStatus = { state: 'none' } | { state: 'invalid'; error: string } | { state: 'present'; exportedAt: string; diagrams: number; hasTarget: boolean; matches: boolean }

const DIAGRAM_TITLES: Record<DiagramKind, string> = { application: '应用架构', technology: '技术架构', system: '系统架构' }

// 按键排序后的 JSON：校验过的对象键的顺序和原来的不一定一样
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// 只比内容：生成时间、核对用的指纹这些每次分析都会变，不算不同
function comparable(diagrams: ArchitectureDiagrams, target: TargetArchitecture | null): string {
  const strip = (diagram: BlockDiagram | undefined) => (diagram ? { layers: diagram.layers, sides: diagram.sides, connectors: diagram.connectors } : null)
  return canonical({ diagrams: DIAGRAM_KINDS.map((kind) => strip(diagrams[kind])), target: target ? { diagram: strip(target.diagram), rules: target.rules } : null })
}

export function sameDefinition(shared: Pick<SharedArchitecture, 'diagrams' | 'target'>, diagrams: ArchitectureDiagrams, target: TargetArchitecture | null): boolean {
  return comparable(shared.diagrams, shared.target) === comparable(diagrams, target)
}

const mermaidId = (value: string) => `n_${value.replace(/[^A-Za-z0-9_]/g, '_')}`
const mermaidText = (value: string) => value.replace(/["<>`]/g, "'").replace(/\s+/g, ' ').trim()

// 分层方块图画成 Mermaid：每层一个子图，层之间的连线写怎么通信
function mermaid(diagram: BlockDiagram): string {
  const lines = ['```mermaid', 'flowchart TB']
  for (const layer of diagram.layers) {
    lines.push(`  subgraph ${mermaidId(layer.id)}["${mermaidText(layer.name)}"]`)
    for (const group of layer.groups) for (const block of group.blocks) lines.push(`    ${mermaidId(block.id)}["${mermaidText(block.name)}"]`)
    lines.push('  end')
  }
  for (const side of diagram.sides) {
    lines.push(`  subgraph ${mermaidId(side.id)}["${mermaidText(side.name)}"]`)
    for (const block of side.blocks) lines.push(`    ${mermaidId(block.id)}["${mermaidText(block.name)}"]`)
    lines.push('  end')
  }
  for (const connector of diagram.connectors) lines.push(`  ${mermaidId(connector.from)} -->${connector.label ? `|"${mermaidText(connector.label)}"|` : ''} ${mermaidId(connector.to)}`)
  lines.push('```')
  return lines.join('\n')
}

function blockList(diagram: BlockDiagram): string[] {
  return diagramBlocks(diagram).map(({ block, layer, side }) => {
    const where = layer ? diagram.layers.find((item) => item.id === layer)?.name : side ? diagram.sides.find((item) => item.id === side)?.name : null
    const code = block.paths.length ? `：${block.paths.map((path) => `\`${path}\``).join('、')}` : ''
    return `- **${block.name}**${where ? `（${where}）` : ''}${code}${block.description ? ` — ${block.description.replace(/\s+/g, ' ')}` : ''}`
  })
}

export function sharedMarkdown(shared: SharedArchitecture): string {
  const out = [`# ${shared.project} 的架构`, '', `由 Diffra 导出（${shared.exportedAt}）。改架构请在 Diffra 的「架构」页里改，再导出覆盖这两个文件；机器读的是同目录的 architecture.json。`, '']
  for (const kind of DIAGRAM_KINDS) {
    const diagram = shared.diagrams[kind]
    if (!diagram) continue
    out.push(`## ${DIAGRAM_TITLES[kind]}`, '', mermaid(diagram), '', ...blockList(diagram), '')
  }
  if (shared.target) {
    const { components } = targetParts(shared.target)
    const name = (id: string) => components.find((component) => component.id === id)?.name ?? id
    out.push('## 目标架构', '', mermaid(shared.target.diagram), '', '### 依赖规则', '')
    for (const rule of shared.target.rules) {
      if (rule.kind === 'layers') out.push(`- 只能依赖同层或下层${rule.strict ? '（只许依赖紧挨着的下一层）' : ''}`)
      else if (rule.kind === 'no-cycles') out.push('- 组件之间不许循环依赖')
      else if (rule.kind === 'forbid') out.push(`- 「${name(rule.from)}」不许依赖「${name(rule.to)}」${rule.note ? `：${rule.note}` : ''}`)
      else if (rule.kind === 'allow') out.push(`- 例外：「${name(rule.from)}」可以依赖「${name(rule.to)}」${rule.note ? `：${rule.note}` : ''}`)
      else out.push(`- 外部包 \`${rule.package}\` 只许 ${rule.only.map((id) => `「${name(id)}」`).join('、') || '（没有组件）'} 使用${rule.note ? `：${rule.note}` : ''}`)
    }
    out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}
