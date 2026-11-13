import type { StopReason } from '@agentclientprotocol/sdk'
import { tool } from 'ai'
import { z } from 'zod'
import { toModelError } from '../models/errors.js'
import { DEFAULT_CONTEXT_WINDOW, notice, takeCheckpoint, taskStateUpdate, type TurnIO } from './loop.js'
import { READ_ONLY_TOOL_NAMES, READ_ONLY_TOOLS, runReadOnlyLoop } from './read-only.js'
import { pendingWorldState } from './world-state.js'
import type { Session } from './session.js'

const MAX_STEPS = 30
const READ_TOOLS = READ_ONLY_TOOL_NAMES

const planInput = z.object({
  understanding: z.string().describe("What the user wants, in your own words, in the user's language"),
  steps: z
    .array(
      z.object({
        title: z.string().describe('What this step does'),
        detail: z.string().describe('How: which functions or behaviour change, and how to verify the step'),
        files: z.array(z.string()).describe('Files this step changes or adds, relative to the project root'),
      }),
    )
    .min(1)
    .max(20),
  risks: z.array(z.string()).describe('Existing behaviour that may break, and questions the user should answer before work starts. Empty if none.'),
})

type Plan = z.infer<typeof planInput>

// 只读：用 exec_command 跑只读命令（rg、sed -n、cat、ls、git log 这类）看代码、搜索，不能改文件
const PLAN_TOOLS = {
  ...READ_ONLY_TOOLS,
  submit_plan: tool({ description: 'Submit the plan. Call it exactly once, at the end.', inputSchema: planInput }),
}

// 接在编码的系统提示词后面（带着项目规则和编码规范），说明这一轮只读、最后交计划
const PLANNING_MODE = [
  '',
  'PLANNING MODE: this turn only plans the task; nothing gets changed yet.',
  '- You can only read: run read-only commands with exec_command (rg, rg --files, sed -n, cat, ls, git log). You cannot change files.',
  '- Explore enough to make the plan concrete: which files and functions change and how, in what order, and how to verify each step.',
  '- Keep the steps small and ordered. Follow the AGENTS.md instructions and the coding rules.',
  '- When the plan is ready, call submit_plan exactly once. Write it in the language the user writes in.',
].join('\n')

// 用户打开「先出计划」时的一轮：规划模型只读地看代码，交一份计划。跑在一轮里（进度实时显示、能停止、存进历史），
// 但探索过程不进编码模型的对话；用户改好计划、点「按计划执行」后，计划作为新的一轮发给编码模型
export async function runPlan(session: Session, turn: { id: string; text: string }, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  const controller = session.activateTurn()
  const { signal } = controller
  const planner = session.config.planModel ?? session.config.model
  try {
    await takeCheckpoint(session, turn.id, io)
    // 撤销到这一轮时按这一份恢复待验证
    await io.update(taskStateUpdate(session))
    const outcome = await runReadOnlyLoop(
      session,
      {
        model: session.planModel,
        system: `${session.systemPrompt}\n${PLANNING_MODE}`,
        // 看得到之前的对话，接着已有任务出计划不会脱节
        messages: [...session.contextMessages(), ...(await pendingWorldState(session)), { role: 'user', content: turn.text }],
        tools: PLAN_TOOLS,
        readTools: READ_TOOLS,
        finalTool: 'submit_plan',
        maxSteps: MAX_STEPS,
        window: planner.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        usage: { role: 'planner', provider: planner.provider, modelId: planner.modelId },
        nudge: 'Keep exploring with the read tools, or call submit_plan when the plan is ready.',
        readOnlyError: 'This is planning mode: you can only read. Use exec_command with read-only commands, or submit_plan.',
        onFinal: (toolCallId, input) => showPlan(toolCallId, planInput.parse(input), io),
      },
      signal,
      io,
    )
    if (outcome === 'cancelled') return 'cancelled'
    if (outcome === 'done') return 'end_turn'
    await notice(io, 'warning', `出计划达到步数上限（${MAX_STEPS} 步），没有给出计划`)
    return 'max_turn_requests'
  } catch (error) {
    if (signal.aborted) return 'cancelled'
    console.error('[session] 出计划失败', error)
    await notice(io, 'error', '出计划失败', toModelError(error, planner.endpoint.apiKey, 0).message)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}

// 计划写成一段文字：界面上可以直接改，改完原样发给编码模型
export function formatPlan(plan: Plan): string {
  const lines = [plan.understanding.trim(), '']
  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title.trim()}`)
    for (const line of step.detail.trim().split('\n')) if (line.trim()) lines.push(`   ${line.trim()}`)
    if (step.files.length > 0) lines.push(`   涉及：${step.files.join('、')}`)
  })
  const risks = plan.risks.map((risk) => risk.trim()).filter(Boolean)
  if (risks.length > 0) lines.push('', '风险和需要确认的问题：', ...risks.map((risk) => `- ${risk}`))
  return lines.join('\n')
}

async function showPlan(toolCallId: string, plan: Plan, io: TurnIO): Promise<void> {
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: '计划',
    kind: 'think',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: formatPlan(plan) } }],
  })
}
