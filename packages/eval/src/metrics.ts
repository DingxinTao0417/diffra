import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate } from '@diffra/core/types'

const CHECK_PREFIXES = ['快速检查：', '完成检查：']
// 静态检查、轻量扫描以前叫安全检查、安全扫描，旧的会话记录里还是旧标题，两套都认
const SECURITY_CARDS = new Set(['静态检查', '轻量扫描', '安全检查', '安全扫描', '深度扫描报告'])
const CARD_TITLES = new Set(['完成', '规范审查', '上下文压缩', ...SECURITY_CARDS])
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
  // 智能体自己调用的工具（读、搜、改、命令），不含检查和各种卡片（包括上下文压缩）
  toolCalls: number
  // 「完成」被门禁打回的次数，含完成条件未满足和证据不合格的打回；和语义层第 57 步之前的结果比，数字会偏高
  gateRejections: number
  checkFailures: number
  findings: Finding[]
  notices: string[]
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

// 从这一轮收到的会话更新里数出步数、打回次数、安全卡片报的问题
export function turnMetrics(updates: SessionUpdate[]): TurnMetrics {
  const titles = new Map<string, string>()
  const finalStatus = new Map<string, string>()
  const finalText = new Map<string, string>()
  const notices: string[] = []
  for (const update of updates) {
    if (update.sessionUpdate === 'tool_call') titles.set(update.toolCallId, update.title)
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (update.status) finalStatus.set(update.toolCallId, update.status)
      const text = textOf(update)
      if (text) finalText.set(update.toolCallId, text)
    }
    if (update.sessionUpdate === 'notice') notices.push(update.title)
  }
  let toolCalls = 0
  let gateRejections = 0
  let checkFailures = 0
  const findings: Finding[] = []
  for (const [id, title] of titles) {
    const status = finalStatus.get(id)
    const isCheck = CHECK_PREFIXES.some((prefix) => title.startsWith(prefix))
    if (title === '完成' && status === 'failed') gateRejections++
    else if (isCheck && status === 'failed') checkFailures++
    if (SECURITY_CARDS.has(title)) findings.push(...parseFindings(title, finalText.get(id) ?? ''))
    if (!isCheck && !CARD_TITLES.has(title)) toolCalls++
  }
  return { toolCalls, gateRejections, checkFailures, findings, notices }
}

export interface UsageTotals {
  calls: number
  coderCalls: number
  reviewerCalls: number
  inputTokens: number
  outputTokens: number
}

// 这道题的 core 进程写下的用量记录（每次模型调用一行）
export function usageTotals(usageDir: string): UsageTotals {
  const totals: UsageTotals = { calls: 0, coderCalls: 0, reviewerCalls: 0, inputTokens: 0, outputTokens: 0 }
  if (!existsSync(usageDir)) return totals
  for (const name of readdirSync(usageDir)) {
    for (const line of readFileSync(join(usageDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const record = JSON.parse(line) as { role: string; input: number | null; output: number | null }
      totals.calls++
      if (record.role === 'coder') totals.coderCalls++
      else totals.reviewerCalls++
      totals.inputTokens += record.input ?? 0
      totals.outputTokens += record.output ?? 0
    }
  }
  return totals
}
