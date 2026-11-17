import type { PromptImage } from '../protocol.js'
import type { ExecSessions } from './exec.js'

// 工具执行失败时抛这个错，message 原样返回给模型，让它自己纠正
export class ToolError extends Error {}

export interface ToolContext {
  cwd: string
  rgPath: string
  bashPath: string | null
  signal: AbortSignal
  // 由会话层决定：自动放行、问用户，或直接拒绝；拒绝时 reason 会告诉模型。justification 是模型写的「为什么要跑」，问用户时显示在确认卡上
  // workdir：命令在哪个目录跑（绝对路径），读项目外的判断按它算相对路径
  requestCommandPermission(command: string, justification?: string, workdir?: string): Promise<{ allowed: true } | { allowed: false; reason: string }>
  // 这个会话的后台进程（exec_command 到点没结束的）；没有时不能跑命令
  execSessions?: ExecSessions
  // 工人只能操作自己启动的进程；主智能体不传，仍可操作整个会话
  processOwner?: string
  // 用户为项目配置的检查命令，自动放行
  trustedCommands: string[]
  // 禁写目录（相对项目根目录）
  readOnlyPaths: string[]
  // 项目外可以只读访问的目录（Skill 目录），view_image 等能用绝对路径访问
  readRoots: string[]
  requestExternalPermission?(path: string, access: 'read' | 'write'): Promise<boolean>
  // 命令输出太长被截短时，完整输出存到这个目录（在 readRoots 里，模型能用 sed -n、rg 看被省略的部分）；没有就不存
  outputDir?: string | null
  // 写文件前的检查（子智能体用：文件归别的智能体时抛 ToolError，没人认领的先认领下来）
  beforeWrite?(target: { absolute: string; display: string }): void
}

export interface ToolOutput {
  // 给模型看的结果
  text: string
  // 给界面的标题，不填就用工具默认标题
  title?: string
  // 改了哪些文件，每个一份改动前后的全文（apply_patch 一次能改好几个）
  diffs?: Array<{ path: string; oldText: string | null; newText: string; deleted?: boolean }>
  edited?: boolean
  // 命令的完整输出（已截断），界面上可展开查看
  terminalOutput?: string
  commandSucceeded?: boolean
  executedCommand?: string
  commandWorkdir?: string
  // 命令这次调用的用时（毫秒），界面写在输出顶上（第 659 步）
  durationMs?: number
  // 要给模型看的图片（view_image），由主循环跟在工具结果后面发
  image?: PromptImage
}
