import { randomUUID } from 'node:crypto'
import type { StopReason } from '@agentclientprotocol/sdk'
import { publishTaskState, runToolCall, type StepToolCall, takeCheckpoint, type TurnIO } from './loop.js'
import type { Session } from './session.js'

// 回答里的 diff 直接应用（第 686 步）：把 unified diff 换成 apply_patch 的写法，走和模型改文件一样的工具（权限、禁写目录、受保护文件、
// 改动卡片），这一轮开头打检查点，能撤销；记成一轮 apply。完了往模型的对话里补一句：用户应用了哪段补丁、结果如何，它下一轮知道文件变了

// unified diff → apply_patch。只认写了文件名（--- a/x、+++ b/x）的；/dev/null 那边是新建或删除
export function unifiedToPatch(diff: string): string {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const sections: string[] = []
  let index = 0
  const pathOf = (line: string) => {
    const raw = line.slice(4).replace(/\t.*$/, '').trim()
    return raw === '/dev/null' ? null : raw.replace(/^[ab]\//, '')
  }
  while (index < lines.length) {
    const line = lines[index]!
    if (!line.startsWith('--- ') || !lines[index + 1]?.startsWith('+++ ')) {
      index++
      continue
    }
    const from = pathOf(line)
    const to = pathOf(lines[index + 1]!)
    index += 2
    const body: string[] = []
    while (index < lines.length && !(lines[index]!.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) && !lines[index]!.startsWith('diff --git ')) {
      const current = lines[index]!
      if (current.startsWith('@@')) body.push('@@')
      else if (/^[ +-]/.test(current)) body.push(current)
      else if (current === '') body.push(' ')
      index++
    }
    // 结尾那一行空行是 split 出来的，不是内容
    while (body.at(-1) === ' ') body.pop()
    if (to === null && from !== null) sections.push(`*** Delete File: ${from}`)
    else if (from === null && to !== null) sections.push(`*** Add File: ${to}`, ...body.filter((item) => item.startsWith('+')))
    else if (to !== null) sections.push(`*** Update File: ${to}`, ...body)
  }
  if (sections.length === 0) throw new Error('这段 diff 没写文件名（--- a/文件 和 +++ b/文件），不知道改哪个文件')
  return ['*** Begin Patch', ...sections, '*** End Patch'].join('\n')
}

export async function runApplyDiff(session: Session, diff: string, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  const turnId = session.turns.at(-1)?.id
  const controller = session.activateTurn()
  try {
    const patch = unifiedToPatch(diff)
    if (turnId) await takeCheckpoint(session, turnId, io)
    const call: StepToolCall = { toolCallId: `apply-${randomUUID()}`, toolName: 'apply_patch', input: { input: patch } } as StepToolCall
    const outcome = await runToolCall(session, call, controller.signal, io)
    const output = outcome.result.output as { type: string; value: unknown }
    const failed = output.type === 'error-text'
    session.messages.push({
      role: 'user',
      content: `[Note from Diffra] The user applied a patch from your earlier answer directly to the project files. ${failed ? `It failed: ${String(output.value)}` : 'It applied cleanly; read the files again before editing them further.'}\n\n${patch}`,
    })
    if (outcome.edited) session.taskState = { ...session.taskState, status: 'blocked', reason: '应用了回答里的补丁，还没跑检查。' }
    await publishTaskState(session, io)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}
