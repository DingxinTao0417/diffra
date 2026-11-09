import { useEffect, useState } from 'react'
import type { ProviderConfig } from '../../../shared/settings'

// 图标清单里的一项（来自 @lobehub/icons 的 toc）
export interface IconEntry {
  id: string
  title: string
  fullTitle: string
  group: string
}

// 模型匹配表里的一条：模型 ID 命中任一正则就用这个图标
export interface ModelIconRule {
  id: string
  patterns: RegExp[]
}

type LobeIcons = typeof import('./lobe-icons')

// 预设 → 图标 id；服务类图标优先（Anthropic 而不是 Claude，Moonshot 而不是 Kimi）
export const PRESET_ICONS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  bailian: 'Bailian',
  'bailian-token-plan': 'Bailian',
  'bailian-coding-plan': 'Bailian',
  moonshot: 'Moonshot',
  'kimi-code': 'Moonshot',
  zhipu: 'Zhipu',
  'zhipu-coding-plan': 'Zhipu',
  openrouter: 'OpenRouter',
}

// 名称和地址里的常见叫法 → 图标 id，按顺序取第一个命中；更具体的写在前面（百炼在阿里云前，阿里云在阿里前）
// 含汉字的按子串匹配，其余按整词匹配；选择器的搜索也查这张表
export const ALIASES: [string, string][] = [
  ['硅基流动', 'SiliconCloud'],
  ['百炼', 'Bailian'],
  ['dashscope', 'Bailian'],
  ['通义', 'Qwen'],
  ['千问', 'Qwen'],
  ['阿里云', 'AlibabaCloud'],
  ['aliyun', 'AlibabaCloud'],
  ['aliyuncs', 'AlibabaCloud'],
  ['阿里', 'Alibaba'],
  ['智谱', 'Zhipu'],
  ['bigmodel', 'Zhipu'],
  ['zhipuai', 'Zhipu'],
  ['月之暗面', 'Moonshot'],
  ['kimi', 'Moonshot'],
  ['火山', 'Volcengine'],
  ['volces', 'Volcengine'],
  ['豆包', 'Doubao'],
  ['字节', 'ByteDance'],
  ['混元', 'Hunyuan'],
  ['腾讯云', 'TencentCloud'],
  ['tencentcloudapi', 'TencentCloud'],
  ['腾讯', 'Tencent'],
  ['文心', 'Wenxin'],
  ['千帆', 'BaiduCloud'],
  ['百度智能云', 'BaiduCloud'],
  ['baidubce', 'BaiduCloud'],
  ['百度', 'Baidu'],
  ['星火', 'Spark'],
  ['讯飞', 'IFlyTekCloud'],
  ['xfyun', 'IFlyTekCloud'],
  ['零一万物', 'ZeroOne'],
  ['lingyiwanwu', 'ZeroOne'],
  ['百川', 'Baichuan'],
  ['minimaxi', 'Minimax'],
  ['稀宇', 'Minimax'],
  ['阶跃', 'Stepfun'],
  ['深度求索', 'DeepSeek'],
  ['googleapis', 'Google'],
]

// 图标 id 或标题本身就是常用词的，整个名称等于它才算命中，作为名称里的一个词不算：「Local Inference」「Nova 网关」不认成 Inference、Nova
const COMMON_WORDS = new Set([
  'ace', 'brave', 'chutes', 'cursor', 'dolphin', 'falcon', 'fireworks', 'flux', 'hyperbolic', 'inception', 'inference', 'inflection',
  'lambda', 'ling', 'liquid', 'magic', 'magpie', 'morph', 'muse', 'nova', 'parasail', 'pi', 'poolside', 'reflection',
  'replicate', 'snowflake', 'spark', 'stability', 'together', 'upstage', 'voyage', 'wafer', 'yi',
])

const GROUP_ORDER = ['provider', 'model']

export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

// 按空白、标点和汉字与其他字符的交界切词：「阿里云百炼（按量）」→ 阿里云百炼、按量；「Kimi开放平台」→ kimi、开放平台
function nameWords(text: string): string[] {
  return text.toLowerCase().match(/\p{Script=Han}+|[^\s\p{P}\p{S}\p{Script=Han}]+/gu) ?? []
}

// 名称包含这个词：相等，或者是连续几个词拼起来（「Agnes AI」「01.AI」）
function containsWord(words: string[], key: string): boolean {
  for (let start = 0; start < words.length; start++) {
    let joined = ''
    for (let end = start; end < words.length && joined.length < key.length; end++) {
      joined += words[end]
      if (joined === key) return true
    }
  }
  return false
}

function matchAlias(words: string[], normalized: string): string | null {
  for (const [alias, id] of ALIASES) {
    if (/\p{Script=Han}/u.test(alias) ? normalized.includes(alias) : containsWord(words, alias)) return id
  }
  return null
}

export function matchIconName(text: string, entries: IconEntry[]): string | null {
  const words = nameWords(text)
  if (words.length === 0) return null
  const normalized = normalizeName(text)
  const alias = matchAlias(words, normalized)
  if (alias) return alias
  const hit = (keys: string[]) =>
    keys.map(normalizeName).some((key) => key !== '' && (key === normalized || (!COMMON_WORDS.has(key) && containsWord(words, key))))
  // fullTitle 括号里的是别名或母品牌（「SiliconCloud (SiliconFlow)」「AI Studio (Google)」），命中 id、标题的排在前面
  const score = (entry: IconEntry) => {
    const [main, ...aside] = entry.fullTitle.split(/[()（）]/)
    const tier = hit([entry.id, entry.title, main]) ? 0 : hit(aside) ? 1 : null
    if (tier === null) return null
    const group = GROUP_ORDER.indexOf(entry.group)
    return tier * (GROUP_ORDER.length + 1) + (group === -1 ? GROUP_ORDER.length : group)
  }
  let best: { id: string; score: number } | null = null
  for (const entry of entries) {
    const value = score(entry)
    if (value !== null && (best === null || value < best.score)) best = { id: entry.id, score: value }
  }
  return best?.id ?? null
}

// 地址里拿来认图标的各段：主机名去掉 api./www. 后，先二级域名，再往左逐段，最后是注册域名（x.ai、z.ai 的二级域名只有一个字母，整体才认得出）
// 子域名是常用词时跳过：inference.example.com 不该认成 Inference，inference.net 才是
export function hostCandidates(baseUrl: string): string[] {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    return []
  }
  const labels = hostname.replace(/^(api|www)\./, '').split('.')
  if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label))) return []
  const generic = labels.length >= 3 && ['com', 'net', 'org', 'gov', 'edu', 'ac', 'co'].includes(labels[labels.length - 2])
  const domain = labels.length - (generic ? 3 : 2)
  const subdomains = labels
    .slice(0, domain)
    .reverse()
    .filter((label) => !COMMON_WORDS.has(normalizeName(label)))
  return [labels[domain], ...subdomains, labels.slice(domain).join('.')]
}

// 服务的图标：自选 → 预设 → 名称 → 地址，都不中返回 null（显示首字母方块）
export function providerIconId(provider: Pick<ProviderConfig, 'icon' | 'presetId' | 'name' | 'baseUrl'>, entries: IconEntry[]): string | null {
  if (provider.icon) return provider.icon
  const preset = provider.presetId ? PRESET_ICONS[provider.presetId] : undefined
  if (preset) return preset
  const byName = matchIconName(provider.name, entries)
  if (byName) return byName
  const hosts = hostCandidates(provider.baseUrl)
  // 别名按别名表的顺序在所有段里找，再逐段按清单匹配：dashscope.aliyuncs.com 是百炼，不是阿里云
  const alias = matchAlias(hosts.flatMap(nameWords), normalizeName(hosts.join('')))
  if (alias) return alias
  for (const host of hosts) {
    const id = matchIconName(host, entries)
    if (id) return id
  }
  return null
}

// 模型的图标：按模型 ID 顺序匹配，取第一条；匹配不上返回 null，调用方用服务的图标
export function modelIconId(modelId: string, rules: ModelIconRule[]): string | null {
  const model = modelId.toLowerCase()
  return rules.find((rule) => rule.patterns.some((pattern) => pattern.test(model)))?.id ?? null
}

let loaded: LobeIcons | null = null
let loading: Promise<LobeIcons> | null = null

// 图标组件和清单有几百 KB，不进主界面的入口：第一次用到时再加载，加载完之前返回 null
export function useLobeIcons(): LobeIcons | null {
  const [icons, setIcons] = useState(loaded)
  useEffect(() => {
    if (icons) return
    let active = true
    // 失败只在共享的 promise 上记一次，清空后下次挂载重新加载
    loading ??= import('./lobe-icons').then(
      (module) => {
        loaded = module
        return module
      },
      (error: unknown) => {
        loading = null
        console.error('加载模型图标失败', error)
        throw error
      },
    )
    loading.then(
      (module) => {
        if (active) setIcons(module)
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [icons])
  return icons
}
