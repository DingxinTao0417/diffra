import { useState } from 'react'
import { type ModelRef, type Role, ROLES, type SettingsView } from '../../../../shared/settings'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorMessage } from '@/lib/errors'

const ROLE_INFO: Record<Role, { label: string; description: string; required: boolean }> = {
  coder: { label: '编码', description: '读代码、改代码、跑命令的主力模型', required: true },
  planner: { label: '规划', description: '拆解任务、制定计划。不选就用编码模型', required: false },
  reviewer: { label: '评审', description: '用新的上下文审查改动。不选就用编码模型', required: false },
  fallback: { label: '兜底', description: '卡住或连续失败时升级使用。不选就不升级', required: false },
}

// Radix Select 不接受空字符串作为选项值
const NONE = '__none__'

function encode(ref: ModelRef): string {
  return JSON.stringify([ref.providerId, ref.modelId])
}

interface RolesCardProps {
  view: SettingsView
  onChange(view: SettingsView): void
}

export function RolesCard({ view, onChange }: RolesCardProps) {
  const [error, setError] = useState<string | null>(null)

  const options = view.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: encode({ providerId: provider.id, modelId: model.id }),
      ref: { providerId: provider.id, modelId: model.id },
      label: `${provider.name} / ${model.id}`,
    })),
  )

  const assign = async (role: Role, value: string) => {
    setError(null)
    const ref = value === NONE ? null : (options.find((option) => option.value === value)?.ref ?? null)
    try {
      onChange(await window.diffra.setRole(role, ref))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>角色分配</CardTitle>
        <CardDescription>agent 在不同环节用的模型。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {options.length === 0 && <p className="text-sm text-muted-foreground">先添加供应商和模型，再来分配。</p>}
        {ROLES.map((role) => {
          const info = ROLE_INFO[role]
          const ref = view.roles[role]
          return (
            <div key={role} className="grid grid-cols-[14rem_1fr] items-center gap-4">
              <div>
                <Label htmlFor={`role-${role}`}>{info.label}</Label>
                <p className="text-xs text-muted-foreground">{info.description}</p>
              </div>
              <Select value={ref ? encode(ref) : NONE} onValueChange={(value) => assign(role, value)} disabled={options.length === 0}>
                <SelectTrigger id={`role-${role}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{info.required ? '未选择' : '不使用'}</SelectItem>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
        {!view.roles.coder && options.length > 0 && (
          <p className="text-sm text-destructive">还没有选编码模型，agent 没法开始工作。</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
