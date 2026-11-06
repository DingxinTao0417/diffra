import { randomUUID } from 'node:crypto'
import type { PermissionOption, SessionUpdate, StopReason, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { type LanguageModel, type ModelMessage, streamText, type ToolChoice, type ToolResultPart, type ToolSet } from 'ai'
import { toModelError } from '../models/errors.js'
import { MODEL_CALL_HEADERS } from '../models/operations.js'
import { commandKeys, classifyCommand } from '../permissions.js'
import { truncateLines } from '../process.js'
import { PERMISSION_OPTIONS } from '../protocol.js'
import {
  annotateDiff,
  buildReviewRequest,
  callReviewer,
  parseReviewOutput,
  type ReviewFinding,
  reviewRulePacks,
} from '../rules/review.js'
import { runShell } from '../tools/command.js'
import { ToolError, type ToolContext, type ToolOutput } from '../tools/types.js'
import { staticScan } from '../security/static.js'
import { auditDependencies, dependenciesChanged } from '../security/deps.js'
import { buildLightScanRequest, parseLightScanOutput } from '../security/light.js'
import { type AddedLines, addedLinesOf, blocking, formatFindings, type SecurityFinding } from '../security/types.js'
import type { ModelCallUsage } from '../usage/log.js'
import type { Session } from './session.js'
import { executeTool, isToolName, parseFinishInput, TOOL_KINDS, TOOLS } from './tools.js'

const MAX_STEPS = 50
// 编辑后的快速检查连续失败、或 finish 门禁连续不过，超过次数就停下交给用户
const MAX_CHECK_FAILURES = 3
const MAX_GATE_ATTEMPTS = 3
export const CONTEXT_STOP_RATIO = 0.8
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const CHECK_TIMEOUT_SECONDS = 300

// 主循环和外界（ACP 客户端）打交道的两个口子，测试时可以替换
export interface TurnIO {
  update(update: SessionUpdate): Promise<void>
  // 返回用户选中的 optionId；取消或出错返回 null
  requestPermission(toolCall: ToolCallUpdate, options: PermissionOption[]): Promise<string | null>
  // 每次模型调用结束后记一次用量；记录失败由实现方处理，不影响任务
  recordUsage(call: ModelCallUsage): Promise<void>
}

export interface StepToolCall {
  toolCallId: string
  toolName: string
  input: unknown
  invalid: string | null
}

const PERMISSION_CHOICES: PermissionOption[] = [
  { optionId: PERMISSION_OPTIONS.allowOnce, name: '允许一次', kind: 'allow_once' },
  { optionId: PERMISSION_OPTIONS.allowAlways, name: '本会话内允许同类命令', kind: 'allow_always' },
  { optionId: PERMISSION_OPTIONS.reject, name: '拒绝', kind: 'reject_once' },
]

export async function runTurn(session: Session, turn: { id: string; text: string }, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  const controller = new AbortController()
  session.activeTurn = controller
  const { signal } = controller
  const contextWindow = session.config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW

  try {
    await takeCheckpoint(session, turn.id, io)
    session.messages.push({ role: 'user', content: turn.text })

    let editedThisTurn = false
    let checkFailures = 0
    let gateAttempts = 0

    for (let step = 0; step < MAX_STEPS; step++) {
      const { toolCalls, inputTokens, answered } = await streamStep(session, signal, io)
      if (inputTokens > 0) {
        await io.update({
          sessionUpdate: 'usage_update',
          used: inputTokens,
          size: contextWindow,
          _meta: { diffra: session.usageBreakdown(inputTokens) },
        })
      }

      if (toolCalls.length === 0) {
        // 改了文件却没调 finish：拉回来走完成门禁
        if (editedThisTurn && gateAttempts < MAX_GATE_ATTEMPTS && !signal.aborted) {
          gateAttempts++
          session.messages.push({
            role: 'user',
            content: '[Diffra] You changed files but did not call finish. Verify your changes, then call finish.',
          })
          continue
        }
        return signal.aborted ? 'cancelled' : 'end_turn'
      }

      const results: ToolResultPart[] = []
      let editedThisStep = false
      let finished = false
      for (const call of toolCalls) {
        // 参数不合法的调用，AI SDK 已经在返回消息里补了错误结果；再补一条会让同一调用出现两个结果
        if (answered.has(call.toolCallId)) {
          await reportInvalidCall(call, io)
          continue
        }
        if (signal.aborted) {
          results.push(errorResult(call, 'Cancelled by the user.'))
          continue
        }
        if (call.toolName === 'finish' && !call.invalid) {
          const gate = await runFinishGate(session, call, turn.id, editedThisTurn, signal, io)
          results.push(gate.result)
          if (gate.passed) finished = true
          else gateAttempts++
          continue
        }
        const outcome = await runToolCall(session, call, signal, io)
        results.push(outcome.result)
        if (outcome.edited) {
          editedThisStep = true
          editedThisTurn = true
        }
      }
      if (results.length > 0) session.messages.push({ role: 'tool', content: results })

      if (finished) return 'end_turn'
      if (signal.aborted) return 'cancelled'

      const afterEdit = session.config.checks.afterEdit
      if (editedThisStep && afterEdit) {
        const check = await runCheck(session, afterEdit, '快速检查', signal, io)
        if (signal.aborted) return 'cancelled'
        if (check.passed) {
          checkFailures = 0
        } else {
          checkFailures++
          session.messages.push({
            role: 'user',
            content: `[Diffra] The automatic check \`${afterEdit}\` failed after your edits:\n${check.output}\nFix the problems before continuing.`,
          })
          if (checkFailures >= MAX_CHECK_FAILURES) {
            await notice(io, 'warning', `快速检查连续 ${MAX_CHECK_FAILURES} 次失败，已停止`, '请查看检查输出，或调整任务后再继续。')
            return 'end_turn'
          }
        }
      }
      if (gateAttempts >= MAX_GATE_ATTEMPTS) {
        await notice(io, 'warning', `完成检查连续 ${MAX_GATE_ATTEMPTS} 次没有通过，已停止`, '改动保留在工作区，可以查看后继续或撤销。')
        return 'end_turn'
      }
      if (inputTokens > contextWindow * CONTEXT_STOP_RATIO) {
        await notice(io, 'warning', '上下文已用到 80%，已停止', '上下文压缩还没做，请开一个新会话继续。')
        return 'max_tokens'
      }
    }
    await notice(io, 'warning', `已达到单次任务的步数上限（${MAX_STEPS} 步），已停止`)
    return 'max_turn_requests'
  } catch (error) {
    if (signal.aborted) return 'cancelled'
    const detail = toModelError(error, session.config.model.endpoint.apiKey, 0)
    console.error('[session] 任务出错', error)
    await notice(io, 'error', '模型调用失败', detail.message)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}

export async function takeCheckpoint(session: Session, turnId: string, io: TurnIO): Promise<void> {
  if (!session.checkpoints) return
  try {
    session.turnCheckpoints.set(turnId, await session.checkpoints.snapshot())
  } catch (error) {
    console.error('[session] 检查点创建失败', error)
    await notice(io, 'warning', '检查点创建失败，这一轮的改动无法撤销', error instanceof Error ? error.message : String(error))
  }
}

function streamStep(session: Session, signal: AbortSignal, io: TurnIO) {
  return streamModelStep(
    {
      model: session.model,
      system: session.systemPrompt,
      messages: session.messages,
      tools: TOOLS,
      usage: { role: 'coder', provider: session.config.model.provider, modelId: session.config.model.modelId },
    },
    signal,
    io,
  )
}

export interface StepSettings {
  model: LanguageModel
  system: string
  // 本次调用的回复会追加到这个数组里
  messages: ModelMessage[]
  tools: ToolSet
  toolChoice?: ToolChoice<ToolSet>
  usage: Omit<ModelCallUsage, 'usage'>
}

// 调一次模型：文字和思考实时推给界面，收集工具调用，记用量
export async function streamModelStep(
  settings: StepSettings,
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ toolCalls: StepToolCall[]; inputTokens: number; answered: Set<string> }> {
  const result = streamText({
    model: settings.model,
    system: settings.system,
    messages: settings.messages,
    tools: settings.tools,
    toolChoice: settings.toolChoice,
    maxRetries: 2,
    abortSignal: signal,
    headers: MODEL_CALL_HEADERS,
  })
  const toolCalls: StepToolCall[] = []
  let inputTokens = 0
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        await io.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part.text } })
        break
      case 'reasoning-delta':
        await io.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.text } })
        break
      case 'tool-call':
        toolCalls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          invalid: 'invalid' in part && part.invalid ? String('error' in part ? part.error : 'invalid input') : null,
        })
        break
      case 'finish-step':
        inputTokens = part.usage.inputTokens ?? inputTokens
        await io.recordUsage({ ...settings.usage, usage: part.usage })
        break
      case 'error':
        throw part.error
    }
  }
  const responseMessages = await result.responseMessages
  settings.messages.push(...responseMessages)
  const answered = new Set(
    responseMessages.flatMap((message) =>
      message.role === 'tool' ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : [])) : [],
    ),
  )
  return { toolCalls, inputTokens, answered }
}

export async function reportInvalidCall(call: StepToolCall, io: TurnIO): Promise<void> {
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: call.toolName, kind: 'other', status: 'failed', rawInput: call.input })
  await io.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: call.toolCallId,
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: `参数不合法：${call.invalid ?? '未知错误'}` } }],
  })
}

export async function runToolCall(
  session: Session,
  call: StepToolCall,
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ result: ToolResultPart; edited: boolean }> {
  const name = call.toolName
  const kind = isToolName(name) ? TOOL_KINDS[name] : 'other'
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId: call.toolCallId,
    title: name,
    kind,
    status: 'in_progress',
    rawInput: call.input,
  })

  try {
    if (call.invalid) throw new ToolError(`Invalid call to ${name}: ${call.invalid}`)
    if (!isToolName(name) || name === 'finish') throw new ToolError(`Unknown tool: ${name}`)
    const context: ToolContext = {
      cwd: session.cwd,
      rgPath: session.environment.rgPath,
      bashPath: session.environment.bashPath,
      signal,
      readHashes: session.readHashes,
      trustedCommands: session.trustedCommands,
      readOnlyPaths: session.config.readOnlyPaths,
      requestCommandPermission: (command) => askCommandPermission(session, call.toolCallId, command, io),
    }
    const output = await executeTool(name, call.input, context)
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: 'completed',
      title: output.title ?? name,
      content: toolContent(output),
    })
    return { result: textResult(call, output.text), edited: output.edited ?? false }
  } catch (error) {
    const message = error instanceof ToolError ? error.message : `Tool failed: ${error instanceof Error ? error.message : String(error)}`
    if (!(error instanceof ToolError)) console.error(`[session] 工具 ${name} 出错`, error)
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: message } }],
    })
    return { result: errorResult(call, message), edited: false }
  }
}

async function askCommandPermission(
  session: Session,
  toolCallId: string,
  command: string,
  io: TurnIO,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const decision = classifyCommand(command, {
    cwd: session.cwd,
    trusted: session.trustedCommands,
    alwaysAllowed: session.alwaysAllowed,
    readOnlyPaths: session.config.readOnlyPaths,
    mode: session.permissionMode,
  })
  if (decision.level === 'allow') return { allowed: true }
  if (decision.level === 'deny') {
    return { allowed: false, reason: `This command is blocked by Diffra (${decision.reason}). Do not retry it.` }
  }
  const choice = await io.requestPermission(
    { toolCallId, title: `执行 ${command}`, kind: 'execute', status: 'pending', rawInput: { command } },
    PERMISSION_CHOICES,
  )
  if (choice === PERMISSION_OPTIONS.allowAlways) {
    for (const key of commandKeys(command)) session.alwaysAllowed.add(key)
  }
  if (choice === PERMISSION_OPTIONS.allowOnce || choice === PERMISSION_OPTIONS.allowAlways) return { allowed: true }
  return { allowed: false, reason: 'The user rejected this command. Do not retry it; try another approach or ask the user.' }
}

async function runFinishGate(
  session: Session,
  call: StepToolCall,
  turnId: string,
  editedThisTurn: boolean,
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ result: ToolResultPart; passed: boolean }> {
  let summary = ''
  try {
    summary = parseFinishInput(call.input).summary
  } catch (error) {
    return { result: errorResult(call, error instanceof Error ? error.message : String(error)), passed: false }
  }
  // 先跑完成检查，检查有了结果再显示「完成」卡片，界面上的先后顺序和实际一致
  const showFinish = (status: 'completed' | 'failed', text: string) =>
    io.update({
      sessionUpdate: 'tool_call',
      toolCallId: call.toolCallId,
      title: '完成',
      kind: 'other',
      status,
      rawInput: call.input,
      content: [{ type: 'content', content: { type: 'text', text } }],
    })

  if (!editedThisTurn) {
    await showFinish('completed', summary)
    return { result: textResult(call, 'Done.'), passed: true }
  }
  const command = session.config.checks.beforeFinish ?? session.config.checks.afterEdit
  if (command) {
    const check = await runCheck(session, command, '完成检查', signal, io)
    if (!check.passed) {
      await showFinish('failed', `完成检查没有通过：${command}`)
      return {
        result: errorResult(call, `The check \`${command}\` failed, so the task is not finished:\n${check.output}\nFix the problems and call finish again.`),
        passed: false,
      }
    }
  }
  // 检查通过（或没配检查）之后再做安全检查和规范审查，免得对跑不通的代码提意见
  const diff = await turnDiff(session, turnId, io)
  const security = diff === null ? [] : await runSecurityChecks(session, diff, summary, signal, io)
  if (signal.aborted) return { result: errorResult(call, 'Cancelled by the user.'), passed: false }
  const blockers = blocking(security)
  if (blockers.length > 0) {
    await showFinish('failed', `安全检查发现 ${blockers.length} 处高危问题`)
    const list = blockers.map((item) => `- ${item.ruleId} at ${item.path}:${item.line}: ${item.message}`).join('\n')
    return {
      result: errorResult(
        call,
        `Security checks found high-risk problems in the code you changed, so the task is not finished:\n${list}\n` +
          'Fix them and call finish again. If you are sure a finding is a false positive: for a static-check finding, keep the code and put ' +
          'a comment on that line or the line above in the form "diffra-allow <RULE-ID>: <reason>" (the user sees every such comment); ' +
          'for any other finding, explain in the finish summary why it is safe.',
      ),
      passed: false,
    }
  }
  const findings = diff === null ? [] : await runReview(session, diff, summary, signal, io)
  if (signal.aborted) return { result: errorResult(call, 'Cancelled by the user.'), passed: false }
  if (findings.length > 0) {
    await showFinish('failed', `规范审查发现 ${findings.length} 处问题`)
    const list = findings.map((item) => `- ${item.ruleId} at ${item.path}:${item.line}: ${item.message}`).join('\n')
    return {
      result: errorResult(
        call,
        `The rule review found violations in the code you changed, so the task is not finished:\n${list}\n` +
          'Fix them and call finish again. If you are sure a finding is wrong, keep the code and explain why in the finish summary.',
      ),
      passed: false,
    }
  }
  if (!command) {
    await showFinish('completed', `${summary}\n\n未配置检查命令，改动未经自动验证。`)
    return { result: textResult(call, 'Done. No project checks are configured, so the changes were not verified.'), passed: true }
  }
  await showFinish('completed', summary)
  return { result: textResult(call, `Done. The check \`${command}\` passed.`), passed: true }
}

// 本轮对文件的改动，安全检查和规范审查共用。都没开时不读；没有检查点或读取失败时提示跳过，返回 null
async function turnDiff(session: Session, turnId: string, io: TurnIO): Promise<string | null> {
  const wanted = [
    session.config.security.staticCheck || session.config.security.lightScan ? '安全检查' : null,
    session.config.rules.review && session.rulePacks.length > 0 ? '规范审查' : null,
  ].filter((item): item is string => item !== null)
  if (wanted.length === 0) return null
  const commit = session.turnCheckpoints.get(turnId)
  if (!session.checkpoints || !commit) {
    await notice(io, 'warning', `${wanted.join('和')}需要检查点（Git），这一轮跳过了`)
    return null
  }
  try {
    return await session.checkpoints.diffSince(commit)
  } catch (error) {
    console.error('[session] 读取本轮改动失败', error)
    await notice(io, 'warning', `读取本轮改动失败，${wanted.join('和')}这一轮跳过了`, error instanceof Error ? error.message : String(error))
    return null
  }
}

// 完成前的安全检查：静态检查按规则匹配本轮新增的代码；轻量扫描用评审模型审查改动。
// 检查本身出错时不拦截完成，只在卡片上说明，免得工具出问题时任务永远完不成
async function runSecurityChecks(session: Session, diff: string, summary: string, signal: AbortSignal, io: TurnIO): Promise<SecurityFinding[]> {
  const added = addedLinesOf(diff)
  if (added.size === 0) return []
  const findings: SecurityFinding[] = []
  if (session.config.security.staticCheck) findings.push(...(await runStaticCheck(session, added, signal, io)))
  // 静态检查已经要打回时先不花模型调用，改好之后再扫
  if (session.config.security.lightScan && blocking(findings).length === 0 && !signal.aborted) {
    findings.push(...(await runLightScan(session, diff, added, summary, signal, io)))
  }
  return findings
}

async function runStaticCheck(session: Session, added: AddedLines, signal: AbortSignal, io: TurnIO): Promise<SecurityFinding[]> {
  const toolCallId = `security-static-${randomUUID()}`
  await io.update({ sessionUpdate: 'tool_call', toolCallId, title: '安全检查', kind: 'other', status: 'in_progress' })
  const finishCard = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text } }] })
  try {
    const findings = await staticScan(session.cwd, added)
    if (signal.aborted) return []
    await finishCard(blocking(findings).length > 0 ? 'failed' : 'completed', findings.length > 0 ? formatFindings(findings) : '没有发现常见的高危写法')
    return findings
  } catch (error) {
    console.error('[session] 静态安全检查失败', error)
    await finishCard('failed', `检查没有完成，这次不拦截：${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

// 轻量扫描：评审模型看本轮改动和所在文件，找注入、越权、SSRF 这类问题；依赖文件变了时顺带审计依赖。
// 模型调用或审计失败只在卡片上说明，不拦截
async function runLightScan(
  session: Session,
  rawDiff: string,
  added: AddedLines,
  summary: string,
  signal: AbortSignal,
  io: TurnIO,
): Promise<SecurityFinding[]> {
  const diff = annotateDiff(rawDiff)
  const depsChanged = dependenciesChanged(added)
  if (diff.addedLines.size === 0 && !depsChanged) return []
  const toolCallId = `security-scan-${randomUUID()}`
  await io.update({ sessionUpdate: 'tool_call', toolCallId, title: '安全扫描', kind: 'other', status: 'in_progress' })
  const findings: SecurityFinding[] = []
  const notes: string[] = []
  if (diff.addedLines.size > 0) {
    const reviewer = session.config.reviewModel ?? session.config.model
    try {
      const { text, usage } = await callReviewer(session.reviewModel, await buildLightScanRequest(session.cwd, diff, summary), signal)
      if (usage) await io.recordUsage({ role: 'reviewer', provider: reviewer.provider, modelId: reviewer.modelId, usage })
      findings.push(...parseLightScanOutput(text, diff.addedLines))
      if (diff.truncated) notes.push('改动太多，模型只看了前面一部分')
    } catch (error) {
      if (signal.aborted) return []
      console.error('[session] 安全扫描的模型调用失败', error)
      notes.push(`模型扫描没有完成，这次不拦截：${toModelError(error, reviewer.endpoint.apiKey, 0).message}`)
    }
  }
  if (depsChanged && !signal.aborted) {
    const audit = await auditDependencies(session.cwd, added, session.environment.bashPath, signal)
    findings.push(...audit.findings)
    notes.push(...audit.notes)
  }
  if (signal.aborted) return []
  const text = [findings.length > 0 ? formatFindings(findings) : '没有发现安全问题', ...notes].join('\n')
  await io.update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: blocking(findings).length > 0 ? 'failed' : 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  })
  return findings
}

// 完成前的规范审查。没开审查、没有选中的规则包、这一轮没改代码文件时跳过；
// 审查调用本身失败不拦截完成，只在卡片上说明，避免评审模型出问题时任务永远完不成
async function runReview(session: Session, rawDiff: string, summary: string, signal: AbortSignal, io: TurnIO): Promise<ReviewFinding[]> {
  if (!session.config.rules.review || session.rulePacks.length === 0) return []
  const toolCallId = `review-${randomUUID()}`
  let cardShown = false
  const showCard = async () => {
    if (cardShown) return
    cardShown = true
    await io.update({ sessionUpdate: 'tool_call', toolCallId, title: '规范审查', kind: 'other', status: 'in_progress' })
  }
  const finishCard = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text } }] })
  try {
    const diff = annotateDiff(rawDiff)
    const packs = reviewRulePacks(session.rulePacks, [...diff.addedLines.keys()])
    if (diff.addedLines.size === 0 || packs.length === 0) return []
    await showCard()
    const { text: output, usage } = await callReviewer(session.reviewModel, buildReviewRequest(packs, diff, summary), signal)
    if (usage) {
      const reviewer = session.config.reviewModel ?? session.config.model
      await io.recordUsage({ role: 'reviewer', provider: reviewer.provider, modelId: reviewer.modelId, usage })
    }
    const ruleIds = new Set(packs.flatMap((pack) => pack.rules.map((rule) => rule.id)))
    const findings = parseReviewOutput(output, ruleIds, diff.addedLines)
    const partial = diff.truncated ? '\n（改动太多，只审查了前面一部分）' : ''
    await finishCard(
      findings.length > 0 ? 'failed' : 'completed',
      findings.length > 0
        ? `${findings.map((item) => `${item.ruleId}  ${item.path}:${item.line}  ${item.message}`).join('\n')}${partial}`
        : `没有发现违反规范的地方${partial}`,
    )
    return findings
  } catch (error) {
    if (signal.aborted) return []
    const apiKey = (session.config.reviewModel ?? session.config.model).endpoint.apiKey
    console.error('[session] 规范审查失败', error)
    await showCard()
    await finishCard('failed', `审查没有完成，这次不拦截：${toModelError(error, apiKey, 0).message}`)
    return []
  }
}

async function runCheck(
  session: Session,
  command: string,
  label: string,
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ passed: boolean; output: string }> {
  const toolCallId = `check-${randomUUID()}`
  await io.update({ sessionUpdate: 'tool_call', toolCallId, title: `${label}：${command}`, kind: 'execute', status: 'in_progress' })
  try {
    const result = await runShell({ cwd: session.cwd, bashPath: session.environment.bashPath, signal }, command, CHECK_TIMEOUT_SECONDS)
    const passed = result.exitCode === 0 && !result.timedOut && !result.aborted
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: passed ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: result.summary } }],
    })
    return { passed, output: truncateLines(result.summary, 120, 8000) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: message } }],
    })
    return { passed: false, output: message }
  }
}

function toolContent(output: ToolOutput): ToolCallContent[] {
  if (output.diff) return [{ type: 'diff', ...output.diff }]
  return [{ type: 'content', content: { type: 'text', text: output.terminalOutput ?? output.text } }]
}

export function textResult(call: StepToolCall, text: string): ToolResultPart {
  return { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: text } }
}

export function errorResult(call: StepToolCall, text: string): ToolResultPart {
  return { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'error-text', value: text } }
}

export function notice(io: TurnIO, severity: 'info' | 'warning' | 'error', title: string, description?: string): Promise<void> {
  return io.update({ sessionUpdate: 'notice', severity, title, description: description ?? null })
}
