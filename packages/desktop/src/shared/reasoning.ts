import type { ReasoningEffort } from '@diffra/core/types'
import { type ModelConfig, type ModelRef, type ProviderConfig, reasoningChoiceKey } from './settings'

// 各协议可选的档位都是这五个；none、minimal 留在 REASONING_EFFORTS 里只为旧设置还能读
export const REASONING_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ReasoningEffort[]

// 发得了思考强度参数的协议
export function supportsReasoningEffort(protocol: ProviderConfig['protocol']): boolean {
  return protocol === 'openai-compatible' || protocol === 'openai-responses' || protocol === 'anthropic' || protocol === 'anthropic-compatible'
}

// 仅匹配已知型号及日期快照；代理别名、未知模型和 Anthropic 系的模型由用户配置，不按协议猜档位。
export function reasoningEffortsFor(provider: Pick<ProviderConfig, 'protocol'>, model: ModelConfig): ReasoningEffort[] {
  if (!supportsReasoningEffort(provider.protocol)) return ['default']
  if (model.reasoningEfforts !== undefined) {
    return ['default', ...REASONING_CHOICES.filter((effort) => model.reasoningEfforts?.includes(effort))]
  }
  if (provider.protocol !== 'openai-compatible' && provider.protocol !== 'openai-responses') return ['default']
  const id = model.id.toLowerCase()
  if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'low', 'medium', 'high']
  if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'low', 'medium', 'high']
  if (/^gpt-5\.[24](?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'low', 'medium', 'high', 'xhigh']
  if (/^(?:o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'low', 'medium', 'high']
  return ['default']
}

// 输入框里给这个模型选过思考程度就用它（第 531 步）；模型后来不支持那一档了就不用
export function withRememberedEffort(ref: ModelRef, providers: ProviderConfig[], choices: Record<string, ReasoningEffort>): ModelRef {
  const remembered = choices[reasoningChoiceKey(ref)]
  if (!remembered) return ref
  const provider = providers.find((item) => item.id === ref.providerId)
  const model = provider?.models.find((item) => item.id === ref.modelId)
  return provider && model && reasoningEffortsFor(provider, model).includes(remembered) ? { ...ref, reasoningEffort: remembered } : ref
}
