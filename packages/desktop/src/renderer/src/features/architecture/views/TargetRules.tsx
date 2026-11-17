import { useMemo } from 'react'
import { diagramBlocks, type TargetArchitecture, type TargetRule } from '@diffra/core/architecture'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { saveTarget } from '../architecture-store'
import { useArch } from '../context'
import { newId } from '../diagram/diagram-model'

// 目标架构的依赖规则：改一项存一项。方块的层由它在图上的位置决定，右边竖栏里的方块不分层
export function TargetRules() {
  const { target, analysis, project } = useArch()
  const current = target!
  const blocks = useMemo(() => diagramBlocks(current.diagram).filter(({ block }) => block.kind !== 'external').map(({ block }) => block), [current])
  const externals = useMemo(() => analysis.externals.filter((item) => !item.builtin).map((item) => item.name), [analysis])
  const save = (change: Partial<TargetArchitecture>) => void saveTarget(project.id, { ...current, ...change, updatedAt: new Date().toISOString() })
  const setRules = (rules: TargetRule[]) => save({ rules })
  const layersRule = current.rules.find((rule) => rule.kind === 'layers')
  const noCycles = current.rules.some((rule) => rule.kind === 'no-cycles')

  return (
    <div className="h-full overflow-y-auto" data-testid="target-rules">
      <div className="mx-auto max-w-3xl space-y-6 p-6 text-sm">
        <section className="space-y-2">
          <h3 className="text-sm font-bold">分层</h3>
          <label className="flex items-center gap-2">
            <Checkbox checked={Boolean(layersRule)} onCheckedChange={(checked) => setRules(checked ? [...current.rules, { id: newId('rule'), kind: 'layers', strict: false }] : current.rules.filter((rule) => rule.kind !== 'layers'))} />
            方块只能依赖同层或下层的方块
          </label>
          {layersRule?.kind === 'layers' && (
            <label className="ml-6 flex items-center gap-2 text-muted-foreground">
              <Checkbox checked={layersRule.strict} onCheckedChange={(checked) => setRules(current.rules.map((rule) => (rule.kind === 'layers' ? { ...rule, strict: checked === true } : rule)))} />
              严格分层：只能依赖紧挨着的下一层
            </label>
          )}
          <label className="flex items-center gap-2">
            <Checkbox checked={noCycles} onCheckedChange={(checked) => setRules(checked ? [...current.rules, { id: newId('rule'), kind: 'no-cycles' }] : current.rules.filter((rule) => rule.kind !== 'no-cycles'))} />
            方块之间不许循环依赖
          </label>
        </section>
        {(['forbid', 'allow'] as const).map((kind) => (
          <section key={kind} className="space-y-2">
            <h3 className="text-sm font-bold">{kind === 'forbid' ? '禁止的依赖' : '分层规则的例外（允许的依赖）'}</h3>
            {current.rules.map((rule) =>
              rule.kind === kind ? (
                <div key={rule.id} className="flex items-center gap-2">
                  <BlockSelect value={rule.from} blocks={blocks} onChange={(from) => setRules(current.rules.map((item) => (item.id === rule.id ? { ...rule, from } : item)))} />
                  <span className="shrink-0 text-xs text-muted-foreground">{kind === 'forbid' ? '不许依赖' : '可以依赖'}</span>
                  <BlockSelect value={rule.to} blocks={blocks} onChange={(to) => setRules(current.rules.map((item) => (item.id === rule.id ? { ...rule, to } : item)))} />
                  <Input
                    className="h-8 flex-1"
                    defaultValue={rule.note}
                    placeholder="原因（会写进违规提示和重构任务）"
                    aria-label="原因"
                    onBlur={(event) => event.target.value !== rule.note && setRules(current.rules.map((item) => (item.id === rule.id ? { ...rule, note: event.target.value } : item)))}
                  />
                  <Button variant="ghost" size="icon" className="size-8" aria-label="删除规则" onClick={() => setRules(current.rules.filter((item) => item.id !== rule.id))}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : null,
            )}
            <Button variant="outline" size="xs" disabled={blocks.length < 2} onClick={() => setRules([...current.rules, { id: newId('rule'), kind, from: blocks[0]!.id, to: blocks[1]!.id, note: '' }])}>
              <Plus className="size-3" />
              加一条
            </Button>
          </section>
        ))}
        <section className="space-y-2">
          <h3 className="text-sm font-bold">外部包只许这些方块使用</h3>
          {current.rules.map((rule) =>
            rule.kind === 'external' ? (
              <div key={rule.id} className="flex flex-wrap items-center gap-2">
                <Select value={rule.package} onValueChange={(value) => setRules(current.rules.map((item) => (item.id === rule.id ? { ...rule, package: value } : item)))}>
                  <SelectTrigger size="sm" className="h-8 w-48 font-mono text-xs" aria-label="外部包">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([rule.package, ...externals])].map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">只许</span>
                {blocks.map((block) => (
                  <label key={block.id} className="flex items-center gap-1 text-xs">
                    <Checkbox
                      checked={rule.only.includes(block.id)}
                      onCheckedChange={(checked) => setRules(current.rules.map((item) => (item.id === rule.id ? { ...rule, only: checked ? [...rule.only, block.id] : rule.only.filter((id) => id !== block.id) } : item)))}
                    />
                    {block.name}
                  </label>
                ))}
                <Button variant="ghost" size="icon" className="size-8" aria-label="删除规则" onClick={() => setRules(current.rules.filter((item) => item.id !== rule.id))}>
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null,
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={externals.length === 0 || blocks.length === 0}
            onClick={() => setRules([...current.rules, { id: newId('rule'), kind: 'external', package: externals[0]!, only: [blocks[0]!.id], note: '' }])}
          >
            <Plus className="size-3" />
            加一条
          </Button>
        </section>
      </div>
    </div>
  )
}

function BlockSelect({ value, blocks, onChange }: { value: string; blocks: Array<{ id: string; name: string }>; onChange(value: string): void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-8 w-40" aria-label="方块">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {blocks.map((block) => (
          <SelectItem key={block.id} value={block.id}>
            {block.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
