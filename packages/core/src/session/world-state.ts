import type { ModelMessage } from 'ai'
import type { PermissionMode } from '../protocol.js'
import { loadProjectDocs, renderProjectDocs } from './agents-md.js'
import type { Session } from './session.js'

// 世界状态（第 511 步，参照 Codex 的 world state）：环境（目录、shell、日期、权限模式）和项目说明文件不放进系统提示词，
// 作为对话里的上下文消息发给模型。第一次发全量，之后每一步只发变了的部分，系统提示词和前面的对话不变，提示缓存一直命中。
// 每一节记在发它的那条消息上；那条消息被压缩掉、撤销截掉之后，这一节算模型不知道，下次重新发全量

export interface WorldState {
  environment: string
  // 没有说明文件时是 null
  agentsMd: string | null
}

type Section = keyof WorldState

export interface WorldStateEntry {
  index: number
  message: ModelMessage
  // 这条消息告诉了模型哪几节、当时的值
  values: Partial<WorldState>
}

export const WORLD_STATE_MARKER = '[Diffra] Context'

const PERMISSION_TEXT: Record<PermissionMode, string> = {
  ask: 'Commands that only read run without asking. Other commands need the user\'s approval; Diffra asks automatically when you run them.',
  auto: 'Most commands run without asking. Risky ones (installing packages, network access, git push or reset, deleting files) need the user\'s approval; Diffra asks automatically when you run them.',
  full: 'Commands run without asking, except dangerous ones that are always blocked and changes under read-only paths.',
}

function osName(): string {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform
}

// 日期按本机时区算
function today(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function environmentContext(session: Pick<Session, 'cwd' | 'environment' | 'permissionMode' | 'config'>): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const shell = session.environment.bashPath
    ? process.platform === 'win32'
      ? 'bash (Git Bash: use bash syntax and forward slashes)'
      : 'bash'
    : 'none (bash was not found, so commands cannot run)'
  const readOnly = session.config.readOnlyPaths
  return [
    '<environment_context>',
    `  <cwd>${session.cwd}</cwd>`,
    `  <operating_system>${osName()}</operating_system>`,
    `  <shell>${shell}</shell>`,
    `  <current_date>${today(timeZone)}</current_date>`,
    `  <timezone>${timeZone}</timezone>`,
    `  <approvals>${PERMISSION_TEXT[session.permissionMode]}</approvals>`,
    ...(readOnly.length > 0 ? [`  <read_only_paths>${readOnly.join(', ')}</read_only_paths>`] : []),
    '</environment_context>',
  ].join('\n')
}

export async function currentWorldState(session: Pick<Session, 'cwd' | 'environment' | 'permissionMode' | 'config'>): Promise<WorldState> {
  return { environment: environmentContext(session), agentsMd: renderProjectDocs(session.cwd, await loadProjectDocs(session.cwd)) }
}

// known 里没有的节当作模型不知道，发全量；有的只在变了时发
export function renderWorldState(current: WorldState, known: Partial<WorldState>): { text: string; values: Partial<WorldState> } | null {
  const parts: string[] = []
  const values: Partial<WorldState> = {}
  const first = Object.keys(known).length === 0
  if (known.environment !== current.environment) {
    parts.push(current.environment)
    values.environment = current.environment
  }
  if (!('agentsMd' in known) || known.agentsMd !== current.agentsMd) {
    values.agentsMd = current.agentsMd
    if (current.agentsMd !== null) {
      parts.push('agentsMd' in known && known.agentsMd !== null ? `These AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n${current.agentsMd}` : current.agentsMd)
    } else if ('agentsMd' in known) {
      parts.push('The previously provided AGENTS.md instructions no longer apply.')
    }
  }
  if (parts.length === 0) return Object.keys(values).length > 0 ? { text: '', values } : null
  const header = first
    ? `${WORLD_STATE_MARKER} for this task, set by Diffra (not written by the user). Later context updates replace the matching parts.`
    : `${WORLD_STATE_MARKER} update:`
  return { text: `${header}\n\n${parts.join('\n\n')}`, values }
}

// 还在发给模型的对话里的那几条（压缩点之后、没被撤销截掉的），每一节取最近一次的值
export function knownWorldState(session: Pick<Session, 'messages' | 'compaction' | 'worldStateLog'>): Partial<WorldState> {
  const start = session.compaction?.upTo ?? 0
  session.worldStateLog = session.worldStateLog.filter((entry) => entry.index >= start && session.messages[entry.index] === entry.message)
  const known: Partial<WorldState> = {}
  for (const entry of session.worldStateLog) {
    for (const key of Object.keys(entry.values) as Section[]) (known as Record<Section, unknown>)[key] = entry.values[key]
  }
  return known
}

export function isWorldStateMessage(message: ModelMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(WORLD_STATE_MARKER)
}

// 主循环每一步调模型前调：有变化就追加一条上下文消息，记下来作为以后比较的基线
export async function injectWorldState(session: Session): Promise<void> {
  const rendered = renderWorldState(await currentWorldState(session), knownWorldState(session))
  if (!rendered) return
  if (!rendered.text) {
    // 只多知道了「没有说明文件」，不用发消息；记在最近一条上
    const last = session.worldStateLog.at(-1)
    if (last) last.values = { ...last.values, ...rendered.values }
    return
  }
  const message: ModelMessage = { role: 'user', content: rendered.text }
  session.messages.push(message)
  session.worldStateLog.push({ index: session.messages.length - 1, message, values: rendered.values })
}

// 只读的一轮（计划、定位）不往会话的对话里写：要补的上下文作为消息返回，接在 contextMessages() 后面
export async function pendingWorldState(session: Session): Promise<ModelMessage[]> {
  const rendered = renderWorldState(await currentWorldState(session), knownWorldState(session))
  return rendered?.text ? [{ role: 'user', content: rendered.text }] : []
}

// 自己从头开对话的（子智能体、深度扫描）：全量
export async function freshWorldState(session: Pick<Session, 'cwd' | 'environment' | 'permissionMode' | 'config'>): Promise<ModelMessage> {
  return { role: 'user', content: renderWorldState(await currentWorldState(session), {})!.text }
}
