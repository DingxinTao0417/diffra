import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate, TurnOutcome, UsagePrice, UsageRecord } from '@diffra/core/types'
import { coreTypes } from './core.ts'

const CHECK_PREFIXES = ['快速检查：', '完成检查：']
// 静态检查、轻量扫描以前叫安全检查、安全扫描，旧的会话记录里还是旧标题，两套都认
const SECURITY_CARDS = new Set(['静态检查', '轻量扫描', '安全检查', '安全扫描', '深度扫描报告'])
const CARD_TITLES = new Set(['完成', '规范审查', '上下文压缩', '步骤', ...SECURITY_CARDS])
// 派出去的工人的卡片标题是「子智能体 名字」；没派成的只有「子智能体」
const WORKER_CARD_PREFIX = '子智能体'
// 安全卡片、深度扫描报告的一行：级别  规则号  路径:行号  说明
const FINDING_LINE = /^(高危|提醒|已放行) {2}(\S+) {2}(\S+):(\d+) {2}(.+)$/

export interface Finding {
  card: string
  level: string
  ruleId: string
  path: string
  line: number
  message: string
}

export interface TurnMetrics {
  // 智能体自己调用的工具（读、搜、改、命令），不含检查和各种卡片（包括上下文压缩、子智能体的卡片）；子智能体调用的也算在内
  toolCalls: number
  // 其中子智能体调用的
  workerToolCalls: number
  // 派出了几个子智能体（没派成的不算）
  delegations: number
  findings: Finding[]
  notices: string[]
  // 因模型接口出错停下的轮次的错误类型（core 照样回 end_turn）：不是智能体说做完了，是半路断了
  modelErrors: string[]
}

function textOf(update: SessionUpdate): string {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return ''
  return (update.content ?? []).flatMap((item) => (item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [])).join('\n')
}

export function parseFindings(card: string, text: string): Finding[] {
  return text.split('\n').flatMap((line) => {
    const match = FINDING_LINE.exec(line)
    return match ? [{ card, level: match[1] ?? '', ruleId: match[2] ?? '', path: match[3] ?? '', line: Number(match[4]), message: match[5] ?? '' }] : []
  })
}

// 从这一轮收到的会话更新里数出步数、安全卡片报的问题
export function turnMetrics(updates: SessionUpdate[]): TurnMetrics {
  const titles = new Map<string, string>()
  const finalText = new Map<string, string>()
  const notices: string[] = []
  const byWorker = new Set<string>()
  const modelErrors: string[] = []
  for (const update of updates) {
    if (update.sessionUpdate === 'session_info_update') {
      const outcome = (update._meta?.diffra as { turnOutcome?: TurnOutcome } | undefined)?.turnOutcome
      if (outcome?.stop === 'model-error') modelErrors.push(outcome.errorKind ?? 'unknown')
    }
    if (update.sessionUpdate === 'tool_call') {
      titles.set(update.toolCallId, update.title)
      const diffra = update._meta?.diffra
      if (typeof diffra === 'object' && diffra !== null && 'parentToolCallId' in diffra) byWorker.add(update.toolCallId)
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const text = textOf(update)
      if (text) finalText.set(update.toolCallId, text)
    }
    if (update.sessionUpdate === 'notice') notices.push(update.title)
  }
  let toolCalls = 0
  let workerToolCalls = 0
  let delegations = 0
  const findings: Finding[] = []
  for (const [id, title] of titles) {
    const isCheck = CHECK_PREFIXES.some((prefix) => title.startsWith(prefix))
    if (SECURITY_CARDS.has(title)) findings.push(...parseFindings(title, finalText.get(id) ?? ''))
    if (title.startsWith(WORKER_CARD_PREFIX)) {
      if (title.length > WORKER_CARD_PREFIX.length) delegations++
      continue
    }
    if (isCheck || CARD_TITLES.has(title)) continue
    toolCalls++
    if (byWorker.has(id)) workerToolCalls++
  }
  return { toolCalls, workerToolCalls, delegations, findings, notices, modelErrors }
}

export interface UsageTotals {
  // 按配置里的单价算的费用（v2）；没配单价是 null
  cost: string | null
  calls: number
  coderCalls: number
  reviewerCalls: number
  // 子智能体的模型调用和它们用掉的 token（已经算在总数里）
  subagentCalls: number
  subagentTokens: number
  inputTokens: number
  outputTokens: number
}

// 这道题的 core 进程写下的用量记录（每次模型调用一行）
export function usageTotals(usageDir: string, prices: readonly UsagePrice[] = []): UsageTotals {
  const totals: UsageTotals = { cost: null, calls: 0, coderCalls: 0, reviewerCalls: 0, subagentCalls: 0, subagentTokens: 0, inputTokens: 0, outputTokens: 0 }
  if (!existsSync(usageDir)) return totals
  const book = prices.length > 0 ? new coreTypes.PriceBook(prices) : null
  let cost = 0n
  for (const name of readdirSync(usageDir)) {
    for (const line of readFileSync(join(usageDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const record = JSON.parse(line) as UsageRecord
      const priced = book?.cost(record) ?? null
      if (priced !== null) cost += priced
      totals.calls++
      if (record.role === 'coder') totals.coderCalls++
      else if (record.role === 'subagent') {
        totals.subagentCalls++
        totals.subagentTokens += (record.input ?? 0) + (record.output ?? 0)
      } else totals.reviewerCalls++
      totals.inputTokens += record.input ?? 0
      totals.outputTokens += record.output ?? 0
    }
  }
  if (book) totals.cost = coreTypes.formatCost(cost)
  return totals
}
