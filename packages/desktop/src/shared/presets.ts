import type { Protocol } from '@diffra/core/types'

export interface ProviderPreset {
  id: string
  group: 'payg' | 'plan'
  name: string
  protocol: Protocol
  baseUrl: string
  // 显示在添加界面上的说明，套餐的条款限制写在这里
  note?: string
}

// 地址来源和核对日期见 docs/decisions.md。地址允许用户修改（换地域、填 Workspace ID）。
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'anthropic', group: 'payg', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'openai', group: 'payg', name: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  {
    id: 'gemini',
    group: 'payg',
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'deepseek',
    group: 'payg',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    note: 'DeepSeek 的 Anthropic 兼容接口只接受 claude- 开头的模型名，所以这里用 OpenAI 兼容接口。',
  },
  {
    id: 'bailian',
    group: 'payg',
    name: '阿里云百炼（按量）',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    note: '默认是北京地域；其他地域请按百炼控制台改地址。按量计费的 Key 和套餐 Key 不通用。',
  },
  { id: 'moonshot', group: 'payg', name: 'Kimi 开放平台', protocol: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  {
    id: 'zhipu',
    group: 'payg',
    name: '智谱开放平台',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  { id: 'openrouter', group: 'payg', name: 'OpenRouter', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  {
    id: 'zhipu-coding-plan',
    group: 'plan',
    name: '智谱 GLM Coding Plan',
    protocol: 'anthropic-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    note: '智谱条款规定套餐只能在其官方列出的编程工具中使用，Diffra 不在列表里，使用前请自行确认。',
  },
  {
    id: 'bailian-token-plan',
    group: 'plan',
    name: '阿里云百炼 Token Plan',
    protocol: 'anthropic-compatible',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    note: '使用 Token Plan 专属 Key，和按量计费、Coding Plan 的 Key 都不通用。',
  },
  {
    id: 'bailian-coding-plan',
    group: 'plan',
    name: '阿里云百炼 Coding Plan（旧版）',
    protocol: 'anthropic-compatible',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    note: '官方已标为旧版（Lite 已停售）。使用套餐专属 Key（sk-sp- 开头），和按量计费 Key 不通用。条款规定只能在交互式编程工具中使用，禁止直接调用 API。',
  },
  {
    id: 'kimi-code',
    group: 'plan',
    name: 'Kimi Code 会员',
    protocol: 'anthropic-compatible',
    baseUrl: 'https://api.kimi.com/coding/',
    note: '模型 ID 填 kimi-for-coding。官方支持第三方编程 agent，但禁止伪造客户端身份。',
  },
]

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic 兼容',
  'openai-responses': 'OpenAI Responses',
  'openai-compatible': 'OpenAI 兼容',
  gemini: 'Gemini',
}

// 自定义供应商可选的协议
export const CUSTOM_PROTOCOLS: Protocol[] = ['openai-compatible', 'anthropic-compatible']

export function baseUrlHint(protocol: Protocol): string {
  return protocol === 'anthropic' || protocol === 'anthropic-compatible'
    ? '按 Claude Code 的写法填，不带 /v1'
    : '一般以 /v1 结尾，按服务商文档填写'
}
