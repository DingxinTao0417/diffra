import type { SessionUpdate } from '@diffra/core/types'
import type { EvalEvent } from './conversation.ts'

// 把一次运行的事件写成给人（和审记录的 Claude）看的过程记录（第 615 步）：用户说的话、智能体的说明和思考、
// 每次工具调用的输入输出、确认和提问怎么答的、提示、每一轮怎么结束的，都带开始后第几秒
const MAX_THOUGHT_CHARS = 1500
const MAX_INPUT_CHARS = 1200
const MAX_OUTPUT_CHARS = 1500

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…（共 ${text.length} 字，后面省略）` : text)
const second = (ms: number) => `${(ms / 1000).toFixed(0)}s`
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n')
const fence = (text: string) => `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``

interface ToolEntry {
  title: string
  kind: string
  status: string
  input: string
  output: string
  worker: boolean
}

function contentText(update: SessionUpdate): string {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return ''
  return (update.content ?? []).flatMap((item) => (item.type === 'content' && item.content.type === 'text' ? [item.content.text] : item.type === 'diff' ? [`（改了 ${item.path}）`] : [])).join('\n')
}

function inputText(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'object' && 'cmd' in raw && typeof raw.cmd === 'string') return raw.cmd
  if (typeof raw === 'object' && 'input' in raw && typeof raw.input === 'string') return raw.input
  return JSON.stringify(raw, null, 1)
}

export function renderTranscript(title: string, events: EvalEvent[]): string {
  const out: string[] = [`# ${title}`, '']
  const tools = new Map<string, ToolEntry>()
  // 按第一次出现的位置排；之后的更新改同一条
  type Block = { kind: 'text'; at: number; label: string; text: string } | { kind: 'tool'; at: number; id: string } | { kind: 'line'; at: number; text: string }
  const blocks: Block[] = []
  let open: Extract<Block, { kind: 'text' }> | null = null
  for (const event of events) {
    if (event.type === 'update') {
      const update = event.update
      if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
        const label = update.sessionUpdate === 'agent_message_chunk' ? '智能体' : '思考'
        const text = update.content.type === 'text' ? update.content.text : ''
        if (open && open.label === label) open.text += text
        else {
          open = { kind: 'text', at: event.at, label, text }
          blocks.push(open)
        }
        continue
      }
      open = null
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        let entry = tools.get(update.toolCallId)
        if (!entry) {
          const diffra = update._meta?.diffra
          entry = { title: '', kind: '', status: '', input: '', output: '', worker: typeof diffra === 'object' && diffra !== null && 'parentToolCallId' in diffra }
          tools.set(update.toolCallId, entry)
          blocks.push({ kind: 'tool', at: event.at, id: update.toolCallId })
        }
        if (update.title) entry.title = update.title
        if (update.kind) entry.kind = update.kind
        if (update.status) entry.status = update.status
        const input = inputText(update.rawInput)
        if (input) entry.input = input
        const output = contentText(update)
        if (output) entry.output = output
        continue
      }
      if (update.sessionUpdate === 'notice') {
        blocks.push({ kind: 'line', at: event.at, text: `**[提示 ${update.severity}]** ${update.title}${update.description ? `：${update.description}` : ''}` })
      }
      continue
    }
    open = null
    if (event.type === 'turn') blocks.push({ kind: 'line', at: event.at, text: `## 第 ${event.index + 1} 轮${event.goal ? '（目标模式）' : ''}\n\n**用户**：\n\n${quote(event.text)}` })
    else if (event.type === 'permission')
      blocks.push({ kind: 'line', at: event.at, text: `**[${event.question ? '提问' : '确认'}]** ${event.title}\n选项：${event.options.join(' / ')} → 答：**${event.answer}**` })
    else if (event.type === 'cancel') blocks.push({ kind: 'line', at: event.at, text: '**[用户点了停止]**' })
    else blocks.push({ kind: 'line', at: event.at, text: `**[这一轮结束]** ${event.stopReason ?? ''}${event.error ? ` 出错：${event.error}` : ''}` })
  }
  for (const block of blocks) {
    if (block.kind === 'line') out.push(`\`${second(block.at)}\` ${block.text}`, '')
    else if (block.kind === 'text') {
      const text = block.text.trim()
      if (!text) continue
      out.push(block.label === '思考' ? `\`${second(block.at)}\` *思考*：\n\n${quote(clip(text, MAX_THOUGHT_CHARS))}` : `\`${second(block.at)}\` **智能体**：${text}`, '')
    } else {
      const entry = tools.get(block.id)
      if (!entry) continue
      const status = entry.status === 'completed' ? '完成' : entry.status === 'failed' ? '失败' : entry.status || '—'
      out.push(`\`${second(block.at)}\` ${entry.worker ? '↳ 子智能体 ' : ''}**[${entry.title || entry.kind}]** ${status}`)
      if (entry.input && entry.input !== entry.title) out.push('输入：', fence(clip(entry.input, MAX_INPUT_CHARS)))
      if (entry.output) out.push('输出：', fence(clip(entry.output, MAX_OUTPUT_CHARS)))
      out.push('')
    }
  }
  return `${out.join('\n')}\n`
}
