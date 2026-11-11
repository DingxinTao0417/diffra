import { createContext, useContext } from 'react'
import type {
  ArchitectureAnalysis,
  ArchitectureDiagrams,
  ArchitectureInterpretation,
  ArchitectureLayout,
  ArchitectureProject,
  BlockDiagram,
  DiagramKind,
  TargetArchitecture,
  TargetEvaluation,
} from '@diffra/core/architecture'
import type { Route } from '@/state/store'
import type { ArchIndex } from './graph'

export type ArchitectureRoute = Extract<Route, { name: 'architecture' }>

// 正在编辑的图：三张架构图之一，或目标架构的图；改动先放在草稿里，保存才落盘
export interface DiagramDraft {
  kind: DiagramKind | 'target'
  diagram: BlockDiagram
  dirty: boolean
}

export interface ArchitectureContextValue {
  project: ArchitectureProject
  analysis: ArchitectureAnalysis
  index: ArchIndex
  interpretation: ArchitectureInterpretation | null
  diagrams: ArchitectureDiagrams
  target: TargetArchitecture | null
  // 现状对比目标架构；没有目标架构为 null
  evaluation: TargetEvaluation | null
  layout: ArchitectureLayout
  route: ArchitectureRoute
  draft: DiagramDraft | null
  setDraft(draft: DiagramDraft | null): void
  // 换视图、范围记进后退历史；只换选中的东西不记（record 为 false）
  go(change: Partial<Pick<ArchitectureRoute, 'tab' | 'diagram' | 'section' | 'scope' | 'focus'>>, record?: boolean): void
  // 在弹窗里看一个文件，停在那一行
  peek(path: string, line?: number): void
}

export const ArchitectureContext = createContext<ArchitectureContextValue | null>(null)

export function useArch(): ArchitectureContextValue {
  const value = useContext(ArchitectureContext)
  if (!value) throw new Error('useArch 要在架构详情页里用')
  return value
}

// 选中方块的 id：block:<图>:<方块 id>；目标架构的图是 block:target:<方块 id>
export const blockFocus = (kind: DiagramKind | 'target', id: string) => `block:${kind}:${id}`

export function diagramOf(context: Pick<ArchitectureContextValue, 'diagrams' | 'target' | 'draft'>, kind: DiagramKind | 'target'): BlockDiagram | null {
  if (context.draft?.kind === kind) return context.draft.diagram
  return kind === 'target' ? (context.target?.diagram ?? null) : (context.diagrams[kind] ?? null)
}
