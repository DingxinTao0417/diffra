import { z } from 'zod'
import { ARCHITECTURE_VERSION, type BlockDiagram, DIAGRAM_KINDS, type TargetArchitecture } from './model.js'

// 界面保存的、从仓库导入的架构图和目标架构：在边界上校验一遍，core 之后信任这个结构
export const id = z.string().trim().min(1).max(80)
const text = (max: number) => z.string().max(max)

const blockSchema = z.object({
  id,
  name: text(80).min(1),
  description: text(4000),
  kind: z.enum(['code', 'tech', 'external', 'store']),
  paths: z.array(text(300).min(1)).max(50),
  packages: z.array(text(200).min(1)).max(50),
  pinned: z.boolean(),
  unverified: z.boolean(),
})

export const diagramSchema = z.object({
  kind: z.enum(DIAGRAM_KINDS),
  source: z.enum(['static', 'model']),
  generatedAt: z.string().max(40),
  model: z.object({ provider: text(200), modelId: text(200) }).nullable(),
  fingerprint: text(200),
  layers: z
    .array(z.object({ id, name: text(80), description: text(2000), pinned: z.boolean(), groups: z.array(z.object({ id, name: text(80), pinned: z.boolean(), blocks: z.array(blockSchema).max(100) })).max(30) }))
    .max(20),
  sides: z.array(z.object({ id, name: text(80), description: text(2000), from: id, to: id, pinned: z.boolean(), blocks: z.array(blockSchema).max(50) })).max(6),
  connectors: z.array(z.object({ from: id, to: id, label: text(200) })).max(40),
  dropped: z.number().int().nonnegative(),
}) satisfies z.ZodType<BlockDiagram>

export const targetSchema = z.object({
  version: z.literal(ARCHITECTURE_VERSION),
  updatedAt: z.iso.datetime(),
  diagram: diagramSchema,
  rules: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ id, kind: z.literal('layers'), strict: z.boolean() }),
        z.object({ id, kind: z.literal('forbid'), from: id, to: id, note: text(1000) }),
        z.object({ id, kind: z.literal('allow'), from: id, to: id, note: text(1000) }),
        z.object({ id, kind: z.literal('no-cycles') }),
        z.object({ id, kind: z.literal('external'), package: text(200).min(1), only: z.array(id).max(200), note: text(1000) }),
      ]),
    )
    .max(300),
}) satisfies z.ZodType<TargetArchitecture>
