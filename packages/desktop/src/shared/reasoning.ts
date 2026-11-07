import { REASONING_EFFORTS, type ReasoningEffort } from '@diffra/core/types'
import type { ModelConfig, ProviderConfig } from './settings'

// 仅匹配已知型号及日期快照；代理别名与未知模型由用户配置，不按协议猜档位。
export function reasoningEffortsFor(provider: Pick<ProviderConfig, 'protocol'>, model: ModelConfig): ReasoningEffort[] {
  if (provider.protocol !== 'openai-compatible' && provider.protocol !== 'openai-responses') return ['default']
  if (model.reasoningEfforts !== undefined) {
    return ['default', ...REASONING_EFFORTS.filter((effort) => effort !== 'default' && model.reasoningEfforts?.includes(effort))]
  }
  const id = model.id.toLowerCase()
  if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'minimal', 'low', 'medium', 'high']
  if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'none', 'low', 'medium', 'high']
  if (/^gpt-5\.[24](?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'none', 'low', 'medium', 'high', 'xhigh']
  if (/^(?:o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['default', 'low', 'medium', 'high']
  return ['default']
}
