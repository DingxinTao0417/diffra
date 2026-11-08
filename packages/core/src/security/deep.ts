import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StopReason } from '@agentclientprotocol/sdk'
import { tool } from 'ai'
import { z } from 'zod'
import { toModelError } from '../models/errors.js'
import { annotateDiff } from '../rules/review.js'
import { DEFAULT_CONTEXT_WINDOW, notice, takeCheckpoint, taskStateUpdate, type TurnIO } from '../session/loop.js'
import { runReadOnlyLoop } from '../session/read-only.js'
import type { Session } from '../session/session.js'
import { TOOLS } from '../session/tools.js'
import { SECURITY_CATEGORIES } from './light.js'

export type DeepScanScope = 'task' | 'project'

export const DEEP_SCAN_TITLES: Record<DeepScanScope, string> = {
  task: '深度安全扫描 · 本任务改动',
  project: '深度安全扫描 · 整个项目',
}

const MAX_STEPS = 40
const MAX_FINDINGS = 20
const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search'])
const CATEGORY_IDS = new Set(SECURITY_CATEGORIES.map(([id]) => id))

const reportInput = z.object({
  summary: z.string().describe('One or two sentences in Chinese: what you checked and the overall result'),
  findings: z
    .array(
      z.object({
        severity: z.enum(['high', 'medium', 'low']),
        ruleId: z.string().describe('Category ID, e.g. SEC-INJ-1'),
        path: z.string().describe('File where the fix belongs, relative to the project root'),
        line: z.number().int().positive(),
        problem: z.string().describe('What is wrong, in Chinese'),
        flow: z.string().describe('How untrusted data gets there, in Chinese, as "path:line 说明 → path:line 说明"'),
        fix: z.string().describe('How to fix it, in Chinese'),
      }),
    )
    .max(MAX_FINDINGS),
})

// 只读：能看代码、搜索，不能改文件、不能执行命令
const DEEP_TOOLS = {
  read_file: TOOLS.read_file,
  list_files: TOOLS.list_files,
  search: TOOLS.search,
  report: tool({ description: 'Finish the audit and report the problems you confirmed. Call it exactly once, at the end.', inputSchema: reportInput }),
}

const AUDITOR_PROMPT = [
  'You are a security auditor working inside a code repository. You can only read: use list_files, search and read_file. ' +
    'You cannot change files or run commands.',
  'Method: find where untrusted data enters (HTTP parameters, body, headers, cookies, uploaded files, CLI arguments, environment, ' +
    'messages, database rows written by users), then follow it across files and functions to dangerous operations: SQL, shell commands, ' +
    'eval, file paths, outgoing URLs and redirects, HTML output, deserialization. Also check that endpoints and user-owned data have ' +
    'authentication and authorization, and look for hard-coded secrets, weak cryptography and insecure randomness.',
  'Confirm each problem by reading the code on the whole path. Do not report style issues, missing tests or guesses. ' +
    'Report the line where the fix belongs. Prefer a few confirmed problems over many possible ones.',
  'Severity: high = exploitable with external input, or a real secret leak; medium = risky but needs specific conditions; low = hardening.',
  '',
  'Categories (use the ID):',
  ...SECURITY_CATEGORIES.map(([id, description]) => `${id}: ${description}`),
  '',
  'When you are done, call report exactly once. Write summary, problem, flow and fix in Chinese.',
].join('\n')

// 扫描从哪里开始：本任务改动从第一轮之前的快照取 diff；整个项目从入口找起
async function scanBrief(session: Session, scope: DeepScanScope): Promise<string> {
  const projectBrief =
    'Audit the whole project. Start by finding entry points: HTTP routes and handlers, RPC or message handlers, CLI argument ' +
    'parsing, file upload handling, and authentication middleware. Then trace untrusted input from them.'
  if (scope === 'project') return projectBrief
  const firstTurn = session.turns.find((turn) => turn.kind === 'prompt')
  const commit = firstTurn ? session.turnCheckpoints.get(firstTurn.id) : undefined
  if (!session.checkpoints || !commit) return `${projectBrief}\n(The changes of this task are not available, so audit the project instead.)`
  const diff = annotateDiff(await session.checkpoints.diffSince(commit))
  if (diff.addedLines.size === 0) return `${projectBrief}\n(This task did not change any code files yet.)`
  return [
    'Audit the code changed in this task. Start from the changed lines below: find where their inputs come from and where their ' +
      'outputs go, following calls across files. Also check code the change calls into.',
    '',
    'Changes of this task (line numbers refer to the current files):',
    diff.text,
    ...(diff.truncated ? ['(The diff was cut off here because it is too long.)'] : []),
  ].join('\n')
}

// 用户在任务页手动发起的只读审计。跑在一轮里（进度实时显示、能停止、会存进历史），
// 但审计过程不进编码模型的对话：报告交给用户，用户勾选后再作为新的一轮发给编码模型
export async function runDeepScan(session: Session, turn: { id: string }, scope: DeepScanScope, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  const controller = new AbortController()
  session.activeTurn = controller
  const { signal } = controller
  const reviewer = session.config.reviewModel ?? session.config.model
  const contextWindow = session.config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  try {
    await takeCheckpoint(session, turn.id, io)
    // 撤销到这一轮时按这一份恢复待验证
    await io.update(taskStateUpdate(session))
    const outcome = await runReadOnlyLoop(
      session,
      {
        model: session.reviewModel,
        system: AUDITOR_PROMPT,
        messages: [{ role: 'user', content: await scanBrief(session, scope) }],
        tools: DEEP_TOOLS,
        readTools: READ_ONLY_TOOLS,
        finalTool: 'report',
        maxSteps: MAX_STEPS,
        window: contextWindow,
        usage: { role: 'reviewer', provider: reviewer.provider, modelId: reviewer.modelId },
        nudge: 'Keep auditing with the tools, or call report when you are done.',
        readOnlyError: 'This audit is read-only. Use read_file, list_files, search or report.',
        onFinal: (toolCallId, input) => showReport(session, toolCallId, reportInput.parse(input), io),
      },
      signal,
      io,
    )
    if (outcome === 'cancelled') return 'cancelled'
    if (outcome === 'done') return 'end_turn'
    await notice(io, 'warning', `深度扫描达到步数上限（${MAX_STEPS} 步），没有给出报告`)
    return 'max_turn_requests'
  } catch (error) {
    if (signal.aborted) return 'cancelled'
    console.error('[security] 深度扫描失败', error)
    await notice(io, 'error', '深度扫描失败', toModelError(error, reviewer.endpoint.apiKey, 0).message)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}

const LEVELS = { high: '高危', medium: '提醒', low: '提醒' } as const

// 报告卡片：第一行是总结，然后每个问题一行（和安全检查卡片同样的格式），下面跟链路和修复建议
async function showReport(session: Session, toolCallId: string, report: z.infer<typeof reportInput>, io: TurnIO): Promise<void> {
  const lines = [report.summary.trim() || '扫描完成']
  let kept = 0
  for (const finding of report.findings) {
    const path = finding.path.replace(/\\/g, '/').replace(/^\.\//, '')
    // 规则号不存在、文件不在项目里的当作臆测丢掉
    if (!CATEGORY_IDS.has(finding.ruleId) || !(await isProjectFile(session.cwd, path))) continue
    lines.push(`${LEVELS[finding.severity]}  ${finding.ruleId}  ${path}:${finding.line}  ${finding.problem.trim()}`)
    if (finding.flow.trim()) lines.push(`  链路：${finding.flow.trim()}`)
    if (finding.fix.trim()) lines.push(`  修复：${finding.fix.trim()}`)
    kept++
  }
  if (kept === 0) lines.push('没有发现可以确认的安全问题')
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: '深度扫描报告',
    kind: 'other',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }],
  })
}

async function isProjectFile(cwd: string, path: string): Promise<boolean> {
  if (path.startsWith('/') || path.includes('..')) return false
  return (await stat(join(cwd, path)).catch(() => null))?.isFile() ?? false
}
