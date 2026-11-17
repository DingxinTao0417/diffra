import { useState } from 'react'
import { modelDisplayName, type ModelRef, type Role, ROLES, type SettingsView } from '../../../../shared/settings'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorMessage } from '@/lib/errors'
import { useLobeIcons } from '@/lib/model-icons'
import { BrandIcon } from './BrandIcon'
import { SettingsGroup, SettingsRow } from '../settings/SettingsLayout'

export const ROLE_INFO: Record<Role, { label: string; description: string; required: boolean; none: string }> = {
  coder: { label: '编码', description: '读代码、改代码、跑命令的主力模型。', required: true, none: '未选择' },
  planner: { label: '规划', description: '用 /计划 先出计划时由它拆解任务。', required: false, none: '沿用编码模型' },
  reviewer: { label: '评审', description: '深度扫描时用新的上下文审查改动。', required: false, none: '沿用编码模型' },
  fallback: { label: '备用', description: '编码模型卡住或连续失败时换它接手。', required: false, none: '不使用' },
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
  const icons = useLobeIcons()

  const groups = view.providers
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      options: provider.models.filter((model) => model.enabled !== false).map((model) => ({
        value: encode({ providerId: provider.id, modelId: model.id }),
        ref: { providerId: provider.id, modelId: model.id },
        name: modelDisplayName(model),
        icon: icons?.matchModelIcon(model.id) ?? icons?.matchProviderIcon(provider) ?? null,
      })),
    }))
    .filter((group) => group.options.length > 0)
  const options = groups.flatMap((group) => group.options)

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
    <SettingsGroup title="角色分配">
      {options.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">先启用至少一个模型，再来分配。</p>}
      {ROLES.map((role) => {
        const info = ROLE_INFO[role]
        const ref = view.roles[role]
        const selectedValue = ref ? encode(ref) : NONE
        const selectedGroup = groups.find((group) => group.options.some((option) => option.value === selectedValue))
        const selectedOption = selectedGroup?.options.find((option) => option.value === selectedValue)
        // 指向的模型已停用或不在列表里时触发器显示「未选择」，必选角色也要提示
        const missing = info.required && !selectedOption && options.length > 0
        return (
          <SettingsRow
            key={role}
            label={info.label}
            hint={missing ? <span className="text-destructive">必选：未选择时无法开始任务</span> : info.description}
          >
            <Select value={selectedValue} onValueChange={(value) => assign(role, value)} disabled={options.length === 0}>
              <SelectTrigger id={`role-${role}`} aria-label={info.label} aria-invalid={missing || undefined} className="w-64 bg-background">
                {/* 列表里供应商已是分组标题，触发器离开了列表，要带上供应商前缀才分得清不同供应商的同名模型 */}
                <SelectValue>
                  {selectedGroup && selectedOption ? (
                    <>
                      <BrandIcon id={selectedOption.icon} fallbackText={selectedGroup.name} size={16} />
                      <span className="truncate"><span className="text-muted-foreground">{selectedGroup.name} / </span>{selectedOption.name}</span>
                    </>
                  ) : info.none}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{info.none}</SelectItem>
                {groups.length > 0 && <SelectSeparator />}
                {groups.map((group) => (
                  <SelectGroup key={group.id}>
                    <SelectLabel>{group.name}</SelectLabel>
                    {group.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <BrandIcon id={option.icon} fallbackText={group.name} size={16} />
                        <span className="truncate">{option.name}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )
      })}
      {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
    </SettingsGroup>
  )
}
